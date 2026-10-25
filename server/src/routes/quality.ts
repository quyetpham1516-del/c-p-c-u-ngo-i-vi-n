import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import {
  addCapa, answerSurvey, closeEvent, createComplaint, DISINFECTION_LEVEL, DISINFECTION_STEPS, EVENT_CATEGORY, eventSuggestions, FACTORS,
  finishCapa, reportEvent, SEVERITY, signDisinfection, updateComplaint, updateEvent,
} from '../quality.js';
import { CAPA_SELECT, CAPA_SOURCE, verifyCapa } from '../qms.js';

const QUALITY: Role[] = ['qa', 'supervisor', 'admin', 'director'];
const QUALITY_VIEW: Role[] = [...QUALITY, 'ipc'];
const IPC: Role[] = ['ipc', 'qa', 'supervisor', 'admin', 'director'];
const IPC_WRITE: Role[] = ['ipc', 'supervisor', 'admin'];
const EXPOSURE_VIEW: Role[] = ['ipc', 'admin', 'director'];
const COMPLAINT_INTAKE: Role[] = ['calltaker', 'dispatcher', 'supervisor', 'qa', 'admin', 'director', 'accountant'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const opt = (n = 2000) => z.string().trim().max(n).nullish();
const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;

export function registerQuality(app: FastifyInstance, { pool, hub }: Ctx) {
  /** Danh bạ nhân viên (tên, vai trò) để chọn người phụ trách, người được quan sát... */
  app.get('/api/staff', { preHandler: guard() }, async () =>
    many(pool, `SELECT id, full_name, role, title, station_id FROM users WHERE active ORDER BY full_name`));

  /* ================= Kiểm soát nhiễm khuẩn ================= */

  app.get('/api/ipc/meta', { preHandler: guard() }, async () => ({ levels: DISINFECTION_LEVEL, steps: DISINFECTION_STEPS }));

  app.get('/api/ipc/disinfections', { preHandler: guard('crew', ...IPC) }, async (req) => {
    const q = z.object({ status: z.enum(['cho_lam', 'da_ky']).optional(), vehicleId: z.string().optional(), days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    return many(pool, `
      SELECT d.*, i.code AS incident_code, i.infection_risk, u.full_name AS done_by_name
        FROM disinfections d LEFT JOIN incidents i ON i.id = d.incident_id LEFT JOIN users u ON u.id = d.done_by
       WHERE ($1::text IS NULL OR d.status = $1) AND ($2::text IS NULL OR d.vehicle_id = $2) AND d.created_at > now() - make_interval(days => $3)
       ORDER BY d.status = 'cho_lam' DESC, d.created_at DESC LIMIT 300`, [q.status ?? null, q.vehicleId ?? null, q.days]);
  });

  app.post('/api/ipc/disinfections', { preHandler: guard('crew', ...IPC_WRITE) }, async (req) => {
    const b = z.object({
      vehicleId: z.string().min(1), incidentId: z.string().uuid().nullish(), level: z.enum(['thuong_quy', 'tang_cuong', 'toan_dien']),
      checklist: z.record(z.string(), z.boolean()), chemical: z.string().trim().min(2).max(120), concentration: opt(60),
      contactMinutes: z.number().int().min(0).max(240).nullish(), note: opt(500),
    }).parse(req.body);
    if (req.user.role === 'crew') {
      const s = await one(pool, 'SELECT 1 FROM crew_shifts WHERE user_id = $1 AND vehicle_id = $2 AND ended_at IS NULL', [req.user.id, b.vehicleId]);
      if (!s) throw new HttpError(403, 'Bạn không đăng nhập ca trên xe này');
    }
    const r = await withTx(pool, (tx) => signDisinfection(tx, actorOf(req), b));
    await hub.publish({ type: 'vehicle', id: b.vehicleId });
    return r;
  });

  /** Kíp đánh dấu nguy cơ lây nhiễm cho ca đang làm (điều phối đánh dấu qua sửa ca) */
  app.post('/api/crew/infection', { preHandler: guard('crew') }, async (req) => {
    const b = z.object({ risk: z.enum(['tiep_xuc', 'giot_ban', 'khong_khi']).nullable() }).parse(req.body);
    const a = await one(pool, `SELECT a.incident_id FROM crew_shifts cs JOIN assignments a ON a.vehicle_id = cs.vehicle_id AND a.ended_at IS NULL
                                WHERE cs.user_id = $1 AND cs.ended_at IS NULL`, [req.user.id]);
    if (!a) throw new HttpError(409, 'Xe không có ca đang làm');
    await withTx(pool, async (tx) => {
      await tx.query('UPDATE incidents SET infection_risk = $2, updated_at = now() WHERE id = $1', [a.incident_id, b.risk]);
      await audit(tx, `incident:${a.incident_id}`, actorOf(req), 'incident.infection_risk', 'incident', a.incident_id, b);
    });
    await hub.publish({ type: 'incident', id: a.incident_id });
    return { ok: true };
  });

  app.post('/api/ipc/hand-hygiene', { preHandler: guard(...IPC_WRITE, 'qa') }, async (req) => {
    const b = z.object({
      stationId: z.string().nullish(), staffId: z.string().uuid().nullish(), staffGroup: opt(60),
      moment: z.enum(['truoc_tiep_xuc', 'truoc_vo_khuan', 'sau_dich_co_the', 'sau_tiep_xuc', 'sau_moi_truong']),
      compliant: z.boolean(), method: z.enum(['chua_con', 'xa_phong', 'khong']).nullish(), note: opt(300),
    }).parse(req.body);
    return one(pool, `INSERT INTO hand_hygiene_obs(station_id, observer_id, staff_id, staff_group, moment, compliant, method, note)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [b.stationId ?? null, req.user.id, b.staffId ?? null, b.staffGroup ?? null, b.moment, b.compliant, b.method ?? null, b.note ?? null]);
  });

  app.get('/api/ipc/hand-hygiene/stats', { preHandler: guard(...IPC) }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const [byMoment, byStation, total] = await Promise.all([
      many(pool, `SELECT moment, count(*)::int AS n, count(*) FILTER (WHERE compliant)::int AS ok FROM hand_hygiene_obs
                   WHERE observed_at > now() - make_interval(days => $1) GROUP BY moment ORDER BY moment`, [q.days]),
      many(pool, `SELECT coalesce(station_id, '—') AS station_id, count(*)::int AS n, count(*) FILTER (WHERE compliant)::int AS ok FROM hand_hygiene_obs
                   WHERE observed_at > now() - make_interval(days => $1) GROUP BY 1 ORDER BY 1`, [q.days]),
      one(pool, `SELECT count(*)::int AS n, count(*) FILTER (WHERE compliant)::int AS ok FROM hand_hygiene_obs WHERE observed_at > now() - make_interval(days => $1)`, [q.days]),
    ]);
    return { byMoment, byStation, total };
  });

  /* Phơi nhiễm nghề nghiệp: hồ sơ bảo mật */
  app.get('/api/ipc/exposures', { preHandler: guard() }, async (req) => {
    const all = EXPOSURE_VIEW.includes(req.user.role);
    return many(pool, `SELECT e.*, s.full_name AS staff_name, i.code AS incident_code FROM exposures e
                         JOIN users s ON s.id = e.staff_id LEFT JOIN incidents i ON i.id = e.incident_id
                        WHERE $1 OR e.staff_id = $2 OR e.reported_by = $2 ORDER BY e.occurred_at DESC`, [all, req.user.id]);
  });

  app.post('/api/ipc/exposures', { preHandler: guard() }, async (req) => {
    const b = z.object({
      staffId: z.string().uuid().nullish(), occurredAt: z.string().datetime(), kind: z.enum(['kim_dam', 'vat_sac', 'mau_ban_niem_mac', 'mau_ban_da_ton_thuong', 'khac']),
      incidentId: z.string().uuid().nullish(), description: z.string().trim().min(5).max(2000), firstAid: opt(1000), sourceStatus: opt(300),
    }).parse(req.body);
    const staffId = b.staffId ?? req.user.id;
    if (staffId !== req.user.id && !IPC_WRITE.includes(req.user.role)) throw new HttpError(403, 'Chỉ báo phơi nhiễm cho chính mình');
    return withTx(pool, async (tx) => {
      const e = await one(tx, `INSERT INTO exposures(staff_id, reported_by, occurred_at, kind, incident_id, description, first_aid, source_status)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [staffId, req.user.id, b.occurredAt, b.kind, b.incidentId ?? null, b.description, b.firstAid ?? null, b.sourceStatus ?? null]);
      // Nhật ký chỉ ghi có hồ sơ, không ghi nội dung y khoa
      await audit(tx, 'system', actorOf(req), 'ipc.exposure_reported', 'exposure', e.id, { kind: b.kind });
      return e;
    });
  });

  app.patch('/api/ipc/exposures/:id', { preHandler: guard(...EXPOSURE_VIEW) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({
      pepStarted: z.boolean().optional(), sourceStatus: opt(300),
      followup: z.object({ on: date, test: z.string().trim().min(1).max(120), result: z.string().trim().max(300) }).optional(),
      close: z.boolean().optional(),
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      const e = await one(tx, `UPDATE exposures SET
                                 pep_started_at = CASE WHEN $2 AND pep_started_at IS NULL THEN now() ELSE pep_started_at END,
                                 source_status = coalesce($3, source_status),
                                 followups = CASE WHEN $4::jsonb IS NULL THEN followups ELSE followups || jsonb_build_array($4::jsonb) END,
                                 status = CASE WHEN $5 THEN 'ket_thuc' ELSE status END
                               WHERE id = $1 RETURNING *`,
      [id, !!b.pepStarted, b.sourceStatus ?? null, b.followup ? JSON.stringify(b.followup) : null, !!b.close]);
      if (!e) throw new HttpError(404, 'Không tìm thấy hồ sơ');
      await audit(tx, 'system', actorOf(req), 'ipc.exposure_updated', 'exposure', id, { pepStarted: b.pepStarted, followup: !!b.followup, close: b.close });
      return e;
    });
  });

  app.get('/api/ipc/vaccinations', { preHandler: guard(...IPC, 'hr') }, async () =>
    many(pool, `SELECT v.*, u.full_name AS staff_name, u.role FROM vaccinations v JOIN users u ON u.id = v.staff_id ORDER BY u.full_name, v.given_on DESC`));

  app.post('/api/ipc/vaccinations', { preHandler: guard(...IPC_WRITE, 'hr') }, async (req) => {
    const b = z.object({ staffId: z.string().uuid(), vaccine: z.string().trim().min(2).max(80), dose: opt(40), givenOn: date, nextDue: date.nullish(), note: opt(300) }).parse(req.body);
    return one(pool, `INSERT INTO vaccinations(staff_id, vaccine, dose, given_on, next_due, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.staffId, b.vaccine, b.dose ?? null, b.givenOn, b.nextDue ?? null, b.note ?? null, req.user.id]);
  });

  app.get('/api/ipc/waste', { preHandler: guard(...IPC) }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(730).default(90) }).parse(req.query);
    const [rows, summary] = await Promise.all([
      many(pool, `SELECT w.*, u.full_name AS created_by_name FROM medical_waste w LEFT JOIN users u ON u.id = w.created_by
                   WHERE w.on_date > vn_today() - $1::int ORDER BY w.on_date DESC, w.id DESC LIMIT 300`, [q.days]),
      many(pool, `SELECT station_id, kind, sum(kg)::float AS kg FROM medical_waste WHERE on_date > vn_today() - $1::int GROUP BY 1, 2 ORDER BY 1, 2`, [q.days]),
    ]);
    return { rows, summary };
  });

  app.post('/api/ipc/waste', { preHandler: guard(...IPC_WRITE, 'crew') }, async (req) => {
    const b = z.object({ stationId: z.string().min(1), onDate: date, kind: z.enum(['lay_nhiem', 'sac_nhon', 'nguy_hai', 'thong_thuong', 'tai_che']), kg: z.number().min(0).max(100000), handedTo: opt(200), note: opt(300) }).parse(req.body);
    return one(pool, `INSERT INTO medical_waste(station_id, on_date, kind, kg, handed_to, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.stationId, b.onDate, b.kind, b.kg, b.handedTo ?? null, b.note ?? null, req.user.id]);
  });

  app.get('/api/ipc/summary', { preHandler: guard(...IPC) }, async () => {
    const [pending, overdue, hh, exposures, vaccDue] = await Promise.all([
      one(pool, `SELECT count(*)::int AS n FROM disinfections WHERE status = 'cho_lam'`),
      many(pool, `SELECT d.vehicle_id, d.required_level, i.code AS incident_code, d.created_at FROM disinfections d LEFT JOIN incidents i ON i.id = d.incident_id
                   WHERE d.status = 'cho_lam' AND d.required_level <> 'thuong_quy' ORDER BY d.created_at`),
      one(pool, `SELECT count(*)::int AS n, count(*) FILTER (WHERE compliant)::int AS ok FROM hand_hygiene_obs WHERE observed_at > now() - interval '30 days'`),
      one(pool, `SELECT count(*)::int AS n FROM exposures WHERE status = 'dang_theo_doi'`),
      many(pool, `SELECT DISTINCT ON (v.staff_id, v.vaccine) v.staff_id, u.full_name, v.vaccine, v.next_due FROM vaccinations v JOIN users u ON u.id = v.staff_id
                   WHERE u.active ORDER BY v.staff_id, v.vaccine, v.given_on DESC`).then((r) => r.filter((x) => x.next_due && x.next_due < new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10))),
    ]);
    return { pendingDisinfections: pending.n, infectiousPending: overdue, handHygiene: hh, openExposures: exposures.n, vaccinesDue: vaccDue };
  });

  /* ================= Sự cố y khoa ================= */

  app.get('/api/quality/meta', { preHandler: guard() }, async () => ({ categories: EVENT_CATEGORY, severity: SEVERITY, factors: FACTORS }));

  /** Mọi nhân viên báo được; có thể ẩn danh */
  app.post('/api/quality/events', { preHandler: guard() }, async (req) => {
    const b = z.object({
      occurredAt: z.string().datetime(), anonymous: z.boolean().default(false), incidentId: z.string().uuid().nullish(), vehicleId: z.string().nullish(),
      stationId: z.string().nullish(), category: z.string(), description: z.string().trim().min(10).max(4000), immediateAction: opt(2000),
      patientAffected: z.boolean().default(false), severity: z.enum(['NC0', 'NC1', 'NC2', 'NC3']), sourceRef: z.string().max(200).nullish(),
    }).parse(req.body);
    if (b.sourceRef && !QUALITY.includes(req.user.role)) throw new HttpError(403, 'Chỉ QLCL tạo báo cáo từ gợi ý');
    const ev = await withTx(pool, (tx) => reportEvent(tx, actorOf(req), b));
    return { id: ev.id, code: ev.code };
  });

  /** Báo cáo mình đã gửi (không ẩn danh) */
  app.get('/api/quality/my-events', { preHandler: guard() }, async (req) =>
    many(pool, `SELECT id, code, reported_at, category, severity_reported, status FROM adverse_events WHERE reporter_id = $1 ORDER BY reported_at DESC`, [req.user.id]));

  app.get('/api/quality/events', { preHandler: guard(...QUALITY_VIEW) }, async (req) => {
    const q = z.object({ status: z.string().optional(), days: z.coerce.number().int().min(1).max(3650).default(365) }).parse(req.query);
    return many(pool, `
      SELECT e.id, e.code, e.reported_at, e.occurred_at, e.category, e.severity_reported, e.severity, e.status, e.anonymous, e.patient_affected,
             e.authority_reported_at, i.code AS incident_code, e.vehicle_id, h.full_name AS handler_name,
             (SELECT count(*)::int FROM capa_actions c WHERE c.event_id = e.id AND c.status = 'mo') AS open_capa,
             (coalesce(e.severity, e.severity_reported) = 'NC3' AND e.authority_reported_at IS NULL AND e.reported_at < now() - interval '24 hours') AS report_overdue
        FROM adverse_events e LEFT JOIN incidents i ON i.id = e.incident_id LEFT JOIN users h ON h.id = e.handler_id
       WHERE ($1::text IS NULL OR e.status = $1) AND e.reported_at > now() - make_interval(days => $2)
       ORDER BY e.status = 'dong', e.reported_at DESC`, [q.status ?? null, q.days]);
  });

  app.get('/api/quality/events/:id', { preHandler: guard(...QUALITY_VIEW) }, async (req) => {
    const id = idParam(req.params);
    const ev = await one(pool, `SELECT e.*, i.code AS incident_code, h.full_name AS handler_name, r.full_name AS reporter_name, c.full_name AS closed_by_name
                                  FROM adverse_events e LEFT JOIN incidents i ON i.id = e.incident_id LEFT JOIN users h ON h.id = e.handler_id
                                  LEFT JOIN users r ON r.id = e.reporter_id LEFT JOIN users c ON c.id = e.closed_by WHERE e.id = $1`, [id]);
    if (!ev) throw new HttpError(404, 'Không tìm thấy báo cáo sự cố');
    const capa = await many(pool, `SELECT c.*, u.full_name AS owner_name FROM capa_actions c JOIN users u ON u.id = c.owner_id WHERE c.event_id = $1 ORDER BY c.created_at`, [id]);
    await withTx(pool, (tx) => audit(tx, 'system', actorOf(req), 'quality.event_viewed', 'adverse_event', id, {}));
    return { ...ev, capa };
  });

  app.patch('/api/quality/events/:id', { preHandler: guard(...QUALITY) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({
      severity: z.enum(['NC0', 'NC1', 'NC2', 'NC3']).optional(), handlerId: z.string().uuid().nullish(), status: z.enum(['dang_xu_ly', 'da_phan_tich']).optional(),
      rootCause: opt(4000), factors: z.array(z.string().max(60)).max(10).optional(), lessons: opt(4000), authorityReported: z.boolean().optional(),
    }).parse(req.body);
    return withTx(pool, (tx) => updateEvent(tx, actorOf(req), id, b));
  });

  app.post('/api/quality/events/:id/close', { preHandler: guard(...QUALITY) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ note: z.string().trim().min(3).max(1000) }).parse(req.body);
    await withTx(pool, (tx) => closeEvent(tx, { ...actorOf(req), role: req.user.role }, id, b.note));
    return { ok: true };
  });

  app.get('/api/quality/suggestions', { preHandler: guard(...QUALITY) }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    return eventSuggestions(pool, q.days);
  });

  /* ================= Hành động khắc phục ================= */

  app.get('/api/quality/capa', { preHandler: guard() }, async (req) => {
    const q = z.object({ mine: z.string().optional(), status: z.string().optional(), source: z.string().optional() }).parse(req.query);
    const mine = q.mine === '1' || !QUALITY_VIEW.includes(req.user.role);
    return many(pool, `${CAPA_SELECT}
       WHERE (NOT $1 OR c.owner_id = $2) AND ($3::text IS NULL OR c.status = $3) AND ($4::text IS NULL OR c.source = $4)
       ORDER BY c.status = 'mo' DESC, c.status = 'xong' DESC, c.due_date`, [mine, req.user.id, q.status ?? null, q.source ?? null]);
  });

  app.post('/api/quality/capa', { preHandler: guard(...QUALITY) }, async (req) => {
    const uuid = z.string().uuid().nullish();
    const b = z.object({
      eventId: uuid, complaintId: uuid, findingId: uuid, riskId: uuid, reviewId: uuid, callbackId: uuid, indicatorId: uuid, caseReviewId: uuid, drillId: uuid,
      source: z.enum(Object.keys(CAPA_SOURCE) as [string, ...string[]]).nullish(), sourceRef: opt(120), rootCause: opt(2000),
      kind: z.enum(['khac_phuc', 'phong_ngua']).default('khac_phuc'), description: z.string().trim().min(5).max(2000), ownerId: z.string().uuid(), dueDate: date,
    }).parse(req.body);
    return withTx(pool, (tx) => addCapa(tx, actorOf(req), b));
  });

  app.post('/api/quality/capa/:id/finish', { preHandler: guard() }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ status: z.enum(['xong', 'huy']), evidence: z.string().trim().min(3).max(2000) }).parse(req.body);
    await withTx(pool, (tx) => finishCapa(tx, { ...actorOf(req), role: req.user.role }, id, b));
    return { ok: true };
  });

  /** Kiểm tra hiệu quả: QLCL hoặc người khác người phụ trách xác nhận; chưa hiệu quả thì mở lại với hạn mới */
  app.post('/api/quality/capa/:id/verify', { preHandler: guard(...QUALITY) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ effective: z.boolean(), note: z.string().trim().min(3).max(2000), newDueDate: date.nullish() }).parse(req.body);
    await withTx(pool, (tx) => verifyCapa(tx, actorOf(req), id, b));
    return { ok: true };
  });

  /* ================= Khiếu nại ================= */

  app.get('/api/quality/complaints', { preHandler: guard(...QUALITY, 'calltaker', 'dispatcher') }, async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    return many(pool, `
      SELECT c.*, i.code AS incident_code, a.full_name AS assigned_name, (c.status IN ('moi', 'dang_xu_ly') AND c.due_at < now()) AS overdue
        FROM complaints c LEFT JOIN incidents i ON i.id = c.incident_id LEFT JOIN users a ON a.id = c.assigned_to
       WHERE ($1::text IS NULL OR c.status = $1) ORDER BY c.status = 'dong', c.due_at`, [q.status ?? null]);
  });

  app.post('/api/quality/complaints', { preHandler: guard(...COMPLAINT_INTAKE) }, async (req) => {
    const b = z.object({
      channel: z.enum(['dien_thoai', 'truc_tiep', 'email', 'mang_xa_hoi', 'khac']), complainant: opt(120), phone: opt(20),
      incidentCode: z.string().trim().max(30).nullish(), category: z.enum(['thai_do', 'thoi_gian', 'chuyen_mon', 'chi_phi', 'khac']),
      content: z.string().trim().min(5).max(4000), urgent: z.boolean().default(false),
    }).parse(req.body);
    let incidentId: string | null = null;
    if (b.incidentCode) {
      const i = await one(pool, 'SELECT id FROM incidents WHERE code = $1', [b.incidentCode.toUpperCase()]);
      if (!i) throw new HttpError(404, `Không có ca ${b.incidentCode}`);
      incidentId = i.id;
    }
    return withTx(pool, (tx) => createComplaint(tx, actorOf(req), { ...b, incidentId }));
  });

  app.patch('/api/quality/complaints/:id', { preHandler: guard(...QUALITY) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ assignedTo: z.string().uuid().nullish(), response: z.string().trim().min(3).max(4000).optional(), close: z.boolean().optional(), satisfied: z.boolean().nullish() }).parse(req.body);
    return withTx(pool, (tx) => updateComplaint(tx, actorOf(req), id, b));
  });

  /* ================= Khảo sát hài lòng ================= */

  app.get('/api/quality/surveys', { preHandler: guard(...QUALITY) }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(730).default(90) }).parse(req.query);
    const [stats, recent] = await Promise.all([
      one(pool, `SELECT count(*)::int AS sent, count(answered_at)::int AS answered, round(avg(overall), 2)::float AS overall,
                        round(avg(timeliness), 2)::float AS timeliness, round(avg(attitude), 2)::float AS attitude, round(avg(care), 2)::float AS care,
                        count(*) FILTER (WHERE overall >= 4)::int AS satisfied
                   FROM surveys WHERE created_at > now() - make_interval(days => $1)`, [q.days]),
      many(pool, `SELECT s.id, i.code AS incident_code, s.created_at, s.answered_at, s.overall, s.timeliness, s.attitude, s.care, s.comment
                    FROM surveys s JOIN incidents i ON i.id = s.incident_id WHERE s.answered_at IS NOT NULL ORDER BY s.answered_at DESC LIMIT 50`),
    ]);
    return { stats, recent };
  });

  /** Trang khảo sát công khai: không cần đăng nhập, chỉ cho biết mã ca và ngày */
  app.get('/api/public/survey/:token', async (req) => {
    const token = z.object({ token: z.string().min(10).max(40) }).parse(req.params).token;
    const s = await one(pool, `SELECT i.code, s.created_at, s.answered_at FROM surveys s JOIN incidents i ON i.id = s.incident_id WHERE s.token = $1`, [token]);
    if (!s) throw new HttpError(404, 'Đường dẫn khảo sát không đúng');
    return { incidentCode: s.code, date: s.created_at, answered: !!s.answered_at };
  });

  app.post('/api/public/survey/:token', async (req) => {
    const token = z.object({ token: z.string().min(10).max(40) }).parse(req.params).token;
    const score = z.number().int().min(1).max(5);
    const b = z.object({ overall: score, timeliness: score.nullish(), attitude: score.nullish(), care: score.nullish(), comment: opt(2000) }).parse(req.body);
    const r = await withTx(pool, (tx) => answerSurvey(tx, token, b));
    return { ok: true, followUp: r.low };
  });

  /* ================= Tin nhắn chờ gửi ================= */

  app.get('/api/messages/outbox', { preHandler: guard('admin', 'qa', 'supervisor') }, async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    return many(pool, `SELECT * FROM message_outbox WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 300`, [q.status ?? null]);
  });

  app.post('/api/messages/outbox/:id/sent', { preHandler: guard('admin', 'qa', 'supervisor') }, async (req) => {
    const id = z.object({ id: z.coerce.number().int() }).parse(req.params).id;
    const b = z.object({ ok: z.boolean().default(true), error: opt(300) }).parse(req.body ?? {});
    await pool.query(`UPDATE message_outbox SET status = $2, sent_at = now(), error = $3 WHERE id = $1`, [id, b.ok ? 'da_gui' : 'loi', b.error ?? null]);
    return { ok: true };
  });
}
