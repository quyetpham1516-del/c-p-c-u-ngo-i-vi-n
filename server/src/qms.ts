import { readFileSync } from 'node:fs';
import { audit, type Actor } from './audit.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';
import { RESPONSE_TARGET_MIN } from './reports.js';
import { trainingReport } from './training.js';

/**
 * Hệ thống quản lý chất lượng (giai đoạn H): sổ rủi ro (QLCL-04), đánh giá nội bộ (QLCL-09), khắc phục phòng ngừa
 * dùng chung có kiểm tra hiệu quả (QLCL-10), bộ chỉ số (QLCL-11), giám sát tuân thủ bằng gọi lại ngẫu nhiên (QLCL-12),
 * đánh giá nhà cung cấp (QLCL-17), xem xét của lãnh đạo (QLCL-18), thời hạn lưu hồ sơ (QLCL-02).
 */

export const QM_ROLES = ['qa', 'supervisor', 'admin', 'director'];

/* ================= Rủi ro ================= */

export function riskLevel(score: number): 'cao' | 'trung_binh' | 'thap' {
  return score >= 15 ? 'cao' : score >= 8 ? 'trung_binh' : 'thap';
}
export const RISK_LEVEL: Record<string, string> = { cao: 'Cao', trung_binh: 'Trung bình', thap: 'Thấp' };

const RISK_SELECT = `
  SELECT r.*, u.full_name AS owner_name, (r.reviewed_on + make_interval(months => r.review_months))::date AS review_due,
         (r.status = 'mo' AND r.reviewed_on + make_interval(months => r.review_months) < vn_today()) AS review_overdue,
         (SELECT count(*)::int FROM capa_actions c WHERE c.risk_id = r.id AND c.status IN ('mo', 'xong')) AS open_capa
    FROM qm_risks r LEFT JOIN users u ON u.id = r.owner_id`;

export async function listRisks(q: Queryable) {
  const rows = await many(q, `${RISK_SELECT} ORDER BY r.status, r.score DESC, r.code`);
  for (const r of rows) {
    r.level = riskLevel(r.score);
    r.needs_action = r.status === 'mo' && r.level === 'cao' && !r.open_capa;
  }
  return rows;
}

export async function saveRisk(tx: Tx, actor: Actor, id: string | null, b: {
  area: string; hazard: string; cause?: string | null; consequence?: string | null; likelihood: number; impact: number;
  controls?: string | null; ownerId?: string | null; reviewMonths: number;
}) {
  const args = [b.area, b.hazard, b.cause ?? null, b.consequence ?? null, b.likelihood, b.impact, b.controls ?? null, b.ownerId ?? null, b.reviewMonths];
  let r;
  if (id) {
    r = await one(tx, `UPDATE qm_risks SET area = $2, hazard = $3, cause = $4, consequence = $5, likelihood = $6, impact = $7, controls = $8,
                                           owner_id = $9, review_months = $10 WHERE id = $1 AND status = 'mo' RETURNING *`, [id, ...args]);
    if (!r) throw new HttpError(404, 'Không tìm thấy rủi ro đang mở');
  } else {
    const n = await nextCounter(tx, 'qm_risk', 'all');
    r = await one(tx, `INSERT INTO qm_risks(code, area, hazard, cause, consequence, likelihood, impact, controls, owner_id, review_months, created_by)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [`RR-${String(n).padStart(4, '0')}`, ...args, actor.id]);
    await tx.query(`INSERT INTO qm_risk_reviews(risk_id, reviewed_on, likelihood, impact, note, reviewed_by) VALUES ($1, vn_today(), $2, $3, 'Nhận diện', $4)`,
      [r.id, b.likelihood, b.impact, actor.id]);
  }
  await audit(tx, 'system', actor, id ? 'qm.risk_updated' : 'qm.risk_created', 'qm_risk', r.id, { code: r.code, score: r.score });
  return r;
}

/** Đánh giá lại định kỳ (hoặc sau khi khắc phục): lưu lịch sử mức cũ, tính lại hạn rà soát */
export async function reviewRisk(tx: Tx, actor: Actor, id: string, b: { likelihood: number; impact: number; note: string; close?: boolean }) {
  const r = await one(tx, `UPDATE qm_risks SET likelihood = $2, impact = $3, reviewed_on = vn_today(), status = CASE WHEN $4 THEN 'dong' ELSE status END
                            WHERE id = $1 AND status = 'mo' RETURNING *`, [id, b.likelihood, b.impact, !!b.close]);
  if (!r) throw new HttpError(404, 'Không tìm thấy rủi ro đang mở');
  await tx.query(`INSERT INTO qm_risk_reviews(risk_id, reviewed_on, likelihood, impact, note, reviewed_by) VALUES ($1, vn_today(), $2, $3, $4, $5)`,
    [id, b.likelihood, b.impact, b.note, actor.id]);
  await audit(tx, 'system', actor, 'qm.risk_reviewed', 'qm_risk', id, { code: r.code, score: r.score, close: !!b.close });
  return r;
}

/* ================= Đánh giá nội bộ ================= */

export const FINDING_KIND: Record<string, string> = {
  nc_lon: 'Không phù hợp nặng', nc_nho: 'Không phù hợp nhẹ', luu_y: 'Lưu ý, cơ hội cải tiến', diem_manh: 'Điểm mạnh',
};
export const AUDIT_STATUS: Record<string, string> = { ke_hoach: 'Kế hoạch', dang_danh_gia: 'Đang đánh giá', da_bao_cao: 'Đã báo cáo', dong: 'Đã đóng', huy: 'Hủy' };

/** Đánh giá viên phải độc lập: không thuộc vai trò, điểm trạm hay khoa phòng được đánh giá */
async function assertIndependent(q: Queryable, auditorIds: string[], unit: { roles: string[]; station: string | null; name: string }) {
  if (!auditorIds.length) return;
  const rows = await many(q, `SELECT u.id, u.full_name, u.role, coalesce(s.station_id, u.station_id) AS station_id, s.department
                                FROM users u LEFT JOIN staff s ON s.user_id = u.id WHERE u.id = ANY($1)`, [auditorIds]);
  if (rows.length !== new Set(auditorIds).size) throw new HttpError(400, 'Có đánh giá viên không tồn tại');
  const unitName = unit.name.trim().toLowerCase();
  const bad = rows.filter((r) => unit.roles.includes(r.role) || (unit.station && r.station_id === unit.station)
    || (r.department && r.department.trim().toLowerCase() === unitName));
  if (bad.length) throw new HttpError(409, `Đánh giá viên phải độc lập với bộ phận được đánh giá: ${bad.map((b) => b.full_name).join(', ')}`);
}

export async function saveAudit(tx: Tx, actor: Actor, id: string | null, b: {
  year: number; title: string; scope?: string | null; auditedUnit: string; auditedRoles: string[]; auditedStation?: string | null;
  plannedMonth: number; leadId?: string | null; auditorIds: string[]; checklist: { q: string; ref?: string | null }[];
}) {
  const team = [...new Set([...(b.leadId ? [b.leadId] : []), ...b.auditorIds])];
  await assertIndependent(tx, team, { roles: b.auditedRoles, station: b.auditedStation ?? null, name: b.auditedUnit });
  const checklist = b.checklist.filter((c) => c.q.trim()).map((c) => ({ q: c.q.trim(), ref: c.ref ?? null, result: null, note: null }));
  const args = [b.year, b.title, b.scope ?? null, b.auditedUnit, b.auditedRoles, b.auditedStation ?? null, b.plannedMonth, b.leadId ?? null, team, JSON.stringify(checklist)];
  let a;
  if (id) {
    a = await one(tx, `UPDATE qm_audits SET year = $2, title = $3, scope = $4, audited_unit = $5, audited_roles = $6, audited_station = $7, planned_month = $8,
                                            lead_id = $9, auditor_ids = $10, checklist = $11 WHERE id = $1 AND status = 'ke_hoach' RETURNING *`, [id, ...args]);
    if (!a) throw new HttpError(409, 'Chỉ sửa cuộc đánh giá đang ở kế hoạch');
  } else {
    const n = await nextCounter(tx, 'qm_audit', String(b.year));
    a = await one(tx, `INSERT INTO qm_audits(code, year, title, scope, audited_unit, audited_roles, audited_station, planned_month, lead_id, auditor_ids, checklist, created_by)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [`DGNB-${b.year}-${String(n).padStart(2, '0')}`, ...args, actor.id]);
  }
  await audit(tx, 'system', actor, id ? 'qm.audit_updated' : 'qm.audit_planned', 'qm_audit', a.id, { code: a.code, unit: b.auditedUnit });
  return a;
}

async function auditFor(tx: Tx, id: string, actor: Actor & { role: string }) {
  const a = await one(tx, 'SELECT * FROM qm_audits WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw new HttpError(404, 'Không tìm thấy cuộc đánh giá');
  if (!a.auditor_ids.includes(actor.id) && !['admin', 'director'].includes(actor.role)) throw new HttpError(403, 'Chỉ đoàn đánh giá ghi kết quả');
  return a;
}

/** Đoàn đánh giá ghi kết quả từng câu hỏi trong bảng kiểm */
export async function recordAudit(tx: Tx, actor: Actor & { role: string }, id: string, b: { results: { result: string | null; note?: string | null }[]; performedOn: string; summary?: string | null }) {
  const a = await auditFor(tx, id, actor);
  if (!['ke_hoach', 'dang_danh_gia'].includes(a.status)) throw new HttpError(409, 'Cuộc đánh giá đã báo cáo');
  const checklist = a.checklist.map((c: any, i: number) => ({ ...c, result: b.results[i]?.result ?? c.result, note: b.results[i]?.note ?? c.note }));
  const r = await one(tx, `UPDATE qm_audits SET checklist = $2, performed_on = $3, summary = coalesce($4, summary), status = 'dang_danh_gia' WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(checklist), b.performedOn, b.summary ?? null]);
  await audit(tx, 'system', actor, 'qm.audit_recorded', 'qm_audit', id, { code: a.code });
  return r;
}

export async function addFinding(tx: Tx, actor: Actor & { role: string }, auditId: string, b: { kind: string; reference?: string | null; description: string; evidence?: string | null }) {
  const a = await auditFor(tx, auditId, actor);
  if (['dong', 'huy'].includes(a.status)) throw new HttpError(409, 'Cuộc đánh giá đã đóng');
  const n = await one(tx, 'SELECT count(*)::int + 1 AS n FROM qm_findings WHERE audit_id = $1', [auditId]);
  const f = await one(tx, `INSERT INTO qm_findings(audit_id, code, kind, reference, description, evidence, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [auditId, `${a.code}/${String(n.n).padStart(2, '0')}`, b.kind, b.reference ?? null, b.description, b.evidence ?? null, actor.id]);
  if (a.status === 'ke_hoach') await tx.query(`UPDATE qm_audits SET status = 'dang_danh_gia' WHERE id = $1`, [auditId]);
  await audit(tx, 'system', actor, 'qm.finding_added', 'qm_audit', auditId, { code: f.code, kind: b.kind });
  return f;
}

/** Báo cáo: đủ kết quả bảng kiểm. Đóng: mọi điểm không phù hợp đã có hành động khắc phục được xác nhận hiệu quả */
export async function advanceAudit(tx: Tx, actor: Actor & { role: string }, id: string, to: 'da_bao_cao' | 'dong' | 'huy') {
  const a = await one(tx, 'SELECT * FROM qm_audits WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw new HttpError(404, 'Không tìm thấy cuộc đánh giá');
  if (to === 'huy') {
    if (a.status !== 'ke_hoach') throw new HttpError(409, 'Chỉ hủy cuộc đánh giá chưa làm');
  } else if (to === 'da_bao_cao') {
    if (a.status !== 'dang_danh_gia') throw new HttpError(409, 'Cuộc đánh giá chưa ghi kết quả');
    if (!a.auditor_ids.includes(actor.id) && !['admin', 'director'].includes(actor.role)) throw new HttpError(403, 'Chỉ đoàn đánh giá báo cáo');
    const missing = a.checklist.filter((c: any) => !c.result).length;
    if (missing) throw new HttpError(409, `Còn ${missing} câu trong bảng kiểm chưa ghi kết quả`);
    if (!a.summary?.trim()) throw new HttpError(409, 'Ghi kết luận chung trước khi báo cáo');
  } else {
    if (a.status !== 'da_bao_cao') throw new HttpError(409, 'Cuộc đánh giá chưa báo cáo');
    const open = await one(tx, `SELECT count(*)::int AS n FROM qm_findings f
                                 WHERE f.audit_id = $1 AND f.kind IN ('nc_lon', 'nc_nho')
                                   AND NOT EXISTS (SELECT 1 FROM capa_actions c WHERE c.finding_id = f.id AND c.status = 'da_xac_nhan')`, [id]);
    if (open.n) throw new HttpError(409, `Còn ${open.n} điểm không phù hợp chưa có hành động khắc phục được xác nhận hiệu quả`);
  }
  await tx.query(`UPDATE qm_audits SET status = $2, closed_at = CASE WHEN $2 = 'dong' THEN now() ELSE closed_at END WHERE id = $1`, [id, to]);
  await audit(tx, 'system', actor, `qm.audit_${to}`, 'qm_audit', id, { code: a.code });
}

/* ================= Khắc phục, phòng ngừa (dùng chung) ================= */

export const CAPA_SOURCE: Record<string, string> = {
  su_co: 'Sự cố', khieu_nai: 'Khiếu nại', danh_gia_noi_bo: 'Đánh giá nội bộ', tieu_chi: 'Tiêu chí chất lượng', rui_ro: 'Rủi ro',
  chi_so: 'Chỉ số không đạt', giam_sat: 'Giám sát gọi lại', xem_xet_lanh_dao: 'Xem xét của lãnh đạo', khac: 'Khác',
};
export const CAPA_STATUS: Record<string, string> = { mo: 'Đang làm', xong: 'Chờ kiểm tra hiệu quả', da_xac_nhan: 'Đã xác nhận hiệu quả', huy: 'Hủy' };
/** Liên kết nguồn của hành động khắc phục; source suy từ liên kết */
export const CAPA_LINKS: [field: string, column: string, source: string][] = [
  ['eventId', 'event_id', 'su_co'], ['complaintId', 'complaint_id', 'khieu_nai'], ['findingId', 'finding_id', 'danh_gia_noi_bo'],
  ['riskId', 'risk_id', 'rui_ro'], ['reviewId', 'review_id', 'xem_xet_lanh_dao'], ['callbackId', 'callback_id', 'giam_sat'], ['indicatorId', 'indicator_id', 'chi_so'],
];
export const CAPA_VERIFY_DAYS = 30;

export const CAPA_SELECT = `
  SELECT c.*, u.full_name AS owner_name, v.full_name AS verified_by_name, e.code AS event_code, k.code AS complaint_code, f.code AS finding_code,
         r.code AS risk_code, rv.code AS review_code, ind.code AS indicator_code, inc.code AS callback_incident_code,
         (c.status = 'mo' AND c.due_date < vn_today()) AS overdue,
         (c.status = 'xong' AND c.verify_due < vn_today()) AS verify_overdue
    FROM capa_actions c JOIN users u ON u.id = c.owner_id LEFT JOIN users v ON v.id = c.verified_by
    LEFT JOIN adverse_events e ON e.id = c.event_id LEFT JOIN complaints k ON k.id = c.complaint_id LEFT JOIN qm_findings f ON f.id = c.finding_id
    LEFT JOIN qm_risks r ON r.id = c.risk_id LEFT JOIN qm_reviews rv ON rv.id = c.review_id LEFT JOIN qm_indicators ind ON ind.id = c.indicator_id
    LEFT JOIN qm_callbacks cb ON cb.id = c.callback_id LEFT JOIN incidents inc ON inc.id = cb.incident_id`;

/** Người kiểm tra hiệu quả khác người phụ trách. Không hiệu quả: mở lại với hạn mới */
export async function verifyCapa(tx: Tx, actor: Actor, id: string, b: { effective: boolean; note: string; newDueDate?: string | null }) {
  const c = await one(tx, 'SELECT * FROM capa_actions WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw new HttpError(404, 'Không tìm thấy hành động');
  if (c.status !== 'xong') throw new HttpError(409, 'Chỉ kiểm tra hiệu quả hành động đã làm xong');
  if (c.owner_id === actor.id) throw new HttpError(403, 'Người phụ trách không tự xác nhận hiệu quả');
  if (b.effective) {
    await tx.query(`UPDATE capa_actions SET status = 'da_xac_nhan', effective = true, verified_at = now(), verified_by = $2, verify_note = $3 WHERE id = $1`, [id, actor.id, b.note]);
  } else {
    if (!b.newDueDate) throw new HttpError(400, 'Đặt hạn mới khi hành động chưa hiệu quả');
    await tx.query(`UPDATE capa_actions SET status = 'mo', effective = false, verified_at = now(), verified_by = $2, verify_note = $3, due_date = $4, done_at = NULL, verify_due = NULL
                     WHERE id = $1`, [id, actor.id, b.note, b.newDueDate]);
  }
  await audit(tx, 'system', actor, 'quality.capa_verified', 'capa_action', id, { effective: b.effective });
}

/* ================= Bộ chỉ số ================= */

interface Calc { num: number | null; den: number | null; value: number | null }
const ratio = (num: number, den: number, scale = 100): Calc => ({ num, den, value: den ? Math.round((num / den) * scale * 10) / 10 : null });
const RANGE = `r AS (SELECT ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AS s, ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AS e)`;

/** Chỉ số tính tự động từ dữ liệu trong khoảng ngày (theo giờ Việt Nam) */
export const AUTO_INDICATORS: Record<string, { label: string; calc: (q: Queryable, from: string, to: string) => Promise<Calc> }> = {
  p1_response: {
    label: 'Ca P1 tới hiện trường trong chỉ tiêu',
    calc: async (q, f, t) => {
      const x = await one(q, `WITH ${RANGE}, c AS (
          SELECT i.id, extract(epoch FROM max(it.at) FILTER (WHERE it.code = 'T7') - min(it.at) FILTER (WHERE it.code = 'T0')) / 60 AS m
            FROM incidents i JOIN incident_times it ON it.incident_id = i.id, r
           WHERE i.final_priority = 'P1' AND i.created_at >= r.s AND i.created_at < r.e GROUP BY i.id)
        SELECT count(*) FILTER (WHERE m <= $3)::int AS num, count(m)::int AS den FROM c WHERE m IS NOT NULL`, [f, t, RESPONSE_TARGET_MIN.P1]);
      return ratio(x.num, x.den);
    },
  },
  answer_10s: {
    label: 'Cuộc gọi được nhấc máy trong 10 giây',
    calc: async (q, f, t) => {
      const x = await one(q, `WITH ${RANGE} SELECT count(*) FILTER (WHERE answered_at - ringing_at <= interval '10 seconds')::int AS num, count(*)::int AS den
                                FROM calls c, r WHERE c.ringing_at >= r.s AND c.ringing_at < r.e AND c.state <> 'ringing'`, [f, t]);
      return ratio(x.num, x.den);
    },
  },
  hand_hygiene: {
    label: 'Tuân thủ vệ sinh tay',
    calc: async (q, f, t) => {
      const x = await one(q, `WITH ${RANGE} SELECT count(*) FILTER (WHERE compliant)::int AS num, count(*)::int AS den FROM hand_hygiene_obs h, r WHERE h.observed_at >= r.s AND h.observed_at < r.e`, [f, t]);
      return ratio(x.num, x.den);
    },
  },
  satisfaction: {
    label: 'Người bệnh hài lòng (4–5 điểm)',
    calc: async (q, f, t) => {
      const x = await one(q, `WITH ${RANGE} SELECT count(*) FILTER (WHERE overall >= 4)::int AS num, count(answered_at)::int AS den FROM surveys s, r WHERE s.answered_at >= r.s AND s.answered_at < r.e`, [f, t]);
      return ratio(x.num, x.den);
    },
  },
  complaint_on_time: {
    label: 'Khiếu nại phản hồi đúng hạn',
    calc: async (q, f, t) => {
      const x = await one(q, `WITH ${RANGE} SELECT count(*) FILTER (WHERE responded_at IS NOT NULL AND responded_at <= due_at)::int AS num, count(*)::int AS den
                                FROM complaints c, r WHERE c.received_at >= r.s AND c.received_at < r.e`, [f, t]);
      return ratio(x.num, x.den);
    },
  },
  harm_events: {
    label: 'Sự cố gây tổn hại (NC2–NC3) trên 1000 ca',
    calc: async (q, f, t) => {
      const x = await one(q, `WITH ${RANGE} SELECT
          (SELECT count(*) FROM adverse_events e, r WHERE e.occurred_at >= r.s AND e.occurred_at < r.e AND coalesce(e.severity, e.severity_reported) IN ('NC2', 'NC3'))::int AS num,
          (SELECT count(DISTINCT a.incident_id) FROM assignments a, r WHERE a.assigned_at >= r.s AND a.assigned_at < r.e)::int AS den`, [f, t]);
      return ratio(x.num, x.den, 1000);
    },
  },
  disinfection_signed: {
    label: 'Phiếu khử khuẩn xe đã ký',
    calc: async (q, f, t) => {
      const x = await one(q, `WITH ${RANGE} SELECT count(*) FILTER (WHERE status = 'da_ky')::int AS num, count(*)::int AS den FROM disinfections d, r WHERE d.created_at >= r.s AND d.created_at < r.e`, [f, t]);
      return ratio(x.num, x.den);
    },
  },
  epcr_signed: {
    label: 'Ca có giao xe đã ký phiếu chăm sóc',
    calc: async (q, f, t) => {
      const x = await one(q, `WITH ${RANGE}, c AS (SELECT DISTINCT i.id FROM incidents i JOIN assignments a ON a.incident_id = i.id, r
                                                   WHERE i.created_at >= r.s AND i.created_at < r.e AND i.status = 'closed')
        SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM transfers t WHERE t.incident_id = c.id AND t.status = 'signed'))::int AS num, count(*)::int AS den FROM c`, [f, t]);
      return ratio(x.num, x.den);
    },
  },
  bls_valid: {
    label: 'Nhân viên lâm sàng có chứng chỉ BLS còn hạn (tại cuối kỳ)',
    calc: async (q, _f, t) => {
      const x = await one(q, `SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM staff_docs d WHERE d.staff_id = s.id AND d.kind IN ('bls', 'acls') AND NOT d.suspended
                                                                    AND (d.expires_on IS NULL OR d.expires_on >= $1::date)))::int AS num, count(*)::int AS den
                                FROM staff s JOIN users u ON u.id = s.user_id WHERE s.status = 'dang_lam' AND u.role = 'crew'`, [t]);
      return ratio(x.num, x.den);
    },
  },
  capa_on_time: {
    label: 'Hành động khắc phục xong đúng hạn',
    calc: async (q, f, t) => {
      const x = await one(q, `SELECT count(*) FILTER (WHERE done_at IS NOT NULL AND (done_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= due_date)::int AS num, count(*)::int AS den
                                FROM capa_actions WHERE due_date BETWEEN $1 AND $2 AND status <> 'huy'`, [f, t]);
      return ratio(x.num, x.den);
    },
  },
};

export function periodRange(period: string): [string, string] {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${period}-01`, `${period}-${String(last).padStart(2, '0')}`];
}

export function indicatorStatus(ind: { direction: string; target: number; warn: number | null }, value: number | null) {
  if (value == null) return null;
  const target = Number(ind.target);
  const warn = ind.warn == null ? null : Number(ind.warn);
  if (ind.direction === 'cao_tot') return value >= target ? (warn != null && value < warn ? 'canh_bao' : 'dat') : 'khong_dat';
  return value <= target ? (warn != null && value > warn ? 'canh_bao' : 'dat') : 'khong_dat';
}

/** Tính lại các chỉ số tự động cho một tháng; chỉ số nhập tay giữ nguyên */
export async function computeIndicators(tx: Tx, period: string) {
  const [from, to] = periodRange(period);
  const inds = await many(tx, `SELECT id, auto_key FROM qm_indicators WHERE active AND auto_key IS NOT NULL`);
  for (const i of inds) {
    const def = AUTO_INDICATORS[i.auto_key];
    if (!def) continue;
    const c = await def.calc(tx, from, to);
    await tx.query(`INSERT INTO qm_indicator_values(indicator_id, period, value, numerator, denominator, auto) VALUES ($1,$2,$3,$4,$5,true)
                    ON CONFLICT (indicator_id, period) DO UPDATE SET value = EXCLUDED.value, numerator = EXCLUDED.numerator, denominator = EXCLUDED.denominator,
                                                                    auto = true, updated_at = now()`, [i.id, period, c.value, c.num, c.den]);
  }
}

/** Bảng chỉ số 12 tháng đến tháng chọn, kèm trạng thái so với chỉ tiêu */
export async function indicatorBoard(q: Queryable, endPeriod: string, months = 12) {
  const [y, m] = endPeriod.split('-').map(Number);
  const periods = Array.from({ length: months }, (_, k) => {
    const d = new Date(Date.UTC(y, m - 1 - (months - 1 - k), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
  const inds = await many(q, `SELECT i.*, u.full_name AS owner_name FROM qm_indicators i LEFT JOIN users u ON u.id = i.owner_id WHERE i.active ORDER BY i.ordinal, i.code`);
  const vals = await many(q, `SELECT * FROM qm_indicator_values WHERE period = ANY($1)`, [periods]);
  const capa = await many(q, `SELECT indicator_id, source_ref FROM capa_actions WHERE indicator_id IS NOT NULL AND status <> 'huy'`);
  return {
    periods,
    rows: inds.map((i) => ({
      ...i,
      autoLabel: i.auto_key ? AUTO_INDICATORS[i.auto_key]?.label ?? null : null,
      values: Object.fromEntries(periods.map((p) => {
        const v = vals.find((x) => x.indicator_id === i.id && x.period === p);
        const value = v?.value == null ? null : Number(v.value);
        return [p, v ? { value, numerator: v.numerator == null ? null : Number(v.numerator), denominator: v.denominator == null ? null : Number(v.denominator), note: v.note, auto: v.auto, status: indicatorStatus(i, value),
          capa: capa.some((c) => c.indicator_id === i.id && c.source_ref === p) } : null];
      })),
    })),
  };
}

/* ================= Giám sát tuân thủ: gọi lại ngẫu nhiên ================= */

export const SAMPLE_PCT = 10;

/** Kiểm tra hồ sơ của một ca không cần gọi: phiếu đã ký, đủ mốc thời gian, thời gian hiện trường hợp lý, sửa phiếu sau ký */
export async function recordChecks(q: Queryable, incidentId: string) {
  const x = await one(q, `
    SELECT i.final_priority,
           EXISTS (SELECT 1 FROM transfers t WHERE t.incident_id = i.id AND t.status = 'signed') AS signed,
           EXISTS (SELECT 1 FROM transfer_amendments m JOIN transfers t ON t.id = m.transfer_id WHERE t.incident_id = i.id) AS amended,
           array(SELECT DISTINCT code FROM incident_times WHERE incident_id = i.id) AS codes,
           extract(epoch FROM (SELECT max(at) FILTER (WHERE code = 'T10') - max(at) FILTER (WHERE code = 'T7') FROM incident_times WHERE incident_id = i.id)) / 60 AS scene_min,
           extract(epoch FROM (SELECT max(at) FILTER (WHERE code = 'T7') - min(at) FILTER (WHERE code = 'T0') FROM incident_times WHERE incident_id = i.id)) / 60 AS response_min
      FROM incidents i WHERE i.id = $1`, [incidentId]);
  const missing = ['T0', 'T4', 'T6', 'T7'].filter((c) => !x.codes.includes(c));
  const target = RESPONSE_TARGET_MIN[x.final_priority as string];
  const scene = x.scene_min == null ? null : Math.round(Number(x.scene_min) * 10) / 10;
  const response = x.response_min == null ? null : Math.round(Number(x.response_min) * 10) / 10;
  const flags: string[] = [];
  if (!x.signed) flags.push('Chưa ký phiếu chăm sóc');
  if (missing.length) flags.push(`Thiếu mốc ${missing.join(', ')}`);
  if (scene != null && (scene < 2 || scene > 90)) flags.push(`Thời gian hiện trường bất thường (${scene} phút)`);
  if (target && response != null && response > target) flags.push(`Tới hiện trường sau ${response} phút, quá chỉ tiêu ${target} phút`);
  if (x.amended) flags.push('Phiếu được bổ sung sau khi ký');
  return { signed: x.signed, missingTimes: missing, sceneMin: scene, responseMin: response, amended: x.amended, flags };
}

/** Rút ngẫu nhiên tối thiểu 10% ca đã đóng có giao xe và có số gọi lại trong khoảng ngày */
export async function createCallbackRound(tx: Tx, actor: Actor, b: { from: string; to: string; pct: number }) {
  if (b.to < b.from) throw new HttpError(400, 'Khoảng ngày không hợp lệ');
  const pop = await many(tx, `WITH ${RANGE}
    SELECT i.id FROM incidents i, r WHERE i.status = 'closed' AND i.created_at >= r.s AND i.created_at < r.e AND coalesce(i.callback_phone, i.caller_phone) IS NOT NULL
       AND EXISTS (SELECT 1 FROM assignments a WHERE a.incident_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM qm_callbacks c WHERE c.incident_id = i.id)
     ORDER BY random()`, [b.from, b.to]);
  if (!pop.length) throw new HttpError(409, 'Không có ca đã đóng nào chưa được giám sát trong khoảng này');
  const n = Math.max(1, Math.ceil((pop.length * b.pct) / 100));
  const period = b.to.slice(0, 7);
  const k = await nextCounter(tx, 'qm_callback_round', period);
  const round = await one(tx, `INSERT INTO qm_callback_rounds(code, date_from, date_to, sample_pct, population, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [`GS-${period}${k > 1 ? `-${k}` : ''}`, b.from, b.to, b.pct, pop.length, actor.id]);
  for (const p of pop.slice(0, n)) {
    await tx.query(`INSERT INTO qm_callbacks(round_id, incident_id, checks) VALUES ($1,$2,$3)`, [round.id, p.id, JSON.stringify(await recordChecks(tx, p.id))]);
  }
  await audit(tx, 'system', actor, 'qm.callback_round', 'qm_callback_round', round.id, { code: round.code, population: pop.length, sample: n });
  return { ...round, sample: n };
}

export async function recordCallback(tx: Tx, actor: Actor, id: string, b: { status: 'da_goi' | 'khong_lien_lac'; confirmed?: boolean | null; attitude?: number | null; issues?: string | null }) {
  const c = await one(tx, `UPDATE qm_callbacks SET status = $2, confirmed = $3, attitude = $4, issues = $5, called_by = $6, called_at = now()
                            WHERE id = $1 RETURNING *`, [id, b.status, b.confirmed ?? null, b.attitude ?? null, b.issues ?? null, actor.id]);
  if (!c) throw new HttpError(404, 'Không tìm thấy ca giám sát');
  await audit(tx, 'system', actor, 'qm.callback_recorded', 'qm_callback', id, { status: b.status, confirmed: b.confirmed, attitude: b.attitude });
  return c;
}

/* ================= Nhà cung cấp ================= */

export const SUPPLIER_CATEGORY: Record<string, string> = {
  xe: 'Xe, sửa chữa xe', thuoc_vat_tu: 'Thuốc, vật tư', thiet_bi: 'Thiết bị y tế', xet_nghiem: 'Xét nghiệm', benh_vien: 'Bệnh viện tiếp nhận',
  phan_mem: 'Phần mềm, công nghệ', dich_vu: 'Dịch vụ (vệ sinh, chất thải...)', khac: 'Khác',
};
export const SUPPLIER_CRITERIA: [string, string][] = [
  ['chat_luong', 'Chất lượng hàng hóa, dịch vụ'], ['dung_hen', 'Giao đúng hẹn, đúng số lượng'], ['gia', 'Giá và điều kiện thanh toán'],
  ['phuc_vu', 'Hỗ trợ, xử lý khiếu nại'], ['phap_ly', 'Giấy phép, hồ sơ pháp lý, an toàn'],
];

export function gradeSupplier(scores: Record<string, number>) {
  const total = SUPPLIER_CRITERIA.reduce((s, [k]) => {
    const v = scores[k];
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new HttpError(400, `Chấm đủ 5 tiêu chí, mỗi tiêu chí 1–5 điểm`);
    return s + v;
  }, 0);
  const pct = Math.round((total / (SUPPLIER_CRITERIA.length * 5)) * 1000) / 10;
  return { pct, result: pct >= 70 ? 'dat' : pct >= 50 ? 'theo_doi' : 'khong_dat' };
}

export async function evaluateSupplier(tx: Tx, actor: Actor, supplierId: string, b: { period: string; scores: Record<string, number>; note?: string | null }) {
  const g = gradeSupplier(b.scores);
  const e = await one(tx, `INSERT INTO qm_supplier_evals(supplier_id, period, scores, pct, result, note, evaluated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
                           ON CONFLICT (supplier_id, period) DO UPDATE SET scores = EXCLUDED.scores, pct = EXCLUDED.pct, result = EXCLUDED.result,
                                                                          note = EXCLUDED.note, evaluated_by = EXCLUDED.evaluated_by, created_at = now()
                           RETURNING *`, [supplierId, b.period, JSON.stringify(b.scores), g.pct, g.result, b.note ?? null, actor.id]);
  // Không đạt thì chuyển sang theo dõi; ngừng hợp tác do Ban Giám đốc quyết định
  if (g.result !== 'dat') await tx.query(`UPDATE qm_suppliers SET status = 'theo_doi' WHERE id = $1 AND status = 'duoc_duyet'`, [supplierId]);
  await audit(tx, 'system', actor, 'qm.supplier_evaluated', 'qm_supplier', supplierId, { period: b.period, pct: g.pct, result: g.result });
  return e;
}

/* ================= Xem xét của lãnh đạo ================= */

/** Đầu vào xem xét của lãnh đạo theo ISO 9001 mục 9.3, lấy tự động từ dữ liệu trong kỳ */
export async function reviewInputs(q: Queryable, from: string, to: string) {
  const months: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  const board = await indicatorBoard(q, to.slice(0, 7), months.length);
  const indicators = board.rows.map((r) => {
    const vs = months.map((p) => r.values[p]).filter((v) => v && v.value != null) as { value: number; status: string }[];
    const last = vs[vs.length - 1];
    return { code: r.code, name: r.name, unit: r.unit, target: Number(r.target), direction: r.direction, last: last?.value ?? null, status: last?.status ?? null, missed: vs.filter((v) => v.status === 'khong_dat').length };
  });
  const [events, complaints, surveys, audits, findings, capa, risks, suppliers, callbacks] = await Promise.all([
    many(q, `WITH ${RANGE} SELECT coalesce(severity, severity_reported) AS severity, count(*)::int AS n, count(*) FILTER (WHERE status = 'dong')::int AS closed
               FROM adverse_events e, r WHERE e.reported_at >= r.s AND e.reported_at < r.e GROUP BY 1 ORDER BY 1`, [from, to]),
    one(q, `WITH ${RANGE} SELECT count(*)::int AS n, count(*) FILTER (WHERE responded_at <= due_at)::int AS on_time, count(*) FILTER (WHERE status <> 'dong')::int AS open
              FROM complaints c, r WHERE c.received_at >= r.s AND c.received_at < r.e`, [from, to]),
    one(q, `WITH ${RANGE} SELECT count(answered_at)::int AS answered, count(*) FILTER (WHERE overall >= 4)::int AS satisfied, round(avg(overall)::numeric, 2)::float AS avg
              FROM surveys s, r WHERE s.answered_at >= r.s AND s.answered_at < r.e`, [from, to]),
    many(q, `SELECT code, title, audited_unit, status, performed_on FROM qm_audits WHERE performed_on BETWEEN $1 AND $2 OR (status <> 'huy' AND year = extract(year FROM $2::date) AND planned_month BETWEEN extract(month FROM $1::date) AND extract(month FROM $2::date)) ORDER BY code`, [from, to]),
    many(q, `SELECT f.kind, count(*)::int AS n FROM qm_findings f JOIN qm_audits a ON a.id = f.audit_id WHERE f.created_at::date BETWEEN $1 AND $2 GROUP BY 1`, [from, to]),
    one(q, `SELECT count(*) FILTER (WHERE status = 'mo')::int AS open, count(*) FILTER (WHERE status = 'mo' AND due_date < vn_today())::int AS overdue,
                   count(*) FILTER (WHERE status = 'xong')::int AS awaiting_verify, count(*) FILTER (WHERE effective IS TRUE AND verified_at::date BETWEEN $1 AND $2)::int AS effective,
                   count(*) FILTER (WHERE effective IS FALSE AND verified_at::date BETWEEN $1 AND $2)::int AS not_effective
              FROM capa_actions`, [from, to]),
    many(q, `SELECT code, area, hazard, score FROM qm_risks WHERE status = 'mo' AND score >= 15 ORDER BY score DESC`),
    many(q, `SELECT s.name, e.period, e.pct, e.result FROM qm_supplier_evals e JOIN qm_suppliers s ON s.id = e.supplier_id
              WHERE e.created_at::date BETWEEN $1 AND $2 AND e.result <> 'dat' ORDER BY e.pct`, [from, to]),
    one(q, `SELECT count(*)::int AS n, count(*) FILTER (WHERE c.status = 'da_goi')::int AS called,
                   count(*) FILTER (WHERE c.confirmed IS FALSE OR c.attitude <= 2 OR jsonb_array_length(c.checks->'flags') > 0)::int AS issues
              FROM qm_callbacks c JOIN qm_callback_rounds r ON r.id = c.round_id WHERE r.date_to BETWEEN $1 AND $2`, [from, to]),
  ]);
  const years = [...new Set([from.slice(0, 4), to.slice(0, 4)])].map(Number);
  const tr = await trainingReport(q, years[years.length - 1]);
  return {
    period: { from, to }, indicators, events, complaints, surveys, audits, findings, capa, highRisks: risks, suppliers, callbacks,
    training: { year: tr.year, staff: tr.staff, trainedPct: tr.trained.pct, certifiedPct: tr.certified.pct, planPct: tr.plan.pct },
  };
}

export async function createReview(tx: Tx, actor: Actor, b: { from: string; to: string; meetingOn: string; chairId?: string | null; attendees?: string | null }) {
  if (b.to < b.from) throw new HttpError(400, 'Khoảng ngày không hợp lệ');
  const quarter = Math.floor((Number(b.to.slice(5, 7)) - 1) / 3) + 1;
  const base = `XXLD-${b.to.slice(0, 4)}-Q${quarter}`;
  const dup = await one(tx, 'SELECT count(*)::int AS n FROM qm_reviews WHERE code LIKE $1', [`${base}%`]);
  const r = await one(tx, `INSERT INTO qm_reviews(code, date_from, date_to, meeting_on, chair_id, attendees, inputs, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [dup.n ? `${base}-${dup.n + 1}` : base, b.from, b.to, b.meetingOn, b.chairId ?? null, b.attendees ?? null, JSON.stringify(await reviewInputs(tx, b.from, b.to)), actor.id]);
  await audit(tx, 'system', actor, 'qm.review_created', 'qm_review', r.id, { code: r.code });
  return r;
}

export async function updateReview(tx: Tx, actor: Actor, id: string, b: { conclusions?: string | null; attendees?: string | null; chairId?: string | null; refresh?: boolean }) {
  const r = await one(tx, 'SELECT * FROM qm_reviews WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw new HttpError(404, 'Không tìm thấy biên bản');
  if (r.status !== 'du_thao') throw new HttpError(409, 'Biên bản đã chốt, không sửa được');
  const inputs = b.refresh ? JSON.stringify(await reviewInputs(tx, r.date_from, r.date_to)) : null;
  const out = await one(tx, `UPDATE qm_reviews SET conclusions = CASE WHEN $2 THEN $3 ELSE conclusions END, attendees = CASE WHEN $4 THEN $5 ELSE attendees END,
                                                   chair_id = CASE WHEN $6 THEN $7 ELSE chair_id END, inputs = coalesce($8::jsonb, inputs)
                              WHERE id = $1 RETURNING *`,
  [id, 'conclusions' in b, b.conclusions ?? null, 'attendees' in b, b.attendees ?? null, 'chairId' in b, b.chairId ?? null, inputs]);
  await audit(tx, 'system', actor, 'qm.review_updated', 'qm_review', id, { code: r.code, refresh: !!b.refresh });
  return out;
}

/** Chủ trì (Ban Giám đốc) ký chốt: số liệu đầu vào cố định từ lúc này */
export async function signReview(tx: Tx, actor: Actor & { role: string }, id: string) {
  const r = await one(tx, 'SELECT * FROM qm_reviews WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw new HttpError(404, 'Không tìm thấy biên bản');
  if (r.status !== 'du_thao') throw new HttpError(409, 'Biên bản đã chốt');
  if (!['director', 'admin'].includes(actor.role)) throw new HttpError(403, 'Ban Giám đốc ký chốt biên bản');
  if (r.chair_id && r.chair_id !== actor.id && actor.role !== 'admin') throw new HttpError(403, 'Người chủ trì ký chốt biên bản');
  if (!r.conclusions?.trim()) throw new HttpError(409, 'Ghi kết luận của lãnh đạo trước khi chốt');
  await tx.query(`UPDATE qm_reviews SET status = 'da_chot', signed_by = $2, signed_at = now() WHERE id = $1`, [id, actor.id]);
  await audit(tx, 'system', actor, 'qm.review_signed', 'qm_review', id, { code: r.code });
}

/* ================= Thời hạn lưu hồ sơ ================= */

/** Đếm số hồ sơ đã quá thời hạn lưu theo từng loại; phần mềm không tự xóa */
export const RETENTION_COUNT: Record<string, string> = {
  benh_an: `SELECT count(*)::int AS n FROM transfers WHERE status = 'signed' AND signed_at < $1::date`,
  cuoc_goi: `SELECT count(*)::int AS n FROM calls WHERE ringing_at < $1::date`,
  nhat_ky: `SELECT count(*)::int AS n FROM audit_events WHERE at < $1::date`,
  su_co: `SELECT count(*)::int AS n FROM adverse_events WHERE status = 'dong' AND closed_at < $1::date`,
  khieu_nai: `SELECT count(*)::int AS n FROM complaints WHERE status = 'dong' AND received_at < $1::date`,
  khao_sat: `SELECT count(*)::int AS n FROM surveys WHERE created_at < $1::date`,
  khu_khuan: `SELECT count(*)::int AS n FROM disinfections WHERE created_at < $1::date`,
  bai_thi: `SELECT count(*)::int AS n FROM tr_attempts WHERE started_at < $1::date`,
};

export async function retentionList(q: Queryable) {
  const rows = await many(q, `SELECT r.*, u.full_name AS updated_by_name, (vn_today() - make_interval(years => r.years))::date AS cutoff
                                FROM qm_retention r LEFT JOIN users u ON u.id = r.updated_by ORDER BY r.label`);
  for (const r of rows) r.expired = RETENTION_COUNT[r.key] ? (await one(q, RETENTION_COUNT[r.key], [r.cutoff])).n : null;
  return rows;
}

/* ================= Dữ liệu mẫu ================= */

interface SeedFile {
  note: string;
  indicators: { code: string; name: string; definition: string; formula: string; unit: string; direction: string; target: number; warn?: number | null; auto_key?: string | null }[];
  risks: { area: string; hazard: string; cause: string; consequence: string; likelihood: number; impact: number; controls: string }[];
  retention: { key: string; label: string; years: number; basis: string }[];
}

/** Nạp bộ chỉ số, sổ rủi ro mẫu và thời hạn lưu mẫu khi các bảng còn trống; người dùng sửa toàn bộ */
export async function seedQms(tx: Tx) {
  const data: SeedFile = JSON.parse(readFileSync(new URL('../data/he-thong-chat-luong-mau.json', import.meta.url), 'utf8'));
  if (!(await one(tx, 'SELECT 1 FROM qm_indicators LIMIT 1'))) {
    let k = 0;
    for (const i of data.indicators) {
      if (i.auto_key && !AUTO_INDICATORS[i.auto_key]) throw new Error(`Chỉ số mẫu ${i.code}: auto_key ${i.auto_key} không tồn tại`);
      await tx.query(`INSERT INTO qm_indicators(code, name, definition, formula, unit, direction, target, warn, auto_key, ordinal, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [i.code, i.name, i.definition, i.formula, i.unit, i.direction, i.target, i.warn ?? null, i.auto_key ?? null, ++k, data.note]);
    }
  }
  if (!(await one(tx, 'SELECT 1 FROM qm_risks LIMIT 1'))) {
    for (const r of data.risks) {
      const n = await nextCounter(tx, 'qm_risk', 'all');
      const row = await one(tx, `INSERT INTO qm_risks(code, area, hazard, cause, consequence, likelihood, impact, controls, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [`RR-${String(n).padStart(4, '0')}`, r.area, r.hazard, r.cause, r.consequence, r.likelihood, r.impact, r.controls, data.note]);
      await tx.query(`INSERT INTO qm_risk_reviews(risk_id, reviewed_on, likelihood, impact, note) VALUES ($1, vn_today(), $2, $3, 'Nhận diện (mẫu)')`, [row.id, r.likelihood, r.impact]);
    }
  }
  for (const r of data.retention) {
    if (!RETENTION_COUNT[r.key]) throw new Error(`Thời hạn lưu mẫu: loại ${r.key} không đếm được`);
    await tx.query(`INSERT INTO qm_retention(key, label, years, basis) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING`, [r.key, r.label, r.years, r.basis]);
  }
}
