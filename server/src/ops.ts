import { audit, type Actor } from './audit.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError, incidentScope } from './domain.js';
import { haversineKm } from './fleet.js';
import { RESPONSE_TARGET_MIN } from './reports.js';

/**
 * Vận hành (giai đoạn I): sổ ngừng tuần hoàn ngoài viện theo Utstein, rà soát ca sau cấp cứu (bình ca hằng tuần,
 * phản hồi không trừng phạt), lưu vết GPS và đối chiếu lộ trình, chế độ đông nạn nhân (ICS, phân loại START,
 * phân bổ bệnh viện), hồ sơ và bảo dưỡng xe (QL-19).
 */

const RANGE = `r AS (SELECT ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AS s, ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AS e)`;
const mins = (a?: string | null, b?: string | null) => {
  if (!a || !b) return null;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 60000;
  return Number.isFinite(d) ? Math.round(d * 10) / 10 : null;
};

/* ================= Utstein ================= */

export const UTSTEIN_LABELS = {
  witnessed: { khong: 'Không ai chứng kiến', nguoi_dan: 'Người dân chứng kiến', nhan_vien_y_te: 'Nhân viên y tế (không phải kíp) chứng kiến', kip: 'Kíp cấp cứu chứng kiến' },
  location: { nha: 'Nhà riêng', noi_cong_cong: 'Nơi công cộng', duong: 'Đường, phương tiện giao thông', noi_lam_viec: 'Nơi làm việc', co_so_y_te: 'Cơ sở y tế', xe_cuu_thuong: 'Trên xe cứu thương', khac: 'Khác' },
  cause: {
    tim: 'Do tim (giả định)', chan_thuong: 'Chấn thương', ngat: 'Ngạt, tắc đường thở', duoi_nuoc: 'Đuối nước', ngo_doc: 'Ngộ độc',
    dien_giat: 'Điện giật', qua_lieu: 'Quá liều thuốc, chất', khac_khong_do_tim: 'Nguyên nhân khác không do tim', khong_ro: 'Không rõ',
  },
  bystanderCpr: { khong: 'Không', chi_ep_tim: 'Chỉ ép tim', ep_tim_thoi_ngat: 'Ép tim và thổi ngạt', khong_ro: 'Không rõ' },
  publicAed: { khong: 'Không dùng', gan_khong_soc: 'Gắn máy, không sốc', co_soc: 'Gắn máy và đã sốc' },
  notAttemptedReason: { dau_hieu_tu_vong: 'Dấu hiệu tử vong rõ', y_nguyen: 'Ý nguyện không hồi sức', nguy_hiem: 'Hiện trường nguy hiểm', khac: 'Khác' },
  firstRhythm: {
    vf: 'Rung thất', pvt: 'Nhanh thất vô mạch', pea: 'Hoạt động điện vô mạch', vo_tam_thu: 'Vô tâm thu',
    aed_soc_duoc: 'AED báo sốc được', aed_khong_soc: 'AED báo không sốc', khong_ro: 'Không rõ',
  },
  airway: { khong: 'Không', bop_bong: 'Bóp bóng mặt nạ', mat_na_thanh_quan: 'Mặt nạ thanh quản', noi_khi_quan: 'Nội khí quản' },
} as const;
const SHOCKABLE = new Set(['vf', 'pvt', 'aed_soc_duoc']);

export interface ArrestRow {
  transfer_id: string; transfer_number: string | null; incident_id: string; incident_code: string; created_at: string;
  arrest: Record<string, any>; patient: Record<string, any>; disposition: string | null; hospital: string | null;
  t0: string | null; t4: string | null; t7: string | null;
  admitted: boolean | null; survived_30d: boolean | null; discharged_on: string | null; cpc: number | null; outcome_note: string | null;
  shockable?: boolean; comparator?: boolean; intervals?: Record<string, number | null>;
}

/** Sổ đăng ký: mọi phiếu đã ký có ngừng tuần hoàn trong khoảng ngày; dữ liệu hiện trường đọc từ ePCR mới nhất */
export async function arrestRegistry(q: Queryable, from: string, to: string): Promise<ArrestRow[]> {
  const rows = await many<ArrestRow>(q, `WITH ${RANGE}
    SELECT t.id AS transfer_id, t.transfer_number, i.id AS incident_id, i.code AS incident_code, i.created_at,
           t.epcr->'arrest' AS arrest, t.epcr->'patient' AS patient, t.epcr->'disposition'->>'type' AS disposition, t.epcr->'disposition'->>'hospital' AS hospital,
           (SELECT at FROM incident_times WHERE incident_id = i.id AND code = 'T0') AS t0,
           (SELECT at FROM incident_times WHERE incident_id = i.id AND code = 'T4') AS t4,
           (SELECT at FROM incident_times WHERE incident_id = i.id AND code = 'T7') AS t7,
           o.admitted, o.survived_30d, o.discharged_on, o.cpc, o.note AS outcome_note
      FROM transfers t JOIN incidents i ON i.id = t.incident_id CROSS JOIN r
      LEFT JOIN ops_arrest_outcomes o ON o.transfer_id = t.id
     WHERE t.status = 'signed' AND (t.epcr->'arrest'->>'present')::boolean IS TRUE AND i.created_at >= r.s AND i.created_at < r.e
     ORDER BY i.created_at DESC`, [from, to]);
  for (const x of rows) {
    const a = x.arrest ?? {};
    x.shockable = SHOCKABLE.has(a.firstRhythm) || a.publicAed === 'co_soc';
    // Nhóm so sánh Utstein: người dân chứng kiến và nhịp đầu sốc được
    x.comparator = a.attempted === true && a.witnessed === 'nguoi_dan' && x.shockable;
    x.intervals = {
      callToArrival: mins(x.t0, x.t7),
      collapseToCall: mins(a.collapseAt, x.t0),
      collapseToCpr: mins(a.collapseAt, a.cprStartAt),
      callToShock: mins(x.t0, a.firstShockAt),
      cprToAdrenaline: mins(a.cprStartAt, a.adrenalineFirstAt),
      cprToRosc: mins(a.cprStartAt, a.roscAt),
    };
  }
  return rows;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const median = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => x != null && x >= 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 10) / 10;
};

/** Báo cáo Utstein: sơ đồ luồng, đặc điểm, can thiệp, kết cục, nhóm so sánh */
export function utsteinReport(rows: ArrestRow[], populationServed: number | null) {
  const a = (r: ArrestRow) => r.arrest ?? {};
  const attempted = rows.filter((r) => a(r).attempted === true);
  const notAttempted = rows.filter((r) => a(r).attempted === false);
  const emsWitnessed = attempted.filter((r) => a(r).witnessed === 'kip');
  const beforeEms = attempted.filter((r) => a(r).witnessed !== 'kip');
  const cardiac = attempted.filter((r) => a(r).cause === 'tim');
  const comparator = attempted.filter((r) => r.comparator);
  const outcome = (set: ArrestRow[]) => ({
    n: set.length,
    roscAny: set.filter((r) => a(r).roscAny).length,
    roscOnArrival: set.filter((r) => a(r).roscOnArrival).length,
    admitted: set.filter((r) => r.admitted).length,
    survived: set.filter((r) => r.survived_30d).length,
    goodCpc: set.filter((r) => r.survived_30d && r.cpc != null && r.cpc <= 2).length,
    followedUp: set.filter((r) => r.survived_30d != null).length,
  });
  const count = (set: ArrestRow[], key: string) => {
    const out: Record<string, number> = {};
    for (const r of set) { const k = a(r)[key] ?? 'chua_ghi'; out[k] = (out[k] ?? 0) + 1; }
    return out;
  };
  return {
    populationServed,
    flow: {
      total: rows.length, attempted: attempted.length, notAttempted: notAttempted.length,
      notAttemptedReasons: count(notAttempted, 'notAttemptedReason'),
      emsWitnessed: emsWitnessed.length, beforeEms: beforeEms.length, cardiac: cardiac.length, comparator: comparator.length,
    },
    incidencePer100k: populationServed ? Math.round((attempted.length / populationServed) * 100000 * 10) / 10 : null,
    characteristics: {
      cause: count(attempted, 'cause'), location: count(attempted, 'location'), witnessed: count(attempted, 'witnessed'),
      firstRhythm: count(attempted, 'firstRhythm'),
      shockablePct: pct(attempted.filter((r) => r.shockable).length, attempted.length),
      age: median(attempted.map((r) => r.patient?.age ?? null)),
      male: attempted.filter((r) => r.patient?.sex === 'M').length,
    },
    bystander: {
      cprPct: pct(beforeEms.filter((r) => ['chi_ep_tim', 'ep_tim_thoi_ngat'].includes(a(r).bystanderCpr)).length, beforeEms.length),
      dispatcherCprPct: pct(beforeEms.filter((r) => a(r).dispatcherCpr).length, beforeEms.length),
      publicAedPct: pct(beforeEms.filter((r) => ['gan_khong_soc', 'co_soc'].includes(a(r).publicAed)).length, beforeEms.length),
      publicShockPct: pct(beforeEms.filter((r) => a(r).publicAed === 'co_soc').length, beforeEms.length),
    },
    intervals: {
      callToArrival: median(attempted.map((r) => r.intervals?.callToArrival)),
      collapseToCpr: median(beforeEms.map((r) => r.intervals?.collapseToCpr)),
      callToShock: median(attempted.filter((r) => r.shockable).map((r) => r.intervals?.callToShock)),
      cprToAdrenaline: median(attempted.map((r) => r.intervals?.cprToAdrenaline)),
    },
    treatment: {
      shocked: attempted.filter((r) => (a(r).shocks ?? 0) > 0 || a(r).firstShockAt).length,
      adrenaline: attempted.filter((r) => (a(r).adrenalineDoses ?? 0) > 0 || a(r).adrenalineFirstAt).length,
      advancedAirway: attempted.filter((r) => ['mat_na_thanh_quan', 'noi_khi_quan'].includes(a(r).airway)).length,
      mechanical: attempted.filter((r) => a(r).mechanicalCpr).length,
      ttm: attempted.filter((r) => a(r).ttm).length,
      ecpr: attempted.filter((r) => a(r).ecpr).length,
    },
    outcomes: { all: outcome(attempted), beforeEms: outcome(beforeEms), emsWitnessed: outcome(emsWitnessed), comparator: outcome(comparator) },
  };
}

export async function saveArrestOutcome(tx: Tx, actor: Actor, transferId: string, b: {
  admitted?: boolean | null; survived30d?: boolean | null; dischargedOn?: string | null; cpc?: number | null; note?: string | null;
}) {
  const t = await one(tx, `SELECT id, incident_id FROM transfers WHERE id = $1 AND status = 'signed' AND (epcr->'arrest'->>'present')::boolean IS TRUE`, [transferId]);
  if (!t) throw new HttpError(404, 'Không có phiếu ngừng tuần hoàn này');
  if (b.survived30d && b.admitted === false) throw new HttpError(400, 'Sống 30 ngày thì phải có nhập viện');
  if (b.cpc != null && !b.survived30d) throw new HttpError(400, 'Phân độ CPC chỉ ghi khi người bệnh sống ra viện');
  const row = await one(tx, `
    INSERT INTO ops_arrest_outcomes(transfer_id, admitted, survived_30d, discharged_on, cpc, note, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (transfer_id) DO UPDATE SET admitted = $2, survived_30d = $3, discharged_on = $4, cpc = $5, note = $6, updated_by = $7, updated_at = now()
    RETURNING *`, [transferId, b.admitted ?? null, b.survived30d ?? null, b.dischargedOn ?? null, b.cpc ?? null, b.note ?? null, actor.id]);
  await audit(tx, incidentScope(t.incident_id), actor, 'ops.arrest_outcome', 'transfer', transferId, b);
  return row;
}

/* ================= Rà soát ca ================= */

export const REVIEW_REASONS: Record<string, string> = {
  tu_vong: 'Tử vong', ngung_tim: 'Ngừng tuần hoàn', p1: 'Ca P1', khieu_nai: 'Có khiếu nại', su_co: 'Có báo cáo sự cố',
  phan_loai: 'Điều phối viên đổi mức ưu tiên so với gợi ý', cham: 'Tới hiện trường quá chỉ tiêu', tu_choi: 'Người bệnh từ chối vận chuyển',
  rut_xe: 'Xe bị rút sang ca khác', bo_sung: 'Phiếu bổ sung sau khi ký', mci: 'Đông nạn nhân', chon: 'Người rà soát chọn',
};
export const REVIEW_CRITERIA: [key: string, label: string][] = [
  ['dieu_phoi', 'Tiếp nhận, phân loại, điều phối đúng và kịp thời'],
  ['tiep_can', 'Đánh giá ban đầu ABCDE, nhận định đúng vấn đề'],
  ['dieu_tri', 'Can thiệp, thuốc theo phác đồ, đúng liều, đúng chỉ định'],
  ['an_toan', 'An toàn người bệnh và kíp (cố định, vận chuyển, KSNK)'],
  ['ghi_chep', 'Ghi chép đầy đủ, mốc thời gian, chữ ký'],
  ['ban_giao', 'Chọn bệnh viện phù hợp, báo trước, bàn giao đủ thông tin'],
  ['giao_tiep', 'Giao tiếp với người bệnh, người nhà, phối hợp trong kíp'],
];
export const REVIEW_SCORE: Record<string, string> = { dat: 'Đạt', can_cai_thien: 'Cần cải thiện', khong_dat: 'Không đạt', khong_ap_dung: 'Không áp dụng' };

/** Lý do một ca cần bình (theo kế hoạch: ca tử vong, ngừng tim, khiếu nại, phân loại sai, cộng ca P1, chậm, từ chối) */
const reasonSql = (pri: string, target: string) => `
  array_remove(ARRAY[
    CASE WHEN EXISTS (SELECT 1 FROM transfers t WHERE t.incident_id = i.id AND t.epcr->'disposition'->>'type' = 'dead_on_scene') THEN 'tu_vong' END,
    CASE WHEN EXISTS (SELECT 1 FROM transfers t WHERE t.incident_id = i.id AND (t.epcr->'arrest'->>'present')::boolean IS TRUE) THEN 'ngung_tim' END,
    CASE WHEN i.final_priority = 'P1' THEN 'p1' END,
    CASE WHEN EXISTS (SELECT 1 FROM complaints c WHERE c.incident_id = i.id) THEN 'khieu_nai' END,
    CASE WHEN EXISTS (SELECT 1 FROM adverse_events e WHERE e.incident_id = i.id) THEN 'su_co' END,
    CASE WHEN i.suggested_priority IS NOT NULL AND i.final_priority IS NOT NULL AND i.suggested_priority <> i.final_priority THEN 'phan_loai' END,
    CASE WHEN i.final_priority = ANY(${pri}::text[]) AND (SELECT extract(epoch FROM max(at) FILTER (WHERE code = 'T7') - min(at) FILTER (WHERE code = 'T0')) / 60
               FROM incident_times WHERE incident_id = i.id) > (${target}::jsonb ->> i.final_priority)::numeric THEN 'cham' END,
    CASE WHEN EXISTS (SELECT 1 FROM transfers t WHERE t.incident_id = i.id AND t.epcr->'disposition'->>'type' = 'refused') THEN 'tu_choi' END,
    CASE WHEN EXISTS (SELECT 1 FROM assignments a WHERE a.incident_id = i.id AND a.end_reason LIKE 'Rút xe%') THEN 'rut_xe' END,
    CASE WHEN EXISTS (SELECT 1 FROM transfer_amendments m JOIN transfers t ON t.id = m.transfer_id WHERE t.incident_id = i.id) THEN 'bo_sung' END,
    CASE WHEN i.mci_declared_at IS NOT NULL THEN 'mci' END
  ], NULL)`;

/** Hàng chờ bình ca: ca đã đóng trong khoảng có ít nhất một lý do, kèm trạng thái rà soát */
export async function reviewQueue(q: Queryable, from: string, to: string, onlyOpen: boolean) {
  const rows = await many(q, `WITH ${RANGE}, c AS (
      SELECT i.id, i.code, i.final_priority, i.chief_complaint, i.created_at, ${reasonSql('$3', '$4')} AS reasons
        FROM incidents i, r WHERE i.status = 'closed' AND i.created_at >= r.s AND i.created_at < r.e
    )
    SELECT c.*, cr.id AS review_id, cr.code AS review_code, cr.status AS review_status, u.full_name AS reviewer_name,
           (SELECT string_agg(DISTINCT a.vehicle_id, ', ') FROM assignments a WHERE a.incident_id = c.id) AS vehicles
      FROM c LEFT JOIN ops_case_reviews cr ON cr.incident_id = c.id LEFT JOIN users u ON u.id = cr.reviewer_id
     WHERE (cardinality(c.reasons) > 0 OR cr.id IS NOT NULL) ${onlyOpen ? `AND (cr.id IS NULL OR cr.status <> 'da_xong')` : ''}
     ORDER BY (cr.status = 'da_xong') NULLS FIRST, cardinality(c.reasons) DESC, c.created_at DESC`,
  [from, to, Object.keys(RESPONSE_TARGET_MIN), JSON.stringify(RESPONSE_TARGET_MIN)]);
  return rows;
}

/** Người trong kíp của ca (đăng nhập ca trên xe được giao trong thời gian giao xe) */
export async function caseCrew(q: Queryable, incidentId: string) {
  return many(q, `
    SELECT DISTINCT u.id, u.full_name, u.title, cs.vehicle_id, cs.crew_role
      FROM assignments a JOIN crew_shifts cs ON cs.vehicle_id = a.vehicle_id
       AND cs.started_at <= coalesce(a.ended_at, now()) AND coalesce(cs.ended_at, now()) >= a.assigned_at
      JOIN users u ON u.id = cs.user_id
     WHERE a.incident_id = $1`, [incidentId]);
}

export async function startCaseReview(tx: Tx, actor: Actor, incidentId: string, extraReason?: string | null) {
  const inc = await one(tx, `SELECT id, code, status, ${reasonSql('$2', '$3')} AS reasons FROM incidents i WHERE id = $1`,
    [incidentId, Object.keys(RESPONSE_TARGET_MIN), JSON.stringify(RESPONSE_TARGET_MIN)]);
  if (!inc) throw new HttpError(404, 'Không tìm thấy ca');
  if (inc.status !== 'closed') throw new HttpError(409, 'Chỉ rà soát ca đã đóng');
  if ((await caseCrew(tx, incidentId)).some((c) => c.id === actor.id)) throw new HttpError(409, 'Người trong kíp của ca không tự rà soát ca mình');
  const exists = await one(tx, 'SELECT id FROM ops_case_reviews WHERE incident_id = $1', [incidentId]);
  if (exists) return exists;
  const reasons = [...inc.reasons, ...(extraReason ? ['chon'] : [])];
  const year = new Date(Date.now() + 7 * 3600_000).getUTCFullYear();
  const n = await nextCounter(tx, 'ops_case_review', String(year));
  const row = await one(tx, `INSERT INTO ops_case_reviews(code, incident_id, reasons, reviewer_id, summary) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [`RSC-${year}-${String(n).padStart(4, '0')}`, incidentId, reasons.length ? reasons : ['chon'], actor.id, extraReason ?? null]);
  await audit(tx, incidentScope(incidentId), actor, 'ops.case_review_started', 'ops_case_review', row.id, { code: row.code, reasons });
  return row;
}

export async function saveCaseReview(tx: Tx, actor: Actor, id: string, b: {
  scores: Record<string, string>; summary?: string | null; goodPractice?: string | null; learning?: string | null; finish?: boolean;
}) {
  const r = await one(tx, 'SELECT * FROM ops_case_reviews WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw new HttpError(404, 'Không tìm thấy phiếu rà soát');
  if (r.status === 'da_xong') throw new HttpError(409, 'Phiếu rà soát đã chốt');
  if (r.reviewer_id !== actor.id) throw new HttpError(403, 'Chỉ người rà soát được sửa phiếu');
  for (const [k, v] of Object.entries(b.scores)) {
    if (!REVIEW_CRITERIA.some(([c]) => c === k) || !REVIEW_SCORE[v]) throw new HttpError(400, `Tiêu chí ${k} không hợp lệ`);
  }
  if (b.finish) {
    const missing = REVIEW_CRITERIA.filter(([k]) => !b.scores[k]).map(([, l]) => l);
    if (missing.length) throw new HttpError(400, `Chưa chấm: ${missing.join('; ')}`);
    if (!b.summary?.trim()) throw new HttpError(400, 'Cần nhận xét chung');
    const weak = Object.values(b.scores).some((v) => v === 'khong_dat' || v === 'can_cai_thien');
    if (weak && !b.learning?.trim()) throw new HttpError(400, 'Có tiêu chí chưa đạt: ghi bài học hoặc điều cần cải thiện cho kíp');
  }
  const row = await one(tx, `UPDATE ops_case_reviews SET scores = $2, summary = $3, good_practice = $4, learning = $5,
                                    status = $6, reviewed_at = CASE WHEN $6 = 'da_xong' THEN now() ELSE reviewed_at END
                              WHERE id = $1 RETURNING *`,
  [id, JSON.stringify(b.scores), b.summary ?? null, b.goodPractice ?? null, b.learning ?? null, b.finish ? 'da_xong' : 'dang_ra_soat']);
  if (b.finish) await audit(tx, incidentScope(r.incident_id), actor, 'ops.case_review_done', 'ops_case_review', id, { code: r.code });
  return row;
}

/** Phản hồi bình ca cho người trong kíp (chỉ phiếu đã chốt) */
export async function myCaseFeedback(q: Queryable, userId: string) {
  return many(q, `
    SELECT cr.id, cr.code, cr.scores, cr.summary, cr.good_practice, cr.learning, cr.reviewed_at, i.code AS incident_code, i.created_at,
           ack.acked_at, ack.comment
      FROM ops_case_reviews cr JOIN incidents i ON i.id = cr.incident_id
      LEFT JOIN ops_review_acks ack ON ack.review_id = cr.id AND ack.user_id = $1
     WHERE cr.status = 'da_xong' AND EXISTS (
       SELECT 1 FROM assignments a JOIN crew_shifts cs ON cs.vehicle_id = a.vehicle_id
          AND cs.started_at <= coalesce(a.ended_at, now()) AND coalesce(cs.ended_at, now()) >= a.assigned_at
        WHERE a.incident_id = cr.incident_id AND cs.user_id = $1)
     ORDER BY cr.reviewed_at DESC LIMIT 100`, [userId]);
}

export async function ackCaseFeedback(tx: Tx, actor: Actor, reviewId: string, comment?: string | null) {
  const mine = (await myCaseFeedback(tx, actor.id!)).find((r) => r.id === reviewId);
  if (!mine) throw new HttpError(404, 'Không có phản hồi này cho bạn');
  await tx.query(`INSERT INTO ops_review_acks(review_id, user_id, comment) VALUES ($1,$2,$3)
                  ON CONFLICT (review_id, user_id) DO UPDATE SET comment = $3, acked_at = now()`, [reviewId, actor.id, comment ?? null]);
}

/* ================= GPS ================= */

/** Ghi một điểm lộ trình; gắn ca đang làm của xe */
export async function recordGps(q: Queryable, vehicleId: string, p: { lat: number; lng: number; accuracy?: number | null; speed?: number | null }) {
  await q.query(`INSERT INTO ops_gps_track(vehicle_id, incident_id, status, lat, lng, accuracy_m, speed_kmh)
                 SELECT id, current_incident_id, status, $2, $3, $4, $5 FROM vehicles WHERE id = $1`,
  [vehicleId, p.lat, p.lng, p.accuracy ?? null, p.speed ?? null]);
}

/** Bỏ điểm sai số lớn (> 100 m) và bước nhảy phi lý (> 160 km/h) khi cộng quãng đường */
export function trackDistanceKm(points: { lat: number; lng: number; at: string; accuracy_m?: number | null }[]) {
  let km = 0;
  let prev: (typeof points)[number] | null = null;
  for (const p of points) {
    if (p.accuracy_m != null && p.accuracy_m > 100) continue;
    if (prev) {
      const d = haversineKm(prev, p);
      const h = (new Date(p.at).getTime() - new Date(prev.at).getTime()) / 3600000;
      if (h > 0 && d / h > 160) continue;
      km += d;
    }
    prev = p;
  }
  return Math.round(km * 10) / 10;
}

/** Lộ trình của ca theo từng xe, quãng đường, so với quãng đường kíp khai trên phiếu */
export async function incidentTrack(q: Queryable, incidentId: string) {
  const inc = await one(q, `SELECT id, code, lat, lng, destination FROM incidents WHERE id = $1`, [incidentId]);
  if (!inc) throw new HttpError(404, 'Không tìm thấy ca');
  const assigns = await many(q, `SELECT vehicle_id, assigned_at, ended_at FROM assignments WHERE incident_id = $1 ORDER BY assigned_at`, [incidentId]);
  const vehicles = [];
  for (const a of assigns) {
    const points = await many(q, `SELECT lat, lng, at, status, accuracy_m, speed_kmh FROM ops_gps_track
                                   WHERE vehicle_id = $1 AND at >= $2 AND at <= coalesce($3::timestamptz, now()) ORDER BY at`,
    [a.vehicle_id, a.assigned_at, a.ended_at]);
    const declared = await one(q, `SELECT (epcr->'disposition'->>'distanceKm')::float8 AS km FROM transfers WHERE incident_id = $1 AND vehicle_id = $2
                                    ORDER BY updated_at DESC LIMIT 1`, [incidentId, a.vehicle_id]);
    const km = trackDistanceKm(points);
    const toScene = inc.lat != null && points.length ? Math.min(...points.map((p) => haversineKm(p, { lat: inc.lat, lng: inc.lng }))) : null;
    vehicles.push({
      vehicleId: a.vehicle_id, from: a.assigned_at, to: a.ended_at, points, km, declaredKm: declared?.km ?? null,
      nearestToSceneKm: toScene == null ? null : Math.round(toScene * 100) / 100,
      flags: trackFlags(points.length, km, declared?.km ?? null, toScene),
    });
  }
  return { incident: inc, vehicles };
}

export function trackFlags(n: number, km: number, declaredKm: number | null, nearestToSceneKm: number | null) {
  const flags: string[] = [];
  if (n < 2) flags.push('Không có lộ trình GPS (máy tính bảng không gửi vị trí)');
  if (n >= 2 && declaredKm != null && declaredKm > 0 && Math.abs(km - declaredKm) / declaredKm > 0.3 && Math.abs(km - declaredKm) > 2) {
    flags.push(`Quãng đường GPS ${km} km khác quãng đường khai ${declaredKm} km quá 30%`);
  }
  if (n >= 2 && nearestToSceneKm != null && nearestToSceneKm > 0.5) flags.push(`Lộ trình không tới gần hiện trường (gần nhất ${Math.round(nearestToSceneKm * 10) / 10} km)`);
  return flags;
}

/* ================= Đông nạn nhân ================= */

export const TRIAGE: Record<string, string> = { do: 'Đỏ (cấp cứu ngay)', vang: 'Vàng (trì hoãn được)', xanh: 'Xanh (đi lại được)', den: 'Đen (tử vong, không cứu được)' };
export const VICTIM_STATUS: Record<string, string> = {
  hien_truong: 'Tại hiện trường', dang_chuyen: 'Đang chuyển', da_den_vien: 'Đã tới bệnh viện', tai_cho: 'Xử trí tại chỗ, không chuyển', tu_vong: 'Tử vong',
};
export const ICS_ROLES: Record<string, string> = {
  chi_huy: 'Chỉ huy sự cố', tac_nghiep: 'Tác nghiệp (hiện trường)', ke_hoach: 'Kế hoạch', hau_can: 'Hậu cần', hanh_chinh: 'Tài chính, hành chính', lien_lac_bv: 'Liên lạc bệnh viện',
};
export const MCI_LEVEL: Record<number, string> = {
  1: 'Mức 1: trung tâm tự xử trí (dưới 5 người bệnh nặng)',
  2: 'Mức 2: từ 5 người bệnh nặng, kích hoạt hỗ trợ 115 và đơn vị bạn',
  3: 'Mức 3: thảm họa, báo Sở Y tế, kích hoạt kế hoạch tỉnh',
};
/** Kế hoạch: năng lực thật 4–5 xe, từ 5 người bệnh nặng trở lên là kích hoạt hỗ trợ */
export const MCI_SUPPORT_THRESHOLD = 5;

export async function declareMci(tx: Tx, actor: Actor, incidentId: string, b: { level: number; note?: string | null; roles?: Partial<Record<string, string>> }) {
  const inc = await one(tx, 'SELECT * FROM incidents WHERE id = $1 FOR UPDATE', [incidentId]);
  if (!inc) throw new HttpError(404, 'Không tìm thấy ca');
  if (['closed', 'cancelled', 'transferred_115', 'advice_only'].includes(inc.status)) throw new HttpError(409, 'Ca đã đóng');
  const first = !inc.mci_declared_at;
  await tx.query(`UPDATE incidents SET mci_declared_at = coalesce(mci_declared_at, now()), mci_declared_by = coalesce(mci_declared_by, $2),
                         mci_level = $3, mci_note = $4, mci_roles = $5, mci_ended_at = NULL, updated_at = now() WHERE id = $1`,
  [incidentId, actor.id, b.level, b.note ?? null, JSON.stringify(b.roles ?? inc.mci_roles ?? {})]);
  if (first || b.level !== inc.mci_level) {
    // Báo 115 và cấp trên qua hàng đợi gửi; chưa có API thì điều phối viên gọi đường nóng rồi đánh dấu đã báo
    await tx.query(`INSERT INTO outbox(topic, payload) VALUES ('mci_declared', $1)`,
      [{ incidentId, code: inc.code, level: b.level, address: inc.address, note: b.note ?? null }]);
  }
  await audit(tx, incidentScope(incidentId), actor, first ? 'mci.declared' : 'mci.updated', 'incident', incidentId, b);
}

export async function endMci(tx: Tx, actor: Actor, incidentId: string, note: string) {
  const inc = await one(tx, 'SELECT mci_declared_at FROM incidents WHERE id = $1 FOR UPDATE', [incidentId]);
  if (!inc?.mci_declared_at) throw new HttpError(409, 'Ca chưa kích hoạt đông nạn nhân');
  const left = await one(tx, `SELECT count(*)::int AS n FROM ops_mci_victims WHERE incident_id = $1 AND status IN ('hien_truong', 'dang_chuyen')`, [incidentId]);
  if (left.n) throw new HttpError(409, `Còn ${left.n} nạn nhân ở hiện trường hoặc đang chuyển`);
  await tx.query(`UPDATE incidents SET mci_ended_at = now(), updated_at = now() WHERE id = $1`, [incidentId]);
  await audit(tx, incidentScope(incidentId), actor, 'mci.ended', 'incident', incidentId, { note });
}

export async function saveVictim(tx: Tx, actor: Actor, incidentId: string, id: string | null, b: {
  tag: string; triage: string; sex?: string | null; ageGroup?: string | null; note?: string | null; status: string;
  vehicleId?: string | null; hospital?: string | null; transferId?: string | null;
}) {
  const inc = await one(tx, 'SELECT mci_declared_at FROM incidents WHERE id = $1', [incidentId]);
  if (!inc?.mci_declared_at) throw new HttpError(409, 'Ca chưa kích hoạt đông nạn nhân');
  if (['dang_chuyen', 'da_den_vien'].includes(b.status) && (!b.vehicleId || !b.hospital)) throw new HttpError(400, 'Nạn nhân được chuyển phải có xe và bệnh viện nhận');
  if (b.status === 'tu_vong' && b.triage !== 'den') b.triage = 'den';
  const args = [incidentId, b.tag.trim(), b.triage, b.sex ?? null, b.ageGroup ?? null, b.note ?? null, b.status, b.vehicleId ?? null, b.hospital ?? null, b.transferId ?? null, actor.id];
  try {
    const row = id
      ? await one(tx, `UPDATE ops_mci_victims SET tag = $2, triage = $3, sex = $4, age_group = $5, note = $6, status = $7, vehicle_id = $8, hospital = $9,
                              transfer_id = $10, recorded_by = $11, updated_at = now() WHERE id = $12 AND incident_id = $1 RETURNING *`, [...args, id])
      : await one(tx, `INSERT INTO ops_mci_victims(incident_id, tag, triage, sex, age_group, note, status, vehicle_id, hospital, transfer_id, recorded_by)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, args);
    if (!row) throw new HttpError(404, 'Không tìm thấy nạn nhân');
    await audit(tx, incidentScope(incidentId), actor, id ? 'mci.victim_updated' : 'mci.victim_added', 'ops_mci_victim', row.id,
      { tag: row.tag, triage: row.triage, status: row.status, hospital: row.hospital });
    return row;
  } catch (e: any) {
    if (e.code === '23505') throw new HttpError(409, `Thẻ ${b.tag} đã có trong danh sách`);
    throw e;
  }
}

export async function mciBoard(q: Queryable, incidentId: string) {
  const inc = await one(q, `SELECT i.id, i.code, i.address, i.mci_declared_at, i.mci_level, i.mci_note, i.mci_ended_at, i.mci_roles, u.full_name AS declared_by
                              FROM incidents i LEFT JOIN users u ON u.id = i.mci_declared_by WHERE i.id = $1`, [incidentId]);
  if (!inc) throw new HttpError(404, 'Không tìm thấy ca');
  const [victims, vehicles] = await Promise.all([
    many(q, `SELECT v.*, t.transfer_number FROM ops_mci_victims v LEFT JOIN transfers t ON t.id = v.transfer_id
              WHERE v.incident_id = $1 ORDER BY array_position(ARRAY['do','vang','xanh','den'], v.triage), v.tag`, [incidentId]),
    many(q, `SELECT a.vehicle_id, v.type, v.status, a.assigned_at, a.ended_at FROM assignments a JOIN vehicles v ON v.id = a.vehicle_id
              WHERE a.incident_id = $1 ORDER BY a.assigned_at`, [incidentId]),
  ]);
  const byTriage = Object.fromEntries(Object.keys(TRIAGE).map((k) => [k, victims.filter((v) => v.triage === k).length]));
  const byHospital: Record<string, Record<string, number>> = {};
  for (const v of victims) {
    if (!v.hospital) continue;
    byHospital[v.hospital] ??= { do: 0, vang: 0, xanh: 0, den: 0 };
    byHospital[v.hospital][v.triage]++;
  }
  const severe = byTriage.do + byTriage.vang;
  const advice: string[] = [];
  if (severe >= MCI_SUPPORT_THRESHOLD && (inc.mci_level ?? 1) < 2) advice.push(`Đã có ${severe} người bệnh nặng (đỏ, vàng): nên nâng lên mức 2 và kích hoạt hỗ trợ 115, đơn vị bạn.`);
  const waitingRed = victims.filter((v) => v.triage === 'do' && v.status === 'hien_truong').length;
  if (waitingRed) advice.push(`${waitingRed} nạn nhân đỏ còn ở hiện trường: ưu tiên chuyển trước.`);
  for (const [h, c] of Object.entries(byHospital)) if (c.do >= 3) advice.push(`${h} đã nhận ${c.do} ca đỏ: cân nhắc phân sang bệnh viện khác.`);
  return { incident: inc, victims, vehicles, byTriage, byHospital, advice, activeVehicles: vehicles.filter((v) => !v.ended_at).length };
}

/* ================= Xe: hồ sơ, bảo dưỡng ================= */

export const VEHICLE_DOC_KIND: Record<string, string> = {
  dang_kiem: 'Đăng kiểm', bao_hiem_tnds: 'Bảo hiểm bắt buộc TNDS', bao_hiem_vat_chat: 'Bảo hiểm vật chất xe', uu_tien: 'Giấy phép thiết bị ưu tiên (đèn, còi)', phu_hieu: 'Phù hiệu, giấy phép kinh doanh vận tải', khac: 'Khác',
};
/** Hết hạn là khóa xe, không ai cho đi được: xe chạy trái luật */
export const BLOCKING_DOCS = ['dang_kiem', 'bao_hiem_tnds'];
export const DOC_WARN_DAYS = 30;
export const MAINTENANCE_KIND: Record<string, string> = { dinh_ky: 'Bảo dưỡng định kỳ', sua_chua: 'Sửa chữa', tai_nan: 'Tai nạn' };

export interface Compliance {
  vehicleId: string; type: string; odometerKm: number | null; odometerAt: string | null;
  docs: { kind: string; label: string; number: string | null; expires_on: string; days_left: number }[];
  missing: string[];
  maintenance: { lastOn: string | null; lastKm: number | null; intervalKm: number; intervalMonths: number; dueOn: string | null; dueKm: number | null; kmLeft: number | null; daysLeft: number | null };
  blocks: string[]; warnings: string[];
}

export async function fleetCompliance(q: Queryable, vehicleIds?: string[]): Promise<Record<string, Compliance>> {
  const [vehicles, docs, maint] = await Promise.all([
    many(q, `SELECT v.id, v.type, v.odometer_km, v.odometer_at, coalesce(p.interval_km, 5000) AS interval_km, coalesce(p.interval_months, 3) AS interval_months
               FROM vehicles v LEFT JOIN ops_maintenance_plans p ON p.vehicle_id = v.id
              WHERE ($1::text[] IS NULL OR v.id = ANY($1)) ORDER BY v.id`, [vehicleIds ?? null]),
    many(q, `SELECT DISTINCT ON (vehicle_id, kind) vehicle_id, kind, number, expires_on, (expires_on - vn_today())::int AS days_left
               FROM ops_vehicle_docs WHERE ($1::text[] IS NULL OR vehicle_id = ANY($1)) ORDER BY vehicle_id, kind, expires_on DESC`, [vehicleIds ?? null]),
    many(q, `SELECT DISTINCT ON (vehicle_id) vehicle_id, done_on, odometer_km FROM ops_maintenance
              WHERE kind = 'dinh_ky' AND ($1::text[] IS NULL OR vehicle_id = ANY($1)) ORDER BY vehicle_id, done_on DESC, created_at DESC`, [vehicleIds ?? null]),
  ]);
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const out: Record<string, Compliance> = {};
  for (const v of vehicles) {
    const d = docs.filter((x) => x.vehicle_id === v.id).map((x) => ({ kind: x.kind, label: VEHICLE_DOC_KIND[x.kind], number: x.number, expires_on: x.expires_on, days_left: x.days_left }));
    const m = maint.find((x) => x.vehicle_id === v.id);
    let dueOn: string | null = null;
    if (m) { const t = new Date(`${m.done_on}T00:00:00Z`); t.setUTCMonth(t.getUTCMonth() + v.interval_months); dueOn = t.toISOString().slice(0, 10); }
    const dueKm = m?.odometer_km != null ? m.odometer_km + v.interval_km : null;
    const kmLeft = dueKm != null && v.odometer_km != null ? dueKm - v.odometer_km : null;
    const daysLeft = dueOn ? Math.round((Date.parse(dueOn) - Date.parse(today)) / 86400000) : null;
    const blocks: string[] = [];
    const warnings: string[] = [];
    for (const x of d) {
      if (x.days_left < 0 && BLOCKING_DOCS.includes(x.kind)) blocks.push(`${x.label} hết hạn ${x.expires_on}`);
      else if (x.days_left < 0) warnings.push(`${x.label} hết hạn ${x.expires_on}`);
      else if (x.days_left <= DOC_WARN_DAYS) warnings.push(`${x.label} còn ${x.days_left} ngày`);
    }
    const missing = BLOCKING_DOCS.filter((k) => !d.some((x) => x.kind === k)).map((k) => VEHICLE_DOC_KIND[k]);
    if (missing.length) warnings.push(`Chưa nhập ${missing.join(', ')}`);
    if (!m) warnings.push('Chưa có lần bảo dưỡng định kỳ nào');
    else if ((daysLeft != null && daysLeft < 0) || (kmLeft != null && kmLeft < 0)) warnings.push(`Quá hạn bảo dưỡng${kmLeft != null && kmLeft < 0 ? ` ${-kmLeft} km` : ''}${daysLeft != null && daysLeft < 0 ? ` ${-daysLeft} ngày` : ''}`);
    else if ((daysLeft != null && daysLeft <= 14) || (kmLeft != null && kmLeft <= 500)) warnings.push(`Sắp tới hạn bảo dưỡng${kmLeft != null ? ` (còn ${kmLeft} km)` : ''}${daysLeft != null ? ` (còn ${daysLeft} ngày)` : ''}`);
    out[v.id] = {
      vehicleId: v.id, type: v.type, odometerKm: v.odometer_km, odometerAt: v.odometer_at, docs: d, missing,
      maintenance: { lastOn: m?.done_on ?? null, lastKm: m?.odometer_km ?? null, intervalKm: v.interval_km, intervalMonths: v.interval_months, dueOn, dueKm, kmLeft, daysLeft },
      blocks, warnings,
    };
  }
  return out;
}

export async function assertVehicleLegal(q: Queryable, vehicleId: string) {
  const c = (await fleetCompliance(q, [vehicleId]))[vehicleId];
  if (c?.blocks.length) throw new HttpError(409, `Xe ${vehicleId} bị khóa: ${c.blocks.join('; ')}. Gia hạn giấy tờ rồi mới giao xe`, { code: 'VEHICLE_LOCKED', vehicleId, blocks: c.blocks });
}

export async function addVehicleDoc(tx: Tx, actor: Actor, vehicleId: string, b: { kind: string; number?: string | null; issuedOn?: string | null; expiresOn: string; note?: string | null }) {
  if (b.issuedOn && b.issuedOn > b.expiresOn) throw new HttpError(400, 'Ngày cấp sau ngày hết hạn');
  const row = await one(tx, `INSERT INTO ops_vehicle_docs(vehicle_id, kind, number, issued_on, expires_on, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [vehicleId, b.kind, b.number ?? null, b.issuedOn ?? null, b.expiresOn, b.note ?? null, actor.id]);
  await audit(tx, 'system', actor, 'ops.vehicle_doc', 'vehicle', vehicleId, b);
  return row;
}

export async function recordOdometer(tx: Tx, actor: Actor, vehicleId: string, b: { km: number; fuelLiters?: number | null; fuelCost?: number | null; note?: string | null }) {
  const v = await one(tx, 'SELECT odometer_km FROM vehicles WHERE id = $1 FOR UPDATE', [vehicleId]);
  if (!v) throw new HttpError(404, 'Không tìm thấy xe');
  if (v.odometer_km != null && b.km < v.odometer_km) throw new HttpError(400, `Số km ${b.km} nhỏ hơn lần ghi trước (${v.odometer_km} km)`);
  if (v.odometer_km != null && b.km - v.odometer_km > 3000 && !b.note?.trim()) throw new HttpError(400, `Tăng ${b.km - v.odometer_km} km so với lần trước: ghi chú lý do`);
  await tx.query(`INSERT INTO ops_odometer(vehicle_id, km, fuel_liters, fuel_cost, note, user_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [vehicleId, b.km, b.fuelLiters ?? null, b.fuelCost ?? null, b.note ?? null, actor.id]);
  await tx.query('UPDATE vehicles SET odometer_km = $2, odometer_at = now() WHERE id = $1', [vehicleId, b.km]);
}

export async function addMaintenance(tx: Tx, actor: Actor, vehicleId: string, b: {
  kind: string; doneOn: string; odometerKm?: number | null; supplierId?: string | null; work: string; cost?: number | null; outOfServiceHours?: number | null;
}) {
  const row = await one(tx, `INSERT INTO ops_maintenance(vehicle_id, kind, done_on, odometer_km, supplier_id, work, cost, out_of_service_hours, recorded_by)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [vehicleId, b.kind, b.doneOn, b.odometerKm ?? null, b.supplierId ?? null, b.work, b.cost ?? null, b.outOfServiceHours ?? null, actor.id]);
  if (b.odometerKm != null) {
    await tx.query('UPDATE vehicles SET odometer_km = greatest(coalesce(odometer_km, 0), $2), odometer_at = now() WHERE id = $1', [vehicleId, b.odometerKm]);
  }
  await audit(tx, 'system', actor, 'ops.maintenance', 'vehicle', vehicleId, b);
  return row;
}
