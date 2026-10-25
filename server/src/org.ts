import { many, one, type Queryable } from './db.js';
import type { Role } from './http.js';

/**
 * Sơ đồ tổ chức và báo cáo theo cấp. Mỗi bộ phận/nhóm có trưởng nhóm (is_lead); trưởng nhóm lập báo cáo kỳ (ngày, tuần, tháng)
 * với số liệu tự lấy từ phần mềm, nộp lên trưởng bộ phận cấp trên; cấp trên duyệt hoặc trả lại, rồi lập báo cáo của mình
 * có kèm tóm tắt các báo cáo cấp dưới; cuối cùng lên Ban Giám đốc.
 */

export const ORG_MANAGERS: Role[] = ['admin', 'director', 'hr'];
export const DOMAIN: Record<string, string> = {
  ban_giam_doc: 'Ban Giám đốc', tiep_nhan: 'Tiếp nhận cuộc gọi', dieu_phoi: 'Điều phối', kip: 'Kíp cấp cứu', kho: 'Dược – kho',
  thiet_bi: 'Thiết bị – xe', ksnk: 'Kiểm soát nhiễm khuẩn', chat_luong: 'Quản lý chất lượng', nhan_su: 'Nhân sự', ke_toan: 'Kế toán', khac: 'Khác',
};
export const PERIOD: Record<string, string> = { ngay: 'Ngày', tuan: 'Tuần', thang: 'Tháng' };
/** Hạn nộp: số ngày sau ngày cuối kỳ */
export const DUE_DAYS: Record<string, number> = { ngay: 1, tuan: 2, thang: 5 };
export const REPORT_STATUS: Record<string, string> = { nhap: 'Nháp', da_nop: 'Đã nộp', da_duyet: 'Đã duyệt', tra_lai: 'Trả lại' };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/** Kỳ báo cáo chứa ngày đã cho: ngày; tuần thứ Hai đến Chủ nhật; tháng */
export function periodRange(period: string, date: string) {
  if (period === 'ngay') return { start: date, end: date };
  if (period === 'tuan') {
    const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    const start = addDays(date, -dow);
    return { start, end: addDays(start, 6) };
  }
  const start = `${date.slice(0, 7)}-01`;
  const next = new Date(`${start}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
  return { start, end: addDays(iso(next), -1) };
}
export const dueOn = (period: string, end: string) => addDays(end, DUE_DAYS[period]);

export async function staffOf(q: Queryable, userId: string) {
  return one(q, 'SELECT id, full_name FROM staff WHERE user_id = $1', [userId]);
}

/** Bộ phận người này làm trưởng nhóm */
export async function leadUnits(q: Queryable, userId: string): Promise<number[]> {
  return (await many(q, `SELECT m.unit_id FROM org_members m JOIN staff s ON s.id = m.staff_id WHERE s.user_id = $1 AND m.is_lead`, [userId])).map((r) => r.unit_id);
}

/** Các bộ phận cấp dưới (kể cả chính nó) */
export async function subtree(q: Queryable, roots: number[]): Promise<number[]> {
  if (!roots.length) return [];
  return (await many(q, `WITH RECURSIVE t AS (SELECT id FROM org_units WHERE id = ANY($1::int[])
                         UNION SELECT o.id FROM org_units o JOIN t ON o.parent_id = t.id) SELECT id FROM t`, [roots])).map((r) => r.id);
}

/** Bộ phận người dùng được xem: Ban Giám đốc, quản trị xem tất cả; trưởng nhóm xem nhóm mình và cấp dưới */
export async function visibleUnits(q: Queryable, user: { id: string; role: Role }): Promise<number[] | 'all'> {
  if (user.role === 'director' || user.role === 'admin') return 'all';
  return subtree(q, await leadUnits(q, user.id));
}

/** Người duyệt được: Ban Giám đốc, hoặc trưởng nhóm của một bộ phận cấp trên (không tự duyệt báo cáo của nhóm mình) */
export async function canReview(q: Queryable, user: { id: string; role: Role }, unitId: number) {
  if (user.role === 'director') return true;
  const r = await one(q, `WITH RECURSIVE up AS (SELECT parent_id AS id FROM org_units WHERE id = $1
                          UNION SELECT o.parent_id FROM org_units o JOIN up ON o.id = up.id WHERE o.parent_id IS NOT NULL)
                          SELECT 1 FROM up JOIN org_members m ON m.unit_id = up.id AND m.is_lead JOIN staff s ON s.id = m.staff_id
                           WHERE s.user_id = $2 LIMIT 1`, [unitId, user.id]);
  return !!r;
}

const range = (start: string, end: string) => [`${start} 00:00`, `${addDays(end, 1)} 00:00`];
const vn = `AT TIME ZONE 'Asia/Ho_Chi_Minh'`;

/** Số liệu tự điền theo loại bộ phận; mọi bộ phận có thêm số thành viên, giờ chấm công, ngày nghỉ */
export async function unitMetrics(q: Queryable, unit: { id: number; domain: string; station_id: string | null }, start: string, end: string) {
  const [a, b] = range(start, end);
  const m: Record<string, number | string | null> = {};
  const put = (o: Record<string, unknown> | null | undefined) => { for (const [k, v] of Object.entries(o ?? {})) m[k] = v == null ? null : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : (v as any); };
  const team = await one(q, `
    SELECT count(DISTINCT m.staff_id)::int AS thanh_vien,
           round(coalesce(sum(extract(epoch FROM (coalesce(at.check_out, now()) - at.check_in)) / 3600), 0)::numeric, 1) AS gio_cham_cong
      FROM org_members m LEFT JOIN attendance at ON at.staff_id = m.staff_id AND at.check_in >= ($2::timestamp ${vn}) AND at.check_in < ($3::timestamp ${vn})
     WHERE m.unit_id = $1`, [unit.id, a, b]);
  put(team);
  put(await one(q, `SELECT coalesce(sum(least(l.to_date, $3::date) - greatest(l.from_date, $2::date) + 1), 0)::int AS ngay_nghi
                      FROM leave_requests l JOIN org_members m ON m.staff_id = l.staff_id AND m.unit_id = $1
                     WHERE l.status = 'da_duyet' AND l.from_date <= $3 AND l.to_date >= $2`, [unit.id, start, end]));

  switch (unit.domain) {
    case 'tiep_nhan':
    case 'dieu_phoi':
    case 'ban_giam_doc':
      put(await one(q, `
        SELECT count(*)::int AS so_ca,
               count(*) FILTER (WHERE final_priority = 'P1')::int AS ca_p1, count(*) FILTER (WHERE final_priority = 'P2')::int AS ca_p2,
               count(*) FILTER (WHERE status = 'cancelled')::int AS ca_huy, count(*) FILTER (WHERE status = 'transferred_115')::int AS chuyen_115,
               count(*) FILTER (WHERE status = 'advice_only')::int AS chi_tu_van
          FROM incidents WHERE created_at >= ($1::timestamp ${vn}) AND created_at < ($2::timestamp ${vn})`, [a, b]));
      put(await one(q, `
        SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t1.at - t0.at)) / 1)::numeric, 0) AS giay_nhac_may_tv,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t4.at - t0.at)) / 60)::numeric, 1) AS phut_giao_xe_tv,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t8.at - t0.at)) / 60)::numeric, 1) AS phut_toi_nguoi_benh_tv
          FROM incidents i JOIN incident_times t0 ON t0.incident_id = i.id AND t0.code = 'T0'
          LEFT JOIN incident_times t1 ON t1.incident_id = i.id AND t1.code = 'T1'
          LEFT JOIN incident_times t4 ON t4.incident_id = i.id AND t4.code = 'T4'
          LEFT JOIN incident_times t8 ON t8.incident_id = i.id AND t8.code = 'T8'
         WHERE i.created_at >= ($1::timestamp ${vn}) AND i.created_at < ($2::timestamp ${vn})`, [a, b]));
      if (unit.domain === 'tiep_nhan' || unit.domain === 'ban_giam_doc') {
        put(await one(q, `SELECT count(*)::int AS cuoc_goi, count(*) FILTER (WHERE state = 'abandoned')::int AS cuoc_goi_nho
                            FROM calls WHERE ringing_at >= ($1::timestamp ${vn}) AND ringing_at < ($2::timestamp ${vn})`, [a, b]));
      }
      break;
    case 'kip':
      put(await one(q, `SELECT count(*)::int AS phieu_da_ky FROM transfers t
                         WHERE t.status = 'signed' AND t.signed_at >= ($1::timestamp ${vn}) AND t.signed_at < ($2::timestamp ${vn})
                           AND ($3::text IS NULL OR t.vehicle_id IN (SELECT id FROM vehicles WHERE station_id = $3))`, [a, b, unit.station_id]));
      put(await one(q, `SELECT count(*)::int AS bao_khan_sos FROM crew_sos WHERE created_at >= ($1::timestamp ${vn}) AND created_at < ($2::timestamp ${vn})`, [a, b]));
      break;
    case 'kho':
      put(await one(q, `SELECT count(*) FILTER (WHERE qty > 0 AND expiry < $1::date + 30)::int AS lo_sap_het_han_30_ngay,
                               count(*) FILTER (WHERE qty > 0 AND expiry < $1::date)::int AS lo_da_het_han
                          FROM stock_lots WHERE ($2::text IS NULL OR station_id = $2)`, [end, unit.station_id]));
      break;
    case 'thiet_bi':
      put(await one(q, `SELECT count(*) FILTER (WHERE next_maintenance <= $1::date)::int AS thiet_bi_den_han_bao_tri,
                               count(*) FILTER (WHERE next_calibration <= $1::date)::int AS thiet_bi_den_han_hieu_chuan,
                               count(*) FILTER (WHERE status <> 'hoat_dong')::int AS thiet_bi_khong_hoat_dong
                          FROM equipment WHERE ($2::text IS NULL OR station_id = $2)`, [end, unit.station_id]));
      break;
    case 'ksnk':
      put(await one(q, `SELECT count(*)::int AS quan_sat_vstay, round(100.0 * avg(CASE WHEN compliant THEN 1 ELSE 0 END), 1) AS tuan_thu_vstay_pct
                          FROM hand_hygiene_obs WHERE observed_at >= ($1::timestamp ${vn}) AND observed_at < ($2::timestamp ${vn})`, [a, b]));
      put(await one(q, `SELECT count(*)::int AS phoi_nhiem FROM exposures WHERE occurred_at >= ($1::timestamp ${vn}) AND occurred_at < ($2::timestamp ${vn})`, [a, b]));
      break;
    case 'chat_luong':
      put(await one(q, `SELECT count(*)::int AS su_co FROM adverse_events WHERE reported_at >= ($1::timestamp ${vn}) AND reported_at < ($2::timestamp ${vn})`, [a, b]));
      put(await one(q, `SELECT count(*)::int AS khieu_nai FROM complaints WHERE received_at >= ($1::timestamp ${vn}) AND received_at < ($2::timestamp ${vn})`, [a, b]));
      put(await one(q, `SELECT count(*) FILTER (WHERE status <> 'xong')::int AS capa_dang_mo, count(*) FILTER (WHERE status <> 'xong' AND due_date < $1::date)::int AS capa_qua_han FROM capa_actions`, [end]));
      break;
    case 'nhan_su':
      put(await one(q, `SELECT count(*) FILTER (WHERE status = 'dang_lam')::int AS nhan_su_dang_lam FROM staff`));
      put(await one(q, `SELECT count(*)::int AS giay_to_het_han_30_ngay FROM staff_docs WHERE expires_on IS NOT NULL AND expires_on <= $1::date + 30`, [end]));
      break;
    case 'ke_toan':
      put(await one(q, `SELECT coalesce(sum(amount), 0)::float8 AS da_thu FROM payments WHERE NOT voided AND received_at >= ($1::timestamp ${vn}) AND received_at < ($2::timestamp ${vn})`, [a, b]));
      put(await one(q, `SELECT coalesce(sum(amount), 0)::float8 AS da_chi FROM expenses WHERE spent_on BETWEEN $1 AND $2`, [start, end]));
      break;
  }
  return m;
}

export const METRIC_LABEL: Record<string, string> = {
  thanh_vien: 'Thành viên', gio_cham_cong: 'Giờ chấm công', ngay_nghi: 'Ngày nghỉ có duyệt',
  so_ca: 'Số ca', ca_p1: 'Ca P1', ca_p2: 'Ca P2', ca_huy: 'Ca hủy', chuyen_115: 'Chuyển 115', chi_tu_van: 'Chỉ tư vấn',
  giay_nhac_may_tv: 'Nhấc máy (giây, trung vị)', phut_giao_xe_tv: 'Giao xe (phút, trung vị)', phut_toi_nguoi_benh_tv: 'Tới người bệnh (phút, trung vị)',
  cuoc_goi: 'Cuộc gọi', cuoc_goi_nho: 'Cuộc gọi nhỡ', phieu_da_ky: 'Phiếu chuyển viện đã ký', bao_khan_sos: 'Báo khẩn SOS',
  lo_sap_het_han_30_ngay: 'Lô thuốc sắp hết hạn (30 ngày)', lo_da_het_han: 'Lô đã hết hạn còn tồn',
  thiet_bi_den_han_bao_tri: 'Thiết bị đến hạn bảo trì', thiet_bi_den_han_hieu_chuan: 'Thiết bị đến hạn hiệu chuẩn', thiet_bi_khong_hoat_dong: 'Thiết bị không hoạt động',
  quan_sat_vstay: 'Lượt quan sát vệ sinh tay', tuan_thu_vstay_pct: 'Tuân thủ vệ sinh tay (%)', phoi_nhiem: 'Phơi nhiễm',
  su_co: 'Sự cố y khoa', khieu_nai: 'Khiếu nại', capa_dang_mo: 'Hành động khắc phục đang mở', capa_qua_han: 'Hành động khắc phục quá hạn',
  nhan_su_dang_lam: 'Nhân sự đang làm', giay_to_het_han_30_ngay: 'Giấy tờ hết hạn trong 30 ngày', da_thu: 'Đã thu (đ)', da_chi: 'Đã chi (đ)',
};

/** Xếp nhân viên vào bộ phận theo vai trò tài khoản (dùng khi khởi tạo dữ liệu) */
export async function autoAssignByRole(q: Queryable) {
  await q.query(`
    INSERT INTO org_members(unit_id, staff_id, is_lead)
    SELECT o.id, s.id, u.role = 'director' FROM staff s JOIN users u ON u.id = s.user_id
      JOIN org_units o ON o.code = CASE u.role
        WHEN 'calltaker' THEN 'EOC-TN' WHEN 'dispatcher' THEN 'EOC-DP' WHEN 'supervisor' THEN 'EOC' WHEN 'crew' THEN 'CM'
        WHEN 'pharmacist' THEN 'HC-KHO' WHEN 'technician' THEN 'HC-TB' WHEN 'ipc' THEN 'QLCL-KSNK' WHEN 'qa' THEN 'QLCL'
        WHEN 'hr' THEN 'HCNS' WHEN 'accountant' THEN 'TCKT' WHEN 'director' THEN 'BGD' END
     WHERE s.status <> 'nghi_viec'
    ON CONFLICT DO NOTHING`);
}
