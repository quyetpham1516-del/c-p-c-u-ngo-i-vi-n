import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { toCsv } from '../finance.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import { createWalkIn, fieldsFor, missingFields, prehospitalSnapshot, REGISTRIES, saveRegistryCase } from '../registry.js';

/** Nhân viên trung tâm xem và bổ sung biểu mẫu (bác sĩ trên kíp, điều phối, trưởng ca, QLCL) */
const INTERNAL: Role[] = ['crew', 'dispatcher', 'supervisor', 'qa', 'admin', 'director'];
/** Bật, tắt biểu mẫu và chọn khoảng thời gian lấy số liệu */
const SETTINGS: Role[] = ['admin', 'director'];
/** Xuất số liệu nghiên cứu (không kèm họ tên, số định danh) */
const EXPORT: Role[] = ['supervisor', 'qa', 'admin', 'director'];
/** Xem bảng kê người nhập, số ca để thanh toán; đánh dấu đã trả */
const PAY_VIEW: Role[] = ['admin', 'director', 'accountant', 'qa'];
const PAY_MARK: Role[] = ['admin', 'director', 'accountant'];
/** Nhân viên trung tâm được tạo ca tự đến thay bệnh viện (chọn bệnh viện) */
const WALK_IN_INTERNAL: Role[] = ['supervisor', 'qa', 'admin', 'director'];
const SOURCE = z.enum(['xe_115', 'tu_den']);
const CODE = z.enum(['utstein', 'patos', 'stroke']);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Biểu mẫu nghiên cứu (Utstein, PATOS chấn thương, đột quỵ) và cổng bệnh viện nhận bệnh: tài khoản bệnh viện tra cứu phiếu
 * chuyển tới bệnh viện mình và điền phần trong viện.
 */
export function registerRegistry(app: FastifyInstance, { pool }: Ctx) {
  const hospitalOf = async (req: FastifyRequest) =>
    req.user.role === 'hospital' ? (await one(pool, 'SELECT hospital_id FROM users WHERE id = $1', [req.user.id]))?.hospital_id ?? -1 : null;

  app.get('/api/registry/defs', { preHandler: guard(...INTERNAL, 'hospital', 'accountant') }, async () => {
    const on = new Set((await many(pool, `SELECT code FROM registry_settings WHERE enabled AND (start_on IS NULL OR start_on <= vn_today())
                                             AND (end_on IS NULL OR end_on >= vn_today())`)).map((r) => r.code));
    return Object.entries(REGISTRIES).map(([code, r]) => ({ code, ...r, collecting: on.has(code) }));
  });

  app.get('/api/registry/settings', { preHandler: guard(...INTERNAL) }, async () =>
    many(pool, `SELECT s.*, u.full_name AS updated_by_name,
                       (SELECT count(*)::int FROM registry_cases c WHERE c.registry = s.code) AS cases,
                       (SELECT count(*)::int FROM registry_cases c WHERE c.registry = s.code AND c.status <> 'du') AS open_cases,
                       (s.enabled AND (s.start_on IS NULL OR s.start_on <= vn_today()) AND (s.end_on IS NULL OR s.end_on >= vn_today())) AS collecting
                  FROM registry_settings s LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.code`));

  app.put('/api/registry/settings/:code', { preHandler: guard(...SETTINGS) }, async (req) => {
    const code = z.object({ code: CODE }).parse(req.params).code;
    const money = z.number().int().min(0).max(100_000_000).nullish();
    const b = z.object({ enabled: z.boolean(), startOn: date.nullish(), endOn: date.nullish(), note: z.string().max(500).nullish(),
      rateWalkIn: money, rateEms: money }).parse(req.body);
    if (b.startOn && b.endOn && b.endOn < b.startOn) throw new HttpError(422, 'Ngày kết thúc trước ngày bắt đầu');
    return withTx(pool, async (tx) => {
      // Đơn giá không gửi lên thì giữ nguyên
      const row = await one(tx, `UPDATE registry_settings SET enabled = $2, start_on = $3, end_on = $4, note = $5, updated_by = $6, updated_at = now(),
                                        rate_walk_in = CASE WHEN $7 THEN $8::numeric ELSE rate_walk_in END, rate_ems = CASE WHEN $9 THEN $10::numeric ELSE rate_ems END
                                  WHERE code = $1 RETURNING *`, [code, b.enabled, b.startOn ?? null, b.endOn ?? null, b.note ?? null, req.user.id,
        b.rateWalkIn !== undefined, b.rateWalkIn ?? null, b.rateEms !== undefined, b.rateEms ?? null]);
      await audit(tx, 'system', actorOf(req), 'registry.settings', 'registry', code, b);
      return row;
    });
  });

  const LIST = `
    SELECT c.id, c.registry, c.source, c.transfer_id, c.incident_id, c.hospital_id, h.name AS hospital_name, c.status, c.completed_at, c.updated_at, c.created_at,
           c.hospital_record_no, c.paid_at, t.transfer_number, t.signed_at, i.code AS incident_code,
           coalesce(c.prehospital->>'age', c.data->>'age') AS age, coalesce(c.prehospital->>'sex', c.data->>'sex') AS sex,
           coalesce(c.prehospital->>'diagnosis', c.data->>'diagnosis') AS diagnosis, u.full_name AS updated_by_name,
           cb.full_name AS created_by_name, fb.full_name AS completed_by_name
      FROM registry_cases c LEFT JOIN transfers t ON t.id = c.transfer_id LEFT JOIN incidents i ON i.id = c.incident_id
      LEFT JOIN hospitals h ON h.id = c.hospital_id LEFT JOIN users u ON u.id = c.updated_by
      LEFT JOIN users cb ON cb.id = c.created_by LEFT JOIN users fb ON fb.id = c.completed_by`;

  app.get('/api/registry/cases', { preHandler: guard(...INTERNAL, 'hospital') }, async (req) => {
    const q = z.object({ registry: CODE.optional(), status: z.enum(['cho_bo_sung', 'dang_bo_sung', 'du', 'chua_du']).optional(),
      hospitalId: z.coerce.number().int().optional(), from: date.optional(), to: date.optional(), transferId: z.string().uuid().optional(),
      source: SOURCE.optional() }).parse(req.query);
    const mine = await hospitalOf(req);
    return many(pool, `${LIST}
       WHERE ($1::text IS NULL OR c.registry = $1)
         AND ($2::text IS NULL OR (CASE WHEN $2 = 'chua_du' THEN c.status <> 'du' ELSE c.status = $2 END))
         AND ($3::int IS NULL OR c.hospital_id = $3) AND ($4::date IS NULL OR c.created_at >= $4::date)
         AND ($5::date IS NULL OR c.created_at < $5::date + 1) AND ($6::uuid IS NULL OR c.transfer_id = $6)
         AND ($7::text IS NULL OR c.source = $7)
       ORDER BY c.created_at DESC LIMIT 500`,
    [q.registry ?? null, q.status ?? null, mine ?? q.hospitalId ?? null, q.from ?? null, q.to ?? null, q.transferId ?? null, q.source ?? null]);
  });

  async function loadCase(req: FastifyRequest, id: string) {
    const c = await one(pool, `${LIST.replace('SELECT c.id,', 'SELECT c.prehospital, c.data, c.id,')} WHERE c.id = $1`, [id]);
    if (!c) throw new HttpError(404, 'Không tìm thấy ca trong biểu mẫu');
    const mine = await hospitalOf(req);
    if (mine !== null && c.hospital_id !== mine) throw new HttpError(403, 'Ca này không chuyển tới bệnh viện của bạn');
    return { ...c, missing: missingFields(c.registry, c.data ?? {}, c.source) };
  }

  app.get('/api/registry/cases/:id', { preHandler: guard(...INTERNAL, 'hospital') }, async (req) =>
    loadCase(req, z.object({ id: z.string().uuid() }).parse(req.params).id));

  app.put('/api/registry/cases/:id', { preHandler: guard(...INTERNAL, 'hospital') }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const patch = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).parse(req.body);
    await withTx(pool, (tx) => saveRegistryCase(tx, actorOf(req), req.user, id, patch));
    return loadCase(req, id);
  });

  /** Thêm ca vào biểu mẫu bằng tay (ca không tự vào vì lúc ký biểu mẫu đang tắt, hoặc tiêu chí không bắt được) */
  app.post('/api/registry/cases', { preHandler: guard('dispatcher', 'supervisor', 'qa', 'admin', 'director') }, async (req) => {
    const b = z.object({ registry: CODE, transferId: z.string().uuid().optional(), transferNumber: z.string().trim().min(1).max(40).optional() })
      .refine((x) => x.transferId || x.transferNumber, 'Chọn phiếu').parse(req.body);
    return withTx(pool, async (tx) => {
      const t = await one(tx, `SELECT t.id, t.transfer_number, t.incident_id, t.signed_at, t.status, t.epcr, t.hospital_id, i.code AS incident_code
                                 FROM transfers t LEFT JOIN incidents i ON i.id = t.incident_id
                                WHERE ($1::uuid IS NOT NULL AND t.id = $1) OR ($1::uuid IS NULL AND t.transfer_number = $2)`, [b.transferId ?? null, b.transferNumber ?? null]);
      if (!t) throw new HttpError(404, 'Không tìm thấy phiếu');
      if (t.status !== 'signed') throw new HttpError(409, 'Phiếu chưa ký');
      const row = await one(tx, `INSERT INTO registry_cases(registry, transfer_id, incident_id, hospital_id, prehospital) VALUES ($1,$2,$3,$4,$5)
                                 ON CONFLICT (registry, transfer_id) DO NOTHING RETURNING id`,
      [b.registry, t.id, t.incident_id, t.hospital_id, prehospitalSnapshot(b.registry, t.epcr ?? {}, t)]);
      if (!row) throw new HttpError(409, 'Phiếu này đã có trong biểu mẫu');
      await audit(tx, 'system', actorOf(req), 'registry.added', 'registry_case', row.id, { registry: b.registry, transferId: t.id });
      return row;
    });
  });

  /**
   * Ca tự đến bệnh viện (người dân tự đưa tới khoa cấp cứu): tài khoản bệnh viện tạo cho bệnh viện mình; QLCL, trưởng ca,
   * admin tạo thay thì chọn bệnh viện.
   */
  app.post('/api/registry/walk-in', { preHandler: guard(...WALK_IN_INTERNAL, 'hospital') }, async (req) => {
    const b = z.object({ registry: CODE, hospitalRecordNo: z.string().trim().min(1).max(40), hospitalId: z.number().int().optional(),
      data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}) }).parse(req.body);
    const mine = await hospitalOf(req);
    const hospitalId = mine ?? b.hospitalId;
    if (!hospitalId || hospitalId < 0) throw new HttpError(400, 'Chọn bệnh viện');
    if (!(await one(pool, 'SELECT 1 FROM hospitals WHERE id = $1', [hospitalId]))) throw new HttpError(400, 'Không có bệnh viện này');
    const row = await withTx(pool, (tx) => createWalkIn(tx, actorOf(req), req.user, { registry: b.registry, hospitalId, hospitalRecordNo: b.hospitalRecordNo, data: b.data }));
    return loadCase(req, row.id);
  });

  /* ---------- Thống kê người nhập và thanh toán ---------- */

  /**
   * Người được tính cho một ca: ca tự đến là người tạo, ca xe 115 là người điền làm biểu mẫu đủ. Chỉ ca đủ mới tính tiền,
   * và chỉ người nhập là tài khoản bệnh viện (nhân viên trung tâm không tính tiền).
   */
  const CONTRIB = `
    FROM registry_cases c CROSS JOIN LATERAL (SELECT CASE WHEN c.source = 'tu_den' THEN c.created_by ELSE c.completed_by END AS uid) x
    LEFT JOIN users u ON u.id = x.uid LEFT JOIN hospitals h ON h.id = coalesce(u.hospital_id, c.hospital_id)
    JOIN registry_settings s ON s.code = c.registry
   WHERE ($1::date IS NULL OR coalesce(c.completed_at, c.created_at) >= $1::date) AND ($2::date IS NULL OR coalesce(c.completed_at, c.created_at) < $2::date + 1)
     AND ($3::text IS NULL OR c.registry = $3) AND ($4::int IS NULL OR c.hospital_id = $4) AND ($5::text IS NULL OR c.source = $5)`;
  const RATE = `(CASE WHEN c.source = 'tu_den' THEN s.rate_walk_in ELSE s.rate_ems END)`;
  const contribQuery = z.object({ from: date.optional(), to: date.optional(), registry: CODE.optional(), hospitalId: z.coerce.number().int().optional(),
    source: SOURCE.optional(), format: z.enum(['json', 'csv']).default('json') });

  app.get('/api/registry/contributors', { preHandler: guard(...PAY_VIEW, 'hospital') }, async (req, reply) => {
    const q = contribQuery.parse(req.query);
    const mine = await hospitalOf(req);
    const rows = await many(pool, `
      SELECT h.id AS hospital_id, h.name AS hospital_name, x.uid AS user_id, u.full_name, u.role, c.registry, c.source,
             count(*)::int AS total, count(*) FILTER (WHERE c.status = 'du')::int AS complete,
             count(*) FILTER (WHERE c.status = 'du' AND c.paid_at IS NULL)::int AS unpaid,
             count(*) FILTER (WHERE c.paid_at IS NOT NULL)::int AS paid, coalesce(sum(c.paid_amount), 0)::float AS paid_amount,
             max(${RATE})::float AS rate,
             (CASE WHEN u.role = 'hospital' AND max(${RATE}) IS NOT NULL THEN coalesce(sum(${RATE}) FILTER (WHERE c.status = 'du' AND c.paid_at IS NULL), 0) END)::float AS due
      ${CONTRIB}
       GROUP BY h.id, h.name, x.uid, u.full_name, u.role, c.registry, c.source
       ORDER BY h.name NULLS LAST, u.full_name NULLS LAST, c.registry, c.source`,
    [q.from ?? null, q.to ?? null, q.registry ?? null, mine ?? q.hospitalId ?? null, q.source ?? null]);
    if (q.format === 'json') return rows;
    await audit(pool, 'system', actorOf(req), 'registry.contributors_exported', 'registry', q.registry ?? 'all', { rows: rows.length, from: q.from, to: q.to });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="bang-ke-nhap-lieu-${q.from ?? 'all'}-${q.to ?? 'all'}.csv"`);
    return toCsv([
      ['Bệnh viện', 'Người nhập', 'Biểu mẫu', 'Nguồn ca', 'Số ca', 'Số ca đủ', 'Đủ, chưa trả', 'Đã trả', 'Đã trả (đồng)', 'Đơn giá (đồng)', 'Còn phải trả (đồng)'],
      ...rows.map((r) => [r.hospital_name ?? '', r.full_name ?? 'Chưa có', REGISTRIES[r.registry].name, r.source === 'tu_den' ? 'Tự đến' : 'Xe 115',
        r.total, r.complete, r.unpaid, r.paid, r.paid_amount, r.rate ?? '', r.due ?? '']),
    ]);
  });

  /** Đánh dấu đã trả: mọi ca đủ, chưa trả, người nhập là tài khoản bệnh viện, biểu mẫu đã đặt đơn giá, trong bộ lọc */
  app.post('/api/registry/payouts', { preHandler: guard(...PAY_MARK) }, async (req) => {
    const b = z.object({ from: date.optional(), to: date.optional(), registry: CODE.optional(), hospitalId: z.number().int().optional(),
      source: SOURCE.optional(), userId: z.string().uuid().optional() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const rows = await many(tx, `
        UPDATE registry_cases rc SET paid_at = now(), paid_by = $7, paid_amount = p.rate
          FROM (SELECT c.id, ${RATE} AS rate ${CONTRIB}
                   AND c.status = 'du' AND c.paid_at IS NULL AND u.role = 'hospital' AND ${RATE} IS NOT NULL AND ($6::uuid IS NULL OR x.uid = $6)) p
         WHERE rc.id = p.id RETURNING rc.id, rc.paid_amount`,
      [b.from ?? null, b.to ?? null, b.registry ?? null, b.hospitalId ?? null, b.source ?? null, b.userId ?? null, req.user.id]);
      const total = rows.reduce((n, r) => n + Number(r.paid_amount), 0);
      await audit(tx, 'system', actorOf(req), 'registry.paid', 'registry', b.registry ?? 'all', { ...b, cases: rows.length, total });
      return { cases: rows.length, total };
    });
  });

  /** Xuất CSV cho nghiên cứu: phần trước viện + trong viện, không họ tên, không số định danh */
  app.get('/api/registry/export', { preHandler: guard(...EXPORT) }, async (req, reply) => {
    const q = z.object({ registry: CODE, from: date.optional(), to: date.optional() }).parse(req.query);
    const rows = await many(pool, `SELECT c.*, t.transfer_number, h.name AS hospital_name FROM registry_cases c LEFT JOIN transfers t ON t.id = c.transfer_id
                                    LEFT JOIN hospitals h ON h.id = c.hospital_id
                                   WHERE c.registry = $1 AND ($2::date IS NULL OR c.created_at >= $2::date) AND ($3::date IS NULL OR c.created_at < $3::date + 1)
                                   ORDER BY c.created_at`, [q.registry, q.from ?? null, q.to ?? null]);
    const fields = fieldsFor(q.registry, 'tu_den');
    const pre = ['age', 'sex', 'chiefComplaint', 'diagnosis', 'icd10', 'hospital', 'handoverAt'];
    const flat = (v: unknown) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    await audit(pool, 'system', actorOf(req), 'registry.exported', 'registry', q.registry, { rows: rows.length, from: q.from, to: q.to });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${q.registry}-${q.from ?? 'all'}-${q.to ?? 'all'}.csv"`);
    return toCsv([
      ['Mã ca nghiên cứu', 'Nguồn ca', 'Số phiếu', 'Bệnh viện', 'Ngày vào biểu mẫu', 'Trạng thái', ...pre, 'Phần trước viện (đầy đủ)', ...fields.map((f) => f.label)],
      ...rows.map((r) => [r.id, r.source === 'tu_den' ? 'Tự đến' : 'Xe 115', r.transfer_number ?? '', r.hospital_name, String(r.created_at), r.status,
        ...pre.map((k) => flat(r.prehospital?.[k] ?? r.data?.[k])), r.source === 'tu_den' ? '' : flat(r.prehospital), ...fields.map((f) => flat(r.data?.[f.key]))]),
    ]);
  });

  /* ---------- Cổng bệnh viện ---------- */

  app.get('/api/hospital/me', { preHandler: guard('hospital') }, async (req) =>
    one(pool, `SELECT h.id, h.name, h.address, h.phone FROM users u JOIN hospitals h ON h.id = u.hospital_id WHERE u.id = $1`, [req.user.id]));

  /** Phiếu đã ký chuyển tới bệnh viện mình, kèm biểu mẫu cần bổ sung */
  app.get('/api/hospital/transfers', { preHandler: guard('hospital') }, async (req) => {
    const q = z.object({ q: z.string().trim().max(60).optional(), days: z.coerce.number().int().min(1).max(366).default(30) }).parse(req.query);
    const mine = await hospitalOf(req);
    return many(pool, `
      SELECT t.id, t.transfer_number, t.signed_at, i.code AS incident_code, p.full_name, p.birth_year, p.sex,
             t.epcr->'diagnosis'->>'text' AS diagnosis, t.epcr->'disposition'->>'handoverAt' AS handover_at,
             coalesce((SELECT json_agg(json_build_object('id', c.id, 'registry', c.registry, 'status', c.status) ORDER BY c.registry)
                         FROM registry_cases c WHERE c.transfer_id = t.id), '[]') AS registries
        FROM transfers t LEFT JOIN incidents i ON i.id = t.incident_id LEFT JOIN patients p ON p.id = t.patient_id
       WHERE t.status = 'signed' AND t.hospital_id = $1 AND t.signed_at > now() - make_interval(days => $2)
         AND ($3::text IS NULL OR t.transfer_number ILIKE '%' || $3 || '%' OR p.full_name ILIKE '%' || $3 || '%' OR i.code ILIKE '%' || $3 || '%')
       ORDER BY t.signed_at DESC LIMIT 200`, [mine, q.days, q.q || null]);
  });
}
