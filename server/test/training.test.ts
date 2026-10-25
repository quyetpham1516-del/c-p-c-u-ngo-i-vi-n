import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { grade, gradeChecklist, normalizeQuestion, privilegeGaps } from '../src/training.js';
import { freshApp, login, token } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let qa: Client, giamdoc: Client, sup: Client, bs: Client, dd: Client, nhansu: Client;
const vnDate = (d = 0) => new Date(Date.now() + 7 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
const staffOf = async (username: string) => (await one('SELECT s.id FROM staff s JOIN users u ON u.id = s.user_id WHERE u.username = $1', [username])).id as string;
/** Đáp án đúng của một bài làm, đọc thẳng từ cơ sở dữ liệu */
const keyOf = async (attemptId: string) => {
  const a = await one('SELECT questions FROM tr_attempts WHERE id = $1', [attemptId]);
  return Object.fromEntries(a.questions.map((q: any) => [q.id, q.answer]));
};

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [qa, giamdoc, sup, bs, dd, nhansu] = await Promise.all(['qlcl', 'giamdoc', 'truongca', 'bs.als', 'dd.als', 'nhansu'].map((u) => login(app, u)));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('chấm điểm', () => {
  it('câu nhiều đáp án phải chọn đúng và đủ; bỏ trống tính sai; đạt theo phần trăm', () => {
    const qs = [{ id: 'a', topic: 'X', answer: ['A'] }, { id: 'b', topic: 'X', answer: ['A', 'C'] }, { id: 'c', topic: 'Y', answer: ['B'] }];
    expect(grade(qs, { a: ['A'], b: ['A'], c: ['B'] }, 70)).toMatchObject({ score: 2, pct: 66.7, passed: false });
    expect(grade(qs, { a: ['A'], b: ['C', 'A'], c: ['B'] }, 70)).toMatchObject({ score: 3, pct: 100, passed: true, byTopic: { X: { correct: 2, total: 2 } } });
  });
  it('bảng kiểm: sai bước bắt buộc là không đạt dù đủ điểm; bước không áp dụng không tính', () => {
    const steps = [{ id: '1', critical: true }, { id: '2', critical: false }, { id: '3', critical: false }, { id: '4', critical: false }, { id: '5', critical: false }];
    expect(gradeChecklist(steps, { 1: true, 2: true, 3: true, 4: true, 5: false }, 80)).toMatchObject({ scorePct: 80, passed: true });
    expect(gradeChecklist(steps, { 1: false, 2: true, 3: true, 4: true, 5: true }, 80)).toMatchObject({ scorePct: 80, criticalFailed: 1, passed: false });
    expect(gradeChecklist(steps, { 1: true, 2: true, 3: true, 4: null, 5: null }, 80)).toMatchObject({ scorePct: 100, passed: true });
    expect(() => gradeChecklist(steps, { 1: true }, 80)).toThrow(/chưa chấm/);
  });
  it('kiểm tra câu hỏi: loại một đáp án chỉ một đáp án đúng, đáp án phải nằm trong phương án', () => {
    expect(() => normalizeQuestion({ topic: 'X', difficulty: 1, kind: 'mot_dap_an', stem: 'Câu hỏi?', options: ['a', 'b'], answer: ['A', 'B'] })).toThrow();
    expect(() => normalizeQuestion({ topic: 'X', difficulty: 1, kind: 'mot_dap_an', stem: 'Câu hỏi?', options: ['a', 'b'], answer: ['C'] })).toThrow();
    expect(normalizeQuestion({ topic: 'X', difficulty: 1, kind: 'dung_sai', stem: 'Câu hỏi?', options: [], answer: ['b'] }).options.map((o) => o.text)).toEqual(['Đúng', 'Sai']);
  });
});

describe('dữ liệu mẫu', () => {
  it('câu hỏi và quy trình kỹ thuật mẫu ở dạng dự thảo; danh mục quy trình công ty vào kiểm soát tài liệu ở trạng thái cần soạn', async () => {
    const r = await one(`SELECT (SELECT count(*) FROM tr_questions WHERE status = 'du_thao')::int AS q, (SELECT count(*) FROM tr_questions WHERE status <> 'du_thao')::int AS q2,
                                (SELECT count(*) FROM tr_procedures WHERE status = 'du_thao')::int AS p,
                                (SELECT count(*) FROM documents WHERE version = '0' AND status = 'du_thao' AND code LIKE 'QLCL-%')::int AS d`);
    expect(r).toMatchObject({ q: 34, q2: 0, p: 7, d: 18 });
  });
});

describe('ngân hàng câu hỏi, bộ đề, kỳ thi', () => {
  let bpId = '';
  let examId = '';
  it('người soạn không tự duyệt; người khác duyệt thì câu vào ngân hàng', async () => {
    const q = await qa('POST', '/api/training/questions', { topic: 'Phản vệ', difficulty: 2, kind: 'mot_dap_an', stem: 'Câu soạn thêm về phản vệ?', options: ['A1', 'B1', 'C1'], answer: ['B'] });
    expect(q.http).toBe(200);
    expect((await qa('POST', '/api/training/questions/approve', { ids: [q.id] })).http).toBe(403);
    expect((await bs('GET', '/api/training/questions')).http).toBe(403);
    const drafts = (await qa('GET', '/api/training/questions?status=du_thao')).data;
    expect((await sup('POST', '/api/training/questions/approve', { ids: drafts.map((d: any) => d.id) })).approved).toBe(35);
    const topics = (await qa('GET', '/api/training/topics')).data;
    expect(topics.find((t: any) => t.topic === 'Hồi sinh tim phổi').active).toBe(6);
  });

  it('bộ đề theo ma trận: ban hành kiểm tra đủ câu, người soạn không tự ban hành', async () => {
    const tooMany = await qa('POST', '/api/training/blueprints', {
      code: 'DE-QUA', version: '1', name: 'Đề vượt số câu', purpose: 'sat_hach', mode: 'ngau_nhien', rules: [{ topic: 'Phản vệ', count: 50 }], durationMin: 30, passPct: 70,
    });
    expect((await giamdoc('POST', `/api/training/blueprints/${tooMany.id}/approve`)).http).toBe(409);
    const bp = await qa('POST', '/api/training/blueprints', {
      code: 'DE-SH', version: '1', name: 'Sát hạch đầu vào kíp cấp cứu', purpose: 'sat_hach', mode: 'ngau_nhien',
      rules: [{ topic: 'Hồi sinh tim phổi', count: 4 }, { topic: 'Phản vệ', difficulty: 2, count: 2 }, { topic: 'Chấn thương', count: 2 }], durationMin: 30, passPct: 70, maxAttempts: 2,
    });
    expect(bp.http).toBe(200);
    bpId = bp.id;
    expect((await qa('POST', `/api/training/blueprints/${bpId}/approve`)).http).toBe(403);
    expect((await giamdoc('POST', `/api/training/blueprints/${bpId}/approve`)).status).toBe('hieu_luc');
    expect((await qa('PUT', `/api/training/blueprints/${bpId}`, { name: 'x x x', purpose: 'sat_hach', mode: 'ngau_nhien', rules: [], durationMin: 30, passPct: 70 })).http).toBe(409);
  });

  it('kỳ thi: chỉ người có tên được thi; đề không lộ đáp án; nộp bài thì chấm và ghi vào hồ sơ đào tạo', async () => {
    const e = await qa('POST', '/api/training/exams', { blueprintId: bpId, name: 'Sát hạch tháng 11', opensOn: vnDate(), closesOn: vnDate(7), staffIds: [await staffOf('bs.als')] });
    expect(e.http).toBe(200);
    examId = e.id;
    const me = await bs('GET', '/api/training/me');
    expect(me.exams.find((x: any) => x.id === examId).open).toBe(true);
    expect((await dd('POST', '/api/training/attempts', { examId })).http).toBe(403);
    const a = await bs('POST', '/api/training/attempts', { examId });
    expect(a.questions).toHaveLength(8);
    expect(a.questions.every((q: any) => q.answer === undefined)).toBe(true);
    expect(new Set(a.questions.map((q: any) => q.id)).size).toBe(8);
    // Bắt đầu lại thì trả đúng bài đang làm, không rút đề mới
    expect((await bs('POST', '/api/training/attempts', { examId })).id).toBe(a.id);
    const key = await keyOf(a.id);
    const wrong = Object.fromEntries(Object.entries(key).map(([k, v]: any) => [k, v[0] === 'A' ? ['B'] : ['A']]));
    expect((await bs('PUT', `/api/training/attempts/${a.id}/answers`, { answers: wrong })).http).toBe(200);
    const failed = await bs('POST', `/api/training/attempts/${a.id}/submit`, {});
    expect(failed).toMatchObject({ passed: false, score: 0, total: 8 });
    expect(failed.questions[0].answer).toBeDefined();
    const a2 = await bs('POST', '/api/training/attempts', { examId });
    const done = await bs('POST', `/api/training/attempts/${a2.id}/submit`, { answers: await keyOf(a2.id) });
    expect(done).toMatchObject({ passed: true, score: 8, pct: 100 });
    expect((await bs('POST', '/api/training/attempts', { examId })).http).toBe(409);
    const t = await one(`SELECT count(*)::int AS n FROM trainings WHERE staff_id = $1 AND kind = 'sat_hach'`, [await staffOf('bs.als')]);
    expect(t.n).toBe(1);
    const res = await qa('GET', `/api/training/exams/${examId}`);
    expect(res.rows[0]).toMatchObject({ tries: 2, passed: true, best_pct: 100 });
    expect(res.hard.length).toBeGreaterThan(0);
  });

  it('hết giờ không nộp thì tự chấm theo câu đã lưu', async () => {
    const e = await qa('POST', '/api/training/exams', { blueprintId: bpId, name: 'Sát hạch bổ sung', opensOn: vnDate(), closesOn: vnDate(1), staffIds: [await staffOf('dd.als')] });
    const a = await dd('POST', '/api/training/attempts', { examId: e.id });
    await dd('PUT', `/api/training/attempts/${a.id}/answers`, { answers: await keyOf(a.id) });
    await pool.query(`UPDATE tr_attempts SET deadline = now() - interval '5 minutes' WHERE id = $1`, [a.id]);
    expect((await dd('PUT', `/api/training/attempts/${a.id}/answers`, { answers: {} })).autoSubmit).toBe(true);
    const r = await dd('GET', `/api/training/attempts/${a.id}`);
    expect(r).toMatchObject({ autoSubmit: true, passed: true, score: 8 });
  });

  it('luyện tập nhanh theo chủ đề không tính vào sát hạch', async () => {
    const p = await dd('POST', '/api/training/practice', { topic: 'Phản vệ' });
    expect(p.questions.length).toBe(5);
    expect((await dd('POST', '/api/training/practice', { topic: 'Phản vệ' })).http).toBe(409);
    const done = await dd('POST', `/api/training/attempts/${p.id}/submit`, { answers: await keyOf(p.id) });
    expect(done).toMatchObject({ purpose: 'luyen_tap', passed: true });
    const t = await one(`SELECT count(*)::int AS n FROM trainings WHERE staff_id = $1 AND kind = 'sat_hach'`, [await staffOf('dd.als')]);
    expect(t.n).toBe(1);
  });

  it('Excel: tải ngân hàng về, sửa, nạp lại; tệp lỗi thì không nạp câu nào', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/training/questions.xlsx', headers: { authorization: `Bearer ${await token(app, 'qlcl')}` } });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as any);
    const ws = wb.worksheets[0];
    ws.getRow(2).getCell(6).value = 'Câu hỏi đã sửa trong Excel?';
    ws.addRow(['', 'Chủ đề mới', 1, '', 'Đúng / Sai', 'Câu đúng sai mới?', '', '', '', '', '', '', 'A', '', '']);
    const ok = await qa('POST', '/api/training/questions/import', { fileBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') });
    expect(ok).toMatchObject({ created: 1, updated: 35 });
    ws.addRow(['', 'Chủ đề mới', 1, '', 'Một đáp án đúng', 'Câu lỗi?', 'x', 'y', '', '', '', '', 'D', '', '']);
    const bad = await qa('POST', '/api/training/questions/import', { fileBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') });
    expect(bad.http).toBe(400);
    expect(bad.details.errors[0]).toMatch(/Dòng 38/);
    expect((await one(`SELECT count(*)::int AS n FROM tr_questions`)).n).toBe(36);
  });
});

describe('thực hành, phân quyền kỹ thuật, chứng nhận', () => {
  let cprId = '';
  it('quy trình kỹ thuật ban hành rồi mới chấm; không tự chấm cho mình; sai bước bắt buộc là không đạt', async () => {
    const list = (await qa('GET', '/api/training/procedures')).data;
    cprId = list.find((p: any) => p.code === 'QTKT-CC-01').id;
    const p = await qa('GET', `/api/training/procedures/${cprId}`);
    const all = (v: boolean) => Object.fromEntries(p.steps.map((s: any) => [s.id, v]));
    expect((await qa('POST', '/api/training/skill-checks', { procedureId: cprId, staffId: await staffOf('bs.als'), kind: 'sat_hach', results: all(true) })).http).toBe(409);
    expect((await giamdoc('POST', `/api/training/procedures/${cprId}/approve`)).status).toBe('hieu_luc');
    expect((await qa('POST', '/api/training/skill-checks', { procedureId: cprId, staffId: await staffOf('qlcl'), kind: 'sat_hach', results: all(true) })).http).toBe(403);
    const crit = p.steps.find((s: any) => s.critical);
    const bad = await qa('POST', '/api/training/skill-checks', { procedureId: cprId, staffId: await staffOf('bs.als'), kind: 'sat_hach', results: { ...all(true), [crit.id]: false }, grant: true });
    expect(bad).toMatchObject({ passed: false, critical_failed: 1, privilege: null });
    const good = await qa('POST', '/api/training/skill-checks', { procedureId: cprId, staffId: await staffOf('bs.als'), kind: 'sat_hach', results: all(true), grant: true });
    expect(good.passed).toBe(true);
    expect(good.privilege.procedure_code).toBe('QTKT-CC-01');
    expect((await qa('POST', '/api/training/privileges', { staffId: await staffOf('dd.als'), procedureCode: 'QTKT-CC-01' })).http).toBe(400);
  });

  it('nhắc khi ký phiếu có can thiệp mà người ký chưa được phân quyền', async () => {
    const ett = (await qa('GET', '/api/training/procedures')).data.find((p: any) => p.code === 'QTKT-CC-04');
    await giamdoc('POST', `/api/training/procedures/${ett.id}/approve`);
    const uid = (await one(`SELECT id FROM users WHERE username = 'bs.als'`)).id;
    expect((await privilegeGaps(pool, uid, { cpr: true, ett: true, defib: false })).map((g) => g.code)).toEqual(['QTKT-CC-04']);
  });

  it('chứng nhận cần đạt cả lý thuyết và thực hành; bật cấu hình thì chưa có chứng nhận không nhận ca', async () => {
    const c = await qa('POST', '/api/training/certs', { staffId: await staffOf('bs.als') });
    expect(c.number).toMatch(/^CN-\d{4}-0001$/);
    const miss = await qa('POST', '/api/training/certs', { staffId: await staffOf('dd.als') });
    expect(miss.http).toBe(409);
    expect(miss.error).toMatch(/thực hành/);
    expect((await qa('PUT', '/api/training/settings', { requireCert: true, certMonths: 24 })).http).toBe(403);
    expect((await giamdoc('PUT', '/api/training/settings', { requireCert: true, certMonths: 24 })).require_cert).toBe(true);
    const blocked = await dd('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Điều dưỡng' });
    expect(blocked.http).toBe(409);
    expect(blocked.error).toMatch(/chứng nhận Medone/);
    expect((await bs('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' })).http).toBe(200);
    await giamdoc('PUT', '/api/training/settings', { requireCert: false, certMonths: 24 });
    const staff = (await qa('GET', '/api/training/staff')).data.find((s: any) => s.code && s.full_name === 'BS Kíp ALS');
    expect(staff).toMatchObject({ cert_number: c.number, recent_exam: true, privileges: ['QTKT-CC-01'] });
  });
});

describe('kế hoạch đào tạo, báo cáo, đọc tài liệu', () => {
  it('kết thúc lớp thì ghi giờ đào tạo cho người có mặt; báo cáo tỷ lệ được tập huấn', async () => {
    const year = Number(vnDate().slice(0, 4));
    const p = await nhansu('POST', '/api/training/plan', { year, title: 'Tập huấn BLS quý 4', kind: 'bls', hours: 8, plannedMonth: 11, targetTitles: ['Điều dưỡng'] });
    expect(p.http).toBe(200);
    const ids = [await staffOf('dd.als'), await staffOf('dd.bls')];
    expect((await nhansu('POST', `/api/training/plan/${p.id}/close`, { heldOn: vnDate(), staffIds: ids })).status).toBe('da_to_chuc');
    expect((await nhansu('PUT', `/api/training/plan/${p.id}`, { year, title: 'Sửa', kind: 'bls', hours: 4, plannedMonth: 11 })).http).toBe(409);
    const r = await qa('GET', `/api/training/report?year=${year}`);
    expect(r.plan.rows[0]).toMatchObject({ attendees: 2, target: 3 });
    expect(r.trained.staff).toBeGreaterThanOrEqual(3);
    expect(r.certified.staff).toBe(1);
    expect(r.byKind.find((k: any) => k.kind === 'bls').hours).toBe(16);
  });

  it('tài liệu bắt buộc đọc hiện ở trang của người cần đọc; xác nhận đọc có ghi vết', async () => {
    const d = await qa('POST', '/api/documents', { code: 'QT-CC-TEST', title: 'Quy trình thử nghiệm đọc', kind: 'quy_trinh', version: '1.0' });
    await giamdoc('POST', `/api/documents/${d.id}/approve`, { effectiveOn: vnDate() });
    expect((await qa('PATCH', `/api/documents/${d.id}/read-policy`, { mustRead: true, roles: ['crew'] })).must_read).toBe(true);
    expect((await bs('GET', '/api/documents/to-read')).data.map((x: any) => x.code)).toContain('QT-CC-TEST');
    expect((await nhansu('GET', '/api/documents/to-read')).data.map((x: any) => x.code)).not.toContain('QT-CC-TEST');
    expect((await bs('POST', `/api/documents/${d.id}/read`)).ok).toBe(true);
    expect((await bs('GET', '/api/training/me')).toRead.map((x: any) => x.code)).not.toContain('QT-CC-TEST');
    const reads = await qa('GET', `/api/documents/${d.id}/reads`);
    expect(reads.read).toBe(1);
    expect(reads.total).toBe(8);
  });
});
