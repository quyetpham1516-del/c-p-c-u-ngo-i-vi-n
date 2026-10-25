import { readFileSync } from 'node:fs';
import { audit, type Actor } from './audit.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';

/**
 * Tuân thủ vận hành (giai đoạn I): sao lưu có thử khôi phục và rà soát tài khoản (QL-16), bảo vệ dữ liệu cá nhân
 * (QL-17, NĐ 13/2023), an toàn lao động, PCCC và diễn tập (QL-18).
 */

const vnYear = () => new Date(Date.now() + 7 * 3600_000).getUTCFullYear();
const vnQuarter = () => Math.floor(new Date(Date.now() + 7 * 3600_000).getUTCMonth() / 3) + 1;

/* ================= Sao lưu ================= */

/** Kế hoạch mục 11: sao lưu hằng ngày, diễn tập khôi phục hằng quý */
export const BACKUP_MAX_AGE_HOURS = 26;
export const RESTORE_TEST_MAX_DAYS = 92;

export async function backupStatus(q: Queryable) {
  const [lastOk, lastFail, lastRestore, recent] = await Promise.all([
    one(q, `SELECT * FROM ops_backups WHERE kind = 'sao_luu' AND ok ORDER BY started_at DESC LIMIT 1`),
    one(q, `SELECT * FROM ops_backups WHERE kind = 'sao_luu' AND ok IS FALSE ORDER BY started_at DESC LIMIT 1`),
    one(q, `SELECT * FROM ops_backups WHERE kind = 'thu_khoi_phuc' AND ok ORDER BY started_at DESC LIMIT 1`),
    many(q, `SELECT * FROM ops_backups ORDER BY started_at DESC LIMIT 60`),
  ]);
  const ageH = lastOk ? (Date.now() - Date.parse(lastOk.finished_at ?? lastOk.started_at)) / 3600000 : null;
  const restoreDays = lastRestore ? (Date.now() - Date.parse(lastRestore.started_at)) / 86400000 : null;
  const warnings: string[] = [];
  if (ageH == null) warnings.push('Chưa có bản sao lưu thành công nào');
  else if (ageH > BACKUP_MAX_AGE_HOURS) warnings.push(`Bản sao lưu gần nhất cách đây ${Math.round(ageH)} giờ (quá ${BACKUP_MAX_AGE_HOURS} giờ)`);
  if (lastFail && (!lastOk || lastFail.started_at > lastOk.started_at)) warnings.push(`Lần sao lưu gần nhất lỗi: ${lastFail.error ?? 'không rõ'}`);
  if (restoreDays == null) warnings.push('Chưa thử khôi phục lần nào');
  else if (restoreDays > RESTORE_TEST_MAX_DAYS) warnings.push(`Lần thử khôi phục gần nhất cách đây ${Math.round(restoreDays)} ngày (phải làm mỗi quý)`);
  return { lastOk, lastRestore, recent, warnings, maxAgeHours: BACKUP_MAX_AGE_HOURS, restoreMaxDays: RESTORE_TEST_MAX_DAYS };
}

/* ================= Rà soát tài khoản ================= */

export const ACCESS_DECISION: Record<string, string> = { giu: 'Giữ nguyên', doi_vai_tro: 'Đổi vai trò', khoa: 'Khóa tài khoản' };
export const INACTIVE_DAYS = 90;

export async function createAccessReview(tx: Tx, actor: Actor) {
  const code = `RSTK-${vnYear()}-Q${vnQuarter()}`;
  const open = await one(tx, `SELECT id FROM ops_access_reviews WHERE status = 'dang_lam'`);
  if (open) throw new HttpError(409, 'Đang có một đợt rà soát chưa xong');
  if (await one(tx, 'SELECT 1 FROM ops_access_reviews WHERE code = $1', [code])) throw new HttpError(409, `Quý này đã rà soát (${code})`);
  const users = await many(tx, `SELECT id, username, full_name, role, active, last_login_at, created_at FROM users ORDER BY active DESC, role, username`);
  const items = users.map((u) => ({
    userId: u.id, username: u.username, fullName: u.full_name, role: u.role, active: u.active, lastLogin: u.last_login_at,
    stale: u.active && (!u.last_login_at || Date.now() - Date.parse(u.last_login_at) > INACTIVE_DAYS * 86400000)
      && Date.now() - Date.parse(u.created_at) > INACTIVE_DAYS * 86400000,
    decision: null as string | null, newRole: null as string | null, note: null as string | null,
  }));
  const row = await one(tx, `INSERT INTO ops_access_reviews(code, reviewer_id, items) VALUES ($1,$2,$3) RETURNING *`, [code, actor.id, JSON.stringify(items)]);
  await audit(tx, 'system', actor, 'ops.access_review_started', 'ops_access_review', row.id, { code, users: items.length });
  return row;
}

export async function decideAccess(tx: Tx, actor: Actor, id: string, b: { userId: string; decision: string; newRole?: string | null; note?: string | null }) {
  const r = await one(tx, 'SELECT * FROM ops_access_reviews WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw new HttpError(404, 'Không tìm thấy đợt rà soát');
  if (r.status !== 'dang_lam') throw new HttpError(409, 'Đợt rà soát đã xong');
  if (b.decision === 'doi_vai_tro' && !b.newRole) throw new HttpError(400, 'Chọn vai trò mới');
  if (b.decision !== 'giu' && !b.note?.trim()) throw new HttpError(400, 'Ghi lý do khóa hoặc đổi vai trò');
  if (b.userId === actor.id && b.decision === 'khoa') throw new HttpError(400, 'Không tự khóa tài khoản của mình');
  const items = r.items as any[];
  const it = items.find((x) => x.userId === b.userId);
  if (!it) throw new HttpError(404, 'Tài khoản không có trong đợt rà soát');
  Object.assign(it, { decision: b.decision, newRole: b.decision === 'doi_vai_tro' ? b.newRole : null, note: b.note ?? null });
  await tx.query('UPDATE ops_access_reviews SET items = $2 WHERE id = $1', [id, JSON.stringify(items)]);
  return it;
}

/** Chốt: áp dụng khóa và đổi vai trò; tài khoản bị khóa không đăng nhập lại được (phiên cũ hết hạn sau tối đa 14 giờ) */
export async function completeAccessReview(tx: Tx, actor: Actor, id: string) {
  const r = await one(tx, 'SELECT * FROM ops_access_reviews WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw new HttpError(404, 'Không tìm thấy đợt rà soát');
  if (r.status !== 'dang_lam') throw new HttpError(409, 'Đợt rà soát đã xong');
  const items = r.items as any[];
  const pending = items.filter((x) => x.active && !x.decision);
  if (pending.length) throw new HttpError(400, `Còn ${pending.length} tài khoản đang hoạt động chưa quyết định`);
  let locked = 0; let changed = 0;
  for (const it of items) {
    if (it.decision === 'khoa' && it.active) { await tx.query('UPDATE users SET active = false WHERE id = $1', [it.userId]); locked++; }
    if (it.decision === 'doi_vai_tro' && it.newRole) { await tx.query('UPDATE users SET role = $2 WHERE id = $1', [it.userId, it.newRole]); changed++; }
  }
  await tx.query(`UPDATE ops_access_reviews SET status = 'da_xong', completed_at = now() WHERE id = $1`, [id]);
  await audit(tx, 'system', actor, 'ops.access_review_done', 'ops_access_review', id, { code: r.code, locked, changed });
  return { locked, changed };
}

/* ================= Bảo vệ dữ liệu cá nhân ================= */

export const PD_REQUEST_KIND: Record<string, string> = {
  xem: 'Xem, biết dữ liệu', cung_cap: 'Cung cấp bản sao dữ liệu', sua: 'Chỉnh sửa', xoa: 'Xóa', rut_dong_y: 'Rút lại đồng ý', han_che: 'Hạn chế xử lý', phan_doi: 'Phản đối xử lý',
};
/** NĐ 13/2023 Điều 14: cung cấp dữ liệu trong 72 giờ. Các loại yêu cầu khác dùng cùng hạn nội bộ; pháp chế xác nhận theo văn bản hiện hành */
export const PD_REQUEST_HOURS = 72;
/** NĐ 13/2023 Điều 23: thông báo cơ quan chuyên trách bảo vệ dữ liệu cá nhân chậm nhất 72 giờ sau khi xảy ra vi phạm */
export const PD_BREACH_HOURS = 72;

export async function createPdRequest(tx: Tx, actor: Actor, b: {
  kind: string; requester: string; relation?: string | null; contact?: string | null; patientId?: string | null; content: string; identityChecked: boolean;
}) {
  const year = vnYear();
  const n = await nextCounter(tx, 'pd_request', String(year));
  const row = await one(tx, `INSERT INTO pd_requests(code, kind, requester, relation, contact, patient_id, content, identity_checked, due_at, created_by)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(hours => $9), $10) RETURNING *`,
  [`YCDL-${year}-${String(n).padStart(3, '0')}`, b.kind, b.requester, b.relation ?? null, b.contact ?? null, b.patientId ?? null, b.content, b.identityChecked, PD_REQUEST_HOURS, actor.id]);
  await audit(tx, 'system', actor, 'pd.request', 'pd_request', row.id, { code: row.code, kind: b.kind });
  return row;
}

export async function answerPdRequest(tx: Tx, actor: Actor, id: string, b: { status: 'dang_xu_ly' | 'da_tra_loi' | 'tu_choi'; response?: string | null }) {
  const r = await one(tx, 'SELECT * FROM pd_requests WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw new HttpError(404, 'Không tìm thấy yêu cầu');
  if (['da_tra_loi', 'tu_choi'].includes(r.status)) throw new HttpError(409, 'Yêu cầu đã đóng');
  if (b.status !== 'dang_xu_ly' && !b.response?.trim()) throw new HttpError(400, 'Ghi nội dung trả lời hoặc lý do từ chối');
  if (b.status === 'da_tra_loi' && !r.identity_checked) throw new HttpError(409, 'Chưa xác minh danh tính người yêu cầu: không được cung cấp dữ liệu');
  const row = await one(tx, `UPDATE pd_requests SET status = $2, response = coalesce($3, response), handled_by = $4,
                                    closed_at = CASE WHEN $2 IN ('da_tra_loi', 'tu_choi') THEN now() END WHERE id = $1 RETURNING *`,
  [id, b.status, b.response ?? null, actor.id]);
  await audit(tx, 'system', actor, 'pd.request_answered', 'pd_request', id, { code: r.code, status: b.status });
  return row;
}

/** Bản tóm tắt dữ liệu đang lưu về một người bệnh, để trả lời yêu cầu xem hoặc cung cấp (không giải mã số định danh) */
export async function patientDataSummary(q: Queryable, patientId: string) {
  const p = await one(q, `SELECT id, ba_number, full_name, dob, birth_year, sex, phone, address, id_type, id_last4, nationality, shared, created_at, updated_at
                            FROM patients WHERE id = $1`, [patientId]);
  if (!p) throw new HttpError(404, 'Không tìm thấy người bệnh');
  const [transfers, calls, surveys, charges] = await Promise.all([
    many(q, `SELECT t.transfer_number, t.status, t.signed_at, t.created_at, i.code AS incident_code, t.epcr->'diagnosis'->>'text' AS diagnosis,
                    t.epcr->'disposition'->>'hospital' AS hospital FROM transfers t LEFT JOIN incidents i ON i.id = t.incident_id
              WHERE t.patient_id = $1 ORDER BY t.created_at`, [patientId]),
    many(q, `SELECT DISTINCT i.code, i.created_at, i.address FROM transfers t JOIN incidents i ON i.id = t.incident_id WHERE t.patient_id = $1`, [patientId]),
    many(q, `SELECT s.created_at, s.answered_at FROM surveys s JOIN transfers t ON t.incident_id = s.incident_id WHERE t.patient_id = $1`, [patientId]),
    many(q, `SELECT c.code, c.total, c.status, c.service_date FROM charges c JOIN transfers t ON t.id = c.transfer_id WHERE t.patient_id = $1`, [patientId]),
  ]);
  return { patient: p, transfers, incidents: calls, surveys, charges, note: 'Số định danh chỉ hiện 4 số cuối; bản đầy đủ cung cấp trực tiếp khi đã xác minh danh tính.' };
}

export async function createBreach(tx: Tx, actor: Actor, b: {
  detectedAt: string; description: string; dataAffected?: string | null; subjectsCount?: number | null; severity: string; containment?: string | null;
}) {
  const year = vnYear();
  const n = await nextCounter(tx, 'pd_breach', String(year));
  const row = await one(tx, `INSERT INTO pd_breaches(code, detected_at, description, data_affected, subjects_count, severity, containment, reported_by)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
  [`VPDL-${year}-${String(n).padStart(2, '0')}`, b.detectedAt, b.description, b.dataAffected ?? null, b.subjectsCount ?? null, b.severity, b.containment ?? null, actor.id]);
  await audit(tx, 'system', actor, 'pd.breach', 'pd_breach', row.id, { code: row.code, severity: b.severity });
  return row;
}

export async function updateBreach(tx: Tx, actor: Actor, id: string, b: {
  containment?: string | null; authorityNotifiedAt?: string | null; subjectsNotifiedAt?: string | null; close?: boolean;
}) {
  const r = await one(tx, 'SELECT * FROM pd_breaches WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw new HttpError(404, 'Không tìm thấy vi phạm');
  if (r.status === 'dong') throw new HttpError(409, 'Đã đóng');
  const authority = b.authorityNotifiedAt ?? r.authority_notified_at;
  if (b.close && !authority) throw new HttpError(400, 'Chưa ghi ngày thông báo cơ quan chuyên trách: chưa đóng được');
  const row = await one(tx, `UPDATE pd_breaches SET containment = coalesce($2, containment), authority_notified_at = $3,
                                    subjects_notified_at = coalesce($4, subjects_notified_at), status = $5 WHERE id = $1 RETURNING *`,
  [id, b.containment ?? null, authority, b.subjectsNotifiedAt ?? null, b.close ? 'dong' : 'mo']);
  await audit(tx, 'system', actor, 'pd.breach_updated', 'pd_breach', id, b);
  return row;
}

/* ================= An toàn, PCCC, diễn tập ================= */

export const DRILL_KIND: Record<string, string> = {
  pccc: 'Phòng cháy chữa cháy', so_tan: 'Sơ tán', atld: 'An toàn lao động', mci_ban: 'Đông nạn nhân (trên bàn)', mci_thuc_dia: 'Đông nạn nhân (thực địa)',
  khoi_phuc_he_thong: 'Khôi phục hệ thống, phiếu giấy', mat_lien_lac: 'Mất liên lạc, mất điện', khac: 'Khác',
};
/** Số lần tối thiểu mỗi năm theo kế hoạch: đông nạn nhân 2 lần (1 trên bàn, 1 thực địa), khôi phục hằng quý, PCCC hằng năm */
export const DRILL_MIN_PER_YEAR: Record<string, number> = { pccc: 1, mci_ban: 1, mci_thuc_dia: 1, khoi_phuc_he_thong: 4 };
export const DRILL_RESULT: Record<string, string> = { dat: 'Đạt', can_cai_thien: 'Cần cải thiện', khong_dat: 'Không đạt' };
export const INJURY_KIND: Record<string, string> = { giao_thong: 'Tai nạn giao thông', nang_vac: 'Nâng, vác người bệnh', te_nga: 'Té ngã', bao_luc: 'Bị hành hung', hoa_chat: 'Hóa chất', dien: 'Điện', khac: 'Khác' };
export const INJURY_SEVERITY: Record<string, string> = { nhe: 'Nhẹ', nang: 'Nặng', chet_nguoi: 'Chết người' };

export async function drillCompliance(q: Queryable, year: number) {
  const done = await many(q, `SELECT kind, count(*)::int AS n FROM sf_drills WHERE status = 'da_lam' AND extract(year FROM done_on) = $1 GROUP BY kind`, [year]);
  return Object.entries(DRILL_MIN_PER_YEAR).map(([kind, min]) => ({ kind, label: DRILL_KIND[kind], min, done: done.find((d) => d.kind === kind)?.n ?? 0 }));
}

export async function saveDrill(tx: Tx, actor: Actor, id: string | null, b: {
  kind: string; title: string; stationId?: string | null; plannedOn: string; leadId?: string | null; scenario?: string | null;
}) {
  if (id) {
    const row = await one(tx, `UPDATE sf_drills SET kind = $2, title = $3, station_id = $4, planned_on = $5, lead_id = $6, scenario = $7
                                WHERE id = $1 AND status = 'ke_hoach' RETURNING *`, [id, b.kind, b.title, b.stationId ?? null, b.plannedOn, b.leadId ?? null, b.scenario ?? null]);
    if (!row) throw new HttpError(409, 'Chỉ sửa được buổi diễn tập chưa làm');
    return row;
  }
  const year = Number(b.plannedOn.slice(0, 4));
  const n = await nextCounter(tx, 'sf_drill', String(year));
  const row = await one(tx, `INSERT INTO sf_drills(code, kind, title, station_id, planned_on, lead_id, scenario, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [`DT-${year}-${String(n).padStart(2, '0')}`, b.kind, b.title, b.stationId ?? null, b.plannedOn, b.leadId ?? null, b.scenario ?? null, actor.id]);
  await audit(tx, 'system', actor, 'sf.drill_planned', 'sf_drill', row.id, { code: row.code, kind: b.kind });
  return row;
}

export async function recordDrill(tx: Tx, actor: Actor, id: string, b: {
  doneOn: string; participants: string[]; durationMin?: number | null; findings: string; result: string;
}) {
  const d = await one(tx, 'SELECT * FROM sf_drills WHERE id = $1 FOR UPDATE', [id]);
  if (!d) throw new HttpError(404, 'Không tìm thấy buổi diễn tập');
  if (d.status === 'huy') throw new HttpError(409, 'Buổi diễn tập đã hủy');
  if (!b.participants.length) throw new HttpError(400, 'Ghi người tham gia');
  const row = await one(tx, `UPDATE sf_drills SET done_on = $2, participants = $3, duration_min = $4, findings = $5, result = $6, status = 'da_lam'
                              WHERE id = $1 RETURNING *`, [id, b.doneOn, b.participants, b.durationMin ?? null, b.findings, b.result]);
  await audit(tx, 'system', actor, 'sf.drill_done', 'sf_drill', id, { code: d.code, result: b.result, participants: b.participants.length });
  return row;
}

export async function createInjury(tx: Tx, actor: Actor, b: {
  occurredAt: string; staffUser?: string | null; person: string; place?: string | null; kind: string; severity: string; description: string;
  daysOff?: number | null; action?: string | null; reportedAuthorityAt?: string | null;
}) {
  const year = vnYear();
  const n = await nextCounter(tx, 'sf_injury', String(year));
  const row = await one(tx, `INSERT INTO sf_injuries(code, occurred_at, staff_user, person, place, kind, severity, description, days_off, action, reported_authority_at, recorded_by)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
  [`TNLD-${year}-${String(n).padStart(2, '0')}`, b.occurredAt, b.staffUser ?? null, b.person, b.place ?? null, b.kind, b.severity, b.description,
    b.daysOff ?? null, b.action ?? null, b.reportedAuthorityAt ?? null, actor.id]);
  await audit(tx, 'system', actor, 'sf.injury', 'sf_injury', row.id, { code: row.code, severity: b.severity });
  return row;
}

/* ================= Dữ liệu mẫu ================= */

interface SeedFile { note: string; activities: { code: string; name: string; purpose: string; subjects: string; data_basic: string; data_sensitive: string; legal_basis: string; recipients: string; retention_key: string | null; safeguards: string }[] }

/** Sổ hoạt động xử lý dữ liệu mẫu (dự thảo, pháp chế rà soát) khi bảng còn trống */
export async function seedCompliance(tx: Tx) {
  if (await one(tx, 'SELECT 1 FROM pd_activities LIMIT 1')) return;
  const data: SeedFile = JSON.parse(readFileSync(new URL('../data/van-hanh-mau.json', import.meta.url), 'utf8'));
  for (const a of data.activities) {
    const retention = a.retention_key && (await one(tx, 'SELECT 1 FROM qm_retention WHERE key = $1', [a.retention_key])) ? a.retention_key : null;
    await tx.query(`INSERT INTO pd_activities(code, name, purpose, subjects, data_basic, data_sensitive, legal_basis, recipients, retention_key, safeguards)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [a.code, a.name, a.purpose, a.subjects, a.data_basic, a.data_sensitive, a.legal_basis, a.recipients, retention, a.safeguards]);
  }
}
