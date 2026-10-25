import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createChargeForTransfer } from '../finance.js';
import { audit, verifyChain } from '../audit.js';
import { ORG_NAME, transferBundle } from '../fhir.js';
import { decryptId, encryptId, isValidCccd, lookupHash, maskLast4, normalizeId } from '../crypto.js';
import { many, one, withTx, type Queryable } from '../db.js';
import { HttpError, incidentScope, newBaNumber, newTransferNumber, patientScope, recordTime, TIME_LABEL } from '../domain.js';
import { EpcrSchema, missingForSign } from '../epcr.js';
import { actorOf, guard, REVIEW_ROLES, type Ctx, type Role } from '../http.js';
import { contentHash, newVerifyCode, signatureHash } from '../safety.js';
import { consumeForTransfer } from '../stock.js';
import { privilegeGaps } from '../training.js';

const CLINICAL: Role[] = ['crew', 'calltaker', 'dispatcher', 'supervisor', 'qa', 'admin'];
const ID_TYPE = z.enum(['CCCD', 'DDCN', 'PASSPORT', 'UNKNOWN']);

function publicPatient(p: any) {
  if (!p) return p;
  const { id_enc, id_hash, ...rest } = p;
  return { ...rest, id_masked: p.id_last4 ? `••••${p.id_last4}` : null };
}

async function patientById(q: Queryable, id: string) {
  const p = await one(q, 'SELECT * FROM patients WHERE id = $1', [id]);
  if (!p) throw new HttpError(404, 'Không tìm thấy bệnh án');
  return p;
}

const uuidParam = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;

export function registerRecords(app: FastifyInstance, { pool, hub }: Ctx) {
  const clinical = { preHandler: guard(...CLINICAL) };

  /* ---------- Bệnh án: một người bệnh – một bệnh án (mục 8.6) ---------- */

  app.get('/api/patients/search', clinical, async (req) => {
    const { q } = z.object({ q: z.string().min(2).max(100) }).parse(req.query);
    const term = q.trim();
    const id = normalizeId(term);
    const hashes = ['CCCD', 'DDCN', 'PASSPORT'].map((t) => lookupHash(t, id));
    const rows = await many(pool, `
      SELECT p.*, (SELECT count(*)::int FROM transfers t WHERE t.patient_id = p.id) AS transfer_count
        FROM patients p
       WHERE p.merged_into IS NULL AND (
             p.id_hash = ANY($1) OR p.ba_number = upper($2) OR p.phone = $2 OR lower(p.full_name) LIKE '%' || lower($2) || '%')
       ORDER BY p.updated_at DESC LIMIT 30`, [hashes, term]);
    await withTx(pool, (tx) => audit(tx, 'system', actorOf(req), 'patient.searched', 'patient', null, { results: rows.length }));
    return rows.map(publicPatient);
  });

  app.post('/api/patients', clinical, async (req, reply) => {
    const b = z.object({
      idType: ID_TYPE,
      idNumber: z.string().max(30).optional(),
      nationality: z.string().max(60).optional(),
      fullName: z.string().max(120).optional(),
      dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      birthYear: z.number().int().min(1900).max(2100).optional(),
      sex: z.enum(['M', 'F', 'U']).default('U'),
      phone: z.string().max(20).optional(),
      address: z.string().max(300).optional(),
      force: z.boolean().default(false),
    }).parse(req.body);
    const actor = actorOf(req);
    let idNorm: string | null = null;
    if (b.idType !== 'UNKNOWN') {
      if (!b.idNumber) throw new HttpError(400, 'Thiếu số định danh');
      idNorm = normalizeId(b.idNumber);
      if ((b.idType === 'CCCD' || b.idType === 'DDCN') && !isValidCccd(idNorm)) throw new HttpError(400, 'Số định danh cá nhân phải gồm 12 chữ số');
      if (b.idType === 'PASSPORT' && !b.nationality) throw new HttpError(400, 'Hộ chiếu cần ghi quốc tịch');
    }
    // CCCD và số định danh cấp khi khai sinh là cùng một dãy số: dùng chung khóa tìm kiếm
    const hashType = b.idType === 'DDCN' ? 'CCCD' : b.idType;
    const hash = idNorm ? lookupHash(hashType, idNorm, b.idType === 'PASSPORT' ? b.nationality : '') : null;
    if (hash) {
      const existing = await one(pool, 'SELECT * FROM patients WHERE id_hash = $1 AND merged_into IS NULL', [hash]);
      if (existing) return reply.code(409).send({ error: 'Người bệnh đã có bệnh án', existing: publicPatient(existing) });
    }
    if (!b.force && (b.fullName || b.phone)) {
      const cands = await many(pool, `
        SELECT * FROM patients WHERE merged_into IS NULL AND (
          (lower(full_name) = lower($1) AND (dob = $2::date OR birth_year = $3)) OR (phone = $4 AND lower(full_name) = lower($1)))
        LIMIT 10`, [b.fullName ?? '', b.dob ?? null, b.birthYear ?? null, b.phone ?? '']);
      if (cands.length) return reply.code(409).send({ error: 'Có thể trùng bệnh án: kiểm tra trước khi tạo mới', candidates: cands.map(publicPatient) });
    }
    const p = await withTx(pool, async (tx) => {
      const ba = await newBaNumber(tx);
      const row = await one(tx, `
        INSERT INTO patients(ba_number, id_type, id_enc, id_hash, id_last4, nationality, full_name, dob, birth_year, sex, phone, address, is_temporary)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [ba, b.idType, idNorm ? encryptId(idNorm) : null, hash, idNorm ? maskLast4(idNorm) : null, b.nationality ?? null,
        b.fullName ?? null, b.dob ?? null, b.birthYear ?? (b.dob ? Number(b.dob.slice(0, 4)) : null), b.sex, b.phone ?? null,
        b.address ?? null, b.idType === 'UNKNOWN']);
      await audit(tx, patientScope(row.id), actor, 'patient.created', 'patient', row.id, { ba, idType: b.idType, temporary: b.idType === 'UNKNOWN' });
      return row;
    });
    return publicPatient(p);
  });

  app.get('/api/patients/:id', clinical, async (req) => {
    const id = uuidParam(req);
    const { reveal } = z.object({ reveal: z.coerce.boolean().default(false) }).parse(req.query);
    const p = await patientById(pool, id);
    const transfers = await many(pool, `
      SELECT t.id, t.transfer_number, t.status, t.created_at, t.signed_at, t.vehicle_id, t.payer,
             t.epcr->'diagnosis'->>'text' AS diagnosis, t.epcr->'disposition'->>'hospital' AS hospital,
             i.code AS incident_code, i.final_priority
        FROM transfers t LEFT JOIN incidents i ON i.id = t.incident_id
       WHERE t.patient_id = $1 ORDER BY t.created_at DESC`, [id]);
    const out: any = { ...publicPatient(p), transfers };
    if (p.merged_into) out.merged_into_ba = (await one(pool, 'SELECT ba_number FROM patients WHERE id = $1', [p.merged_into]))?.ba_number;
    const merges = await many(pool, `SELECT m.*, f.ba_number AS from_ba FROM patient_merges m JOIN patients f ON f.id = m.from_id
                                      WHERE m.into_id = $1 AND m.undone_at IS NULL`, [id]);
    out.merges = merges;
    if (reveal) {
      if (!REVIEW_ROLES.includes(req.user.role)) throw new HttpError(403, 'Chỉ Ban Giám đốc, trưởng ca, QLCL được xem đầy đủ số định danh');
      out.id_number = p.id_enc ? decryptId(p.id_enc) : null;
    }
    await withTx(pool, (tx) => audit(tx, patientScope(id), actorOf(req), reveal ? 'patient.id_revealed' : 'patient.viewed', 'patient', id));
    return out;
  });

  app.patch('/api/patients/:id', clinical, async (req) => {
    const id = uuidParam(req);
    const b = z.object({
      fullName: z.string().max(120).optional(), dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), birthYear: z.number().int().nullish(),
      sex: z.enum(['M', 'F', 'U']).optional(), phone: z.string().max(20).nullish(), address: z.string().max(300).nullish(),
      shared: z.object({
        allergies: z.string().max(1000).optional(), history: z.string().max(2000).optional(), medications: z.string().max(2000).optional(),
        bloodType: z.string().max(10).optional(), contact: z.string().max(300).optional(), advanceDirective: z.string().max(1000).optional(),
      }).optional(),
    }).parse(req.body);
    const actor = actorOf(req);
    const p = await withTx(pool, async (tx) => {
      const before = await patientById(tx, id);
      const row = await one(tx, `
        UPDATE patients SET full_name = COALESCE($2, full_name), dob = COALESCE($3, dob), birth_year = COALESCE($4, birth_year),
               sex = COALESCE($5, sex), phone = COALESCE($6, phone), address = COALESCE($7, address),
               shared = shared || COALESCE($8, '{}'::jsonb), updated_at = now()
         WHERE id = $1 RETURNING *`,
      [id, b.fullName ?? null, b.dob ?? null, b.birthYear ?? null, b.sex ?? null, b.phone ?? null, b.address ?? null, b.shared ?? null]);
      await audit(tx, patientScope(id), actor, 'patient.updated', 'patient', id, { changes: b, before: { full_name: before.full_name, shared: before.shared } });
      return row;
    });
    return publicPatient(p);
  });

  /** Gộp bệnh án tạm vào bệnh án thật: QLCL duyệt, có lưu vết, tách lại được */
  app.post('/api/patients/:id/merge', { preHandler: guard('qa', 'supervisor', 'admin') }, async (req) => {
    const id = uuidParam(req);
    const b = z.object({ intoId: z.string().uuid(), reason: z.string().min(3).max(500) }).parse(req.body);
    if (b.intoId === id) throw new HttpError(400, 'Không gộp bệnh án vào chính nó');
    const actor = actorOf(req);
    await withTx(pool, async (tx) => {
      const from = await patientById(tx, id);
      const into = await patientById(tx, b.intoId);
      if (from.merged_into || into.merged_into) throw new HttpError(409, 'Bệnh án đã được gộp trước đó');
      const moved = await many(tx, 'UPDATE transfers SET patient_id = $2 WHERE patient_id = $1 RETURNING id', [id, b.intoId]);
      await tx.query('UPDATE patients SET merged_into = $2, updated_at = now() WHERE id = $1', [id, b.intoId]);
      await tx.query('INSERT INTO patient_merges(from_id, into_id, transfer_ids, reason, merged_by) VALUES ($1,$2,$3,$4,$5)',
        [id, b.intoId, moved.map((m) => m.id), b.reason, actor.id]);
      for (const scope of [patientScope(id), patientScope(b.intoId)]) {
        await audit(tx, scope, actor, 'patient.merged', 'patient', id, { from: from.ba_number, into: into.ba_number, transfers: moved.length, reason: b.reason });
      }
    });
    return { ok: true };
  });

  app.post('/api/patients/merges/:mergeId/undo', { preHandler: guard('qa', 'supervisor', 'admin') }, async (req) => {
    const mergeId = z.object({ mergeId: z.coerce.number() }).parse(req.params).mergeId;
    const b = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    const actor = actorOf(req);
    await withTx(pool, async (tx) => {
      const m = await one(tx, 'SELECT * FROM patient_merges WHERE id = $1 AND undone_at IS NULL FOR UPDATE', [mergeId]);
      if (!m) throw new HttpError(404, 'Không tìm thấy lần gộp');
      await tx.query('UPDATE transfers SET patient_id = $1 WHERE id = ANY($2)', [m.from_id, m.transfer_ids]);
      await tx.query('UPDATE patients SET merged_into = NULL, updated_at = now() WHERE id = $1', [m.from_id]);
      await tx.query('UPDATE patient_merges SET undone_at = now(), undone_by = $2 WHERE id = $1', [mergeId, actor.id]);
      for (const scope of [patientScope(m.from_id), patientScope(m.into_id)]) {
        await audit(tx, scope, actor, 'patient.unmerged', 'patient', m.from_id, { mergeId, reason: b.reason });
      }
    });
    return { ok: true };
  });

  /* ---------- Phiếu chuyển viện + ePCR ---------- */

  /**
   * Lưu phiếu từ máy tính bảng. Idempotent theo UUID do máy sinh: gửi lại khi mạng chập chờn không
   * tạo bản trùng. baseVersion lệch => 409 kèm bản trên máy chủ để máy tính bảng xử lý.
   */
  app.put('/api/transfers/:id', clinical, async (req, reply) => {
    const id = uuidParam(req);
    const b = z.object({
      incidentId: z.string().uuid().nullish(),
      patientId: z.string().uuid().nullish(),
      vehicleId: z.string().max(40).nullish(),
      baseVersion: z.number().int().min(0),
      deviceId: z.string().max(80).optional(),
      epcr: EpcrSchema,
    }).parse(req.body);
    const actor = actorOf(req);
    const res = await withTx(pool, async (tx) => {
      const cur = await one(tx, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [id]);
      if (!cur) {
        const number = await newTransferNumber(tx);
        const row = await one(tx, `
          INSERT INTO transfers(id, transfer_number, patient_id, incident_id, vehicle_id, epcr, device_id, author_id, payer)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, number, b.patientId ?? null, b.incidentId ?? null, b.vehicleId ?? null, b.epcr, b.deviceId ?? null, actor.id, b.epcr.payer ?? null]);
        await audit(tx, b.incidentId ? incidentScope(b.incidentId) : 'system', actor, 'transfer.created', 'transfer', id, { number, patientId: b.patientId ?? null });
        return { status: 200, row };
      }
      if (cur.status === 'signed') return { status: 409, body: { error: 'Phiếu đã ký: chỉ được bổ sung có lý do', server: cur } };
      if (b.baseVersion !== cur.version) return { status: 409, body: { error: 'Phiếu đã được sửa ở nơi khác', server: cur } };
      const row = await one(tx, `
        UPDATE transfers SET epcr = $2, patient_id = COALESCE($3, patient_id), incident_id = COALESCE($4, incident_id),
               vehicle_id = COALESCE($5, vehicle_id), payer = $6, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
      [id, b.epcr, b.patientId ?? null, b.incidentId ?? null, b.vehicleId ?? null, b.epcr.payer ?? null]);
      const scope = row.incident_id ? incidentScope(row.incident_id) : 'system';
      await audit(tx, scope, actor, 'transfer.saved', 'transfer', id, { version: row.version, device: b.deviceId ?? null });
      // T9: can thiệp đầu tiên lấy từ thủ thuật/thuốc sớm nhất trong ePCR
      const first = [...b.epcr.interventions, ...b.epcr.medications].map((x) => x.at).filter(Boolean).sort()[0];
      if (first && row.incident_id) await recordTime(tx, row.incident_id, 'T9', first, 'ePCR', actor);
      return { status: 200, row };
    });
    if (res.status !== 200) return reply.code(res.status).send(res.body);
    return res.row;
  });

  app.get('/api/transfers/:id', clinical, async (req) => {
    const id = uuidParam(req);
    const t = await one(pool, `
      SELECT t.*, i.code AS incident_code, i.final_priority, i.source, i.source_ref, i.address AS incident_address,
             i.caller_name, i.callback_phone, i.caller_phone,
             p.ba_number, p.full_name AS patient_name, p.id_last4, p.sex AS patient_sex, p.dob AS patient_dob, p.birth_year,
             a.full_name AS author_name, s.full_name AS signed_by_name
        FROM transfers t
        LEFT JOIN incidents i ON i.id = t.incident_id
        LEFT JOIN patients p ON p.id = t.patient_id
        LEFT JOIN users a ON a.id = t.author_id
        LEFT JOIN users s ON s.id = t.signed_by
       WHERE t.id = $1`, [id]);
    if (!t) throw new HttpError(404, 'Không tìm thấy phiếu');
    const times = t.incident_id ? await many(pool, 'SELECT code, at, source FROM incident_times WHERE incident_id = $1 ORDER BY substring(code from 2)::int', [t.incident_id]) : [];
    const amendments = await many(pool, `SELECT m.version, m.reason, m.created_at, u.full_name AS author FROM transfer_amendments m
                                          LEFT JOIN users u ON u.id = m.author_id WHERE m.transfer_id = $1 ORDER BY m.id`, [id]);
    const crew = t.vehicle_id ? await many(pool, `SELECT u.full_name, u.title, u.license_no, cs.crew_role FROM crew_shifts cs JOIN users u ON u.id = cs.user_id
        WHERE cs.vehicle_id = $1 AND cs.started_at <= COALESCE($2::timestamptz, now()) AND (cs.ended_at IS NULL OR cs.ended_at >= $3::timestamptz)`,
    [t.vehicle_id, t.signed_at, t.created_at]) : [];
    await withTx(pool, (tx) => audit(tx, t.incident_id ? incidentScope(t.incident_id) : 'system', actorOf(req), 'transfer.viewed', 'transfer', id));
    return { ...t, times: times.map((x) => ({ ...x, label: TIME_LABEL[x.code] })), amendments, crew };
  });

  /** Xuất phiếu theo chuẩn HL7 FHIR R4 (Bundle "document") để gửi bệnh viện nhận; số định danh đầy đủ chỉ khi người có quyền chọn */
  app.get('/api/transfers/:id/fhir', clinical, async (req, reply) => {
    const id = uuidParam(req);
    const full = z.object({ nationalId: z.enum(['0', '1']).default('0') }).parse(req.query).nationalId === '1';
    if (full && !REVIEW_ROLES.includes(req.user.role)) throw new HttpError(403, 'Chỉ Ban Giám đốc, trưởng ca, QLCL được xuất kèm số định danh đầy đủ');
    const t = await one(pool, `
      SELECT t.*, i.code AS incident_code, i.final_priority, i.address AS incident_address,
             p.ba_number, p.full_name AS patient_name, p.sex AS patient_sex, to_char(p.dob, 'YYYY-MM-DD') AS patient_dob, p.birth_year,
             p.id_type, p.id_enc, p.id_last4, p.phone AS patient_phone
        FROM transfers t LEFT JOIN incidents i ON i.id = t.incident_id LEFT JOIN patients p ON p.id = t.patient_id
       WHERE t.id = $1`, [id]);
    if (!t) throw new HttpError(404, 'Không tìm thấy phiếu');
    const times = t.incident_id ? await many(pool, 'SELECT code, at FROM incident_times WHERE incident_id = $1', [t.incident_id]) : [];
    const crew = t.vehicle_id ? await many(pool, `SELECT u.full_name, u.title, u.license_no, cs.crew_role FROM crew_shifts cs JOIN users u ON u.id = cs.user_id
        WHERE cs.vehicle_id = $1 AND cs.started_at <= COALESCE($2::timestamptz, now()) AND (cs.ended_at IS NULL OR cs.ended_at >= $3::timestamptz)`,
    [t.vehicle_id, t.signed_at, t.created_at]) : [];
    const hname = t.epcr?.disposition?.hospital;
    const hospital = hname ? await one(pool, 'SELECT name, kcb_code, address FROM hospitals WHERE name = $1', [hname]) : null;
    const bundle = transferBundle({
      ...t, times, crew, hospital: hospital ?? (hname ? { name: hname, kcb_code: null, address: null } : null),
      national_id: full && t.id_enc ? decryptId(t.id_enc) : null, org: { name: ORG_NAME },
    });
    await withTx(pool, (tx) => audit(tx, t.incident_id ? incidentScope(t.incident_id) : 'system', actorOf(req), 'transfer.fhir_exported', 'transfer', id,
      { nationalId: full, resources: bundle.entry.length }));
    return reply.header('content-type', 'application/fhir+json; charset=utf-8')
      .header('content-disposition', `attachment; filename="fhir-${t.transfer_number ?? id}.json"`).send(bundle);
  });

  app.post('/api/transfers/:id/sign', clinical, async (req) => {
    const id = uuidParam(req);
    const actor = actorOf(req);
    const warnings = await withTx(pool, async (tx) => {
      const t = await one(tx, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [id]);
      if (!t) throw new HttpError(404, 'Không tìm thấy phiếu');
      if (t.status === 'signed') throw new HttpError(409, 'Phiếu đã ký');
      if (!t.patient_id) throw new HttpError(409, 'Phiếu chưa gắn bệnh án (Số BA)');
      const epcr = EpcrSchema.parse(t.epcr);
      const miss = missingForSign(epcr);
      if (miss.length) throw new HttpError(422, 'Còn thiếu thông tin bắt buộc', miss);
      await consumeForTransfer(tx, actor, id, epcr.medications);
      // Chữ ký điện tử: băm từng chữ ký để phát hiện sửa về sau; phiếu nhận mã xác thực in kèm QR cho bệnh viện tra cứu
      const signed = { ...epcr, signatures: epcr.signatures?.map((s) => ({ ...s, hash: signatureHash(s) })) };
      await tx.query(`UPDATE transfers SET status = 'signed', signed_by = $2, signed_at = now(), updated_at = now(), epcr = $3,
                             verify_code = $4, content_hash = $5 WHERE id = $1`, [id, actor.id, signed, newVerifyCode(), contentHash(signed)]);
      await createChargeForTransfer(tx, actor, id);
      const scope = t.incident_id ? incidentScope(t.incident_id) : 'system';
      await audit(tx, scope, actor, 'transfer.signed', 'transfer', id, { number: t.transfer_number, version: t.version });
      await audit(tx, patientScope(t.patient_id), actor, 'transfer.signed', 'transfer', id, { number: t.transfer_number });
      if (t.incident_id) {
        await recordTime(tx, t.incident_id, 'T15', new Date(), 'ePCR', actor);
        const h = t.epcr?.disposition?.handoverAt;
        if (h) await recordTime(tx, t.incident_id, 'T13', h, 'ePCR (bàn giao)', actor);
      }
      // Can thiệp người ký chưa được phân quyền kỹ thuật (QLCL-14): không chặn cấp cứu, ghi vết để quản lý chất lượng rà soát
      const gaps = await privilegeGaps(tx, actor.id!, epcr.care as Record<string, unknown>);
      if (gaps.length) await audit(tx, scope, actor, 'training.privilege_gap', 'transfer', id, { procedures: gaps.map((g) => g.code) });
      return gaps.map((g) => `Bạn chưa được phân quyền kỹ thuật "${g.title}" (${g.code}); quản lý chất lượng sẽ rà soát ca này`);
    });
    const t = await one(pool, 'SELECT incident_id FROM transfers WHERE id = $1', [id]);
    if (t?.incident_id) await hub.publish({ type: 'incident', id: t.incident_id, refetch: true });
    return { ok: true, warnings };
  });

  app.post('/api/transfers/:id/amend', clinical, async (req) => {
    const id = uuidParam(req);
    const b = z.object({ reason: z.string().min(3).max(500), epcr: EpcrSchema }).parse(req.body);
    const actor = actorOf(req);
    await withTx(pool, async (tx) => {
      const t = await one(tx, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [id]);
      if (!t) throw new HttpError(404, 'Không tìm thấy phiếu');
      if (t.status !== 'signed') throw new HttpError(409, 'Phiếu chưa ký thì sửa trực tiếp, không cần bổ sung');
      await tx.query('INSERT INTO transfer_amendments(transfer_id, version, reason, epcr, author_id) VALUES ($1,$2,$3,$4,$5)',
        [id, t.version, b.reason, t.epcr, actor.id]);
      // Chữ ký của người bệnh, người nhà đã cố định lúc ký phiếu: bản bổ sung giữ nguyên, không thêm bớt
      const epcr = { ...b.epcr, signatures: t.epcr?.signatures };
      await tx.query('UPDATE transfers SET epcr = $2, version = version + 1, content_hash = $3, updated_at = now() WHERE id = $1', [id, epcr, contentHash(epcr)]);
      await audit(tx, t.incident_id ? incidentScope(t.incident_id) : 'system', actor, 'transfer.amended', 'transfer', id, { fromVersion: t.version, reason: b.reason });
    });
    return { ok: true };
  });

  /* ---------- Truy xuất ca (mục 6.3) ---------- */

  app.get('/api/incidents/:id/trace', { preHandler: guard(...REVIEW_ROLES, 'dispatcher', 'calltaker', 'crew') }, async (req) => {
    const id = uuidParam(req);
    const { reason } = z.object({ reason: z.string().max(300).optional() }).parse(req.query);
    const inc = await one(pool, 'SELECT id, code FROM incidents WHERE id = $1', [id]);
    if (!inc) throw new HttpError(404, 'Không tìm thấy ca');
    if (!REVIEW_ROLES.includes(req.user.role)) {
      // Chỉ người tham gia ca được xem (mục 6.3)
      const took = await one(pool, `SELECT 1 FROM audit_events WHERE scope = $1 AND actor_id = $2 LIMIT 1`, [incidentScope(id), req.user.id]);
      if (!took) throw new HttpError(403, 'Chỉ Ban Giám đốc, QLCL, trưởng ca và người tham gia ca được xem');
    }
    await withTx(pool, (tx) => audit(tx, incidentScope(id), actorOf(req), 'trace.viewed', 'incident', id, { reason: reason ?? null }));
    const events = await many(pool, `SELECT id, at, actor_name, action, entity, entity_id, data, hash FROM audit_events WHERE scope = $1 ORDER BY id`, [incidentScope(id)]);
    const chain = await verifyChain(pool, incidentScope(id));
    return { incident: inc, events, chain };
  });
}
