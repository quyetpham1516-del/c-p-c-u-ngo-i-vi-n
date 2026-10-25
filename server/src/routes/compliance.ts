import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import {
  ACCESS_DECISION, answerPdRequest, backupStatus, completeAccessReview, createAccessReview, createBreach, createInjury, createPdRequest, decideAccess,
  DRILL_KIND, DRILL_MIN_PER_YEAR, DRILL_RESULT, drillCompliance, INACTIVE_DAYS, INJURY_KIND, INJURY_SEVERITY, patientDataSummary, PD_BREACH_HOURS,
  PD_REQUEST_HOURS, PD_REQUEST_KIND, recordDrill, saveDrill, updateBreach,
} from '../compliance.js';
import { backup, verify } from '../tools/backup.js';

const IT: Role[] = ['admin', 'director'];
const DPO: Role[] = ['qa', 'admin', 'director'];
const SAFETY_VIEW: Role[] = ['supervisor', 'qa', 'admin', 'director', 'hr', 'technician'];
const SAFETY_EDIT: Role[] = ['supervisor', 'qa', 'admin', 'director', 'hr'];
const ROLES = ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ts = z.string().datetime({ offset: true });
const opt = (n = 2000) => z.string().trim().max(n).nullish();
const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;

export function registerCompliance(app: FastifyInstance, { pool }: Ctx) {
  app.get('/api/compliance/meta', { preHandler: guard() }, async () => ({
    accessDecision: ACCESS_DECISION, inactiveDays: INACTIVE_DAYS, pdRequestKind: PD_REQUEST_KIND, pdRequestHours: PD_REQUEST_HOURS, pdBreachHours: PD_BREACH_HOURS,
    drillKind: DRILL_KIND, drillMinPerYear: DRILL_MIN_PER_YEAR, drillResult: DRILL_RESULT, injuryKind: INJURY_KIND, injurySeverity: INJURY_SEVERITY,
  }));

  /* ---------- Sao lưu ---------- */

  app.get('/api/compliance/backups', { preHandler: guard(...IT) }, async () => backupStatus(pool));

  let running = false;
  app.post('/api/compliance/backups/run', { preHandler: guard(...IT) }, async (req) => {
    const b = z.object({ kind: z.enum(['sao_luu', 'thu_khoi_phuc']) }).parse(req.body);
    if (running) throw new HttpError(409, 'Đang chạy một lượt sao lưu hoặc khôi phục');
    running = true;
    try {
      const who = `${req.user.name} (giao diện)`;
      await (b.kind === 'sao_luu' ? backup(who) : verify(who));
    } catch (e) {
      throw new HttpError(500, (e as Error).message);
    } finally { running = false; }
    return backupStatus(pool);
  });

  /* ---------- Rà soát tài khoản ---------- */

  app.get('/api/compliance/access-reviews', { preHandler: guard(...IT) }, async () =>
    many(pool, `SELECT r.*, u.full_name AS reviewer_name FROM ops_access_reviews r JOIN users u ON u.id = r.reviewer_id ORDER BY r.created_at DESC LIMIT 20`));
  app.post('/api/compliance/access-reviews', { preHandler: guard(...IT) }, async (req) => withTx(pool, (tx) => createAccessReview(tx, actorOf(req))));
  app.put('/api/compliance/access-reviews/:id', { preHandler: guard(...IT) }, async (req) => {
    const b = z.object({ userId: z.string().uuid(), decision: z.enum(['giu', 'doi_vai_tro', 'khoa']), newRole: z.enum(ROLES).nullish(), note: opt(500) }).parse(req.body);
    return withTx(pool, (tx) => decideAccess(tx, actorOf(req), idParam(req.params), b));
  });
  app.post('/api/compliance/access-reviews/:id/complete', { preHandler: guard(...IT) }, async (req) =>
    withTx(pool, (tx) => completeAccessReview(tx, actorOf(req), idParam(req.params))));

  /* ---------- Dữ liệu cá nhân ---------- */

  app.get('/api/compliance/pd/activities', { preHandler: guard(...DPO) }, async () =>
    many(pool, `SELECT a.*, u.full_name AS owner_name, r.label AS retention_label, r.years AS retention_years
                  FROM pd_activities a LEFT JOIN users u ON u.id = a.owner_id LEFT JOIN qm_retention r ON r.key = a.retention_key ORDER BY a.code`));

  const activityBody = z.object({
    code: z.string().trim().min(2).max(20), name: z.string().trim().min(3).max(200), purpose: z.string().trim().min(3).max(1000), subjects: z.string().trim().min(2).max(500),
    dataBasic: opt(1000), dataSensitive: opt(1000), legalBasis: z.string().trim().min(3).max(1000), recipients: opt(1000), retentionKey: opt(40),
    crossBorder: z.boolean().default(false), safeguards: opt(1000), ownerId: z.string().uuid().nullish(), confirmed: z.boolean().default(false),
  });
  const activityArgs = (b: z.infer<typeof activityBody>) => [b.code, b.name, b.purpose, b.subjects, b.dataBasic ?? null, b.dataSensitive ?? null, b.legalBasis,
    b.recipients ?? null, b.retentionKey || null, b.crossBorder, b.safeguards ?? null, b.ownerId ?? null, b.confirmed];
  app.post('/api/compliance/pd/activities', { preHandler: guard(...DPO) }, async (req) => {
    const b = activityBody.parse(req.body);
    return withTx(pool, async (tx) => {
      const row = await one(tx, `INSERT INTO pd_activities(code, name, purpose, subjects, data_basic, data_sensitive, legal_basis, recipients, retention_key, cross_border, safeguards, owner_id, confirmed)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, activityArgs(b));
      await audit(tx, 'system', actorOf(req), 'pd.activity', 'pd_activity', row.id, { code: b.code });
      return row;
    });
  });
  app.put('/api/compliance/pd/activities/:id', { preHandler: guard(...DPO) }, async (req) => {
    const b = activityBody.parse(req.body);
    return withTx(pool, async (tx) => {
      const row = await one(tx, `UPDATE pd_activities SET code = $1, name = $2, purpose = $3, subjects = $4, data_basic = $5, data_sensitive = $6, legal_basis = $7, recipients = $8,
                                        retention_key = $9, cross_border = $10, safeguards = $11, owner_id = $12, confirmed = $13, updated_at = now() WHERE id = $14 RETURNING *`,
      [...activityArgs(b), idParam(req.params)]);
      if (!row) throw new HttpError(404, 'Không tìm thấy hoạt động xử lý');
      await audit(tx, 'system', actorOf(req), 'pd.activity', 'pd_activity', row.id, { code: b.code, confirmed: b.confirmed });
      return row;
    });
  });

  app.get('/api/compliance/pd/requests', { preHandler: guard(...DPO) }, async () =>
    many(pool, `SELECT r.*, p.ba_number, p.full_name AS patient_name, u.full_name AS handled_by_name,
                       (r.status IN ('moi', 'dang_xu_ly') AND r.due_at < now()) AS overdue
                  FROM pd_requests r LEFT JOIN patients p ON p.id = r.patient_id LEFT JOIN users u ON u.id = r.handled_by
                 ORDER BY r.status IN ('moi', 'dang_xu_ly') DESC, r.due_at LIMIT 200`));
  app.post('/api/compliance/pd/requests', { preHandler: guard(...DPO) }, async (req) => {
    const b = z.object({
      kind: z.enum(Object.keys(PD_REQUEST_KIND) as [string, ...string[]]), requester: z.string().trim().min(2).max(200), relation: opt(100), contact: opt(200),
      patientBa: z.string().trim().max(40).nullish(), content: z.string().trim().min(5).max(2000), identityChecked: z.boolean().default(false),
    }).parse(req.body);
    let patientId: string | null = null;
    if (b.patientBa) {
      patientId = (await one(pool, 'SELECT id FROM patients WHERE ba_number = $1 AND merged_into IS NULL', [b.patientBa]))?.id ?? null;
      if (!patientId) throw new HttpError(404, `Không tìm thấy bệnh án số ${b.patientBa}`);
    }
    return withTx(pool, (tx) => createPdRequest(tx, actorOf(req), { ...b, patientId }));
  });
  app.patch('/api/compliance/pd/requests/:id', { preHandler: guard(...DPO) }, async (req) => {
    const b = z.object({ status: z.enum(['dang_xu_ly', 'da_tra_loi', 'tu_choi']), response: opt(4000), identityChecked: z.boolean().optional() }).parse(req.body);
    const id = idParam(req.params);
    return withTx(pool, async (tx) => {
      if (b.identityChecked) await tx.query('UPDATE pd_requests SET identity_checked = true WHERE id = $1', [id]);
      return answerPdRequest(tx, actorOf(req), id, b);
    });
  });
  app.get('/api/compliance/pd/requests/:id/data', { preHandler: guard(...DPO) }, async (req) => {
    const r = await one(pool, 'SELECT * FROM pd_requests WHERE id = $1', [idParam(req.params)]);
    if (!r?.patient_id) throw new HttpError(404, 'Yêu cầu chưa gắn bệnh án');
    if (!r.identity_checked) throw new HttpError(409, 'Chưa xác minh danh tính người yêu cầu');
    await withTx(pool, (tx) => audit(tx, `patient:${r.patient_id}`, actorOf(req), 'pd.data_exported', 'pd_request', r.id, { code: r.code }));
    return patientDataSummary(pool, r.patient_id);
  });

  app.get('/api/compliance/pd/breaches', { preHandler: guard(...DPO) }, async () =>
    many(pool, `SELECT b.*, u.full_name AS reported_by_name, b.detected_at + make_interval(hours => $1) AS authority_due,
                       (b.authority_notified_at IS NULL AND b.detected_at + make_interval(hours => $1) < now()) AS overdue
                  FROM pd_breaches b LEFT JOIN users u ON u.id = b.reported_by ORDER BY b.status, b.detected_at DESC`, [PD_BREACH_HOURS]));
  app.post('/api/compliance/pd/breaches', { preHandler: guard(...DPO) }, async (req) => {
    const b = z.object({
      detectedAt: ts, description: z.string().trim().min(5).max(4000), dataAffected: opt(1000), subjectsCount: z.number().int().min(0).nullish(),
      severity: z.enum(['thap', 'trung_binh', 'cao']), containment: opt(2000),
    }).parse(req.body);
    return withTx(pool, (tx) => createBreach(tx, actorOf(req), b));
  });
  app.patch('/api/compliance/pd/breaches/:id', { preHandler: guard(...DPO) }, async (req) => {
    const b = z.object({ containment: opt(2000), authorityNotifiedAt: ts.nullish(), subjectsNotifiedAt: ts.nullish(), close: z.boolean().default(false) }).parse(req.body);
    return withTx(pool, (tx) => updateBreach(tx, actorOf(req), idParam(req.params), b));
  });

  app.get('/api/compliance/pd/assessments', { preHandler: guard(...DPO) }, async () =>
    many(pool, `SELECT s.*, a.code AS activity_code, u.full_name AS approved_by_name FROM pd_assessments s
                  LEFT JOIN pd_activities a ON a.id = s.activity_id LEFT JOIN users u ON u.id = s.approved_by ORDER BY s.assessed_on DESC`));
  app.post('/api/compliance/pd/assessments', { preHandler: guard(...DPO) }, async (req) => {
    const b = z.object({
      title: z.string().trim().min(3).max(200), activityId: z.string().uuid().nullish(), assessedOn: date, risks: z.string().trim().min(5).max(4000),
      measures: z.string().trim().min(5).max(4000), conclusion: opt(2000),
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      const row = await one(tx, `INSERT INTO pd_assessments(title, activity_id, assessed_on, risks, measures, conclusion, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.title, b.activityId ?? null, b.assessedOn, b.risks, b.measures, b.conclusion ?? null, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'pd.assessment', 'pd_assessment', row.id, { title: b.title });
      return row;
    });
  });
  app.post('/api/compliance/pd/assessments/:id/approve', { preHandler: guard('director', 'admin') }, async (req) => {
    const id = idParam(req.params);
    return withTx(pool, async (tx) => {
      const row = await one(tx, `UPDATE pd_assessments SET approved_by = $2, approved_at = now() WHERE id = $1 AND approved_at IS NULL RETURNING *`, [id, req.user.id]);
      if (!row) throw new HttpError(409, 'Đã duyệt hoặc không tồn tại');
      if (row.created_by === req.user.id) throw new HttpError(409, 'Người lập không tự duyệt');
      await audit(tx, 'system', actorOf(req), 'pd.assessment_approved', 'pd_assessment', id, {});
      return row;
    });
  });

  /* ---------- An toàn, PCCC, diễn tập ---------- */

  app.get('/api/compliance/drills', { preHandler: guard(...SAFETY_VIEW) }, async (req) => {
    const year = z.object({ year: z.coerce.number().int().min(2020).max(2100).optional() }).parse(req.query).year ?? new Date(Date.now() + 7 * 3600_000).getUTCFullYear();
    const [rows, compliance] = await Promise.all([
      many(pool, `SELECT d.*, s.name AS station_name, u.full_name AS lead_name, cardinality(d.participants) AS participant_count,
                         (d.status = 'ke_hoach' AND d.planned_on < vn_today()) AS late,
                         (SELECT count(*)::int FROM capa_actions c WHERE c.drill_id = d.id AND c.status IN ('mo', 'xong')) AS open_capa
                    FROM sf_drills d LEFT JOIN stations s ON s.id = d.station_id LEFT JOIN users u ON u.id = d.lead_id
                   WHERE extract(year FROM d.planned_on) = $1 ORDER BY d.planned_on`, [year]),
      drillCompliance(pool, year),
    ]);
    return { year, rows, compliance };
  });
  const drillBody = z.object({
    kind: z.enum(Object.keys(DRILL_KIND) as [string, ...string[]]), title: z.string().trim().min(3).max(200), stationId: z.string().max(40).nullish(),
    plannedOn: date, leadId: z.string().uuid().nullish(), scenario: opt(4000),
  });
  app.post('/api/compliance/drills', { preHandler: guard(...SAFETY_EDIT) }, async (req) => withTx(pool, (tx) => saveDrill(tx, actorOf(req), null, drillBody.parse(req.body))));
  app.put('/api/compliance/drills/:id', { preHandler: guard(...SAFETY_EDIT) }, async (req) =>
    withTx(pool, (tx) => saveDrill(tx, actorOf(req), idParam(req.params), drillBody.parse(req.body))));
  app.post('/api/compliance/drills/:id/record', { preHandler: guard(...SAFETY_EDIT) }, async (req) => {
    const b = z.object({
      doneOn: date, participants: z.array(z.string().uuid()).max(500), durationMin: z.number().int().min(1).max(10000).nullish(),
      findings: z.string().trim().min(3).max(4000), result: z.enum(['dat', 'can_cai_thien', 'khong_dat']),
    }).parse(req.body);
    return withTx(pool, (tx) => recordDrill(tx, actorOf(req), idParam(req.params), b));
  });
  app.post('/api/compliance/drills/:id/cancel', { preHandler: guard(...SAFETY_EDIT) }, async (req) => {
    const row = await one(pool, `UPDATE sf_drills SET status = 'huy' WHERE id = $1 AND status = 'ke_hoach' RETURNING id`, [idParam(req.params)]);
    if (!row) throw new HttpError(409, 'Chỉ hủy được buổi chưa làm');
    return { ok: true };
  });

  app.get('/api/compliance/injuries', { preHandler: guard(...SAFETY_VIEW) }, async () =>
    many(pool, `SELECT i.*, u.full_name AS recorded_by_name FROM sf_injuries i LEFT JOIN users u ON u.id = i.recorded_by ORDER BY i.occurred_at DESC LIMIT 200`));
  app.post('/api/compliance/injuries', { preHandler: guard(...SAFETY_EDIT) }, async (req) => {
    const b = z.object({
      occurredAt: ts, staffUser: z.string().uuid().nullish(), person: z.string().trim().min(2).max(200), place: opt(300),
      kind: z.enum(Object.keys(INJURY_KIND) as [string, ...string[]]), severity: z.enum(['nhe', 'nang', 'chet_nguoi']),
      description: z.string().trim().min(5).max(4000), daysOff: z.number().int().min(0).max(3650).nullish(), action: opt(2000), reportedAuthorityAt: ts.nullish(),
    }).parse(req.body);
    return withTx(pool, (tx) => createInjury(tx, actorOf(req), b));
  });

  /** Tổng quan việc cần làm của phần tuân thủ */
  app.get('/api/compliance/summary', { preHandler: guard(...SAFETY_VIEW, ...DPO, ...IT) }, async () => {
    const year = new Date(Date.now() + 7 * 3600_000).getUTCFullYear();
    const [backups, pdReq, breaches, drills, access] = await Promise.all([
      backupStatus(pool),
      one(pool, `SELECT count(*) FILTER (WHERE status IN ('moi', 'dang_xu_ly'))::int AS open, count(*) FILTER (WHERE status IN ('moi', 'dang_xu_ly') AND due_at < now())::int AS overdue FROM pd_requests`),
      one(pool, `SELECT count(*) FILTER (WHERE status = 'mo')::int AS open,
                        count(*) FILTER (WHERE authority_notified_at IS NULL AND detected_at + make_interval(hours => $1) < now())::int AS overdue FROM pd_breaches`, [PD_BREACH_HOURS]),
      drillCompliance(pool, year),
      one(pool, `SELECT max(completed_at) AS last FROM ops_access_reviews WHERE status = 'da_xong'`),
    ]);
    return { backupWarnings: backups.warnings, pdRequests: pdReq, breaches, drills, lastAccessReview: access?.last ?? null };
  });
}
