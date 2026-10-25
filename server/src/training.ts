import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import type { Actor } from './audit.js';
import { audit } from './audit.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';
import { DATA_DIR } from './tools/importers.js';

/**
 * Đào tạo và sát hạch (QLCL-13), phân quyền kỹ thuật (QLCL-14).
 * - Theo MedOne: đề sát hạch mặc định 100 câu, 30 phút, đạt từ 70%; câu bỏ trống tính sai; hết giờ tự nộp.
 * - Ngân hàng câu hỏi có 3 loại (một đáp án, nhiều đáp án, đúng/sai); câu soạn xong phải được người khác duyệt mới vào đề.
 * - Bộ đề cố định hoặc rút ngẫu nhiên theo ma trận chủ đề × độ khó, có phiên bản, Ban Giám đốc ban hành.
 * - Bài làm lưu bản chụp câu hỏi, nên sửa ngân hàng không làm đổi kết quả cũ.
 * - Thi thực hành chấm theo bảng kiểm của quy trình kỹ thuật; sai một bước bắt buộc là không đạt.
 * - Chứng nhận Medone cấp khi đạt cả lý thuyết và thực hành trong 90 ngày gần nhất; bật cấu hình thì chưa có chứng nhận còn hạn không nhận ca.
 */

export const QUESTION_KIND: Record<string, string> = { mot_dap_an: 'Một đáp án đúng', nhieu_dap_an: 'Nhiều đáp án đúng', dung_sai: 'Đúng / Sai' };
export const DIFFICULTY: Record<number, string> = { 1: 'Dễ', 2: 'Trung bình', 3: 'Khó' };
export const PURPOSE: Record<string, string> = { sat_hach: 'Sát hạch đầu vào', dinh_ky: 'Kiểm tra định kỳ', luyen_tap: 'Luyện tập' };
export const CHECK_KIND: Record<string, string> = { sat_hach: 'Sát hạch thực hành', giam_sat: 'Giám sát tuân thủ' };
/** Thời gian còn hiệu lực của bài đạt để xét cấp chứng nhận, cấp quyền kỹ thuật */
export const EVIDENCE_DAYS = 90;
/** Nộp trễ do mạng chậm vẫn nhận trong khoảng này sau giờ hết hạn */
const GRACE_MS = 30_000;
const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

export interface QuestionInput {
  topic: string; difficulty: number; roles?: string[]; kind: string; stem: string;
  options: string[]; answer: string[]; explanation?: string | null; reference?: string | null; source?: string | null;
}

/** Kiểm tra câu hỏi và trả về dạng lưu (options có khóa A, B, C...) */
export function normalizeQuestion(q: QuestionInput) {
  const options = q.kind === 'dung_sai' ? ['Đúng', 'Sai'] : q.options.map((o) => o.trim()).filter(Boolean);
  if (options.length < 2) throw new HttpError(400, 'Cần ít nhất 2 phương án');
  if (options.length > KEYS.length) throw new HttpError(400, `Tối đa ${KEYS.length} phương án`);
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new HttpError(400, 'Có phương án trùng nhau');
  const keys = KEYS.slice(0, options.length);
  const answer = [...new Set(q.answer.map((a) => a.trim().toUpperCase()))].sort();
  if (!answer.length || answer.some((a) => !keys.includes(a))) throw new HttpError(400, `Đáp án đúng phải là ${keys.join(', ')}`);
  if (q.kind !== 'nhieu_dap_an' && answer.length !== 1) throw new HttpError(400, 'Loại câu này chỉ có một đáp án đúng');
  if (q.kind === 'nhieu_dap_an' && answer.length === options.length) throw new HttpError(400, 'Câu nhiều đáp án không được đúng tất cả phương án');
  return { ...q, options: options.map((text, i) => ({ key: keys[i], text })), answer };
}

/* ---------------- Ngân hàng câu hỏi ---------------- */

export async function saveQuestion(tx: Tx, actor: Actor, id: string | null, input: QuestionInput) {
  const q = normalizeQuestion(input);
  const vals = [q.topic.trim(), q.difficulty, q.roles ?? [], q.kind, q.stem.trim(), JSON.stringify(q.options), q.answer,
    q.explanation ?? null, q.reference ?? null, q.source ?? null];
  if (!id) {
    const r = await one(tx, `INSERT INTO tr_questions(topic, difficulty, roles, kind, stem, options, answer, explanation, reference, source, created_by)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [...vals, actor.id]);
    await audit(tx, 'system', actor, 'training.question_created', 'tr_question', r.id, { code: r.code });
    return r;
  }
  // Sửa câu đang dùng thì quay về dự thảo, phải duyệt lại
  const r = await one(tx, `UPDATE tr_questions SET topic = $2, difficulty = $3, roles = $4, kind = $5, stem = $6, options = $7, answer = $8,
                                  explanation = $9, reference = $10, source = coalesce($11, source), status = 'du_thao', approved_by = NULL, approved_at = NULL,
                                  created_by = $12, updated_at = now()
                            WHERE id = $1 AND status <> 'ngung' RETURNING *`, [id, ...vals, actor.id]);
  if (!r) throw new HttpError(404, 'Không tìm thấy câu hỏi hoặc câu đã ngưng dùng');
  await audit(tx, 'system', actor, 'training.question_updated', 'tr_question', id, { code: r.code });
  return r;
}

/** Duyệt nhiều câu: người duyệt khác người soạn */
export async function approveQuestions(tx: Tx, actor: Actor, ids: string[]) {
  const rows = await many(tx, `SELECT id, code, status, created_by FROM tr_questions WHERE id = ANY($1) FOR UPDATE`, [ids]);
  const own = rows.filter((r) => r.created_by === actor.id);
  if (own.length) throw new HttpError(403, `Người soạn không tự duyệt: ${own.map((r) => r.code).join(', ')}`);
  const todo = rows.filter((r) => r.status === 'du_thao').map((r) => r.id);
  if (todo.length) {
    await tx.query(`UPDATE tr_questions SET status = 'hieu_luc', approved_by = $2, approved_at = now() WHERE id = ANY($1)`, [todo, actor.id]);
    await audit(tx, 'system', actor, 'training.questions_approved', 'tr_question', todo[0], { count: todo.length, codes: rows.filter((r) => todo.includes(r.id)).map((r) => r.code) });
  }
  return { approved: todo.length };
}

export async function setQuestionStatus(tx: Tx, actor: Actor, id: string, status: 'ngung' | 'du_thao') {
  const r = await one(tx, `UPDATE tr_questions SET status = $2, approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = $1 RETURNING id, code`, [id, status]);
  if (!r) throw new HttpError(404, 'Không tìm thấy câu hỏi');
  await audit(tx, 'system', actor, status === 'ngung' ? 'training.question_retired' : 'training.question_restored', 'tr_question', id, { code: r.code });
  return r;
}

export const Q_XLSX_COLUMNS = ['Mã', 'Chủ đề', 'Độ khó (1-3)', 'Vị trí áp dụng', 'Loại', 'Câu hỏi', 'A', 'B', 'C', 'D', 'E', 'F', 'Đáp án đúng', 'Giải thích', 'Tài liệu tham khảo'];
const KIND_BY_LABEL: Record<string, string> = Object.fromEntries(Object.entries(QUESTION_KIND).flatMap(([k, v]) => [[k, k], [v.toLowerCase(), k]]));

export async function questionsToXlsx(q: Queryable): Promise<Buffer> {
  const rows = await many(q, `SELECT * FROM tr_questions WHERE status <> 'ngung' ORDER BY topic, difficulty, code`);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Câu hỏi');
  ws.addRow(Q_XLSX_COLUMNS).font = { bold: true };
  ws.columns = [9, 22, 8, 18, 16, 60, 30, 30, 30, 30, 20, 20, 10, 40, 30].map((width) => ({ width }));
  for (const r of rows) {
    const opts = KEYS.map((k) => r.options.find((o: any) => o.key === k)?.text ?? '');
    ws.addRow([r.code, r.topic, r.difficulty, r.roles.join(', '), QUESTION_KIND[r.kind], r.stem, ...opts, r.answer.join(','), r.explanation ?? '', r.reference ?? '']);
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const info = wb.addWorksheet('Hướng dẫn');
  for (const line of [
    'Mỗi dòng là một câu hỏi. Để trống cột "Mã" là thêm câu mới; giữ mã là sửa câu đó (câu đã sửa quay về dự thảo, cần duyệt lại).',
    `Loại: ${Object.values(QUESTION_KIND).join(' / ')}. Câu Đúng/Sai không cần điền phương án: A = Đúng, B = Sai.`,
    'Đáp án đúng ghi khóa phương án, câu nhiều đáp án ghi cách nhau dấu phẩy, ví dụ "A,C". Độ khó: 1 dễ, 2 trung bình, 3 khó.',
    'Vị trí áp dụng (không bắt buộc): Bác sĩ, Điều dưỡng, Lái xe, Điều phối... cách nhau dấu phẩy; để trống là mọi người.',
    'Nạp lại ở trang Đào tạo → Ngân hàng câu hỏi → "Nạp từ Excel". Câu nạp vào ở dạng dự thảo, người khác người nạp duyệt mới được dùng trong đề.',
  ]) info.addRow([line]);
  info.getColumn(1).width = 140;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return '';
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((r) => r.text).join('').trim();
  if (typeof v === 'object' && 'result' in v) return String(v.result ?? '').trim();
  return String(v).trim();
};

export async function importQuestionsXlsx(tx: Tx, actor: Actor, buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { throw new HttpError(400, 'Không đọc được tệp Excel (.xlsx)'); }
  const ws = wb.worksheets[0];
  if (!ws) throw new HttpError(400, 'Tệp Excel không có trang tính');
  const header = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map(cellText).map((h) => h.toLowerCase());
  const col = (name: string) => {
    const i = header.indexOf(name.toLowerCase());
    if (i < 0) throw new HttpError(400, `Thiếu cột "${name}" ở dòng tiêu đề`);
    return i + 1;
  };
  const cols = Object.fromEntries(Q_XLSX_COLUMNS.map((n) => [n, col(n)]));
  const parsed: { row: number; code: string; q: QuestionInput }[] = [];
  const errors: string[] = [];
  ws.eachRow((row, r) => {
    if (r === 1) return;
    const get = (n: string) => cellText(row.getCell(cols[n]).value);
    const stem = get('Câu hỏi');
    if (!stem) return;
    const kind = KIND_BY_LABEL[get('Loại').toLowerCase()] ?? (get('Loại') ? '' : 'mot_dap_an');
    const difficulty = Number(get('Độ khó (1-3)') || 2);
    if (!kind) { errors.push(`Dòng ${r}: loại câu "${get('Loại')}" không hợp lệ`); return; }
    if (![1, 2, 3].includes(difficulty)) { errors.push(`Dòng ${r}: độ khó phải là 1, 2 hoặc 3`); return; }
    const q: QuestionInput = {
      topic: get('Chủ đề') || 'Chung', difficulty, kind, stem,
      roles: get('Vị trí áp dụng').split(',').map((s) => s.trim()).filter(Boolean),
      options: KEYS.map((k) => get(k)), answer: get('Đáp án đúng').split(/[,;\s]+/).filter(Boolean),
      explanation: get('Giải thích') || null, reference: get('Tài liệu tham khảo') || null, source: 'Nạp từ Excel',
    };
    // Phương án để trống ở giữa làm lệch khóa đáp án nên không cho phép
    const filled = q.options.map((o) => !!o);
    if (kind !== 'dung_sai' && filled.indexOf(false) >= 0 && filled.slice(filled.indexOf(false)).some(Boolean)) {
      errors.push(`Dòng ${r}: phương án phải điền liên tục từ A`); return;
    }
    try { normalizeQuestion(q); } catch (e: any) { errors.push(`Dòng ${r}: ${e.message}`); return; }
    parsed.push({ row: r, code: get('Mã'), q });
  });
  if (errors.length) throw new HttpError(400, `Tệp có ${errors.length} lỗi, chưa nạp câu nào`, { errors: errors.slice(0, 50) });
  if (!parsed.length) throw new HttpError(400, 'Tệp không có câu hỏi nào');
  let created = 0; let updated = 0;
  for (const p of parsed) {
    const ex = p.code ? await one(tx, `SELECT id FROM tr_questions WHERE code = $1`, [p.code]) : null;
    if (p.code && !ex) throw new HttpError(400, `Dòng ${p.row}: không có câu mã ${p.code}; để trống cột Mã nếu là câu mới`);
    await saveQuestion(tx, actor, ex?.id ?? null, p.q);
    if (ex) updated++; else created++;
  }
  return { created, updated };
}

/* ---------------- Bộ đề ---------------- */

export interface Rule { topic: string; difficulty?: number | null; count: number }
export interface BlueprintInput {
  code: string; name: string; version: string; purpose: string; mode: string; rules: Rule[]; questionIds: string[];
  durationMin: number; passPct: number; maxAttempts?: number | null; shuffle: boolean; note?: string | null;
}

/** Số câu hiệu lực khớp từng dòng ma trận; dòng sau không lấy lại câu dòng trước đã dùng */
export async function ruleAvailability(q: Queryable, rules: Rule[]) {
  const qs = await many(q, `SELECT id, topic, difficulty FROM tr_questions WHERE status = 'hieu_luc'`);
  const used = new Set<string>();
  return rules.map((r) => {
    const pool = qs.filter((x) => x.topic === r.topic && (r.difficulty == null || x.difficulty === r.difficulty) && !used.has(x.id));
    pool.slice(0, r.count).forEach((x) => used.add(x.id));
    return { ...r, available: pool.length };
  });
}

async function checkBlueprint(q: Queryable, b: { mode: string; rules: Rule[]; question_ids?: string[]; questionIds?: string[] }, strict: boolean) {
  const ids = b.question_ids ?? b.questionIds ?? [];
  if (b.mode === 'co_dinh') {
    if (!ids.length) throw new HttpError(400, 'Bộ đề cố định cần ít nhất một câu');
    if (strict) {
      const ok = await one(q, `SELECT count(*)::int AS n FROM tr_questions WHERE id = ANY($1) AND status = 'hieu_luc'`, [ids]);
      if (ok.n !== new Set(ids).size) throw new HttpError(409, `Có ${new Set(ids).size - ok.n} câu chưa duyệt hoặc đã ngưng trong bộ đề`);
    }
    return;
  }
  if (!b.rules.length) throw new HttpError(400, 'Bộ đề ngẫu nhiên cần ít nhất một dòng ma trận');
  if (strict) {
    const short = (await ruleAvailability(q, b.rules)).filter((r) => r.available < r.count);
    if (short.length) {
      throw new HttpError(409, `Ngân hàng chưa đủ câu đã duyệt: ${short.map((r) => `${r.topic}${r.difficulty ? ` (${DIFFICULTY[r.difficulty]})` : ''} cần ${r.count}, có ${r.available}`).join('; ')}`);
    }
  }
}

export async function createBlueprint(tx: Tx, actor: Actor, b: BlueprintInput) {
  await checkBlueprint(tx, b, false);
  if (await one(tx, 'SELECT 1 FROM tr_blueprints WHERE code = $1 AND version = $2', [b.code, b.version])) throw new HttpError(409, 'Đã có bộ đề cùng mã và phiên bản');
  const r = await one(tx, `INSERT INTO tr_blueprints(code, name, version, purpose, mode, rules, question_ids, duration_min, pass_pct, max_attempts, shuffle, note, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [b.code, b.name, b.version, b.purpose, b.mode, JSON.stringify(b.rules), b.questionIds, b.durationMin, b.passPct, b.maxAttempts ?? null, b.shuffle, b.note ?? null, actor.id]);
  await audit(tx, 'system', actor, 'training.blueprint_created', 'tr_blueprint', r.id, { code: b.code, version: b.version });
  return r;
}

export async function updateBlueprint(tx: Tx, actor: Actor, id: string, b: Omit<BlueprintInput, 'code' | 'version'>) {
  const cur = await one(tx, 'SELECT status FROM tr_blueprints WHERE id = $1 FOR UPDATE', [id]);
  if (!cur) throw new HttpError(404, 'Không tìm thấy bộ đề');
  if (cur.status !== 'du_thao') throw new HttpError(409, 'Bộ đề đã ban hành chỉ nhân bản thành phiên bản mới');
  await checkBlueprint(tx, b, false);
  const r = await one(tx, `UPDATE tr_blueprints SET name = $2, purpose = $3, mode = $4, rules = $5, question_ids = $6, duration_min = $7, pass_pct = $8,
                                  max_attempts = $9, shuffle = $10, note = $11, created_by = $12 WHERE id = $1 RETURNING *`,
    [id, b.name, b.purpose, b.mode, JSON.stringify(b.rules), b.questionIds, b.durationMin, b.passPct, b.maxAttempts ?? null, b.shuffle, b.note ?? null, actor.id]);
  await audit(tx, 'system', actor, 'training.blueprint_updated', 'tr_blueprint', id, {});
  return r;
}

export async function approveBlueprint(tx: Tx, actor: Actor, id: string) {
  const b = await one(tx, 'SELECT * FROM tr_blueprints WHERE id = $1 FOR UPDATE', [id]);
  if (!b || b.status !== 'du_thao') throw new HttpError(409, 'Chỉ ban hành bộ đề dự thảo');
  if (b.created_by === actor.id) throw new HttpError(403, 'Người soạn không tự ban hành');
  await checkBlueprint(tx, b, true);
  await tx.query(`UPDATE tr_blueprints SET status = 'het_hieu_luc' WHERE code = $1 AND status = 'hieu_luc'`, [b.code]);
  const r = await one(tx, `UPDATE tr_blueprints SET status = 'hieu_luc', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *`, [id, actor.id]);
  await audit(tx, 'system', actor, 'training.blueprint_approved', 'tr_blueprint', id, { code: b.code, version: b.version });
  return r;
}

export async function cloneBlueprint(tx: Tx, actor: Actor, id: string, version: string) {
  const b = await one(tx, 'SELECT * FROM tr_blueprints WHERE id = $1', [id]);
  if (!b) throw new HttpError(404, 'Không tìm thấy bộ đề');
  return createBlueprint(tx, actor, {
    code: b.code, name: b.name, version, purpose: b.purpose, mode: b.mode, rules: b.rules, questionIds: b.question_ids,
    durationMin: b.duration_min, passPct: b.pass_pct, maxAttempts: b.max_attempts, shuffle: b.shuffle, note: b.note,
  });
}

function shuffled<T>(a: T[]): T[] {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = randomInt(i + 1); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

/** Rút câu cho một bài làm; trả bản chụp kèm đáp án (chỉ lưu ở máy chủ) */
export async function drawQuestions(q: Queryable, b: any) {
  let picked: any[];
  if (b.mode === 'co_dinh') {
    const rows = await many(q, `SELECT * FROM tr_questions WHERE id = ANY($1) AND status = 'hieu_luc'`, [b.question_ids]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    picked = b.question_ids.map((id: string) => byId.get(id)).filter(Boolean);
    if (b.shuffle) picked = shuffled(picked);
  } else {
    const all = await many(q, `SELECT * FROM tr_questions WHERE status = 'hieu_luc'`);
    const used = new Set<string>();
    picked = [];
    for (const r of b.rules as Rule[]) {
      const pool = shuffled(all.filter((x) => x.topic === r.topic && (r.difficulty == null || x.difficulty === r.difficulty) && !used.has(x.id)));
      if (pool.length < r.count) throw new HttpError(409, `Ngân hàng không còn đủ câu chủ đề "${r.topic}" để ra đề, báo người quản lý đào tạo`);
      for (const x of pool.slice(0, r.count)) { used.add(x.id); picked.push(x); }
    }
    if (b.shuffle) picked = shuffled(picked);
  }
  return picked.map((x) => {
    // Trộn phương án và đổi lại khóa A, B, C theo thứ tự mới; câu Đúng/Sai giữ nguyên
    const opts = b.shuffle && x.kind !== 'dung_sai' ? shuffled(x.options) : x.options;
    const remap = new Map(opts.map((o: any, i: number) => [o.key, KEYS[i]]));
    return {
      id: x.id, code: x.code, topic: x.topic, difficulty: x.difficulty, kind: x.kind, stem: x.stem,
      options: opts.map((o: any, i: number) => ({ key: KEYS[i], text: o.text })),
      answer: x.answer.map((a: string) => remap.get(a)).sort(), explanation: x.explanation, reference: x.reference,
    };
  });
}

/* ---------------- Kỳ thi và bài làm ---------------- */

export async function staffOfUser(q: Queryable, userId: string) {
  const s = await one(q, `SELECT id, full_name, title, station_id, status FROM staff WHERE user_id = $1`, [userId]);
  if (!s) throw new HttpError(409, 'Tài khoản chưa có hồ sơ nhân viên, liên hệ phòng Nhân sự');
  return s;
}

export async function createExam(tx: Tx, actor: Actor, b: { blueprintId: string; name: string; opensOn: string; closesOn: string; staffIds: string[] }) {
  const bp = await one(tx, 'SELECT id, status, purpose, name FROM tr_blueprints WHERE id = $1', [b.blueprintId]);
  if (!bp || bp.status !== 'hieu_luc') throw new HttpError(409, 'Chỉ tổ chức thi bằng bộ đề đang hiệu lực');
  if (bp.purpose === 'luyen_tap') throw new HttpError(409, 'Bộ đề luyện tập không dùng cho kỳ thi');
  if (!b.staffIds.length) throw new HttpError(400, 'Chưa chọn người dự thi');
  const ok = await many(tx, `SELECT id FROM staff WHERE id = ANY($1) AND status <> 'nghi_viec'`, [b.staffIds]);
  if (ok.length !== new Set(b.staffIds).size) throw new HttpError(400, 'Có người dự thi không tồn tại hoặc đã nghỉ việc');
  const e = await one(tx, `INSERT INTO tr_exams(blueprint_id, name, opens_on, closes_on, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.blueprintId, b.name, b.opensOn, b.closesOn, actor.id]);
  await tx.query(`INSERT INTO tr_exam_candidates(exam_id, staff_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [e.id, ok.map((r) => r.id)]);
  await audit(tx, 'system', actor, 'training.exam_created', 'tr_exam', e.id, { name: b.name, blueprint: bp.name, candidates: ok.length });
  return e;
}

/** Bản gửi người thi: không có đáp án */
export function attemptForTaker(a: any) {
  const done = !!a.submitted_at;
  return {
    id: a.id, examId: a.exam_id, blueprintId: a.blueprint_id, startedAt: a.started_at, deadline: a.deadline, submittedAt: a.submitted_at,
    autoSubmit: a.auto_submit, total: a.total, score: a.score, pct: a.pct == null ? null : Number(a.pct), passed: a.passed, byTopic: a.by_topic,
    answers: a.answers, name: a.name, passPct: a.pass_pct, purpose: a.purpose,
    questions: a.questions.map((x: any) => ({
      id: x.id, code: x.code, topic: x.topic, kind: x.kind, stem: x.stem, options: x.options,
      ...(done ? { answer: x.answer, explanation: x.explanation, reference: x.reference, correct: sameSet(a.answers[x.id] ?? [], x.answer) } : {}),
    })),
  };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

export async function startAttempt(tx: Tx, user: { id: string }, b: { examId?: string | null; blueprintId?: string | null }) {
  const s = await staffOfUser(tx, user.id);
  await finalizeExpired(tx, s.id);
  const open = await one(tx, `SELECT * FROM tr_attempts WHERE staff_id = $1 AND submitted_at IS NULL`, [s.id]);
  if (open) {
    if ((b.examId && open.exam_id === b.examId) || (!b.examId && open.blueprint_id === b.blueprintId && !open.exam_id)) return open;
    throw new HttpError(409, 'Bạn đang có một bài làm dở, hãy nộp bài đó trước');
  }
  let bp: any;
  if (b.examId) {
    const e = await one(tx, `SELECT e.*, (vn_today() BETWEEN e.opens_on AND e.closes_on) AS in_window FROM tr_exams e WHERE e.id = $1`, [b.examId]);
    if (!e) throw new HttpError(404, 'Không tìm thấy kỳ thi');
    if (e.status !== 'mo' || !e.in_window) throw new HttpError(409, `Kỳ thi mở từ ${e.opens_on} đến ${e.closes_on}`);
    if (!(await one(tx, `SELECT 1 FROM tr_exam_candidates WHERE exam_id = $1 AND staff_id = $2`, [e.id, s.id]))) throw new HttpError(403, 'Bạn không có tên trong kỳ thi này');
    bp = await one(tx, `SELECT * FROM tr_blueprints WHERE id = $1`, [e.blueprint_id]);
    const n = await one(tx, `SELECT count(*)::int AS n, bool_or(passed) AS passed FROM tr_attempts WHERE exam_id = $1 AND staff_id = $2`, [e.id, s.id]);
    if (n.passed) throw new HttpError(409, 'Bạn đã đạt kỳ thi này');
    if (bp.max_attempts && n.n >= bp.max_attempts) throw new HttpError(409, `Đã hết ${bp.max_attempts} lượt thi`);
  } else {
    bp = await one(tx, `SELECT * FROM tr_blueprints WHERE id = $1`, [b.blueprintId]);
    if (!bp || bp.status !== 'hieu_luc' || bp.purpose !== 'luyen_tap') throw new HttpError(409, 'Chỉ tự luyện tập bằng bộ đề luyện tập đang hiệu lực');
  }
  const questions = await drawQuestions(tx, bp);
  return insertAttempt(tx, { examId: b.examId ?? null, blueprintId: bp.id, staffId: s.id, userId: user.id, name: bp.name, purpose: bp.purpose,
    passPct: bp.pass_pct, durationMin: bp.duration_min, questions });
}

async function insertAttempt(tx: Tx, a: { examId: string | null; blueprintId: string | null; staffId: string; userId: string; name: string; purpose: string;
  passPct: number; durationMin: number; questions: any[] }) {
  return one(tx, `INSERT INTO tr_attempts(exam_id, blueprint_id, staff_id, user_id, name, purpose, pass_pct, questions, total, deadline)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(mins => $10)) RETURNING *`,
    [a.examId, a.blueprintId, a.staffId, a.userId, a.name, a.purpose, a.passPct, JSON.stringify(a.questions), a.questions.length, a.durationMin]);
}

/** Luyện tập nhanh theo chủ đề (như MedOne "Kiểm tra" trên từng quy trình): 10 câu, 1 phút/câu, đạt 70%, không tính vào chứng nhận */
export const PRACTICE = { count: 10, minutesPerQuestion: 1, passPct: 70 };
export async function startPractice(tx: Tx, user: { id: string }, topic: string) {
  const s = await staffOfUser(tx, user.id);
  await finalizeExpired(tx, s.id);
  if (await one(tx, `SELECT 1 FROM tr_attempts WHERE staff_id = $1 AND submitted_at IS NULL`, [s.id])) throw new HttpError(409, 'Bạn đang có một bài làm dở, hãy nộp bài đó trước');
  const pool = await many(tx, `SELECT 1 FROM tr_questions WHERE status = 'hieu_luc' AND topic = $1`, [topic]);
  if (!pool.length) throw new HttpError(409, `Chủ đề "${topic}" chưa có câu hỏi đã duyệt`);
  const n = Math.min(PRACTICE.count, pool.length);
  const questions = await drawQuestions(tx, { mode: 'ngau_nhien', shuffle: true, rules: [{ topic, count: n }] });
  return insertAttempt(tx, { examId: null, blueprintId: null, staffId: s.id, userId: user.id, name: `Luyện tập: ${topic}`, purpose: 'luyen_tap',
    passPct: PRACTICE.passPct, durationMin: n * PRACTICE.minutesPerQuestion, questions });
}

export async function loadAttempt(q: Queryable, id: string) {
  return one(q, `SELECT * FROM tr_attempts WHERE id = $1`, [id]);
}

export async function saveAnswers(tx: Tx, userId: string, id: string, answers: Record<string, string[]>) {
  const a = await one(tx, `SELECT * FROM tr_attempts WHERE id = $1 FOR UPDATE`, [id]);
  if (!a || a.user_id !== userId) throw new HttpError(404, 'Không tìm thấy bài làm');
  if (a.submitted_at) throw new HttpError(409, 'Bài đã nộp');
  if (Date.now() > new Date(a.deadline).getTime() + GRACE_MS) return submitAttempt(tx, userId, id, true);
  const ids = new Set(a.questions.map((x: any) => x.id));
  const clean = Object.fromEntries(Object.entries(answers).filter(([k]) => ids.has(k)).map(([k, v]) => [k, [...new Set(v.map((s) => s.toUpperCase()))].sort()]));
  await tx.query(`UPDATE tr_attempts SET answers = answers || $2::jsonb WHERE id = $1`, [id, JSON.stringify(clean)]);
  return loadAttempt(tx, id);
}

/** Chấm: đúng khi chọn đúng và đủ các đáp án; câu bỏ trống tính sai */
export function grade(questions: any[], answers: Record<string, string[]>, passPct: number) {
  const byTopic: Record<string, { correct: number; total: number }> = {};
  let score = 0;
  for (const x of questions) {
    const ok = sameSet(answers[x.id] ?? [], x.answer);
    byTopic[x.topic] ??= { correct: 0, total: 0 };
    byTopic[x.topic].total++;
    if (ok) { score++; byTopic[x.topic].correct++; }
  }
  const pct = questions.length ? Math.round((score / questions.length) * 1000) / 10 : 0;
  return { score, pct, passed: pct >= passPct, byTopic };
}

export async function submitAttempt(tx: Tx, userId: string | null, id: string, auto = false) {
  const a = await one(tx, `SELECT * FROM tr_attempts WHERE id = $1 FOR UPDATE`, [id]);
  if (!a || (userId && a.user_id !== userId)) throw new HttpError(404, 'Không tìm thấy bài làm');
  if (a.submitted_at) return loadAttempt(tx, id);
  const late = Date.now() > new Date(a.deadline).getTime() + GRACE_MS;
  const g = grade(a.questions, a.answers, a.pass_pct);
  await tx.query(`UPDATE tr_attempts SET submitted_at = CASE WHEN $6 THEN deadline ELSE now() END, auto_submit = $2 OR $6, score = $3, pct = $4, passed = $5, by_topic = $7 WHERE id = $1`,
    [id, auto, g.score, g.pct, g.passed, late, JSON.stringify(g.byTopic)]);
  if (g.passed && a.purpose !== 'luyen_tap') {
    await tx.query(`INSERT INTO trainings(staff_id, course, kind, hours, completed_on, provider, certificate) VALUES ($1, $2, 'sat_hach', 0, vn_today(), 'Medone', $3)`,
      [a.staff_id, `Đạt ${a.name} (${g.score}/${a.total})`, `Bài thi ${id.slice(0, 8)}`]);
  }
  await audit(tx, 'system', { id: a.user_id, name: 'Người thi' }, 'training.attempt_submitted', 'tr_attempt', id,
    { score: g.score, total: a.total, pct: g.pct, passed: g.passed, auto: auto || late, blueprint: a.name });
  return loadAttempt(tx, id);
}

/** Bài quá giờ mà người thi chưa nộp (tắt máy, mất mạng) thì chấm theo câu đã lưu */
export async function finalizeExpired(tx: Tx, staffId?: string) {
  const rows = await many(tx, `SELECT id FROM tr_attempts WHERE submitted_at IS NULL AND deadline < now() - make_interval(secs => $2)
                                AND ($1::uuid IS NULL OR staff_id = $1)`, [staffId ?? null, GRACE_MS / 1000]);
  for (const r of rows) await submitAttempt(tx, null, r.id, true);
  return rows.length;
}

/* ---------------- Quy trình kỹ thuật và bảng kiểm ---------------- */

export interface ProcedureInput {
  code: string; title: string; version: string; category?: string | null; roles?: string[]; documentId?: string | null;
  epcrFlags?: string[]; passPct?: number; privilegeMonths?: number; source?: string | null;
  steps: { text: string; critical?: boolean }[];
}

async function writeSteps(tx: Tx, id: string, steps: ProcedureInput['steps']) {
  await tx.query('DELETE FROM tr_steps WHERE procedure_id = $1', [id]);
  let i = 0;
  for (const s of steps) {
    if (!s.text.trim()) continue;
    await tx.query('INSERT INTO tr_steps(procedure_id, ordinal, text, critical) VALUES ($1,$2,$3,$4)', [id, ++i, s.text.trim(), !!s.critical]);
  }
}

export async function createProcedure(tx: Tx, actor: Actor, p: ProcedureInput, status: 'du_thao' | 'hieu_luc' = 'du_thao') {
  if (await one(tx, 'SELECT 1 FROM tr_procedures WHERE code = $1 AND version = $2', [p.code, p.version])) throw new HttpError(409, 'Đã có quy trình cùng mã và phiên bản');
  const r = await one(tx, `INSERT INTO tr_procedures(code, title, version, category, roles, document_id, epcr_flags, pass_pct, privilege_months, source, status, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8, 80),coalesce($9, 12),$10,$11,$12) RETURNING *`,
    [p.code, p.title, p.version, p.category ?? null, p.roles ?? [], p.documentId ?? null, p.epcrFlags ?? [], p.passPct ?? null, p.privilegeMonths ?? null,
      p.source ?? null, status, actor.id]);
  await writeSteps(tx, r.id, p.steps);
  await audit(tx, 'system', actor, 'training.procedure_created', 'tr_procedure', r.id, { code: p.code, version: p.version });
  return r;
}

export async function updateProcedure(tx: Tx, actor: Actor, id: string, p: Omit<ProcedureInput, 'code' | 'version'>) {
  const cur = await one(tx, 'SELECT status FROM tr_procedures WHERE id = $1 FOR UPDATE', [id]);
  if (!cur) throw new HttpError(404, 'Không tìm thấy quy trình');
  if (cur.status !== 'du_thao') throw new HttpError(409, 'Quy trình đã ban hành chỉ nhân bản thành phiên bản mới');
  await tx.query(`UPDATE tr_procedures SET title = $2, category = $3, roles = $4, document_id = $5, epcr_flags = $6, pass_pct = coalesce($7, pass_pct),
                         privilege_months = coalesce($8, privilege_months), source = $9, created_by = $10 WHERE id = $1`,
    [id, p.title, p.category ?? null, p.roles ?? [], p.documentId ?? null, p.epcrFlags ?? [], p.passPct ?? null, p.privilegeMonths ?? null, p.source ?? null, actor.id]);
  await writeSteps(tx, id, p.steps);
  await audit(tx, 'system', actor, 'training.procedure_updated', 'tr_procedure', id, {});
  return procedureDetail(tx, id);
}

export async function procedureDetail(q: Queryable, id: string) {
  const p = await one(q, `SELECT p.*, d.code AS document_code, d.title AS document_title FROM tr_procedures p LEFT JOIN documents d ON d.id = p.document_id WHERE p.id = $1`, [id]);
  if (!p) throw new HttpError(404, 'Không tìm thấy quy trình');
  p.steps = await many(q, 'SELECT id, ordinal, text, critical FROM tr_steps WHERE procedure_id = $1 ORDER BY ordinal', [id]);
  return p;
}

export async function approveProcedure(tx: Tx, actor: Actor, id: string) {
  const p = await one(tx, 'SELECT * FROM tr_procedures WHERE id = $1 FOR UPDATE', [id]);
  if (!p || p.status !== 'du_thao') throw new HttpError(409, 'Chỉ ban hành quy trình dự thảo');
  if (p.created_by === actor.id) throw new HttpError(403, 'Người soạn không tự ban hành');
  const n = await one(tx, 'SELECT count(*)::int AS n FROM tr_steps WHERE procedure_id = $1', [id]);
  if (n.n < 2) throw new HttpError(409, 'Quy trình cần ít nhất 2 bước');
  await tx.query(`UPDATE tr_procedures SET status = 'het_hieu_luc' WHERE code = $1 AND status = 'hieu_luc'`, [p.code]);
  const r = await one(tx, `UPDATE tr_procedures SET status = 'hieu_luc', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *`, [id, actor.id]);
  await audit(tx, 'system', actor, 'training.procedure_approved', 'tr_procedure', id, { code: p.code, version: p.version });
  return r;
}

export async function cloneProcedure(tx: Tx, actor: Actor, id: string, version: string) {
  const p = await procedureDetail(tx, id);
  return createProcedure(tx, actor, {
    code: p.code, title: p.title, version, category: p.category, roles: p.roles, documentId: p.document_id, epcrFlags: p.epcr_flags,
    passPct: p.pass_pct, privilegeMonths: p.privilege_months, source: p.source, steps: p.steps,
  });
}

/** Chấm bảng kiểm: điểm = số bước đạt / số bước áp dụng; sai bước bắt buộc là không đạt */
export function gradeChecklist(steps: { id: string; critical: boolean }[], results: Record<string, boolean | null>, passPct: number) {
  const missing = steps.filter((s) => !(s.id in results));
  if (missing.length) throw new HttpError(400, `Còn ${missing.length} bước chưa chấm`);
  const applicable = steps.filter((s) => results[s.id] !== null);
  if (!applicable.length) throw new HttpError(400, 'Không có bước nào được chấm');
  const ok = applicable.filter((s) => results[s.id] === true).length;
  const criticalFailed = steps.filter((s) => s.critical && results[s.id] === false).length;
  const scorePct = Math.round((ok / applicable.length) * 1000) / 10;
  return { scorePct, criticalFailed, passed: criticalFailed === 0 && scorePct >= passPct };
}

export async function recordSkillCheck(tx: Tx, examiner: Actor & { id: string }, b: {
  procedureId: string; staffId: string; kind: 'sat_hach' | 'giam_sat'; results: Record<string, boolean | null>; note?: string | null; incidentId?: string | null;
}) {
  const p = await procedureDetail(tx, b.procedureId);
  if (p.status !== 'hieu_luc') throw new HttpError(409, 'Chỉ chấm theo quy trình đang hiệu lực');
  const s = await one(tx, 'SELECT id, user_id, full_name FROM staff WHERE id = $1', [b.staffId]);
  if (!s) throw new HttpError(404, 'Không tìm thấy nhân viên');
  if (s.user_id === examiner.id) throw new HttpError(403, 'Không tự chấm cho chính mình');
  const g = gradeChecklist(p.steps, b.results, p.pass_pct);
  const r = await one(tx, `INSERT INTO tr_skill_checks(procedure_id, staff_id, examiner_id, kind, steps, results, score_pct, critical_failed, passed, note, incident_id)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [p.id, s.id, examiner.id, b.kind, JSON.stringify(p.steps), JSON.stringify(b.results), g.scorePct, g.criticalFailed, g.passed, b.note ?? null, b.incidentId ?? null]);
  await audit(tx, 'system', examiner, 'training.skill_checked', 'tr_skill_check', r.id,
    { procedure: p.code, staff: s.full_name, kind: b.kind, scorePct: g.scorePct, criticalFailed: g.criticalFailed, passed: g.passed });
  return { ...r, procedure_code: p.code, procedure_title: p.title };
}

/* ---------------- Phân quyền kỹ thuật và chứng nhận ---------------- */

export async function grantPrivilege(tx: Tx, actor: Actor, b: { staffId: string; procedureCode: string; skillCheckId?: string | null; note?: string | null }) {
  const p = await one(tx, `SELECT code, title, privilege_months FROM tr_procedures WHERE code = $1 AND status = 'hieu_luc'`, [b.procedureCode]);
  if (!p) throw new HttpError(409, 'Kỹ thuật này chưa có quy trình đang hiệu lực');
  let check: any = null;
  if (b.skillCheckId) {
    check = await one(tx, `SELECT c.*, p.code FROM tr_skill_checks c JOIN tr_procedures p ON p.id = c.procedure_id WHERE c.id = $1`, [b.skillCheckId]);
    if (!check || check.staff_id !== b.staffId || check.code !== b.procedureCode) throw new HttpError(400, 'Lượt chấm không khớp người hoặc kỹ thuật');
    if (!check.passed) throw new HttpError(409, 'Lượt chấm này không đạt');
    if (Date.now() - new Date(check.at).getTime() > EVIDENCE_DAYS * 86400_000) throw new HttpError(409, `Lượt chấm đã quá ${EVIDENCE_DAYS} ngày, cần chấm lại`);
  } else if (!b.note?.trim()) {
    throw new HttpError(400, 'Cấp quyền không qua sát hạch thực hành phải ghi căn cứ (ví dụ chứng chỉ bên ngoài)');
  }
  await tx.query(`UPDATE tr_privileges SET revoked_at = now(), revoke_reason = 'Cấp lại' WHERE staff_id = $1 AND procedure_code = $2 AND revoked_at IS NULL`, [b.staffId, b.procedureCode]);
  const r = await one(tx, `INSERT INTO tr_privileges(staff_id, procedure_code, granted_on, expires_on, skill_check_id, note, granted_by)
                           VALUES ($1,$2,vn_today(), vn_today() + make_interval(months => $3), $4, $5, $6) RETURNING *`,
    [b.staffId, b.procedureCode, p.privilege_months, check?.id ?? null, b.note ?? null, actor.id]);
  await audit(tx, 'system', actor, 'training.privilege_granted', 'staff', b.staffId, { procedure: b.procedureCode, expiresOn: r.expires_on, basis: check ? 'skill_check' : b.note });
  return r;
}

export async function revokePrivilege(tx: Tx, actor: Actor, id: string, reason: string) {
  const r = await one(tx, `UPDATE tr_privileges SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING *`, [id, reason]);
  if (!r) throw new HttpError(409, 'Quyền không còn hiệu lực');
  await audit(tx, 'system', actor, 'training.privilege_revoked', 'staff', r.staff_id, { procedure: r.procedure_code, reason });
  return r;
}

export async function issueCert(tx: Tx, actor: Actor, staffId: string) {
  const s = await one(tx, 'SELECT id, full_name, user_id FROM staff WHERE id = $1', [staffId]);
  if (!s) throw new HttpError(404, 'Không tìm thấy nhân viên');
  if (s.user_id === actor.id) throw new HttpError(403, 'Không tự cấp chứng nhận cho chính mình');
  const exam = await one(tx, `SELECT a.id, a.score, a.total FROM tr_attempts a
                               WHERE a.staff_id = $1 AND a.passed AND a.purpose IN ('sat_hach', 'dinh_ky') AND a.submitted_at > now() - make_interval(days => $2)
                               ORDER BY a.submitted_at DESC LIMIT 1`, [staffId, EVIDENCE_DAYS]);
  const checks = await many(tx, `SELECT id FROM tr_skill_checks WHERE staff_id = $1 AND passed AND kind = 'sat_hach' AND at > now() - make_interval(days => $2)`, [staffId, EVIDENCE_DAYS]);
  const miss = [!exam && `bài thi lý thuyết đạt trong ${EVIDENCE_DAYS} ngày`, !checks.length && `lượt sát hạch thực hành đạt trong ${EVIDENCE_DAYS} ngày`].filter(Boolean);
  if (miss.length) throw new HttpError(409, `Chưa đủ điều kiện cấp chứng nhận: thiếu ${miss.join(' và ')}`);
  const st = await one(tx, 'SELECT cert_months FROM tr_settings WHERE id = 1');
  const year = (await one(tx, `SELECT to_char(vn_today(), 'YYYY') AS y`)).y;
  const number = `CN-${year}-${String(await nextCounter(tx, 'tr_cert', year)).padStart(4, '0')}`;
  const r = await one(tx, `INSERT INTO tr_certs(staff_id, number, issued_on, expires_on, attempt_id, skill_check_ids, issued_by)
                           VALUES ($1,$2,vn_today(), vn_today() + make_interval(months => $3), $4, $5, $6) RETURNING *`,
    [staffId, number, st.cert_months, exam.id, checks.map((c) => c.id), actor.id]);
  await audit(tx, 'system', actor, 'training.cert_issued', 'staff', staffId, { number, expiresOn: r.expires_on });
  return r;
}

export async function revokeCert(tx: Tx, actor: Actor, id: string, reason: string) {
  const r = await one(tx, `UPDATE tr_certs SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING *`, [id, reason]);
  if (!r) throw new HttpError(409, 'Chứng nhận không còn hiệu lực');
  await audit(tx, 'system', actor, 'training.cert_revoked', 'staff', r.staff_id, { number: r.number, reason });
  return r;
}

/** Chứng nhận còn hạn mới nhất của nhân viên */
export async function activeCert(q: Queryable, staffId: string) {
  return one(q, `SELECT number, issued_on, expires_on, (expires_on < vn_today() + 30) AS expiring FROM tr_certs
                  WHERE staff_id = $1 AND revoked_at IS NULL AND expires_on >= vn_today() ORDER BY expires_on DESC LIMIT 1`, [staffId]);
}

/** Can thiệp ghi trên phiếu mà người ký chưa được phân quyền kỹ thuật (chỉ nhắc, không chặn cấp cứu) */
export async function privilegeGaps(q: Queryable, userId: string, care: Record<string, unknown> | undefined) {
  const flags = Object.entries(care ?? {}).filter(([, v]) => v === true).map(([k]) => k);
  if (!flags.length) return [];
  const s = await one(q, 'SELECT id FROM staff WHERE user_id = $1', [userId]);
  if (!s) return [];
  return many(q, `SELECT p.code, p.title FROM tr_procedures p
                   WHERE p.status = 'hieu_luc' AND p.epcr_flags && $1::text[]
                     AND NOT EXISTS (SELECT 1 FROM tr_privileges v WHERE v.staff_id = $2 AND v.procedure_code = p.code
                                       AND v.revoked_at IS NULL AND v.expires_on >= vn_today())
                   ORDER BY p.code`, [flags, s.id]);
}

/* ---------------- Dữ liệu mẫu ---------------- */

export const SAMPLE_FILE = `${DATA_DIR}dao-tao-mau-ccnv.json`;
export const CATALOG_FILE = `${DATA_DIR}danh-muc-quy-trinh-medone.json`;

/**
 * Nạp mẫu khi ngân hàng trống: câu hỏi và quy trình kỹ thuật ở dạng DỰ THẢO, chuyên môn phải duyệt mới dùng;
 * danh mục quy trình của công ty vào kiểm soát tài liệu ở trạng thái "cần soạn".
 */
export async function seedTraining(tx: Tx) {
  const sys: Actor = { id: null, name: 'Hệ thống' };
  let questions = 0; let procedures = 0; let documents = 0;
  if (!(await one(tx, 'SELECT 1 FROM tr_questions LIMIT 1')) && !(await one(tx, 'SELECT 1 FROM tr_procedures LIMIT 1'))) {
    const data = JSON.parse(readFileSync(SAMPLE_FILE, 'utf8'));
    for (const q of data.questions) { await saveQuestion(tx, sys, null, { ...q, source: data.source }); questions++; }
    for (const p of data.procedures) { await createProcedure(tx, sys, { ...p, source: data.source }); procedures++; }
  }
  const cat = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'));
  for (const d of cat.documents) {
    if (await one(tx, 'SELECT 1 FROM documents WHERE code = $1', [d.code])) continue;
    await tx.query(`INSERT INTO documents(code, title, kind, version, owner_unit, change_note) VALUES ($1,$2,'quy_trinh','0',$3,$4)`,
      [d.code, d.title, d.group, `Cần soạn, cần có từ: ${d.due}. ${cat.source}`]);
    documents++;
  }
  return { questions, procedures, documents };
}

/* ---------------- Kế hoạch đào tạo năm ---------------- */

export interface PlanInput {
  year: number; title: string; kind: string; hours: number; plannedMonth: number; targetTitles?: string[];
  procedureCode?: string | null; trainer?: string | null; provider?: string | null; note?: string | null;
}

export async function savePlanItem(tx: Tx, actor: Actor, id: string | null, b: PlanInput) {
  const vals = [b.year, b.title, b.kind, b.hours, b.plannedMonth, b.targetTitles ?? [], b.procedureCode ?? null, b.trainer ?? null, b.provider ?? null, b.note ?? null];
  if (!id) {
    const r = await one(tx, `INSERT INTO tr_plan_items(year, title, kind, hours, planned_month, target_titles, procedure_code, trainer, provider, note, created_by)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [...vals, actor.id]);
    await audit(tx, 'system', actor, 'training.plan_created', 'tr_plan_item', r.id, { year: b.year, title: b.title });
    return r;
  }
  const r = await one(tx, `UPDATE tr_plan_items SET year = $2, title = $3, kind = $4, hours = $5, planned_month = $6, target_titles = $7, procedure_code = $8,
                                  trainer = $9, provider = $10, note = $11 WHERE id = $1 AND status = 'ke_hoach' RETURNING *`, [id, ...vals]);
  if (!r) throw new HttpError(409, 'Chỉ sửa lớp còn ở trạng thái kế hoạch');
  await audit(tx, 'system', actor, 'training.plan_updated', 'tr_plan_item', id, {});
  return r;
}

/** Kết thúc lớp: ghi giờ đào tạo vào hồ sơ từng người có mặt */
export async function closePlanItem(tx: Tx, actor: Actor, id: string, b: { heldOn: string; staffIds: string[] }) {
  const p = await one(tx, 'SELECT * FROM tr_plan_items WHERE id = $1 FOR UPDATE', [id]);
  if (!p || p.status !== 'ke_hoach') throw new HttpError(409, 'Lớp đã kết thúc hoặc đã hủy');
  if (!b.staffIds.length) throw new HttpError(400, 'Chưa điểm danh ai');
  const ok = await many(tx, `SELECT id FROM staff WHERE id = ANY($1)`, [b.staffIds]);
  if (ok.length !== new Set(b.staffIds).size) throw new HttpError(400, 'Có người không tồn tại');
  await tx.query(`INSERT INTO tr_attendance(plan_item_id, staff_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [id, b.staffIds]);
  await tx.query(`INSERT INTO trainings(staff_id, course, kind, hours, completed_on, provider, plan_item_id, created_by)
                  SELECT unnest($2::uuid[]), $3, $4, $5, $6, $7, $1, $8`,
    [id, b.staffIds, p.title, p.kind, p.hours, b.heldOn, p.provider ?? p.trainer ?? 'Medone', actor.id]);
  const r = await one(tx, `UPDATE tr_plan_items SET status = 'da_to_chuc', held_on = $2 WHERE id = $1 RETURNING *`, [id, b.heldOn]);
  await audit(tx, 'system', actor, 'training.plan_held', 'tr_plan_item', id, { title: p.title, attendees: b.staffIds.length, hours: p.hours });
  return r;
}

export async function cancelPlanItem(tx: Tx, actor: Actor, id: string, reason: string) {
  const r = await one(tx, `UPDATE tr_plan_items SET status = 'huy', note = coalesce(note || ' · ', '') || $2 WHERE id = $1 AND status = 'ke_hoach' RETURNING *`, [id, `Hủy: ${reason}`]);
  if (!r) throw new HttpError(409, 'Chỉ hủy lớp còn ở trạng thái kế hoạch');
  await audit(tx, 'system', actor, 'training.plan_cancelled', 'tr_plan_item', id, { reason });
  return r;
}

/** Báo cáo đào tạo năm: số liệu cho tiêu chí chất lượng (tỷ lệ nhân viên được tập huấn, có chứng nhận, có quyền kỹ thuật) */
export async function trainingReport(q: Queryable, year: number) {
  const staff = await many(q, `SELECT id, title FROM staff WHERE status = 'dang_lam'`);
  const total = staff.length;
  const trained = await one(q, `SELECT count(DISTINCT t.staff_id)::int AS n, coalesce(sum(t.hours), 0)::float AS hours FROM trainings t JOIN staff s ON s.id = t.staff_id
                                 WHERE s.status = 'dang_lam' AND extract(year FROM t.completed_on) = $1`, [year]);
  const byKind = await many(q, `SELECT t.kind, count(DISTINCT t.staff_id)::int AS staff, coalesce(sum(t.hours), 0)::float AS hours FROM trainings t JOIN staff s ON s.id = t.staff_id
                                 WHERE s.status = 'dang_lam' AND extract(year FROM t.completed_on) = $1 GROUP BY t.kind ORDER BY t.kind`, [year]);
  const certs = await one(q, `SELECT count(DISTINCT c.staff_id)::int AS n FROM tr_certs c JOIN staff s ON s.id = c.staff_id
                               WHERE s.status = 'dang_lam' AND c.revoked_at IS NULL AND c.expires_on >= vn_today()`);
  const plan = await many(q, `SELECT p.*, (SELECT count(*)::int FROM tr_attendance a WHERE a.plan_item_id = p.id) AS attendees,
                                     (SELECT count(*)::int FROM staff s WHERE s.status = 'dang_lam' AND (cardinality(p.target_titles) = 0 OR s.title = ANY(p.target_titles))) AS target
                                FROM tr_plan_items p WHERE p.year = $1 ORDER BY p.planned_month, p.title`, [year]);
  const exams = await one(q, `SELECT count(*)::int AS attempts, count(*) FILTER (WHERE passed)::int AS passed, round(avg(pct), 1)::float AS avg_pct
                               FROM tr_attempts WHERE submitted_at IS NOT NULL AND purpose <> 'luyen_tap' AND extract(year FROM submitted_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = $1`, [year]);
  const privileges = await many(q, `SELECT p.code, p.title, count(DISTINCT v.staff_id)::int AS staff FROM tr_procedures p
                                      LEFT JOIN tr_privileges v ON v.procedure_code = p.code AND v.revoked_at IS NULL AND v.expires_on >= vn_today()
                                     WHERE p.status = 'hieu_luc' GROUP BY p.code, p.title ORDER BY p.code`);
  const checks = await one(q, `SELECT count(*)::int AS n, count(*) FILTER (WHERE passed)::int AS passed, count(*) FILTER (WHERE kind = 'giam_sat')::int AS audits
                                FROM tr_skill_checks WHERE extract(year FROM at AT TIME ZONE 'Asia/Ho_Chi_Minh') = $1`, [year]);
  const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  const held = plan.filter((p) => p.status === 'da_to_chuc').length;
  return {
    year, staff: total,
    trained: { staff: trained.n, pct: pct(trained.n), hours: trained.hours },
    certified: { staff: certs.n, pct: pct(certs.n) },
    plan: { items: plan.length, held, cancelled: plan.filter((p) => p.status === 'huy').length, pct: plan.length ? Math.round((held / plan.length) * 1000) / 10 : 0, rows: plan },
    byKind, exams, checks, privileges,
  };
}
