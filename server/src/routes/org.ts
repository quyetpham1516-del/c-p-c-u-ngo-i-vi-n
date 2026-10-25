import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx, type Queryable } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type TokenUser } from '../http.js';
import {
  canReview, DOMAIN, dueOn, leadUnits, METRIC_LABEL, ORG_MANAGERS, PERIOD, periodRange, REPORT_STATUS, subtree, unitMetrics, visibleUnits,
} from '../org.js';

const unitParam = (p: unknown) => z.object({ id: z.coerce.number().int().positive() }).parse(p).id;
const reportParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
const memberParams = (p: unknown) => z.object({ id: z.coerce.number().int().positive(), staffId: z.string().uuid() }).parse(p);
const dateZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày dạng YYYY-MM-DD');
const periodZ = z.enum(Object.keys(PERIOD) as [string, ...string[]]);
const text = z.string().trim().max(4000).nullish();
const EDITABLE = ['nhap', 'tra_lai'];

/** Ngày hôm nay theo giờ Việt Nam */
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const isOverdue = (period: string, end: string, status: string | null) => !['da_nop', 'da_duyet'].includes(status ?? '') && dueOn(period, end) < today();

type User = Pick<TokenUser, 'id' | 'role' | 'name'>;

async function unitRow(q: Queryable, id: number) {
  const u = await one(q, 'SELECT * FROM org_units WHERE id = $1', [id]);
  if (!u) throw new HttpError(404, 'Không tìm thấy bộ phận');
  return u;
}

async function isLeadOf(q: Queryable, userId: string, unitId: number) {
  return (await leadUnits(q, userId)).includes(unitId);
}

async function canSee(q: Queryable, user: User, unitId: number) {
  const v = await visibleUnits(q, user as any);
  return v === 'all' || v.includes(unitId) || (await canReview(q, user as any, unitId));
}

/** Tóm tắt báo cáo cùng kỳ của các bộ phận con trực tiếp (đã nộp hoặc đã duyệt), kể cả bộ phận chưa nộp */
async function childSummaries(q: Queryable, unitId: number, period: string, start: string) {
  return many(q, `
    SELECT o.id AS unit_id, o.code, o.name, r.id AS report_id, coalesce(r.status, 'chua_lam') AS status,
           CASE WHEN r.status IN ('da_nop', 'da_duyet') THEN r.summary END AS summary,
           CASE WHEN r.status IN ('da_nop', 'da_duyet') THEN r.issues END AS issues,
           CASE WHEN r.status IN ('da_nop', 'da_duyet') THEN r.proposals END AS proposals,
           CASE WHEN r.status IN ('da_nop', 'da_duyet') THEN r.metrics END AS metrics
      FROM org_units o LEFT JOIN unit_reports r ON r.unit_id = o.id AND r.period = $2 AND r.period_start = $3
     WHERE o.parent_id = $1 AND o.active ORDER BY o.sort, o.code`, [unitId, period, start]);
}

async function refreshData(q: Queryable, r: any) {
  const unit = await unitRow(q, r.unit_id);
  const metrics = await unitMetrics(q, unit, r.period_start, r.period_end);
  const children = await childSummaries(q, unit.id, r.period, r.period_start);
  await q.query('UPDATE unit_reports SET metrics = $2, children = $3, updated_at = now() WHERE id = $1', [r.id, metrics, JSON.stringify(children)]);
}

async function logEvent(q: Queryable, reportId: string, user: User, action: string, note: string | null = null) {
  await q.query('INSERT INTO unit_report_events(report_id, action, actor_id, actor_name, note) VALUES ($1,$2,$3,$4,$5)', [reportId, action, user.id, user.name, note]);
}

async function reportDetail(q: Queryable, id: string, user: User) {
  const r = await one(q, `
    SELECT r.*, o.code AS unit_code, o.name AS unit_name, o.domain, o.parent_id, p.name AS parent_name,
           c.full_name AS created_by_name, sb.full_name AS submitted_by_name, rv.full_name AS reviewed_by_name
      FROM unit_reports r JOIN org_units o ON o.id = r.unit_id LEFT JOIN org_units p ON p.id = o.parent_id
      JOIN users c ON c.id = r.created_by LEFT JOIN users sb ON sb.id = r.submitted_by LEFT JOIN users rv ON rv.id = r.reviewed_by
     WHERE r.id = $1`, [id]);
  if (!r) throw new HttpError(404, 'Không tìm thấy báo cáo');
  const lead = await isLeadOf(q, user.id, r.unit_id);
  if (!lead && !(await canSee(q, user, r.unit_id))) throw new HttpError(403, 'Không có quyền xem báo cáo của bộ phận này');
  const reviewer = !lead && r.submitted_by !== user.id && (await canReview(q, user as any, r.unit_id));
  const events = await many(q, 'SELECT action, actor_name, note, at FROM unit_report_events WHERE report_id = $1 ORDER BY id', [id]);
  return {
    ...r, events, due: dueOn(r.period, r.period_end), overdue: isOverdue(r.period, r.period_end, r.status),
    canEdit: lead && EDITABLE.includes(r.status), canReview: reviewer && r.status === 'da_nop',
  };
}

export function registerOrg(app: FastifyInstance, { pool, hub }: Ctx) {
  const notify = (id: string, unitId: number, status: string) => hub.publish({ type: 'unit_report', id, unitId, status });

  /* ---------- Sơ đồ tổ chức ---------- */

  app.get('/api/org/meta', { preHandler: guard() }, async () => ({ domains: DOMAIN, periods: PERIOD, statuses: REPORT_STATUS, metrics: METRIC_LABEL }));

  /** Sơ đồ: mọi người xem được tên bộ phận, trưởng nhóm, thành viên */
  app.get('/api/org/units', { preHandler: guard() }, async () => {
    const units = await many(pool, `SELECT o.*, s.name AS station_name FROM org_units o LEFT JOIN stations s ON s.id = o.station_id ORDER BY o.sort, o.code`);
    const members = await many(pool, `SELECT m.unit_id, m.staff_id, m.is_lead, st.code, st.full_name, st.title
                                        FROM org_members m JOIN staff st ON st.id = m.staff_id ORDER BY m.is_lead DESC, st.full_name`);
    return units.map((u) => ({ ...u, members: members.filter((m) => m.unit_id === u.id) }));
  });

  /** Danh sách nhân viên để xếp vào bộ phận */
  app.get('/api/org/staff', { preHandler: guard(...ORG_MANAGERS) }, async () =>
    many(pool, `SELECT id, code, full_name, title FROM staff WHERE status <> 'nghi_viec' ORDER BY full_name`));

  const UnitZ = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, 'Mã 2–20 ký tự chữ, số, gạch ngang'),
    name: z.string().trim().min(2).max(120),
    parentId: z.number().int().positive().nullable(),
    domain: z.enum(Object.keys(DOMAIN) as [string, ...string[]]),
    stationId: z.string().nullish(),
    sort: z.number().int().min(0).max(999).default(0),
  });

  app.post('/api/org/units', { preHandler: guard(...ORG_MANAGERS) }, async (req) => {
    const b = UnitZ.parse(req.body);
    return withTx(pool, async (tx) => {
      if (b.parentId) await unitRow(tx, b.parentId);
      const u = await one(tx, `INSERT INTO org_units(code, name, parent_id, domain, station_id, sort) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [b.code, b.name, b.parentId, b.domain, b.stationId ?? null, b.sort]);
      await audit(tx, 'system', actorOf(req), 'org.unit_created', 'org_unit', String(u.id), { code: b.code, name: b.name, parentId: b.parentId });
      return u;
    });
  });

  app.patch('/api/org/units/:id', { preHandler: guard(...ORG_MANAGERS) }, async (req) => {
    const id = unitParam(req.params);
    const b = UnitZ.extend({ active: z.boolean() }).partial().parse(req.body);
    return withTx(pool, async (tx) => {
      const cur = await unitRow(tx, id);
      if (b.parentId !== undefined && b.parentId !== null) {
        if ((await subtree(tx, [id])).includes(b.parentId)) throw new HttpError(422, 'Không đặt bộ phận cấp trên là chính nó hoặc cấp dưới của nó');
        await unitRow(tx, b.parentId);
      }
      if (b.parentId === null && cur.parent_id !== null) {
        const root = await one(tx, 'SELECT 1 FROM org_units WHERE parent_id IS NULL AND id <> $1', [id]);
        if (root) throw new HttpError(422, 'Chỉ có một bộ phận cao nhất (Ban Giám đốc)');
      }
      if (b.active === false && (await one(tx, 'SELECT 1 FROM org_units WHERE parent_id = $1 AND active', [id]))) {
        throw new HttpError(409, 'Còn bộ phận cấp dưới đang hoạt động: chuyển hoặc ngừng các bộ phận đó trước');
      }
      const u = await one(tx, `UPDATE org_units SET code = coalesce($2, code), name = coalesce($3, name),
                                 parent_id = CASE WHEN $4::boolean THEN $5 ELSE parent_id END, domain = coalesce($6, domain),
                                 station_id = CASE WHEN $7::boolean THEN $8 ELSE station_id END, sort = coalesce($9, sort), active = coalesce($10, active)
                                WHERE id = $1 RETURNING *`,
        [id, b.code ?? null, b.name ?? null, b.parentId !== undefined, b.parentId ?? null, b.domain ?? null,
          b.stationId !== undefined, b.stationId ?? null, b.sort ?? null, b.active ?? null]);
      await audit(tx, 'system', actorOf(req), 'org.unit_changed', 'org_unit', String(id), b as any);
      return u;
    });
  });

  /** Thêm thành viên hoặc đổi vai trò trưởng nhóm */
  app.put('/api/org/units/:id/members/:staffId', { preHandler: guard(...ORG_MANAGERS) }, async (req) => {
    const { id, staffId } = memberParams(req.params);
    const b = z.object({ isLead: z.boolean() }).parse(req.body ?? {});
    return withTx(pool, async (tx) => {
      const unit = await unitRow(tx, id);
      const st = await one(tx, 'SELECT id, full_name, status FROM staff WHERE id = $1', [staffId]);
      if (!st) throw new HttpError(404, 'Không tìm thấy nhân viên');
      if (st.status === 'nghi_viec') throw new HttpError(409, 'Nhân viên đã nghỉ việc');
      await tx.query(`INSERT INTO org_members(unit_id, staff_id, is_lead) VALUES ($1,$2,$3)
                      ON CONFLICT (unit_id, staff_id) DO UPDATE SET is_lead = $3`, [id, staffId, b.isLead]);
      await audit(tx, 'system', actorOf(req), b.isLead ? 'org.lead_set' : 'org.member_set', 'org_unit', String(id),
        { unit: unit.code, staffId, staff: st.full_name, isLead: b.isLead });
      return { ok: true };
    });
  });

  app.delete('/api/org/units/:id/members/:staffId', { preHandler: guard(...ORG_MANAGERS) }, async (req) => {
    const { id, staffId } = memberParams(req.params);
    return withTx(pool, async (tx) => {
      const r = await one(tx, 'DELETE FROM org_members WHERE unit_id = $1 AND staff_id = $2 RETURNING is_lead', [id, staffId]);
      if (!r) throw new HttpError(404, 'Nhân viên không thuộc bộ phận này');
      await audit(tx, 'system', actorOf(req), 'org.member_removed', 'org_unit', String(id), { staffId, wasLead: r.is_lead });
      return { ok: true };
    });
  });

  /** Vai trò của tôi trong sơ đồ: nhóm tôi làm trưởng, có xem tổng hợp hay không */
  app.get('/api/org/me', { preHandler: guard() }, async (req) => {
    const leads = await leadUnits(pool, req.user.id);
    const visible = await visibleUnits(pool, req.user);
    return {
      leadUnits: leads.length ? await many(pool, 'SELECT id, code, name, domain FROM org_units WHERE id = ANY($1::int[]) ORDER BY sort, code', [leads]) : [],
      canManage: ORG_MANAGERS.includes(req.user.role),
      seesAll: visible === 'all',
      hasReports: visible === 'all' || leads.length > 0,
    };
  });

  /* ---------- Báo cáo ---------- */

  /** Bảng theo dõi: các bộ phận người dùng được xem, tình trạng báo cáo kỳ này */
  app.get('/api/org/dashboard', { preHandler: guard() }, async (req) => {
    const q = z.object({ period: periodZ.default('tuan'), date: dateZ.optional() }).parse(req.query);
    const { start, end } = periodRange(q.period, q.date ?? today());
    const visible = await visibleUnits(pool, req.user);
    if (visible !== 'all' && !visible.length) return { period: q.period, start, end, due: dueOn(q.period, end), units: [] };
    const leads = await leadUnits(pool, req.user.id);
    const rows = await many(pool, `
      SELECT o.id, o.code, o.name, o.parent_id, o.domain, o.sort,
             (SELECT string_agg(st.full_name, ', ' ORDER BY st.full_name) FROM org_members m JOIN staff st ON st.id = m.staff_id WHERE m.unit_id = o.id AND m.is_lead) AS leads,
             r.id AS report_id, r.status, r.submitted_at, r.reviewed_at, r.review_note
        FROM org_units o LEFT JOIN unit_reports r ON r.unit_id = o.id AND r.period = $1 AND r.period_start = $2
       WHERE o.active AND ($3::int[] IS NULL OR o.id = ANY($3::int[])) ORDER BY o.sort, o.code`,
      [q.period, start, visible === 'all' ? null : visible]);
    return {
      period: q.period, start, end, due: dueOn(q.period, end),
      units: rows.map((r) => ({ ...r, status: r.status ?? 'chua_lam', overdue: isOverdue(q.period, end, r.status), mine: leads.includes(r.id) })),
    };
  });

  /** Trưởng nhóm mở báo cáo kỳ (tạo mới nếu chưa có), số liệu tự lấy */
  app.post('/api/org/reports', { preHandler: guard() }, async (req) => {
    const b = z.object({ unitId: z.number().int().positive(), period: periodZ, date: dateZ }).parse(req.body);
    if (!(await isLeadOf(pool, req.user.id, b.unitId))) throw new HttpError(403, 'Chỉ trưởng nhóm của bộ phận lập báo cáo');
    const { start, end } = periodRange(b.period, b.date);
    if (start > today()) throw new HttpError(422, 'Kỳ báo cáo chưa bắt đầu');
    const id = await withTx(pool, async (tx) => {
      const unit = await unitRow(tx, b.unitId);
      if (!unit.active) throw new HttpError(409, 'Bộ phận đã ngừng hoạt động');
      const ex = await one(tx, 'SELECT id FROM unit_reports WHERE unit_id = $1 AND period = $2 AND period_start = $3', [b.unitId, b.period, start]);
      if (ex) return ex.id as string;
      const r = await one(tx, `INSERT INTO unit_reports(unit_id, period, period_start, period_end, created_by) VALUES ($1,$2,$3,$4,$5)
                               ON CONFLICT (unit_id, period, period_start) DO NOTHING RETURNING *`, [b.unitId, b.period, start, end, req.user.id]);
      if (!r) return (await one(tx, 'SELECT id FROM unit_reports WHERE unit_id = $1 AND period = $2 AND period_start = $3', [b.unitId, b.period, start])).id as string;
      await refreshData(tx, r);
      await logEvent(tx, r.id, req.user, 'tao');
      return r.id as string;
    });
    return reportDetail(pool, id, req.user);
  });

  /** Lịch sử báo cáo của một bộ phận */
  app.get('/api/org/units/:id/reports', { preHandler: guard() }, async (req) => {
    const id = unitParam(req.params);
    if (!(await isLeadOf(pool, req.user.id, id)) && !(await canSee(pool, req.user, id))) throw new HttpError(403, 'Không có quyền xem báo cáo của bộ phận này');
    return many(pool, `SELECT r.id, r.period, r.period_start, r.period_end, r.status, r.submitted_at, r.reviewed_at, u.full_name AS created_by_name
                         FROM unit_reports r JOIN users u ON u.id = r.created_by WHERE r.unit_id = $1 ORDER BY r.period_start DESC, r.period LIMIT 100`, [id]);
  });

  app.get('/api/org/reports/:id', { preHandler: guard() }, async (req) => reportDetail(pool, reportParam(req.params), req.user));

  async function editable(q: Queryable, id: string, user: User) {
    const r = await one(q, 'SELECT * FROM unit_reports WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw new HttpError(404, 'Không tìm thấy báo cáo');
    if (!(await isLeadOf(q, user.id, r.unit_id))) throw new HttpError(403, 'Chỉ trưởng nhóm của bộ phận sửa báo cáo');
    if (!EDITABLE.includes(r.status)) throw new HttpError(409, 'Báo cáo đã nộp, không sửa được (cấp trên trả lại thì sửa tiếp)');
    return r;
  }

  app.put('/api/org/reports/:id', { preHandler: guard() }, async (req) => {
    const id = reportParam(req.params);
    const b = z.object({ summary: text, issues: text, proposals: text, nextPlan: text }).parse(req.body);
    await withTx(pool, async (tx) => {
      await editable(tx, id, req.user);
      await tx.query(`UPDATE unit_reports SET summary = $2, issues = $3, proposals = $4, next_plan = $5, updated_at = now() WHERE id = $1`,
        [id, b.summary || null, b.issues || null, b.proposals || null, b.nextPlan || null]);
    });
    return reportDetail(pool, id, req.user);
  });

  /** Lấy lại số liệu và tóm tắt cấp dưới (khi nhóm con vừa nộp) */
  app.post('/api/org/reports/:id/refresh', { preHandler: guard() }, async (req) => {
    const id = reportParam(req.params);
    await withTx(pool, async (tx) => refreshData(tx, await editable(tx, id, req.user)));
    return reportDetail(pool, id, req.user);
  });

  /** Nộp lên cấp trên; bộ phận cao nhất (Ban Giám đốc) nộp là hoàn tất */
  app.post('/api/org/reports/:id/submit', { preHandler: guard() }, async (req) => {
    const id = reportParam(req.params);
    const out = await withTx(pool, async (tx) => {
      const r = await editable(tx, id, req.user);
      if (!r.summary || r.summary.trim().length < 10) throw new HttpError(422, 'Viết tóm tắt tình hình (ít nhất 10 ký tự) trước khi nộp');
      if (r.period_start > today()) throw new HttpError(422, 'Kỳ báo cáo chưa bắt đầu');
      await refreshData(tx, r);
      const unit = await unitRow(tx, r.unit_id);
      const status = unit.parent_id === null ? 'da_duyet' : 'da_nop';
      await tx.query(`UPDATE unit_reports SET status = $2::text, submitted_by = $3::uuid, submitted_at = now(),
                        reviewed_by = CASE WHEN $2::text = 'da_duyet' THEN $3::uuid END, reviewed_at = CASE WHEN $2::text = 'da_duyet' THEN now() END,
                        review_note = NULL, updated_at = now() WHERE id = $1`, [id, status, req.user.id]);
      await logEvent(tx, id, req.user, 'nop');
      await audit(tx, 'system', actorOf(req), 'org.report_submitted', 'unit_report', id, { unit: unit.code, period: r.period, start: r.period_start, final: status === 'da_duyet' });
      return { unitId: r.unit_id, status };
    });
    await notify(id, out.unitId, out.status);
    return reportDetail(pool, id, req.user);
  });

  /** Cấp trên duyệt hoặc trả lại (bắt buộc ghi lý do khi trả lại) */
  app.post('/api/org/reports/:id/review', { preHandler: guard() }, async (req) => {
    const id = reportParam(req.params);
    const b = z.object({ decision: z.enum(['duyet', 'tra_lai']), note: z.string().trim().max(2000).nullish() })
      .refine((x) => x.decision === 'duyet' || (x.note ?? '').length >= 5, { message: 'Ghi lý do trả lại (ít nhất 5 ký tự)', path: ['note'] }).parse(req.body);
    const out = await withTx(pool, async (tx) => {
      const r = await one(tx, 'SELECT * FROM unit_reports WHERE id = $1 FOR UPDATE', [id]);
      if (!r) throw new HttpError(404, 'Không tìm thấy báo cáo');
      if (r.status !== 'da_nop') throw new HttpError(409, 'Chỉ duyệt báo cáo đã nộp');
      if (r.submitted_by === req.user.id || (await isLeadOf(tx, req.user.id, r.unit_id))) throw new HttpError(403, 'Không tự duyệt báo cáo của nhóm mình');
      if (!(await canReview(tx, req.user, r.unit_id))) throw new HttpError(403, 'Chỉ trưởng bộ phận cấp trên hoặc Ban Giám đốc duyệt');
      const status = b.decision === 'duyet' ? 'da_duyet' : 'tra_lai';
      await tx.query('UPDATE unit_reports SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4, updated_at = now() WHERE id = $1',
        [id, status, req.user.id, b.note || null]);
      await logEvent(tx, id, req.user, b.decision, b.note || null);
      await audit(tx, 'system', actorOf(req), b.decision === 'duyet' ? 'org.report_approved' : 'org.report_returned', 'unit_report', id, { note: b.note ?? null });
      return { unitId: r.unit_id, status };
    });
    await notify(id, out.unitId, out.status);
    return reportDetail(pool, id, req.user);
  });
}
