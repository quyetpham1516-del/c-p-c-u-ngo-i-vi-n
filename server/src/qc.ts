import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { audit, type Actor } from './audit.js';
import { many, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';
import { DATA_DIR } from './tools/importers.js';

/**
 * Bộ tiêu chí chất lượng và đánh giá theo khung Quyết định 6858/QĐ-BYT (QLCL-01, 02).
 * - Mỗi tiêu chí có 5 mức; mức 1 là tiểu mục "có vấn đề", mức 2–5 là tiểu mục cần đạt.
 * - Xếp mức: có tiểu mục mức 1 xảy ra → mức 1; còn lại là mức cao nhất mà mọi tiểu mục từ mức 2 tới mức đó đều đạt.
 *   Tiểu mục "không áp dụng" bỏ qua. Mức 2 chưa đạt đủ → mức 1.
 * - Bộ tiêu chí sửa được khi ở dạng dự thảo; bộ đã dùng cho đợt đánh giá chỉ nhân bản thành phiên bản mới.
 */

export const FACILITY_KIND: Record<string, string> = { ccnv: 'Cấp cứu ngoại viện', phong_kham: 'Phòng khám', khac: 'Khác' };
export const ASSESSMENT_KIND: Record<string, string> = { tu_danh_gia: 'Tự đánh giá', kiem_tra_cap_tren: 'Kiểm tra của cấp trên (Sở Y tế)', danh_gia_ngoai: 'Đánh giá độc lập' };
export const METHODS = ['Quan sát', 'Kiểm tra số liệu', 'Kiểm tra văn bản, sổ sách', 'Phỏng vấn', 'Đóng vai', 'Đếm lượt người bệnh'];
/** Bộ tiêu chí nạp sẵn: bộ 41 tiêu chí TTCC 115 TP.HCM và bộ 10 tiêu chí cho đơn vị cấp cứu ngoại viện trong mạng lưới */
export const BUNDLED_QC_SETS = [`${DATA_DIR}tieu-chi-don-vi-ccnv.json`, `${DATA_DIR}tieu-chi-ccnv-2024.json`, `${DATA_DIR}tieu-chi-phong-kham-syt.json`];

export interface CriterionInput {
  part: string; partName: string; chapter: string; chapterName: string; code: string; title: string;
  legalBasis?: string | null; ownerUnit?: string | null; weight?: number;
  /** levels[0] là mức 1 ... levels[4] là mức 5; mỗi phần tử là danh sách tiểu mục */
  levels: string[][];
}
export interface SetInput { code: string; name: string; version: string; facilityKind?: string; source?: string | null; criteria: CriterionInput[] }

type Results = Record<string, boolean | null>;

/** Mức đạt của một tiêu chí từ kết quả từng tiểu mục (null = chưa đủ dữ liệu để xếp) */
export function computeLevel(items: { id: string; level: number }[], results: Results): number | null {
  const at = (l: number) => items.filter((i) => i.level === l);
  if (at(1).some((i) => results[i.id] === true)) return 1;
  // Chưa trả lời hết mức 1 thì chưa xếp được
  if (at(1).some((i) => !(i.id in results))) return null;
  let level = 1;
  for (let l = 2; l <= 5; l++) {
    const applicable = at(l).filter((i) => results[i.id] !== null);
    if (applicable.every((i) => results[i.id] === true)) level = l;
    else break;
  }
  return level;
}

async function insertCriteria(tx: Tx, setId: string, criteria: CriterionInput[]) {
  let sort = 0;
  for (const c of criteria) {
    const r = await one(tx, `INSERT INTO qc_criteria(set_id, part, part_name, chapter, chapter_name, code, title, legal_basis, owner_unit, weight, sort)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [setId, c.part, c.partName, c.chapter, c.chapterName, c.code, c.title, c.legalBasis ?? null, c.ownerUnit ?? null, c.weight ?? 1, sort++]);
    await insertItems(tx, r.id, c.levels);
  }
}

async function insertItems(tx: Tx, criterionId: string, levels: string[][]) {
  let ordinal = 1;
  for (let l = 0; l < 5; l++) {
    for (const text of levels[l] ?? []) {
      if (!text.trim()) continue;
      await tx.query('INSERT INTO qc_items(criterion_id, level, ordinal, text) VALUES ($1,$2,$3,$4)', [criterionId, l + 1, ordinal++, text.trim()]);
    }
  }
}

export async function importSet(tx: Tx, actor: Actor, s: SetInput, status: 'du_thao' | 'hieu_luc' = 'du_thao') {
  if (await one(tx, 'SELECT 1 FROM qc_sets WHERE code = $1 AND version = $2', [s.code, s.version])) throw new HttpError(409, 'Đã có bộ tiêu chí cùng mã và phiên bản');
  const set = await one(tx, `INSERT INTO qc_sets(code, name, facility_kind, version, source, status, created_by, approved_at)
                             VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $6 = 'hieu_luc' THEN now() END) RETURNING *`,
  [s.code, s.name, s.facilityKind ?? 'ccnv', s.version, s.source ?? null, status, actor.id]);
  await insertCriteria(tx, set.id, s.criteria);
  await audit(tx, 'system', actor, 'qc.set_imported', 'qc_set', set.id, { code: s.code, version: s.version, criteria: s.criteria.length });
  return set;
}

/** Nạp các bộ tiêu chí tham khảo kèm phần mềm; bộ nào đã có (cùng mã, kể cả đã sửa thành phiên bản khác) thì bỏ qua */
export async function seedQcSets(tx: Tx) {
  let n = 0;
  for (const file of BUNDLED_QC_SETS) {
    const s = JSON.parse(readFileSync(file, 'utf8')) as SetInput;
    if ((await tx.query('SELECT 1 FROM qc_sets WHERE code = $1 LIMIT 1', [s.code])).rowCount) continue;
    await importSet(tx, { id: null, name: 'Hệ thống' }, s, 'hieu_luc');
    n++;
  }
  return n;
}

/* ---------------- Excel: tải bộ tiêu chí ra để sửa, nạp lại thành phiên bản dự thảo mới ---------------- */

export const XLSX_COLUMNS = ['Phần', 'Tên phần', 'Chương', 'Tên chương', 'Mã tiêu chí', 'Tên tiêu chí', 'Căn cứ pháp lý', 'Khoa/phòng phụ trách', 'Hệ số', 'Mức', 'Nội dung tiểu mục'];

export async function setToXlsx(q: Queryable, setId: string): Promise<Buffer> {
  const set = await setDetail(q, setId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tiêu chí');
  ws.addRow(XLSX_COLUMNS).font = { bold: true };
  ws.columns = [6, 24, 8, 30, 10, 50, 30, 14, 7, 6, 90].map((width) => ({ width }));
  for (const c of set.criteria) {
    const base = [c.part, c.part_name, c.chapter, c.chapter_name, c.code, c.title, c.legal_basis ?? '', c.owner_unit ?? '', c.weight];
    if (!c.items.length) ws.addRow([...base, '', '']);
    for (const i of c.items) ws.addRow([...base, i.level, i.text]);
  }
  ws.getColumn(11).alignment = { wrapText: true, vertical: 'top' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const info = wb.addWorksheet('Hướng dẫn');
  for (const line of [
    `Bộ tiêu chí: ${set.name} (mã ${set.code}, phiên bản ${set.version})`,
    'Mỗi dòng là một tiểu mục. Các dòng cùng "Mã tiêu chí" thuộc cùng một tiêu chí; thông tin tiêu chí lấy ở dòng đầu tiên.',
    'Mức 1: các tiểu mục "có vấn đề" (xảy ra là tiêu chí ở mức 1). Mức 2–5: các tiểu mục cần đạt.',
    'Sửa, thêm, xóa dòng tùy ý rồi nạp lại ở trang Chất lượng → Tiêu chí chất lượng → "Nạp từ Excel". Hệ thống tạo phiên bản dự thảo mới, đánh số lại tiểu mục; các đợt đánh giá cũ vẫn giữ bộ cũ.',
  ]) info.addRow([line]);
  info.getColumn(1).width = 140;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function xlsxToCriteria(buf: Buffer): Promise<CriterionInput[]> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { throw new HttpError(400, 'Không đọc được tệp Excel (.xlsx)'); }
  const ws = wb.worksheets[0];
  if (!ws) throw new HttpError(400, 'Tệp Excel không có trang tính');
  const text = (v: ExcelJS.CellValue): string => {
    if (v == null) return '';
    if (typeof v === 'object' && 'richText' in v) return v.richText.map((r) => r.text).join('').trim();
    if (typeof v === 'object' && 'result' in v) return String(v.result ?? '').trim();
    return String(v).trim();
  };
  const header = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map(text);
  const col = (name: string) => {
    const i = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    if (i < 0) throw new HttpError(400, `Thiếu cột "${name}" ở dòng tiêu đề`);
    return i + 1;
  };
  const cols = Object.fromEntries(XLSX_COLUMNS.map((n) => [n, col(n)]));
  const out = new Map<string, CriterionInput>();
  const errors: string[] = [];
  ws.eachRow((row, r) => {
    if (r === 1) return;
    const get = (n: string) => text(row.getCell(cols[n]).value);
    const code = get('Mã tiêu chí');
    if (!code) { if (get('Nội dung tiểu mục')) errors.push(`dòng ${r}: thiếu mã tiêu chí`); return; }
    let c = out.get(code);
    if (!c) {
      const weight = Number(get('Hệ số') || 1);
      if (!(weight >= 0.5 && weight <= 5)) errors.push(`dòng ${r}: hệ số phải từ 0,5 đến 5`);
      c = { part: get('Phần') || code.slice(0, 1), partName: get('Tên phần') || 'Chưa đặt tên', chapter: get('Chương') || code.split('.')[0],
        chapterName: get('Tên chương') || 'Chưa đặt tên', code, title: get('Tên tiêu chí'), legalBasis: get('Căn cứ pháp lý') || null,
        ownerUnit: get('Khoa/phòng phụ trách') || null, weight: weight >= 0.5 && weight <= 5 ? weight : 1, levels: [[], [], [], [], []] };
      if (!c.title) errors.push(`dòng ${r}: tiêu chí ${code} thiếu tên`);
      out.set(code, c);
    }
    const item = get('Nội dung tiểu mục');
    if (!item) return;
    const level = Number(get('Mức'));
    if (!Number.isInteger(level) || level < 1 || level > 5) { errors.push(`dòng ${r}: mức phải từ 1 đến 5`); return; }
    c.levels[level - 1].push(item.replace(/^\d+\.\s*/, ''));
  });
  if (errors.length) throw new HttpError(400, `Tệp Excel có lỗi: ${errors.slice(0, 8).join('; ')}${errors.length > 8 ? '…' : ''}`, { errors });
  if (!out.size) throw new HttpError(400, 'Tệp Excel không có tiêu chí nào');
  return [...out.values()];
}

export async function setDetail(q: Queryable, setId: string) {
  const set = await one(q, `SELECT s.*, u.full_name AS approved_by_name,
                                   EXISTS (SELECT 1 FROM qc_assessments a WHERE a.set_id = s.id) AS in_use
                              FROM qc_sets s LEFT JOIN users u ON u.id = s.approved_by WHERE s.id = $1`, [setId]);
  if (!set) throw new HttpError(404, 'Không tìm thấy bộ tiêu chí');
  const criteria = await many(q, `
    SELECT c.*, coalesce(json_agg(json_build_object('id', i.id, 'level', i.level, 'ordinal', i.ordinal, 'text', i.text) ORDER BY i.ordinal)
                         FILTER (WHERE i.id IS NOT NULL), '[]') AS items
      FROM qc_criteria c LEFT JOIN qc_items i ON i.criterion_id = c.id
     WHERE c.set_id = $1 GROUP BY c.id ORDER BY c.sort, c.code`, [setId]);
  return { ...set, criteria: criteria.map((c) => ({ ...c, weight: Number(c.weight) })) };
}

/** Chỉ sửa được bộ dự thảo chưa dùng cho đợt đánh giá nào */
async function editableSet(tx: Tx, setId: string) {
  const s = await one(tx, 'SELECT * FROM qc_sets WHERE id = $1 FOR UPDATE', [setId]);
  if (!s) throw new HttpError(404, 'Không tìm thấy bộ tiêu chí');
  if (s.status !== 'du_thao') throw new HttpError(409, 'Bộ tiêu chí đã ban hành không sửa trực tiếp; hãy nhân bản thành phiên bản mới');
  return s;
}

export async function cloneSet(tx: Tx, actor: Actor, setId: string, b: { version: string; name?: string | null; code?: string | null }) {
  const src = await setDetail(tx, setId);
  const levels = (items: { level: number; text: string }[]) => [1, 2, 3, 4, 5].map((l) => items.filter((i) => i.level === l).map((i) => i.text));
  return importSet(tx, actor, {
    code: b.code ?? src.code, name: b.name ?? src.name, version: b.version, facilityKind: src.facility_kind, source: src.source,
    criteria: src.criteria.map((c: any) => ({
      part: c.part, partName: c.part_name, chapter: c.chapter, chapterName: c.chapter_name, code: c.code, title: c.title,
      legalBasis: c.legal_basis, ownerUnit: c.owner_unit, weight: c.weight, levels: levels(c.items),
    })),
  });
}

export async function updateSet(tx: Tx, actor: Actor, setId: string, b: { name?: string; source?: string | null; facilityKind?: string }) {
  await editableSet(tx, setId);
  const s = await one(tx, `UPDATE qc_sets SET name = coalesce($2, name), source = CASE WHEN $4 THEN $3 ELSE source END, facility_kind = coalesce($5, facility_kind)
                            WHERE id = $1 RETURNING *`, [setId, b.name ?? null, b.source ?? null, 'source' in b, b.facilityKind ?? null]);
  await audit(tx, 'system', actor, 'qc.set_updated', 'qc_set', setId, b);
  return s;
}

export async function saveCriterion(tx: Tx, actor: Actor, setId: string, criterionId: string | null, c: CriterionInput) {
  await editableSet(tx, setId);
  const dup = await one(tx, 'SELECT id FROM qc_criteria WHERE set_id = $1 AND code = $2 AND ($3::uuid IS NULL OR id <> $3)', [setId, c.code, criterionId]);
  if (dup) throw new HttpError(409, `Mã tiêu chí ${c.code} đã có trong bộ`);
  let id = criterionId;
  if (id) {
    const r = await tx.query(`UPDATE qc_criteria SET part = $3, part_name = $4, chapter = $5, chapter_name = $6, code = $7, title = $8,
                                     legal_basis = $9, owner_unit = $10, weight = $11 WHERE id = $1 AND set_id = $2`,
    [id, setId, c.part, c.partName, c.chapter, c.chapterName, c.code, c.title, c.legalBasis ?? null, c.ownerUnit ?? null, c.weight ?? 1]);
    if (!r.rowCount) throw new HttpError(404, 'Không tìm thấy tiêu chí');
    await tx.query('DELETE FROM qc_items WHERE criterion_id = $1', [id]);
    await insertItems(tx, id, c.levels);
  } else {
    const sort = (await one(tx, 'SELECT coalesce(max(sort), -1) + 1 AS n FROM qc_criteria WHERE set_id = $1', [setId])).n;
    const r = await one(tx, `INSERT INTO qc_criteria(set_id, part, part_name, chapter, chapter_name, code, title, legal_basis, owner_unit, weight, sort)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [setId, c.part, c.partName, c.chapter, c.chapterName, c.code, c.title, c.legalBasis ?? null, c.ownerUnit ?? null, c.weight ?? 1, sort]);
    id = r.id as string;
    await insertItems(tx, id, c.levels);
  }
  await audit(tx, 'system', actor, criterionId ? 'qc.criterion_updated' : 'qc.criterion_added', 'qc_set', setId, { code: c.code });
  return { id };
}

export async function deleteCriterion(tx: Tx, actor: Actor, setId: string, criterionId: string) {
  await editableSet(tx, setId);
  const r = await one(tx, 'DELETE FROM qc_criteria WHERE id = $1 AND set_id = $2 RETURNING code', [criterionId, setId]);
  if (!r) throw new HttpError(404, 'Không tìm thấy tiêu chí');
  await audit(tx, 'system', actor, 'qc.criterion_deleted', 'qc_set', setId, { code: r.code });
}

/** Ban hành: bộ cùng mã đang hiệu lực chuyển sang hết hiệu lực; người ban hành khác người soạn */
export async function approveSet(tx: Tx, actor: Actor, setId: string) {
  const s = await editableSet(tx, setId);
  if (s.created_by && s.created_by === actor.id) throw new HttpError(403, 'Người soạn không tự ban hành bộ tiêu chí');
  const n = (await one(tx, 'SELECT count(*)::int AS n FROM qc_criteria WHERE set_id = $1', [setId])).n;
  if (!n) throw new HttpError(409, 'Bộ tiêu chí chưa có tiêu chí nào');
  const empty = await many(tx, `SELECT c.code FROM qc_criteria c WHERE c.set_id = $1
                                   AND NOT EXISTS (SELECT 1 FROM qc_items i WHERE i.criterion_id = c.id AND i.level >= 2) ORDER BY c.sort`, [setId]);
  if (empty.length) throw new HttpError(409, `Tiêu chí chưa có tiểu mục từ mức 2: ${empty.map((e) => e.code).join(', ')}`);
  await tx.query(`UPDATE qc_sets SET status = 'het_hieu_luc' WHERE code = $1 AND status = 'hieu_luc'`, [s.code]);
  const r = await one(tx, `UPDATE qc_sets SET status = 'hieu_luc', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *`, [setId, actor.id]);
  await audit(tx, 'system', actor, 'qc.set_approved', 'qc_set', setId, { code: s.code, version: s.version });
  return r;
}

export async function deleteDraftSet(tx: Tx, actor: Actor, setId: string) {
  const s = await editableSet(tx, setId);
  if (await one(tx, 'SELECT 1 FROM qc_assessments WHERE set_id = $1', [setId])) throw new HttpError(409, 'Bộ tiêu chí đã có đợt đánh giá');
  await tx.query('DELETE FROM qc_sets WHERE id = $1', [setId]);
  await audit(tx, 'system', actor, 'qc.set_deleted', 'qc_set', setId, { code: s.code, version: s.version });
}

/* ---------------- Đợt đánh giá ---------------- */

export async function createAssessment(tx: Tx, actor: Actor, b: { setId: string; name: string; kind: string; periodFrom: string; periodTo: string; note?: string | null }) {
  const s = await one(tx, 'SELECT status FROM qc_sets WHERE id = $1', [b.setId]);
  if (!s) throw new HttpError(404, 'Không tìm thấy bộ tiêu chí');
  if (s.status !== 'hieu_luc') throw new HttpError(409, 'Chỉ đánh giá theo bộ tiêu chí đang hiệu lực');
  if (b.periodTo < b.periodFrom) throw new HttpError(400, 'Kỳ đánh giá không hợp lệ');
  const a = await one(tx, `INSERT INTO qc_assessments(set_id, name, kind, period_from, period_to, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.setId, b.name, b.kind, b.periodFrom, b.periodTo, b.note ?? null, actor.id]);
  await tx.query('INSERT INTO qc_scores(assessment_id, criterion_id) SELECT $1, id FROM qc_criteria WHERE set_id = $2', [a.id, b.setId]);
  await audit(tx, 'system', actor, 'qc.assessment_created', 'qc_assessment', a.id, { name: b.name, kind: b.kind });
  return a;
}

async function openAssessment(tx: Tx, id: string) {
  const a = await one(tx, 'SELECT * FROM qc_assessments WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw new HttpError(404, 'Không tìm thấy đợt đánh giá');
  if (a.status !== 'dang_cham') throw new HttpError(409, 'Đợt đánh giá đã chốt, không sửa được');
  return a;
}

/** Phân công người chấm từng tiêu chí (khắc phục việc "không biết ai chấm tiêu chí nào" khi đoàn kiểm tra đến) */
export async function assignAssessors(tx: Tx, actor: Actor, id: string, rows: { criterionId: string; assessorId: string | null }[]) {
  await openAssessment(tx, id);
  for (const r of rows) {
    const u = await tx.query('UPDATE qc_scores SET assessor_id = $3 WHERE assessment_id = $1 AND criterion_id = $2', [id, r.criterionId, r.assessorId]);
    if (!u.rowCount) throw new HttpError(404, 'Tiêu chí không thuộc đợt đánh giá');
  }
  await audit(tx, 'system', actor, 'qc.assigned', 'qc_assessment', id, { count: rows.length });
}

export interface ScoreInput {
  applicable: boolean; results: Results; finalLevel?: number | null; currentState?: string | null; methods?: string[];
  explanation?: string | null; doubts?: string | null; evidence?: string | null; improvement?: string | null; reviewerNote?: string | null;
}

export async function saveScore(tx: Tx, actor: Actor & { id: string }, canManage: boolean, id: string, criterionId: string, b: ScoreInput) {
  await openAssessment(tx, id);
  const sc = await one(tx, 'SELECT * FROM qc_scores WHERE assessment_id = $1 AND criterion_id = $2 FOR UPDATE', [id, criterionId]);
  if (!sc) throw new HttpError(404, 'Tiêu chí không thuộc đợt đánh giá');
  if (!canManage && sc.assessor_id !== actor.id) throw new HttpError(403, 'Bạn không được phân công chấm tiêu chí này');
  const items = await many(tx, 'SELECT id, level FROM qc_items WHERE criterion_id = $1', [criterionId]);
  const known = new Set(items.map((i) => i.id));
  const results: Results = {};
  for (const [k, v] of Object.entries(b.results)) if (known.has(k)) results[k] = v;
  const computed = b.applicable ? computeLevel(items, results) : null;
  const final = b.applicable ? (b.finalLevel ?? computed) : null;
  if (final != null && computed != null && final !== computed && !b.explanation?.trim()) {
    throw new HttpError(400, `Mức chấm (${final}) khác mức tính theo tiểu mục (${computed}): cần ghi giải trình`);
  }
  if (!b.applicable && !b.explanation?.trim()) throw new HttpError(400, 'Tiêu chí không áp dụng cần ghi lý do ở phần giải trình');
  const r = await one(tx, `
    UPDATE qc_scores SET applicable = $3, results = $4, computed_level = $5, final_level = $6, current_state = $7, methods = $8,
           explanation = $9, doubts = $10, evidence = $11, improvement = $12, reviewer_note = $13, scored_by = $14, scored_at = now()
     WHERE assessment_id = $1 AND criterion_id = $2 RETURNING *`,
  [id, criterionId, b.applicable, JSON.stringify(results), computed, final, b.currentState ?? null, b.methods ?? [],
    b.explanation ?? null, b.doubts ?? null, b.evidence ?? null, b.improvement ?? null, b.reviewerNote ?? null, actor.id]);
  await audit(tx, 'system', actor, 'qc.scored', 'qc_assessment', id, { criterionId, level: final, applicable: b.applicable });
  return r;
}

export async function closeAssessment(tx: Tx, actor: Actor, id: string) {
  await openAssessment(tx, id);
  const missing = await many(tx, `SELECT c.code FROM qc_scores s JOIN qc_criteria c ON c.id = s.criterion_id
                                   WHERE s.assessment_id = $1 AND s.applicable AND s.final_level IS NULL ORDER BY c.sort`, [id]);
  if (missing.length) throw new HttpError(409, `Còn ${missing.length} tiêu chí chưa chấm: ${missing.slice(0, 10).map((m) => m.code).join(', ')}${missing.length > 10 ? '…' : ''}`);
  const r = await one(tx, `UPDATE qc_assessments SET status = 'da_chot', closed_by = $2, closed_at = now() WHERE id = $1 RETURNING *`, [id, actor.id]);
  await audit(tx, 'system', actor, 'qc.assessment_closed', 'qc_assessment', id, {});
  return r;
}

export async function reopenAssessment(tx: Tx, actor: Actor, id: string, reason: string) {
  const r = await one(tx, `UPDATE qc_assessments SET status = 'dang_cham', closed_by = NULL, closed_at = NULL WHERE id = $1 AND status = 'da_chot' RETURNING *`, [id]);
  if (!r) throw new HttpError(409, 'Đợt đánh giá chưa chốt');
  await audit(tx, 'system', actor, 'qc.assessment_reopened', 'qc_assessment', id, { reason });
  return r;
}

/** Danh sách tiêu chí của đợt kèm kết quả chấm, người chấm */
export async function assessmentRows(q: Queryable, id: string) {
  return many(q, `
    SELECT c.id AS criterion_id, c.part, c.part_name, c.chapter, c.chapter_name, c.code, c.title, c.owner_unit, c.weight::float AS weight,
           s.assessor_id, ua.full_name AS assessor_name, s.applicable, s.computed_level, s.final_level, s.scored_at, us.full_name AS scored_by_name,
           s.explanation, s.reviewer_note, s.improvement
      FROM qc_scores s JOIN qc_criteria c ON c.id = s.criterion_id
      LEFT JOIN users ua ON ua.id = s.assessor_id LEFT JOIN users us ON us.id = s.scored_by
     WHERE s.assessment_id = $1 ORDER BY c.sort, c.code`, [id]);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Tổng hợp kết quả như báo cáo kiểm tra chất lượng: số tiêu chí áp dụng, tổng điểm, điểm trung bình, phân bố theo mức, theo phần/chương */
export async function assessmentSummary(q: Queryable, id: string) {
  const a = await one(q, `SELECT a.*, s.code AS set_code, s.name AS set_name, s.version AS set_version, uc.full_name AS closed_by_name
                            FROM qc_assessments a JOIN qc_sets s ON s.id = a.set_id LEFT JOIN users uc ON uc.id = a.closed_by WHERE a.id = $1`, [id]);
  if (!a) throw new HttpError(404, 'Không tìm thấy đợt đánh giá');
  const rows = await assessmentRows(q, id);
  const summarize = (list: typeof rows) => {
    const scored = list.filter((r) => r.applicable && r.final_level != null);
    const w = scored.reduce((s, r) => s + r.weight, 0);
    const points = scored.reduce((s, r) => s + r.final_level * r.weight, 0);
    return { total: list.length, applicable: list.filter((r) => r.applicable).length, scored: scored.length, points: round2(points), average: w ? round2(points / w) : null };
  };
  const overall = summarize(rows);
  const scored = rows.filter((r) => r.applicable && r.final_level != null);
  const byLevel = [1, 2, 3, 4, 5].map((l) => {
    const n = scored.filter((r) => r.final_level === l).length;
    return { level: l, n, pct: scored.length ? round2((n / scored.length) * 100) : 0 };
  });
  const group = (key: 'part' | 'chapter', name: 'part_name' | 'chapter_name') => {
    const keys = [...new Set(rows.map((r) => r[key]))];
    return keys.map((k) => ({ code: k, name: rows.find((r) => r[key] === k)![name], ...summarize(rows.filter((r) => r[key] === k)) }));
  };
  // So sánh với đợt đã chốt gần nhất của cùng mã bộ tiêu chí
  const prev = await one(q, `
    SELECT a.id, a.name, a.period_to FROM qc_assessments a JOIN qc_sets s ON s.id = a.set_id
     WHERE s.code = $1 AND a.status = 'da_chot' AND a.id <> $2 AND a.period_to <= $3 ORDER BY a.period_to DESC, a.closed_at DESC LIMIT 1`,
  [a.set_code, id, a.period_to]);
  let previous = null;
  if (prev) {
    const pr = await assessmentRows(q, prev.id);
    const levels = Object.fromEntries(pr.map((r) => [r.code, r.applicable ? r.final_level : null]));
    previous = { id: prev.id, name: prev.name, ...summarize(pr), levels };
  }
  return { assessment: a, overall, byLevel, parts: group('part', 'part_name'), chapters: group('chapter', 'chapter_name'), rows, previous, priorities: await priorities(q, id) };
}

/** Vấn đề ưu tiên cải tiến: tiểu mục chưa đạt ở mức kế tiếp (hoặc tiểu mục mức 1 đã xảy ra), ưu tiên tiêu chí điểm thấp, hệ số cao */
async function priorities(q: Queryable, id: string) {
  const rows = await many(q, `
    SELECT c.code, c.title, c.owner_unit, c.weight::float AS weight, s.final_level, s.results, s.improvement,
           json_agg(json_build_object('id', i.id, 'level', i.level, 'ordinal', i.ordinal, 'text', i.text) ORDER BY i.ordinal) AS items
      FROM qc_scores s JOIN qc_criteria c ON c.id = s.criterion_id JOIN qc_items i ON i.criterion_id = c.id
     WHERE s.assessment_id = $1 AND s.applicable AND s.final_level < 5
     GROUP BY c.id, s.assessment_id, s.criterion_id ORDER BY s.final_level, c.weight DESC, c.sort`, [id]);
  return rows.map((r) => {
    const res = r.results as Results;
    const occurred = r.items.filter((i: any) => i.level === 1 && res[i.id] === true);
    const next = r.final_level + 1;
    const missing = occurred.length ? occurred : r.items.filter((i: any) => i.level >= 2 && i.level <= next && res[i.id] !== true && res[i.id] !== null);
    return { code: r.code, title: r.title, owner_unit: r.owner_unit, level: r.final_level, target: occurred.length ? 2 : next, improvement: r.improvement,
      items: missing.map((i: any) => ({ ordinal: i.ordinal, level: i.level, text: i.text })) };
  }).filter((r) => r.items.length);
}
