import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { toCsv } from '../finance.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import {
  approveSet, ASSESSMENT_KIND, assessmentRows, assessmentSummary, assignAssessors, cloneSet, closeAssessment, createAssessment, deleteCriterion,
  deleteDraftSet, FACILITY_KIND, importSet, METHODS, reopenAssessment, saveCriterion, saveScore, setDetail, setToXlsx, updateSet, xlsxToCriteria,
} from '../qc.js';

/** Quản lý chất lượng soạn bộ tiêu chí, tạo đợt, phân công; giám đốc hoặc quản trị ban hành bộ tiêu chí */
const QC_MANAGE: Role[] = ['qa', 'supervisor', 'admin', 'director'];
const QC_APPROVE: Role[] = ['director', 'admin'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
const txt = (n: number) => z.string().trim().max(n).nullish();

const criterionBody = z.object({
  part: z.string().trim().min(1).max(5), partName: z.string().trim().min(2).max(200),
  chapter: z.string().trim().min(1).max(10), chapterName: z.string().trim().min(2).max(300),
  code: z.string().trim().min(1).max(20), title: z.string().trim().min(3).max(600),
  legalBasis: txt(4000), ownerUnit: txt(120), weight: z.number().min(0.5).max(5).optional(),
  levels: z.array(z.array(z.string().max(2000)).max(40)).length(5),
});

export function registerQc(app: FastifyInstance, { pool }: Ctx) {
  const canManage = (role: string) => QC_MANAGE.includes(role as Role);

  app.get('/api/qc/meta', { preHandler: guard() }, async () => ({ facilityKinds: FACILITY_KIND, assessmentKinds: ASSESSMENT_KIND, methods: METHODS }));

  /* ---------- Bộ tiêu chí ---------- */

  app.get('/api/qc/sets', { preHandler: guard() }, async () =>
    many(pool, `SELECT s.*, (SELECT count(*)::int FROM qc_criteria c WHERE c.set_id = s.id) AS criteria,
                       EXISTS (SELECT 1 FROM qc_assessments a WHERE a.set_id = s.id) AS in_use
                  FROM qc_sets s ORDER BY s.status = 'hieu_luc' DESC, s.status = 'du_thao' DESC, s.code, s.created_at DESC`));

  app.get('/api/qc/sets/:id', { preHandler: guard() }, async (req) => setDetail(pool, z.object({ id: uuid }).parse(req.params).id));

  /** Tạo bộ mới trống (ví dụ bộ tiêu chí phòng khám) */
  app.post('/api/qc/sets', { preHandler: guard(...QC_MANAGE) }, async (req) => {
    const b = z.object({
      code: z.string().trim().min(2).max(30), name: z.string().trim().min(3).max(300), version: z.string().trim().min(1).max(20),
      facilityKind: z.enum(['ccnv', 'phong_kham', 'khac']), source: txt(1000),
    }).parse(req.body);
    return withTx(pool, (tx) => importSet(tx, actorOf(req), { ...b, criteria: [] }));
  });

  /** Tải bộ tiêu chí ra Excel (mỗi tiểu mục một dòng) để sửa ngoài phần mềm */
  app.get('/api/qc/sets/:id/xlsx', { preHandler: guard() }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const s = await one(pool, 'SELECT code, version FROM qc_sets WHERE id = $1', [id]);
    if (!s) throw new HttpError(404, 'Không tìm thấy bộ tiêu chí');
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${encodeURIComponent(`${s.code}-${s.version}.xlsx`)}"`);
    return setToXlsx(pool, id);
  });

  /** Nạp Excel đã sửa thành phiên bản dự thảo mới; ban hành như bộ soạn trên phần mềm */
  app.post('/api/qc/sets/import', { preHandler: guard(...QC_MANAGE), bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const b = z.object({
      code: z.string().trim().min(2).max(30), name: z.string().trim().min(3).max(300), version: z.string().trim().min(1).max(20),
      facilityKind: z.enum(['ccnv', 'phong_kham', 'khac']), source: txt(1000), fileBase64: z.string().min(10).max(11_000_000),
    }).parse(req.body);
    const criteria = await xlsxToCriteria(Buffer.from(b.fileBase64.replace(/^data:[^,]*,/, ''), 'base64'));
    const { fileBase64: _f, ...meta } = b;
    return withTx(pool, (tx) => importSet(tx, actorOf(req), { ...meta, criteria }));
  });

  app.post('/api/qc/sets/:id/clone', { preHandler: guard(...QC_MANAGE) }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ version: z.string().trim().min(1).max(20), name: txt(300), code: z.string().trim().min(2).max(30).nullish() }).parse(req.body);
    return withTx(pool, (tx) => cloneSet(tx, actorOf(req), id, b));
  });

  app.patch('/api/qc/sets/:id', { preHandler: guard(...QC_MANAGE) }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(3).max(300).optional(), source: txt(1000), facilityKind: z.enum(['ccnv', 'phong_kham', 'khac']).optional() }).parse(req.body);
    return withTx(pool, (tx) => updateSet(tx, actorOf(req), id, b));
  });

  app.delete('/api/qc/sets/:id', { preHandler: guard(...QC_MANAGE) }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await withTx(pool, (tx) => deleteDraftSet(tx, actorOf(req), id));
    return { ok: true };
  });

  app.post('/api/qc/sets/:id/approve', { preHandler: guard(...QC_APPROVE) }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return withTx(pool, (tx) => approveSet(tx, actorOf(req), id));
  });

  app.post('/api/qc/sets/:id/criteria', { preHandler: guard(...QC_MANAGE) }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = criterionBody.parse(req.body);
    return withTx(pool, (tx) => saveCriterion(tx, actorOf(req), id, null, b));
  });

  app.put('/api/qc/sets/:id/criteria/:cid', { preHandler: guard(...QC_MANAGE) }, async (req) => {
    const { id, cid } = z.object({ id: uuid, cid: uuid }).parse(req.params);
    const b = criterionBody.parse(req.body);
    return withTx(pool, (tx) => saveCriterion(tx, actorOf(req), id, cid, b));
  });

  app.delete('/api/qc/sets/:id/criteria/:cid', { preHandler: guard(...QC_MANAGE) }, async (req) => {
    const { id, cid } = z.object({ id: uuid, cid: uuid }).parse(req.params);
    await withTx(pool, (tx) => deleteCriterion(tx, actorOf(req), id, cid));
    return { ok: true };
  });

  /* ---------- Đợt đánh giá ---------- */

  app.get('/api/qc/assessments', { preHandler: guard() }, async (req) =>
    many(pool, `
      SELECT a.*, s.code AS set_code, s.name AS set_name, s.version AS set_version,
             count(sc.*)::int AS total, count(sc.*) FILTER (WHERE NOT sc.applicable OR sc.final_level IS NOT NULL)::int AS done,
             count(sc.*) FILTER (WHERE sc.assessor_id = $1)::int AS mine,
             count(sc.*) FILTER (WHERE sc.assessor_id = $1 AND sc.applicable AND sc.final_level IS NULL)::int AS mine_todo,
             round(sum(sc.final_level * c.weight) FILTER (WHERE sc.applicable) / nullif(sum(c.weight) FILTER (WHERE sc.applicable AND sc.final_level IS NOT NULL), 0), 2)::float AS average
        FROM qc_assessments a JOIN qc_sets s ON s.id = a.set_id
        LEFT JOIN qc_scores sc ON sc.assessment_id = a.id LEFT JOIN qc_criteria c ON c.id = sc.criterion_id
       GROUP BY a.id, s.id ORDER BY a.period_to DESC, a.created_at DESC`, [req.user.id]));

  app.post('/api/qc/assessments', { preHandler: guard(...QC_MANAGE) }, async (req) => {
    const b = z.object({
      setId: uuid, name: z.string().trim().min(3).max(300), kind: z.enum(['tu_danh_gia', 'kiem_tra_cap_tren', 'danh_gia_ngoai']),
      periodFrom: date, periodTo: date, note: txt(2000),
    }).parse(req.body);
    return withTx(pool, (tx) => createAssessment(tx, actorOf(req), b));
  });

  app.get('/api/qc/assessments/:id', { preHandler: guard() }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const a = await one(pool, `SELECT a.*, s.code AS set_code, s.name AS set_name, s.version AS set_version
                                 FROM qc_assessments a JOIN qc_sets s ON s.id = a.set_id WHERE a.id = $1`, [id]);
    if (!a) throw new HttpError(404, 'Không tìm thấy đợt đánh giá');
    return { ...a, rows: await assessmentRows(pool, id) };
  });

  app.put('/api/qc/assessments/:id/assign', { preHandler: guard(...QC_MANAGE) }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ rows: z.array(z.object({ criterionId: uuid, assessorId: uuid.nullable() })).min(1).max(500) }).parse(req.body);
    await withTx(pool, (tx) => assignAssessors(tx, actorOf(req), id, b.rows));
    return { ok: true };
  });

  /** Phiếu chấm một tiêu chí: tiêu chí, tiểu mục, kết quả đã chấm */
  app.get('/api/qc/assessments/:id/criteria/:cid', { preHandler: guard() }, async (req) => {
    const { id, cid } = z.object({ id: uuid, cid: uuid }).parse(req.params);
    const s = await one(pool, `
      SELECT sc.*, ua.full_name AS assessor_name, us.full_name AS scored_by_name, a.status AS assessment_status, a.name AS assessment_name,
             c.part, c.part_name, c.chapter, c.chapter_name, c.code, c.title, c.legal_basis, c.owner_unit, c.weight::float AS weight
        FROM qc_scores sc JOIN qc_assessments a ON a.id = sc.assessment_id JOIN qc_criteria c ON c.id = sc.criterion_id
        LEFT JOIN users ua ON ua.id = sc.assessor_id LEFT JOIN users us ON us.id = sc.scored_by
       WHERE sc.assessment_id = $1 AND sc.criterion_id = $2`, [id, cid]);
    if (!s) throw new HttpError(404, 'Tiêu chí không thuộc đợt đánh giá');
    const items = await many(pool, 'SELECT id, level, ordinal, text FROM qc_items WHERE criterion_id = $1 ORDER BY ordinal', [cid]);
    return { ...s, items, canEdit: s.assessment_status === 'dang_cham' && (canManage(req.user.role) || s.assessor_id === req.user.id) };
  });

  app.put('/api/qc/assessments/:id/criteria/:cid', { preHandler: guard() }, async (req) => {
    const { id, cid } = z.object({ id: uuid, cid: uuid }).parse(req.params);
    const b = z.object({
      applicable: z.boolean(), results: z.record(z.string(), z.boolean().nullable()), finalLevel: z.number().int().min(1).max(5).nullish(),
      currentState: txt(8000), methods: z.array(z.string().max(80)).max(10).optional(), explanation: txt(8000), doubts: txt(4000),
      evidence: txt(4000), improvement: txt(4000), reviewerNote: txt(4000),
    }).parse(req.body);
    return withTx(pool, (tx) => saveScore(tx, { id: req.user.id, name: req.user.name }, canManage(req.user.role), id, cid, b));
  });

  app.post('/api/qc/assessments/:id/close', { preHandler: guard(...QC_MANAGE) }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return withTx(pool, (tx) => closeAssessment(tx, actorOf(req), id));
  });

  app.post('/api/qc/assessments/:id/reopen', { preHandler: guard('director', 'admin') }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason: z.string().trim().min(5).max(1000) }).parse(req.body);
    return withTx(pool, (tx) => reopenAssessment(tx, actorOf(req), id, b.reason));
  });

  /** Báo cáo tổng hợp; ?format=csv xuất Excel */
  app.get('/api/qc/assessments/:id/summary', { preHandler: guard() }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({ format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    const s = await assessmentSummary(pool, id);
    if (q.format === 'json') return s;
    const o = s.overall;
    const rows: (string | number | null)[][] = [
      [`Báo cáo đánh giá chất lượng: ${s.assessment.name}`], [`Bộ tiêu chí: ${s.assessment.set_name} (${s.assessment.set_version})`], [],
      ['Tổng số tiêu chí', o.total], ['Số tiêu chí áp dụng', o.applicable], ['Tổng điểm', o.points], ['Điểm trung bình', o.average], [],
      ['Mức', ...s.byLevel.map((l) => `Mức ${l.level}`)], ['Số tiêu chí', ...s.byLevel.map((l) => l.n)], ['Tỷ lệ (%)', ...s.byLevel.map((l) => l.pct)], [],
      ['Phần', 'Tên', 'Áp dụng', 'Điểm', 'Trung bình'], ...s.parts.map((p) => [p.code, p.name, p.applicable, p.points, p.average]), [],
      ['Mã', 'Tiêu chí', 'Phụ trách', 'Người chấm', 'Hệ số', 'Mức', s.previous ? 'Mức kỳ trước' : '', 'Giải trình', 'Góp ý', 'Cải tiến'],
      ...s.rows.map((r) => [r.code, r.title, r.owner_unit, r.assessor_name, r.weight, r.applicable ? r.final_level : 'Không áp dụng',
        s.previous ? (s.previous.levels[r.code] ?? '') : '', r.explanation, r.reviewer_note, r.improvement]),
    ];
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="danh-gia-chat-luong.csv"');
    return toCsv(rows);
  });
}
