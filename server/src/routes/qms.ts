import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import {
  addFinding, advanceAudit, AUDIT_STATUS, AUTO_INDICATORS, CAPA_SELECT, CAPA_SOURCE, CAPA_STATUS, CAPA_VERIFY_DAYS, computeIndicators, createCallbackRound,
  createReview, evaluateSupplier, FINDING_KIND, indicatorBoard, listRisks, recordAudit, recordCallback, RETENTION_COUNT, retentionList, reviewInputs,
  reviewRisk, RISK_LEVEL, SAMPLE_PCT, saveAudit, saveRisk, signReview, SUPPLIER_CATEGORY, SUPPLIER_CRITERIA, updateReview,
} from '../qms.js';

const QM_VIEW: Role[] = ['qa', 'supervisor', 'admin', 'director', 'ipc'];
const QM: Role[] = ['qa', 'supervisor', 'admin', 'director'];
const BOARD: Role[] = ['director', 'admin'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const opt = (n = 2000) => z.string().trim().max(n).nullish();
const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
const level = z.number().int().min(1).max(5);
const vnPeriod = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);

export function registerQms(app: FastifyInstance, { pool }: Ctx) {
  app.get('/api/qms/meta', { preHandler: guard() }, async () => ({
    riskLevels: RISK_LEVEL, findingKinds: FINDING_KIND, auditStatus: AUDIT_STATUS, capaSources: CAPA_SOURCE, capaStatus: CAPA_STATUS, capaVerifyDays: CAPA_VERIFY_DAYS,
    supplierCategories: SUPPLIER_CATEGORY, supplierCriteria: SUPPLIER_CRITERIA, samplePct: SAMPLE_PCT,
    autoIndicators: Object.fromEntries(Object.entries(AUTO_INDICATORS).map(([k, v]) => [k, v.label])),
  }));

  /** Tổng quan: việc cần làm của hệ thống chất lượng */
  app.get('/api/qms/summary', { preHandler: guard(...QM_VIEW) }, async () => {
    const prev = new Date(Date.now() + 7 * 3600_000);
    prev.setUTCDate(1); prev.setUTCMonth(prev.getUTCMonth() - 1);
    const last = prev.toISOString().slice(0, 7);
    const [risks, capa, audits, callbacks, suppliers, board] = await Promise.all([
      listRisks(pool),
      one(pool, `SELECT count(*) FILTER (WHERE status = 'mo')::int AS open, count(*) FILTER (WHERE status = 'mo' AND due_date < vn_today())::int AS overdue,
                        count(*) FILTER (WHERE status = 'xong')::int AS verify, count(*) FILTER (WHERE status = 'xong' AND verify_due < vn_today())::int AS verify_overdue FROM capa_actions`),
      one(pool, `SELECT count(*) FILTER (WHERE status <> 'huy')::int AS planned, count(*) FILTER (WHERE status IN ('da_bao_cao', 'dong'))::int AS done,
                        count(*) FILTER (WHERE status = 'ke_hoach' AND planned_month < extract(month FROM vn_today()))::int AS late
                   FROM qm_audits WHERE year = extract(year FROM vn_today())`),
      one(pool, `SELECT count(*)::int AS pending FROM qm_callbacks WHERE status = 'cho_goi'`),
      one(pool, `SELECT count(*) FILTER (WHERE status = 'theo_doi')::int AS watch, count(*) FILTER (WHERE status <> 'ngung' AND contract_until < vn_today() + 30)::int AS expiring FROM qm_suppliers`),
      indicatorBoard(pool, last, 1),
    ]);
    return {
      period: last,
      risks: { high: risks.filter((r) => r.status === 'mo' && r.level === 'cao').length, needsAction: risks.filter((r) => r.needs_action).length, reviewOverdue: risks.filter((r) => r.review_overdue).length },
      capa, audits, callbacks, suppliers,
      indicators: { missed: board.rows.filter((r) => r.values[last]?.status === 'khong_dat').map((r) => ({ code: r.code, name: r.name, value: r.values[last]?.value, target: r.target, unit: r.unit })) },
    };
  });

  /* ================= Rủi ro ================= */

  const RiskBody = z.object({
    area: z.string().trim().min(2).max(120), hazard: z.string().trim().min(5).max(1000), cause: opt(1000), consequence: opt(1000),
    likelihood: level, impact: level, controls: opt(2000), ownerId: z.string().uuid().nullish(), reviewMonths: z.number().int().min(1).max(24).default(6),
  });

  app.get('/api/qms/risks', { preHandler: guard(...QM_VIEW) }, async () => listRisks(pool));
  app.post('/api/qms/risks', { preHandler: guard(...QM) }, async (req) => withTx(pool, (tx) => saveRisk(tx, actorOf(req), null, RiskBody.parse(req.body))));
  app.put('/api/qms/risks/:id', { preHandler: guard(...QM) }, async (req) => withTx(pool, (tx) => saveRisk(tx, actorOf(req), idParam(req.params), RiskBody.parse(req.body))));
  app.post('/api/qms/risks/:id/review', { preHandler: guard(...QM) }, async (req) => {
    const b = z.object({ likelihood: level, impact: level, note: z.string().trim().min(3).max(1000), close: z.boolean().optional() }).parse(req.body);
    return withTx(pool, (tx) => reviewRisk(tx, actorOf(req), idParam(req.params), b));
  });
  app.get('/api/qms/risks/:id/history', { preHandler: guard(...QM_VIEW) }, async (req) =>
    many(pool, `SELECT h.*, h.likelihood * h.impact AS score, u.full_name AS reviewed_by_name FROM qm_risk_reviews h LEFT JOIN users u ON u.id = h.reviewed_by
                 WHERE h.risk_id = $1 ORDER BY h.id DESC`, [idParam(req.params)]));

  /* ================= Đánh giá nội bộ ================= */

  const AuditBody = z.object({
    year: z.number().int().min(2020).max(2100), title: z.string().trim().min(3).max(200), scope: opt(1000), auditedUnit: z.string().trim().min(2).max(120),
    auditedRoles: z.array(z.string().max(30)).max(12).default([]), auditedStation: z.string().max(20).nullish(), plannedMonth: z.number().int().min(1).max(12),
    leadId: z.string().uuid().nullish(), auditorIds: z.array(z.string().uuid()).max(10).default([]),
    checklist: z.array(z.object({ q: z.string().max(500), ref: opt(120) })).max(100).default([]),
  });

  app.get('/api/qms/audits', { preHandler: guard() }, async (req) => {
    const q = z.object({ year: z.coerce.number().int().optional() }).parse(req.query);
    const all = QM_VIEW.includes(req.user.role);
    return many(pool, `
      SELECT a.id, a.code, a.year, a.title, a.audited_unit, a.planned_month, a.performed_on, a.status, a.auditor_ids, l.full_name AS lead_name,
             (SELECT string_agg(u.full_name, ', ') FROM users u WHERE u.id = ANY(a.auditor_ids)) AS auditors,
             jsonb_array_length(a.checklist) AS questions,
             (SELECT count(*)::int FROM qm_findings f WHERE f.audit_id = a.id AND f.kind IN ('nc_lon', 'nc_nho')) AS nc,
             (SELECT count(*)::int FROM qm_findings f WHERE f.audit_id = a.id) AS findings
        FROM qm_audits a LEFT JOIN users l ON l.id = a.lead_id
       WHERE ($1::int IS NULL OR a.year = $1) AND ($2 OR $3 = ANY(a.auditor_ids))
       ORDER BY a.year DESC, a.planned_month, a.code`, [q.year ?? null, all, req.user.id]);
  });

  app.get('/api/qms/audits/:id', { preHandler: guard() }, async (req) => {
    const id = idParam(req.params);
    const a = await one(pool, `SELECT a.*, l.full_name AS lead_name, (SELECT jsonb_agg(jsonb_build_object('id', u.id, 'name', u.full_name, 'role', u.role)) FROM users u WHERE u.id = ANY(a.auditor_ids)) AS team
                                 FROM qm_audits a LEFT JOIN users l ON l.id = a.lead_id WHERE a.id = $1`, [id]);
    if (!a) throw new HttpError(404, 'Không tìm thấy cuộc đánh giá');
    if (!QM_VIEW.includes(req.user.role) && !a.auditor_ids.includes(req.user.id)) throw new HttpError(403, 'Không có quyền xem');
    const findings = await many(pool, `SELECT f.*, (SELECT jsonb_agg(jsonb_build_object('id', c.id, 'description', c.description, 'status', c.status, 'owner', u.full_name, 'due_date', c.due_date))
                                                     FROM capa_actions c JOIN users u ON u.id = c.owner_id WHERE c.finding_id = f.id) AS capa
                                         FROM qm_findings f WHERE f.audit_id = $1 ORDER BY f.code`, [id]);
    return { ...a, findings };
  });

  app.post('/api/qms/audits', { preHandler: guard(...QM) }, async (req) => withTx(pool, (tx) => saveAudit(tx, actorOf(req), null, AuditBody.parse(req.body))));
  app.put('/api/qms/audits/:id', { preHandler: guard(...QM) }, async (req) => withTx(pool, (tx) => saveAudit(tx, actorOf(req), idParam(req.params), AuditBody.parse(req.body))));

  app.post('/api/qms/audits/:id/record', { preHandler: guard() }, async (req) => {
    const b = z.object({
      results: z.array(z.object({ result: z.enum(['dat', 'khong_dat', 'khong_ap_dung']).nullable(), note: opt(1000) })).max(100),
      performedOn: date, summary: opt(4000),
    }).parse(req.body);
    return withTx(pool, (tx) => recordAudit(tx, { ...actorOf(req), role: req.user.role }, idParam(req.params), b));
  });

  app.post('/api/qms/audits/:id/findings', { preHandler: guard() }, async (req) => {
    const b = z.object({ kind: z.enum(['nc_lon', 'nc_nho', 'luu_y', 'diem_manh']), reference: opt(200), description: z.string().trim().min(5).max(2000), evidence: opt(2000) }).parse(req.body);
    return withTx(pool, (tx) => addFinding(tx, { ...actorOf(req), role: req.user.role }, idParam(req.params), b));
  });

  app.post('/api/qms/audits/:id/advance', { preHandler: guard() }, async (req) => {
    const b = z.object({ to: z.enum(['da_bao_cao', 'dong', 'huy']) }).parse(req.body);
    if (b.to !== 'da_bao_cao' && !QM.includes(req.user.role)) throw new HttpError(403, 'QLCL đóng hoặc hủy cuộc đánh giá');
    await withTx(pool, (tx) => advanceAudit(tx, { ...actorOf(req), role: req.user.role }, idParam(req.params), b.to));
    return { ok: true };
  });

  /* ================= Bộ chỉ số ================= */

  const IndicatorBody = z.object({
    code: z.string().trim().min(2).max(20), name: z.string().trim().min(3).max(200), definition: opt(2000), formula: opt(500), unit: z.string().trim().min(1).max(20),
    direction: z.enum(['cao_tot', 'thap_tot']), target: z.number(), warn: z.number().nullish(), autoKey: z.string().max(40).nullish(),
    ownerId: z.string().uuid().nullish(), active: z.boolean().default(true),
  }).refine((b) => !b.autoKey || AUTO_INDICATORS[b.autoKey], 'Cách tính tự động không hợp lệ');

  app.get('/api/qms/indicators', { preHandler: guard(...QM_VIEW) }, async (req) => {
    const q = z.object({ period: period.optional(), months: z.coerce.number().int().min(1).max(24).default(12) }).parse(req.query);
    return indicatorBoard(pool, q.period ?? vnPeriod(), q.months);
  });

  app.post('/api/qms/indicators/compute', { preHandler: guard(...QM) }, async (req) => {
    const b = z.object({ period }).parse(req.body);
    await withTx(pool, async (tx) => {
      await computeIndicators(tx, b.period);
      await audit(tx, 'system', actorOf(req), 'qm.indicators_computed', 'qm_indicator', b.period, {});
    });
    return { ok: true };
  });

  const saveIndicator = async (req: any, id: string | null) => {
    const b = IndicatorBody.parse(req.body);
    return withTx(pool, async (tx) => {
      const args = [b.code, b.name, b.definition ?? null, b.formula ?? null, b.unit, b.direction, b.target, b.warn ?? null, b.autoKey ?? null, b.ownerId ?? null, b.active];
      const r = id
        ? await one(tx, `UPDATE qm_indicators SET code = $2, name = $3, definition = $4, formula = $5, unit = $6, direction = $7, target = $8, warn = $9, auto_key = $10,
                                                  owner_id = $11, active = $12 WHERE id = $1 RETURNING *`, [id, ...args])
        : await one(tx, `INSERT INTO qm_indicators(code, name, definition, formula, unit, direction, target, warn, auto_key, owner_id, active, ordinal)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, (SELECT coalesce(max(ordinal), 0) + 1 FROM qm_indicators)) RETURNING *`, args);
      if (!r) throw new HttpError(404, 'Không tìm thấy chỉ số');
      await audit(tx, 'system', actorOf(req), id ? 'qm.indicator_updated' : 'qm.indicator_created', 'qm_indicator', r.id, { code: b.code, target: b.target });
      return r;
    });
  };
  app.post('/api/qms/indicators', { preHandler: guard(...QM) }, async (req) => saveIndicator(req, null));
  app.put('/api/qms/indicators/:id', { preHandler: guard(...QM) }, async (req) => saveIndicator(req, idParam(req.params)));

  /** Nhập tay số liệu tháng cho chỉ số không tính tự động; chỉ số tự động chỉ ghi được ghi chú */
  app.put('/api/qms/indicators/:id/values/:period', { preHandler: guard(...QM) }, async (req) => {
    const p = z.object({ id: z.string().uuid(), period }).parse(req.params);
    const b = z.object({ numerator: z.number().nullish(), denominator: z.number().positive().nullish(), value: z.number().nullish(), note: opt(1000) }).parse(req.body);
    return withTx(pool, async (tx) => {
      const ind = await one(tx, 'SELECT * FROM qm_indicators WHERE id = $1', [p.id]);
      if (!ind) throw new HttpError(404, 'Không tìm thấy chỉ số');
      if (ind.auto_key) {
        const r = await one(tx, `UPDATE qm_indicator_values SET note = $3, entered_by = $4, updated_at = now() WHERE indicator_id = $1 AND period = $2 RETURNING *`, [p.id, p.period, b.note ?? null, req.user.id]);
        if (!r) throw new HttpError(409, 'Chỉ số tính tự động: bấm "Tính lại" cho tháng này trước');
        return r;
      }
      const scale = ind.unit === '%' ? 100 : 1;
      const value = b.value ?? (b.numerator != null && b.denominator ? Math.round((b.numerator / b.denominator) * scale * 10) / 10 : null);
      if (value == null) throw new HttpError(400, 'Nhập giá trị, hoặc tử số và mẫu số');
      const r = await one(tx, `INSERT INTO qm_indicator_values(indicator_id, period, value, numerator, denominator, note, auto, entered_by) VALUES ($1,$2,$3,$4,$5,$6,false,$7)
                               ON CONFLICT (indicator_id, period) DO UPDATE SET value = EXCLUDED.value, numerator = EXCLUDED.numerator, denominator = EXCLUDED.denominator,
                                                                               note = EXCLUDED.note, entered_by = EXCLUDED.entered_by, updated_at = now() RETURNING *`,
      [p.id, p.period, value, b.numerator ?? null, b.denominator ?? null, b.note ?? null, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'qm.indicator_value', 'qm_indicator', p.id, { period: p.period, value });
      return r;
    });
  });

  /* ================= Giám sát gọi lại ================= */

  app.get('/api/qms/callback-rounds', { preHandler: guard(...QM_VIEW) }, async () =>
    many(pool, `SELECT r.*, (SELECT count(*)::int FROM qm_callbacks c WHERE c.round_id = r.id) AS sample,
                       (SELECT count(*)::int FROM qm_callbacks c WHERE c.round_id = r.id AND c.status <> 'cho_goi') AS done,
                       (SELECT count(*)::int FROM qm_callbacks c WHERE c.round_id = r.id AND (c.confirmed IS FALSE OR c.attitude <= 2 OR jsonb_array_length(c.checks->'flags') > 0)) AS issues
                  FROM qm_callback_rounds r ORDER BY r.created_at DESC`));

  app.post('/api/qms/callback-rounds', { preHandler: guard(...QM) }, async (req) => {
    const b = z.object({ from: date, to: date, pct: z.number().min(SAMPLE_PCT, `Rút tối thiểu ${SAMPLE_PCT}% số ca`).max(100).default(SAMPLE_PCT) }).parse(req.body);
    return withTx(pool, (tx) => createCallbackRound(tx, actorOf(req), b));
  });

  app.get('/api/qms/callback-rounds/:id', { preHandler: guard(...QM_VIEW) }, async (req) => {
    const id = idParam(req.params);
    const r = await one(pool, 'SELECT * FROM qm_callback_rounds WHERE id = $1', [id]);
    if (!r) throw new HttpError(404, 'Không tìm thấy đợt giám sát');
    const rows = await many(pool, `SELECT c.*, i.code AS incident_code, i.created_at AS incident_at, i.final_priority, coalesce(i.callback_phone, i.caller_phone) AS phone,
                                          u.full_name AS called_by_name, (SELECT count(*)::int FROM capa_actions x WHERE x.callback_id = c.id) AS capa
                                     FROM qm_callbacks c JOIN incidents i ON i.id = c.incident_id LEFT JOIN users u ON u.id = c.called_by
                                    WHERE c.round_id = $1 ORDER BY i.created_at`, [id]);
    return { ...r, rows };
  });

  app.put('/api/qms/callbacks/:id', { preHandler: guard(...QM) }, async (req) => {
    const b = z.object({ status: z.enum(['da_goi', 'khong_lien_lac']), confirmed: z.boolean().nullish(), attitude: level.nullish(), issues: opt(2000) }).parse(req.body);
    return withTx(pool, (tx) => recordCallback(tx, actorOf(req), idParam(req.params), b));
  });

  /* ================= Nhà cung cấp ================= */

  const SupplierBody = z.object({
    name: z.string().trim().min(2).max(200), category: z.enum(Object.keys(SUPPLIER_CATEGORY) as [string, ...string[]]), contact: opt(300),
    contractUntil: date.nullish(), note: opt(1000), status: z.enum(['duoc_duyet', 'theo_doi', 'ngung']).optional(),
  });

  app.get('/api/qms/suppliers', { preHandler: guard(...QM_VIEW, 'pharmacist', 'technician', 'accountant') }, async () =>
    many(pool, `SELECT s.*, e.period AS last_period, e.pct AS last_pct, e.result AS last_result,
                       (s.status <> 'ngung' AND s.contract_until < vn_today() + 30) AS contract_expiring
                  FROM qm_suppliers s LEFT JOIN LATERAL (SELECT * FROM qm_supplier_evals x WHERE x.supplier_id = s.id ORDER BY x.created_at DESC LIMIT 1) e ON true
                 ORDER BY s.status = 'ngung', s.category, s.name`));

  const saveSupplier = async (req: any, id: string | null) => {
    const b = SupplierBody.parse(req.body);
    if (b.status === 'ngung' && !BOARD.includes(req.user.role)) throw new HttpError(403, 'Ngừng hợp tác do Ban Giám đốc quyết định');
    return withTx(pool, async (tx) => {
      const r = id
        ? await one(tx, `UPDATE qm_suppliers SET name = $2, category = $3, contact = $4, contract_until = $5, note = $6, status = coalesce($7, status) WHERE id = $1 RETURNING *`,
          [id, b.name, b.category, b.contact ?? null, b.contractUntil ?? null, b.note ?? null, b.status ?? null])
        : await one(tx, `INSERT INTO qm_suppliers(name, category, contact, contract_until, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [b.name, b.category, b.contact ?? null, b.contractUntil ?? null, b.note ?? null, req.user.id]);
      if (!r) throw new HttpError(404, 'Không tìm thấy nhà cung cấp');
      await audit(tx, 'system', actorOf(req), id ? 'qm.supplier_updated' : 'qm.supplier_created', 'qm_supplier', r.id, { name: b.name, status: b.status });
      return r;
    });
  };
  app.post('/api/qms/suppliers', { preHandler: guard(...QM, 'pharmacist', 'technician') }, async (req) => saveSupplier(req, null));
  app.put('/api/qms/suppliers/:id', { preHandler: guard(...QM, 'pharmacist', 'technician') }, async (req) => saveSupplier(req, idParam(req.params)));

  app.post('/api/qms/suppliers/:id/evaluations', { preHandler: guard(...QM, 'pharmacist', 'technician') }, async (req) => {
    const b = z.object({ period: z.string().regex(/^\d{4}(-(H1|H2|Q[1-4]))?$/, 'Kỳ dạng 2026, 2026-H2 hoặc 2026-Q4'), scores: z.record(z.string(), z.number().int()), note: opt(1000) }).parse(req.body);
    return withTx(pool, (tx) => evaluateSupplier(tx, actorOf(req), idParam(req.params), b));
  });

  app.get('/api/qms/suppliers/:id/evaluations', { preHandler: guard(...QM_VIEW, 'pharmacist', 'technician', 'accountant') }, async (req) =>
    many(pool, `SELECT e.*, u.full_name AS evaluated_by_name FROM qm_supplier_evals e LEFT JOIN users u ON u.id = e.evaluated_by WHERE e.supplier_id = $1 ORDER BY e.created_at DESC`,
      [idParam(req.params)]));

  /* ================= Xem xét của lãnh đạo ================= */

  app.get('/api/qms/reviews', { preHandler: guard(...QM_VIEW) }, async () =>
    many(pool, `SELECT r.id, r.code, r.date_from, r.date_to, r.meeting_on, r.status, r.signed_at, c.full_name AS chair_name,
                       (SELECT count(*)::int FROM capa_actions x WHERE x.review_id = r.id) AS actions,
                       (SELECT count(*)::int FROM capa_actions x WHERE x.review_id = r.id AND x.status = 'mo') AS open_actions
                  FROM qm_reviews r LEFT JOIN users c ON c.id = r.chair_id ORDER BY r.meeting_on DESC`));

  app.get('/api/qms/reviews/preview', { preHandler: guard(...QM_VIEW) }, async (req) => {
    const q = z.object({ from: date, to: date }).parse(req.query);
    return reviewInputs(pool, q.from, q.to);
  });

  app.post('/api/qms/reviews', { preHandler: guard(...QM) }, async (req) => {
    const b = z.object({ from: date, to: date, meetingOn: date, chairId: z.string().uuid().nullish(), attendees: opt(1000) }).parse(req.body);
    return withTx(pool, (tx) => createReview(tx, actorOf(req), b));
  });

  app.get('/api/qms/reviews/:id', { preHandler: guard(...QM_VIEW) }, async (req) => {
    const id = idParam(req.params);
    const r = await one(pool, `SELECT r.*, c.full_name AS chair_name, s.full_name AS signed_by_name FROM qm_reviews r
                                 LEFT JOIN users c ON c.id = r.chair_id LEFT JOIN users s ON s.id = r.signed_by WHERE r.id = $1`, [id]);
    if (!r) throw new HttpError(404, 'Không tìm thấy biên bản');
    return { ...r, actions: await many(pool, `${CAPA_SELECT} WHERE c.review_id = $1 ORDER BY c.created_at`, [id]) };
  });

  app.patch('/api/qms/reviews/:id', { preHandler: guard(...QM) }, async (req) => {
    const b = z.object({ conclusions: opt(8000), attendees: opt(1000), chairId: z.string().uuid().nullish(), refresh: z.boolean().optional() }).parse(req.body);
    return withTx(pool, (tx) => updateReview(tx, actorOf(req), idParam(req.params), b));
  });

  app.post('/api/qms/reviews/:id/sign', { preHandler: guard(...BOARD) }, async (req) => {
    await withTx(pool, (tx) => signReview(tx, { ...actorOf(req), role: req.user.role }, idParam(req.params)));
    return { ok: true };
  });

  /* ================= Thời hạn lưu hồ sơ ================= */

  app.get('/api/qms/retention', { preHandler: guard(...QM_VIEW) }, async () => ({
    rows: await retentionList(pool),
    disposals: await many(pool, `SELECT d.*, r.label, u.full_name AS approved_by_name FROM qm_disposals d JOIN qm_retention r ON r.key = d.record_key
                                   JOIN users u ON u.id = d.approved_by ORDER BY d.created_at DESC LIMIT 100`),
  }));

  app.put('/api/qms/retention/:key', { preHandler: guard('qa', 'admin', 'director') }, async (req) => {
    const key = z.object({ key: z.string().max(40) }).parse(req.params).key;
    const b = z.object({ years: z.number().int().min(1).max(100), basis: opt(500), confirmed: z.boolean() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const r = await one(tx, `UPDATE qm_retention SET years = $2, basis = $3, confirmed = $4, updated_by = $5, updated_at = now() WHERE key = $1 RETURNING *`,
        [key, b.years, b.basis ?? null, b.confirmed, req.user.id]);
      if (!r) throw new HttpError(404, 'Không tìm thấy loại hồ sơ');
      await audit(tx, 'system', actorOf(req), 'qm.retention_updated', 'qm_retention', key, b);
      return r;
    });
  });

  /** Ghi biên bản hủy hồ sơ hết hạn lưu (Hội đồng do Ban Giám đốc chủ trì); dữ liệu không bị xóa tự động */
  app.post('/api/qms/disposals', { preHandler: guard(...BOARD) }, async (req) => {
    const b = z.object({ recordKey: z.string().max(40), decision: z.string().trim().min(10).max(2000) }).parse(req.body);
    return withTx(pool, async (tx) => {
      const r = await one(tx, `SELECT *, (vn_today() - make_interval(years => years))::date AS cutoff FROM qm_retention WHERE key = $1`, [b.recordKey]);
      if (!r || !RETENTION_COUNT[r.key]) throw new HttpError(404, 'Không tìm thấy loại hồ sơ');
      if (!r.confirmed) throw new HttpError(409, 'QLCL chưa xác nhận căn cứ thời hạn lưu của loại hồ sơ này');
      const n = (await one(tx, RETENTION_COUNT[r.key], [r.cutoff])).n;
      if (!n) throw new HttpError(409, 'Không có hồ sơ nào quá thời hạn lưu');
      const d = await one(tx, `INSERT INTO qm_disposals(record_key, before_date, records, decision, approved_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [r.key, r.cutoff, n, b.decision, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'qm.disposal_recorded', 'qm_retention', r.key, { before: r.cutoff, records: n });
      return d;
    });
  });
}
