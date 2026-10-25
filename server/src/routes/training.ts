import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { TRAINING_KIND } from '../hr.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import {
  activeCert, approveBlueprint, approveProcedure, approveQuestions, attemptForTaker, cancelPlanItem, CHECK_KIND, cloneBlueprint, cloneProcedure, closePlanItem,
  createBlueprint, createExam, createProcedure, DIFFICULTY, EVIDENCE_DAYS, finalizeExpired, grantPrivilege, importQuestionsXlsx, issueCert, loadAttempt,
  PRACTICE, procedureDetail, PURPOSE, QUESTION_KIND, questionsToXlsx, recordSkillCheck, revokeCert, revokePrivilege, ruleAvailability, saveAnswers,
  savePlanItem, saveQuestion, setQuestionStatus, startAttempt, startPractice, submitAttempt, trainingReport, updateBlueprint, updateProcedure,
} from '../training.js';

/** Quản lý đào tạo soạn câu hỏi, bộ đề, kỳ thi, kế hoạch, chấm thực hành; Ban Giám đốc ban hành bộ đề và quy trình */
const TR_MANAGE: Role[] = ['qa', 'supervisor', 'hr', 'admin', 'director'];
const Q_APPROVE: Role[] = ['qa', 'supervisor', 'admin', 'director'];
const TR_APPROVE: Role[] = ['director', 'admin'];
const DOC_EDIT: Role[] = ['qa', 'admin', 'director'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
const txt = (n: number) => z.string().trim().max(n).nullish();
const idParam = (req: FastifyRequest) => z.object({ id: uuid }).parse(req.params).id;

const questionBody = z.object({
  topic: z.string().trim().min(2).max(120), difficulty: z.number().int().min(1).max(3), roles: z.array(z.string().trim().max(60)).max(20).optional(),
  kind: z.enum(['mot_dap_an', 'nhieu_dap_an', 'dung_sai']), stem: z.string().trim().min(5).max(2000),
  options: z.array(z.string().max(500)).max(6), answer: z.array(z.string().max(2)).min(1).max(6),
  explanation: txt(2000), reference: txt(300),
});
const ruleBody = z.object({ topic: z.string().trim().min(1).max(120), difficulty: z.number().int().min(1).max(3).nullish(), count: z.number().int().min(1).max(200) });
const blueprintFields = {
  name: z.string().trim().min(3).max(200), purpose: z.enum(['sat_hach', 'dinh_ky', 'luyen_tap']), mode: z.enum(['ngau_nhien', 'co_dinh']),
  rules: z.array(ruleBody).max(50).default([]), questionIds: z.array(uuid).max(300).default([]),
  durationMin: z.number().int().min(1).max(300), passPct: z.number().int().min(1).max(100), maxAttempts: z.number().int().min(1).max(20).nullish(),
  shuffle: z.boolean().default(true), note: txt(1000),
};
const procedureFields = {
  title: z.string().trim().min(3).max(300), category: txt(120), roles: z.array(z.string().max(60)).max(20).optional(), documentId: uuid.nullish(),
  epcrFlags: z.array(z.string().max(40)).max(20).optional(), passPct: z.number().int().min(1).max(100).optional(),
  privilegeMonths: z.number().int().min(1).max(120).optional(), source: txt(1000),
  steps: z.array(z.object({ text: z.string().max(1000), critical: z.boolean().optional() })).max(80),
};
const planBody = z.object({
  year: z.number().int().min(2020).max(2100), title: z.string().trim().min(3).max(300), kind: z.enum(Object.keys(TRAINING_KIND) as [string, ...string[]]),
  hours: z.number().min(0).max(500), plannedMonth: z.number().int().min(1).max(12), targetTitles: z.array(z.string().max(60)).max(20).optional(),
  procedureCode: txt(30), trainer: txt(200), provider: txt(200), note: txt(1000),
});

export function registerTraining(app: FastifyInstance, { pool }: Ctx) {
  const canManage = (role: string) => TR_MANAGE.includes(role as Role);

  app.get('/api/training/meta', { preHandler: guard() }, async () => ({
    questionKinds: QUESTION_KIND, difficulty: DIFFICULTY, purposes: PURPOSE, checkKinds: CHECK_KIND, trainingKinds: TRAINING_KIND,
    practice: PRACTICE, evidenceDays: EVIDENCE_DAYS,
  }));

  app.get('/api/training/settings', { preHandler: guard() }, async () => one(pool, 'SELECT require_cert, cert_months, updated_at FROM tr_settings WHERE id = 1'));
  app.put('/api/training/settings', { preHandler: guard(...TR_APPROVE) }, async (req) => {
    const b = z.object({ requireCert: z.boolean(), certMonths: z.number().int().min(1).max(120) }).parse(req.body);
    return withTx(pool, async (tx) => {
      const r = await one(tx, `UPDATE tr_settings SET require_cert = $1, cert_months = $2, updated_by = $3, updated_at = now() WHERE id = 1 RETURNING *`,
        [b.requireCert, b.certMonths, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'training.settings_updated', 'tr_settings', '1', b);
      return r;
    });
  });

  /** Trang của từng nhân viên: chứng nhận, kỳ thi đang mở cho mình, bài đã làm, quyền kỹ thuật, tài liệu cần đọc */
  app.get('/api/training/me', { preHandler: guard() }, async (req) => {
    const s = await one(pool, 'SELECT id, code, full_name, title FROM staff WHERE user_id = $1', [req.user.id]);
    const settings = await one(pool, 'SELECT require_cert, cert_months FROM tr_settings WHERE id = 1');
    const toRead = await many(pool, toReadSql, [req.user.id, req.user.role]);
    const practice = await many(pool, `SELECT id, name, duration_min, pass_pct, rules, question_ids, mode FROM tr_blueprints WHERE status = 'hieu_luc' AND purpose = 'luyen_tap' ORDER BY name`);
    const topics = await many(pool, `SELECT topic, count(*)::int AS n FROM tr_questions WHERE status = 'hieu_luc' GROUP BY topic ORDER BY topic`);
    if (!s) return { staff: null, settings, toRead, practice, topics, exams: [], attempts: [], privileges: [], cert: null, checks: [] };
    await withTx(pool, (tx) => finalizeExpired(tx, s.id));
    const [cert, exams, attempts, privileges, checks] = await Promise.all([
      activeCert(pool, s.id),
      many(pool, `SELECT e.id, e.name, e.opens_on, e.closes_on, b.duration_min, b.pass_pct, b.max_attempts, b.purpose,
                         (vn_today() BETWEEN e.opens_on AND e.closes_on AND e.status = 'mo') AS open,
                         (SELECT count(*)::int FROM tr_attempts a WHERE a.exam_id = e.id AND a.staff_id = $1) AS tries,
                         (SELECT bool_or(passed) FROM tr_attempts a WHERE a.exam_id = e.id AND a.staff_id = $1) AS passed,
                         (SELECT max(pct)::float FROM tr_attempts a WHERE a.exam_id = e.id AND a.staff_id = $1) AS best_pct
                    FROM tr_exams e JOIN tr_exam_candidates c ON c.exam_id = e.id AND c.staff_id = $1 JOIN tr_blueprints b ON b.id = e.blueprint_id
                   WHERE e.closes_on >= vn_today() - 30 ORDER BY e.opens_on DESC`, [s.id]),
      many(pool, `SELECT id, exam_id, name, purpose, started_at, deadline, submitted_at, score, total, pct::float, passed FROM tr_attempts WHERE staff_id = $1 ORDER BY started_at DESC LIMIT 30`, [s.id]),
      many(pool, `SELECT v.*, p.title FROM tr_privileges v LEFT JOIN tr_procedures p ON p.code = v.procedure_code AND p.status = 'hieu_luc'
                   WHERE v.staff_id = $1 AND v.revoked_at IS NULL ORDER BY v.procedure_code`, [s.id]),
      many(pool, `SELECT c.id, c.kind, c.score_pct::float, c.passed, c.at, p.code, p.title FROM tr_skill_checks c JOIN tr_procedures p ON p.id = c.procedure_id
                   WHERE c.staff_id = $1 ORDER BY c.at DESC LIMIT 20`, [s.id]),
    ]);
    return { staff: s, settings, cert, exams, attempts, privileges, checks, toRead, practice, topics };
  });

  /* ---------- Ngân hàng câu hỏi ---------- */

  app.get('/api/training/questions', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const q = z.object({ status: z.enum(['du_thao', 'hieu_luc', 'ngung']).optional(), topic: z.string().max(120).optional() }).parse(req.query);
    return many(pool, `SELECT q.*, u.full_name AS created_by_name, a.full_name AS approved_by_name FROM tr_questions q
                         LEFT JOIN users u ON u.id = q.created_by LEFT JOIN users a ON a.id = q.approved_by
                        WHERE ($1::text IS NULL OR q.status = $1) AND ($2::text IS NULL OR q.topic = $2)
                        ORDER BY q.topic, q.difficulty, q.code`, [q.status ?? null, q.topic ?? null]);
  });

  app.get('/api/training/topics', { preHandler: guard() }, async () =>
    many(pool, `SELECT topic, count(*) FILTER (WHERE status = 'hieu_luc')::int AS active, count(*) FILTER (WHERE status = 'du_thao')::int AS draft,
                       count(*) FILTER (WHERE status = 'hieu_luc' AND difficulty = 1)::int AS d1, count(*) FILTER (WHERE status = 'hieu_luc' AND difficulty = 2)::int AS d2,
                       count(*) FILTER (WHERE status = 'hieu_luc' AND difficulty = 3)::int AS d3
                  FROM tr_questions WHERE status <> 'ngung' GROUP BY topic ORDER BY topic`));

  app.post('/api/training/questions', { preHandler: guard(...TR_MANAGE) }, async (req) =>
    withTx(pool, (tx) => saveQuestion(tx, actorOf(req), null, questionBody.parse(req.body))));
  app.put('/api/training/questions/:id', { preHandler: guard(...TR_MANAGE) }, async (req) =>
    withTx(pool, (tx) => saveQuestion(tx, actorOf(req), idParam(req), questionBody.parse(req.body))));
  app.post('/api/training/questions/approve', { preHandler: guard(...Q_APPROVE) }, async (req) => {
    const b = z.object({ ids: z.array(uuid).min(1).max(500) }).parse(req.body);
    return withTx(pool, (tx) => approveQuestions(tx, actorOf(req), b.ids));
  });
  app.post('/api/training/questions/:id/retire', { preHandler: guard(...TR_MANAGE) }, async (req) =>
    withTx(pool, (tx) => setQuestionStatus(tx, actorOf(req), idParam(req), 'ngung')));
  app.post('/api/training/questions/:id/restore', { preHandler: guard(...TR_MANAGE) }, async (req) =>
    withTx(pool, (tx) => setQuestionStatus(tx, actorOf(req), idParam(req), 'du_thao')));

  app.get('/api/training/questions.xlsx', { preHandler: guard(...TR_MANAGE) }, async (_req, reply) => {
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="ngan-hang-cau-hoi.xlsx"`);
    return questionsToXlsx(pool);
  });
  app.post('/api/training/questions/import', { preHandler: guard(...TR_MANAGE), bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const b = z.object({ fileBase64: z.string().min(10).max(11_000_000) }).parse(req.body);
    return withTx(pool, (tx) => importQuestionsXlsx(tx, actorOf(req), Buffer.from(b.fileBase64.replace(/^data:[^,]*,/, ''), 'base64')));
  });

  /* ---------- Bộ đề ---------- */

  app.get('/api/training/blueprints', { preHandler: guard(...TR_MANAGE) }, async () =>
    many(pool, `SELECT b.*, u.full_name AS created_by_name, a.full_name AS approved_by_name,
                       CASE WHEN b.mode = 'co_dinh' THEN cardinality(b.question_ids) ELSE (SELECT coalesce(sum((r->>'count')::int), 0) FROM jsonb_array_elements(b.rules) r) END::int AS question_count,
                       EXISTS (SELECT 1 FROM tr_exams e WHERE e.blueprint_id = b.id) AS in_use
                  FROM tr_blueprints b LEFT JOIN users u ON u.id = b.created_by LEFT JOIN users a ON a.id = b.approved_by
                 ORDER BY b.status = 'hieu_luc' DESC, b.status = 'du_thao' DESC, b.code, b.created_at DESC`));

  app.get('/api/training/blueprints/:id', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = await one(pool, 'SELECT * FROM tr_blueprints WHERE id = $1', [idParam(req)]);
    if (!b) throw new HttpError(404, 'Không tìm thấy bộ đề');
    const availability = b.mode === 'ngau_nhien' ? await ruleAvailability(pool, b.rules) : [];
    const questions = b.mode === 'co_dinh' ? await many(pool, `SELECT id, code, topic, difficulty, stem, status FROM tr_questions WHERE id = ANY($1)`, [b.question_ids]) : [];
    return { ...b, availability, questions };
  });

  app.post('/api/training/blueprints', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = z.object({ code: z.string().trim().min(2).max(30), version: z.string().trim().min(1).max(20), ...blueprintFields }).parse(req.body);
    return withTx(pool, (tx) => createBlueprint(tx, actorOf(req), b));
  });
  app.put('/api/training/blueprints/:id', { preHandler: guard(...TR_MANAGE) }, async (req) =>
    withTx(pool, (tx) => updateBlueprint(tx, actorOf(req), idParam(req), z.object(blueprintFields).parse(req.body))));
  app.post('/api/training/blueprints/:id/approve', { preHandler: guard(...TR_APPROVE) }, async (req) =>
    withTx(pool, (tx) => approveBlueprint(tx, actorOf(req), idParam(req))));
  app.post('/api/training/blueprints/:id/clone', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = z.object({ version: z.string().trim().min(1).max(20) }).parse(req.body);
    return withTx(pool, (tx) => cloneBlueprint(tx, actorOf(req), idParam(req), b.version));
  });
  app.delete('/api/training/blueprints/:id', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const id = idParam(req);
    return withTx(pool, async (tx) => {
      const r = await one(tx, `DELETE FROM tr_blueprints WHERE id = $1 AND status = 'du_thao' AND NOT EXISTS (SELECT 1 FROM tr_attempts a WHERE a.blueprint_id = $1) RETURNING code, version`, [id]);
      if (!r) throw new HttpError(409, 'Chỉ xóa bộ đề dự thảo chưa dùng');
      await audit(tx, 'system', actorOf(req), 'training.blueprint_deleted', 'tr_blueprint', id, r);
      return { ok: true };
    });
  });

  /* ---------- Kỳ thi ---------- */

  app.get('/api/training/exams', { preHandler: guard(...TR_MANAGE) }, async () =>
    many(pool, `SELECT e.*, b.name AS blueprint_name, b.version AS blueprint_version, b.pass_pct,
                       (SELECT count(*)::int FROM tr_exam_candidates c WHERE c.exam_id = e.id) AS candidates,
                       (SELECT count(DISTINCT a.staff_id)::int FROM tr_attempts a WHERE a.exam_id = e.id AND a.submitted_at IS NOT NULL) AS taken,
                       (SELECT count(DISTINCT a.staff_id)::int FROM tr_attempts a WHERE a.exam_id = e.id AND a.passed) AS passed
                  FROM tr_exams e JOIN tr_blueprints b ON b.id = e.blueprint_id ORDER BY e.opens_on DESC, e.created_at DESC LIMIT 200`));

  app.post('/api/training/exams', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = z.object({
      blueprintId: uuid, name: z.string().trim().min(3).max(200), opensOn: date, closesOn: date,
      staffIds: z.array(uuid).max(1000).default([]), titles: z.array(z.string().max(60)).max(20).optional(), stationId: z.string().max(40).nullish(),
    }).parse(req.body);
    // Chọn theo chức danh/điểm thì lấy mọi nhân viên đang làm khớp điều kiện
    let ids = b.staffIds;
    if (!ids.length && (b.titles?.length || b.stationId)) {
      ids = (await many(pool, `SELECT id FROM staff WHERE status = 'dang_lam' AND ($1::text[] IS NULL OR title = ANY($1)) AND ($2::text IS NULL OR station_id = $2)`,
        [b.titles?.length ? b.titles : null, b.stationId ?? null])).map((r) => r.id);
    }
    return withTx(pool, (tx) => createExam(tx, actorOf(req), { ...b, staffIds: ids }));
  });

  app.get('/api/training/exams/:id', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const id = idParam(req);
    await withTx(pool, (tx) => finalizeExpired(tx));
    const e = await one(pool, `SELECT e.*, b.name AS blueprint_name, b.pass_pct, b.max_attempts FROM tr_exams e JOIN tr_blueprints b ON b.id = e.blueprint_id WHERE e.id = $1`, [id]);
    if (!e) throw new HttpError(404, 'Không tìm thấy kỳ thi');
    const rows = await many(pool, `
      SELECT s.id AS staff_id, s.code, s.full_name, s.title, s.station_id,
             count(a.id) FILTER (WHERE a.submitted_at IS NOT NULL)::int AS tries, max(a.pct)::float AS best_pct, bool_or(a.passed) AS passed,
             max(a.submitted_at) AS last_at, (array_agg(a.id ORDER BY a.pct DESC NULLS LAST))[1] AS best_attempt
        FROM tr_exam_candidates c JOIN staff s ON s.id = c.staff_id
        LEFT JOIN tr_attempts a ON a.exam_id = c.exam_id AND a.staff_id = c.staff_id
       WHERE c.exam_id = $1 GROUP BY s.id ORDER BY s.full_name`, [id]);
    // Câu sai nhiều nhất giúp tìm nội dung cần đào tạo lại
    const hard = await many(pool, `
      SELECT x->>'code' AS code, x->>'topic' AS topic, x->>'stem' AS stem, count(*)::int AS asked,
             count(*) FILTER (WHERE NOT ((a.answers -> (x->>'id')) @> (x->'answer') AND (x->'answer') @> coalesce(a.answers -> (x->>'id'), '[]'::jsonb)))::int AS wrong
        FROM tr_attempts a, jsonb_array_elements(a.questions) x
       WHERE a.exam_id = $1 AND a.submitted_at IS NOT NULL
       GROUP BY 1, 2, 3 ORDER BY wrong DESC, asked DESC LIMIT 10`, [id]);
    return { ...e, rows, hard };
  });

  app.post('/api/training/exams/:id/close', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const id = idParam(req);
    return withTx(pool, async (tx) => {
      const r = await one(tx, `UPDATE tr_exams SET status = 'dong' WHERE id = $1 AND status = 'mo' RETURNING id, name`, [id]);
      if (!r) throw new HttpError(409, 'Kỳ thi đã đóng');
      await finalizeExpired(tx);
      await audit(tx, 'system', actorOf(req), 'training.exam_closed', 'tr_exam', id, { name: r.name });
      return r;
    });
  });

  /* ---------- Làm bài ---------- */

  app.post('/api/training/attempts', { preHandler: guard() }, async (req) => {
    const b = z.object({ examId: uuid.nullish(), blueprintId: uuid.nullish() }).refine((x) => !!x.examId !== !!x.blueprintId, 'Chọn kỳ thi hoặc bộ đề luyện tập').parse(req.body);
    const a = await withTx(pool, (tx) => startAttempt(tx, req.user, b));
    return attemptForTaker(await loadAttempt(pool, a.id));
  });

  app.post('/api/training/practice', { preHandler: guard() }, async (req) => {
    const b = z.object({ topic: z.string().trim().min(1).max(120) }).parse(req.body);
    const a = await withTx(pool, (tx) => startPractice(tx, req.user, b.topic));
    return attemptForTaker(await loadAttempt(pool, a.id));
  });

  app.get('/api/training/attempts/:id', { preHandler: guard() }, async (req) => {
    const id = idParam(req);
    let a = await loadAttempt(pool, id);
    if (!a || (a.user_id !== req.user.id && !canManage(req.user.role))) throw new HttpError(404, 'Không tìm thấy bài làm');
    if (!a.submitted_at && Date.now() > new Date(a.deadline).getTime() + 30_000) a = await withTx(pool, (tx) => submitAttempt(tx, null, id, true));
    // Người quản lý chỉ xem đáp án sau khi bài đã nộp, để không lộ đề đang thi
    return attemptForTaker(a);
  });

  app.put('/api/training/attempts/:id/answers', { preHandler: guard() }, async (req) => {
    const b = z.object({ answers: z.record(z.string(), z.array(z.string().max(2)).max(6)) }).parse(req.body);
    return attemptForTaker(await withTx(pool, (tx) => saveAnswers(tx, req.user.id, idParam(req), b.answers)));
  });

  app.post('/api/training/attempts/:id/submit', { preHandler: guard() }, async (req) => {
    const b = z.object({ answers: z.record(z.string(), z.array(z.string().max(2)).max(6)).optional() }).parse(req.body ?? {});
    const id = idParam(req);
    return attemptForTaker(await withTx(pool, async (tx) => {
      const a = await one(tx, 'SELECT submitted_at FROM tr_attempts WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (!a) throw new HttpError(404, 'Không tìm thấy bài làm');
      if (b.answers && !a.submitted_at) await saveAnswers(tx, req.user.id, id, b.answers);
      return submitAttempt(tx, req.user.id, id);
    }));
  });

  /* ---------- Quy trình kỹ thuật và bảng kiểm ---------- */

  app.get('/api/training/procedures', { preHandler: guard() }, async (req) =>
    many(pool, `SELECT p.id, p.code, p.title, p.version, p.category, p.roles, p.status, p.epcr_flags, p.pass_pct, p.privilege_months, p.document_id, p.approved_at,
                       (SELECT count(*)::int FROM tr_steps s WHERE s.procedure_id = p.id) AS steps,
                       (SELECT count(*)::int FROM tr_steps s WHERE s.procedure_id = p.id AND s.critical) AS critical
                  FROM tr_procedures p WHERE p.status = 'hieu_luc' OR ($1 AND p.status = 'du_thao')
                 ORDER BY p.code, p.created_at DESC`, [canManage(req.user.role)]));

  app.get('/api/training/procedures/:id', { preHandler: guard() }, async (req) => procedureDetail(pool, idParam(req)));
  app.post('/api/training/procedures', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = z.object({ code: z.string().trim().min(2).max(30), version: z.string().trim().min(1).max(20), ...procedureFields }).parse(req.body);
    return withTx(pool, (tx) => createProcedure(tx, actorOf(req), b));
  });
  app.put('/api/training/procedures/:id', { preHandler: guard(...TR_MANAGE) }, async (req) =>
    withTx(pool, (tx) => updateProcedure(tx, actorOf(req), idParam(req), z.object(procedureFields).parse(req.body))));
  app.post('/api/training/procedures/:id/approve', { preHandler: guard(...TR_APPROVE) }, async (req) =>
    withTx(pool, (tx) => approveProcedure(tx, actorOf(req), idParam(req))));
  app.post('/api/training/procedures/:id/clone', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = z.object({ version: z.string().trim().min(1).max(20) }).parse(req.body);
    return withTx(pool, (tx) => cloneProcedure(tx, actorOf(req), idParam(req), b.version));
  });

  app.post('/api/training/skill-checks', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = z.object({
      procedureId: uuid, staffId: uuid, kind: z.enum(['sat_hach', 'giam_sat']), results: z.record(z.string(), z.boolean().nullable()),
      note: txt(2000), incidentId: uuid.nullish(), grant: z.boolean().optional(),
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      const c = await recordSkillCheck(tx, { ...actorOf(req), id: req.user.id }, b);
      // Đạt sát hạch thực hành thì người chấm có thể cấp quyền kỹ thuật ngay
      const privilege = b.grant && c.passed && b.kind === 'sat_hach'
        ? await grantPrivilege(tx, actorOf(req), { staffId: b.staffId, procedureCode: c.procedure_code, skillCheckId: c.id }) : null;
      return { ...c, privilege };
    });
  });

  app.get('/api/training/skill-checks', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const q = z.object({ staffId: uuid.optional(), procedureId: uuid.optional() }).parse(req.query);
    return many(pool, `SELECT c.id, c.kind, c.score_pct::float, c.critical_failed, c.passed, c.note, c.at, c.incident_id, p.code, p.title, s.full_name, s.code AS staff_code, u.full_name AS examiner
                         FROM tr_skill_checks c JOIN tr_procedures p ON p.id = c.procedure_id JOIN staff s ON s.id = c.staff_id JOIN users u ON u.id = c.examiner_id
                        WHERE ($1::uuid IS NULL OR c.staff_id = $1) AND ($2::uuid IS NULL OR c.procedure_id = $2) ORDER BY c.at DESC LIMIT 300`, [q.staffId ?? null, q.procedureId ?? null]);
  });

  app.get('/api/training/skill-checks/:id', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const c = await one(pool, `SELECT c.*, p.code, p.title, s.full_name, u.full_name AS examiner FROM tr_skill_checks c JOIN tr_procedures p ON p.id = c.procedure_id
                                JOIN staff s ON s.id = c.staff_id JOIN users u ON u.id = c.examiner_id WHERE c.id = $1`, [idParam(req)]);
    if (!c) throw new HttpError(404, 'Không tìm thấy lượt chấm');
    return c;
  });

  /* ---------- Phân quyền kỹ thuật, chứng nhận ---------- */

  app.post('/api/training/privileges', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = z.object({ staffId: uuid, procedureCode: z.string().max(30), skillCheckId: uuid.nullish(), note: txt(500) }).parse(req.body);
    return withTx(pool, (tx) => grantPrivilege(tx, actorOf(req), b));
  });
  app.post('/api/training/privileges/:id/revoke', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return withTx(pool, (tx) => revokePrivilege(tx, actorOf(req), idParam(req), b.reason));
  });
  app.post('/api/training/certs', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = z.object({ staffId: uuid }).parse(req.body);
    return withTx(pool, (tx) => issueCert(tx, actorOf(req), b.staffId));
  });
  app.post('/api/training/certs/:id/revoke', { preHandler: guard(...TR_APPROVE) }, async (req) => {
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return withTx(pool, (tx) => revokeCert(tx, actorOf(req), idParam(req), b.reason));
  });

  /** Bảng theo dõi nhân viên: chứng nhận, bài thi gần nhất, thực hành, quyền kỹ thuật */
  app.get('/api/training/staff', { preHandler: guard(...TR_MANAGE) }, async () =>
    many(pool, `
      SELECT s.id, s.code, s.full_name, s.title, s.station_id,
             c.id AS cert_id, c.number AS cert_number, c.expires_on AS cert_expires, (c.expires_on < vn_today() + 30) AS cert_expiring,
             (SELECT row_to_json(x) FROM (SELECT a.name, a.pct::float AS pct, a.passed, a.submitted_at FROM tr_attempts a
                WHERE a.staff_id = s.id AND a.submitted_at IS NOT NULL AND a.purpose <> 'luyen_tap' ORDER BY a.submitted_at DESC LIMIT 1) x) AS last_exam,
             (SELECT count(*)::int FROM tr_skill_checks k WHERE k.staff_id = s.id AND k.passed AND k.kind = 'sat_hach' AND k.at > now() - make_interval(days => $1)) AS recent_checks,
             EXISTS (SELECT 1 FROM tr_attempts a WHERE a.staff_id = s.id AND a.passed AND a.purpose IN ('sat_hach', 'dinh_ky') AND a.submitted_at > now() - make_interval(days => $1)) AS recent_exam,
             (SELECT array_agg(v.procedure_code ORDER BY v.procedure_code) FROM tr_privileges v WHERE v.staff_id = s.id AND v.revoked_at IS NULL AND v.expires_on >= vn_today()) AS privileges
        FROM staff s
        LEFT JOIN LATERAL (SELECT * FROM tr_certs c WHERE c.staff_id = s.id AND c.revoked_at IS NULL AND c.expires_on >= vn_today() ORDER BY c.expires_on DESC LIMIT 1) c ON true
       WHERE s.status = 'dang_lam' ORDER BY s.full_name`, [EVIDENCE_DAYS]));

  app.get('/api/training/staff/:id', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const id = idParam(req);
    const s = await one(pool, 'SELECT id, code, full_name, title, station_id FROM staff WHERE id = $1', [id]);
    if (!s) throw new HttpError(404, 'Không tìm thấy nhân viên');
    const [certs, attempts, checks, privileges, trainings] = await Promise.all([
      many(pool, `SELECT c.*, u.full_name AS issued_by_name FROM tr_certs c LEFT JOIN users u ON u.id = c.issued_by WHERE c.staff_id = $1 ORDER BY c.issued_on DESC`, [id]),
      many(pool, `SELECT id, name, purpose, submitted_at, score, total, pct::float, passed, auto_submit FROM tr_attempts WHERE staff_id = $1 AND submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 50`, [id]),
      many(pool, `SELECT c.id, c.kind, c.score_pct::float, c.critical_failed, c.passed, c.at, p.code, p.title, u.full_name AS examiner FROM tr_skill_checks c
                    JOIN tr_procedures p ON p.id = c.procedure_id JOIN users u ON u.id = c.examiner_id WHERE c.staff_id = $1 ORDER BY c.at DESC`, [id]),
      many(pool, `SELECT v.*, u.full_name AS granted_by_name, (v.revoked_at IS NULL AND v.expires_on >= vn_today()) AS active FROM tr_privileges v
                    LEFT JOIN users u ON u.id = v.granted_by WHERE v.staff_id = $1 ORDER BY v.created_at DESC`, [id]),
      many(pool, `SELECT * FROM trainings WHERE staff_id = $1 ORDER BY completed_on DESC LIMIT 50`, [id]),
    ]);
    return { ...s, certs, attempts, checks, privileges, trainings };
  });

  /* ---------- Kế hoạch đào tạo, báo cáo ---------- */

  app.get('/api/training/plan', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const q = z.object({ year: z.coerce.number().int().min(2020).max(2100) }).parse(req.query);
    return many(pool, `SELECT p.*, (SELECT count(*)::int FROM tr_attendance a WHERE a.plan_item_id = p.id) AS attendees,
                              (SELECT count(*)::int FROM staff s WHERE s.status = 'dang_lam' AND (cardinality(p.target_titles) = 0 OR s.title = ANY(p.target_titles))) AS target
                         FROM tr_plan_items p WHERE p.year = $1 ORDER BY p.planned_month, p.title`, [q.year]);
  });
  app.post('/api/training/plan', { preHandler: guard(...TR_MANAGE) }, async (req) =>
    withTx(pool, (tx) => savePlanItem(tx, actorOf(req), null, planBody.parse(req.body))));
  app.put('/api/training/plan/:id', { preHandler: guard(...TR_MANAGE) }, async (req) =>
    withTx(pool, (tx) => savePlanItem(tx, actorOf(req), idParam(req), planBody.parse(req.body))));
  app.post('/api/training/plan/:id/close', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = z.object({ heldOn: date, staffIds: z.array(uuid).max(1000) }).parse(req.body);
    return withTx(pool, (tx) => closePlanItem(tx, actorOf(req), idParam(req), b));
  });
  app.post('/api/training/plan/:id/cancel', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return withTx(pool, (tx) => cancelPlanItem(tx, actorOf(req), idParam(req), b.reason));
  });

  app.get('/api/training/report', { preHandler: guard(...TR_MANAGE) }, async (req) => {
    const q = z.object({ year: z.coerce.number().int().min(2020).max(2100) }).parse(req.query);
    return trainingReport(pool, q.year);
  });

  /* ---------- Đọc và xác nhận tài liệu (QLCL-01) ---------- */

  app.get('/api/documents/to-read', { preHandler: guard() }, async (req) => many(pool, toReadSql, [req.user.id, req.user.role]));

  app.post('/api/documents/:id/read', { preHandler: guard() }, async (req) => {
    const id = idParam(req);
    return withTx(pool, async (tx) => {
      const d = await one(tx, `SELECT code, version FROM documents WHERE id = $1 AND status = 'hieu_luc'`, [id]);
      if (!d) throw new HttpError(409, 'Chỉ xác nhận đọc tài liệu đang hiệu lực');
      const r = await tx.query(`INSERT INTO document_reads(document_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, req.user.id]);
      if (r.rowCount) await audit(tx, 'system', actorOf(req), 'document.read', 'document', id, d);
      return { ok: true };
    });
  });

  app.patch('/api/documents/:id/read-policy', { preHandler: guard(...DOC_EDIT) }, async (req) => {
    const id = idParam(req);
    const b = z.object({ mustRead: z.boolean(), roles: z.array(z.string().max(30)).max(20).default([]) }).parse(req.body);
    return withTx(pool, async (tx) => {
      const d = await one(tx, `UPDATE documents SET must_read = $2, read_roles = $3 WHERE id = $1 RETURNING id, code, must_read, read_roles`, [id, b.mustRead, b.roles]);
      if (!d) throw new HttpError(404, 'Không tìm thấy tài liệu');
      await audit(tx, 'system', actorOf(req), 'document.read_policy', 'document', id, b);
      return d;
    });
  });

  /** Ai đã đọc, ai chưa đọc một tài liệu bắt buộc */
  app.get('/api/documents/:id/reads', { preHandler: guard(...DOC_EDIT, 'supervisor', 'hr') }, async (req) => {
    const id = idParam(req);
    const d = await one(pool, 'SELECT id, code, title, version, must_read, read_roles FROM documents WHERE id = $1', [id]);
    if (!d) throw new HttpError(404, 'Không tìm thấy tài liệu');
    const rows = await many(pool, `SELECT u.id, u.full_name, u.role, r.at FROM users u LEFT JOIN document_reads r ON r.document_id = $1 AND r.user_id = u.id
                                    WHERE u.active AND (cardinality($2::text[]) = 0 OR u.role = ANY($2) OR r.at IS NOT NULL)
                                    ORDER BY r.at IS NULL DESC, u.full_name`, [id, d.read_roles]);
    return { ...d, rows, read: rows.filter((r) => r.at).length, total: rows.length };
  });
}

const toReadSql = `SELECT d.id, d.code, d.title, d.kind, d.version, d.url, d.effective_on FROM documents d
                    WHERE d.status = 'hieu_luc' AND d.must_read AND (cardinality(d.read_roles) = 0 OR $2 = ANY(d.read_roles))
                      AND NOT EXISTS (SELECT 1 FROM document_reads r WHERE r.document_id = d.id AND r.user_id = $1)
                    ORDER BY d.effective_on DESC NULLS LAST, d.code`;
