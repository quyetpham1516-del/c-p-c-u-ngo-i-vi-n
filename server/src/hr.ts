import { audit, type Actor } from './audit.js';
import { many, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';

/**
 * Nhân sự: hồ sơ, giấy tờ hành nghề, đào tạo, lịch trực, chấm công, nghỉ phép.
 * Quy tắc an toàn: người có giấy phép hành nghề/bằng lái hết hạn hoặc bị đình chỉ không nhận ca trên xe được.
 */

export const DOC_KIND: Record<string, string> = {
  gphn: 'Giấy phép/chứng chỉ hành nghề', bang_lai: 'Giấy phép lái xe', bls: 'Chứng nhận BLS', acls: 'Chứng nhận ACLS',
  phtls: 'Chứng nhận PHTLS', ksnk: 'Chứng nhận KSNK', pccc: 'Chứng nhận PCCC', khac: 'Khác',
};
export const TRAINING_KIND: Record<string, string> = {
  cme: 'Cập nhật kiến thức y khoa liên tục', bls: 'BLS', acls: 'ACLS', phtls: 'PHTLS', ksnk: 'Kiểm soát nhiễm khuẩn',
  pccc: 'Phòng cháy chữa cháy', dieu_phoi: 'Điều phối, tiếp nhận cuộc gọi', lai_xe: 'Lái xe cấp cứu an toàn', khac: 'Khác',
};
export const SHIFT: Record<string, { label: string; hours: number }> = {
  ngay: { label: 'Ca ngày (7h–19h)', hours: 12 }, dem: { label: 'Ca đêm (19h–7h)', hours: 12 },
  truc_24: { label: 'Trực 24 giờ', hours: 24 }, hanh_chinh: { label: 'Hành chính', hours: 8 },
};
export const LEAVE_KIND: Record<string, string> = {
  phep_nam: 'Phép năm', om: 'Nghỉ ốm', viec_rieng: 'Việc riêng có lương', khong_luong: 'Không lương', thai_san: 'Thai sản', khac: 'Khác',
};
/** Số tiết cập nhật kiến thức y khoa tối thiểu trong 5 năm cho người hành nghề (chỉnh theo quy định hiện hành của Bộ Y tế) */
export const CME_REQUIRED_HOURS = 120;
export const EXPIRY_WARN_DAYS = 60;

/** Giấy tờ bắt buộc theo chức danh */
export function requiredDocs(title: string | null): string[] {
  const t = (title ?? '').toLowerCase();
  const need: string[] = [];
  if (/bác sĩ|bs\b|y sĩ|điều dưỡng|đd\b|kỹ thuật viên|ktv|hộ sinh/.test(t)) need.push('gphn');
  if (/lái xe/.test(t)) need.push('bang_lai');
  return need;
}

export interface Compliance { blocking: string[]; warnings: string[] }

/** Đánh giá giấy tờ của một nhân viên: blocking chặn nhận ca, warnings chỉ nhắc */
export async function staffCompliance(q: Queryable, staffId: string): Promise<Compliance> {
  const s = await one(q, 'SELECT title FROM staff WHERE id = $1', [staffId]);
  if (!s) return { blocking: [], warnings: [] };
  const docs = await many(q, `SELECT kind, number, expires_on::text AS expires_on, suspended,
                                     (expires_on IS NOT NULL AND expires_on < vn_today()) AS expired,
                                     (expires_on IS NOT NULL AND expires_on < vn_today() + $2::int) AS expiring
                                FROM staff_docs WHERE staff_id = $1`, [staffId, EXPIRY_WARN_DAYS]);
  const blocking: string[] = [];
  const warnings: string[] = [];
  for (const kind of requiredDocs(s.title)) {
    const mine = docs.filter((d) => d.kind === kind);
    if (!mine.length) { warnings.push(`Chưa có ${DOC_KIND[kind].toLowerCase()} trong hồ sơ`); continue; }
    const valid = mine.filter((d) => !d.suspended && !d.expired);
    if (!valid.length) {
      const d = mine[0];
      blocking.push(d.suspended ? `${DOC_KIND[kind]} đang bị đình chỉ` : `${DOC_KIND[kind]} hết hạn ngày ${d.expires_on}`);
    } else if (valid.every((d) => d.expiring)) {
      warnings.push(`${DOC_KIND[kind]} sắp hết hạn (${valid.map((d) => d.expires_on).sort().at(-1)})`);
    }
  }
  for (const d of docs.filter((x) => !requiredDocs(s.title).includes(x.kind))) {
    if (d.expired) warnings.push(`${DOC_KIND[d.kind]} đã hết hạn ngày ${d.expires_on}`);
    else if (d.expiring) warnings.push(`${DOC_KIND[d.kind]} sắp hết hạn (${d.expires_on})`);
  }
  if (requiredDocs(s.title).includes('gphn')) {
    const cme = await one(q, `SELECT coalesce(sum(hours), 0)::float AS h FROM trainings WHERE staff_id = $1 AND kind = 'cme' AND completed_on > vn_today() - interval '5 years'`, [staffId]);
    if (cme.h < CME_REQUIRED_HOURS) warnings.push(`Cập nhật kiến thức y khoa 5 năm: ${cme.h}/${CME_REQUIRED_HOURS} tiết`);
  }
  return { blocking, warnings };
}

/** Gọi khi kíp bắt đầu ca trên xe */
export async function assertCanStartShift(q: Queryable, userId: string) {
  const s = await one(q, `SELECT id, status FROM staff WHERE user_id = $1`, [userId]);
  if (!s) return { warnings: [] as string[] };
  if (s.status !== 'dang_lam') throw new HttpError(409, 'Hồ sơ nhân sự đang ở trạng thái tạm nghỉ/nghỉ việc', { code: 'STAFF_INACTIVE' });
  const leave = await one(q, `SELECT kind FROM leave_requests WHERE staff_id = $1 AND status = 'da_duyet'
                                AND vn_today() BETWEEN from_date AND to_date`, [s.id]);
  if (leave) throw new HttpError(409, `Bạn đang trong thời gian nghỉ (${LEAVE_KIND[leave.kind]}) đã duyệt`, { code: 'ON_LEAVE' });
  const c = await staffCompliance(q, s.id);
  if (c.blocking.length) throw new HttpError(409, `Không nhận ca được: ${c.blocking.join('; ')}. Liên hệ phòng Nhân sự.`, { code: 'LICENSE', reasons: c.blocking });
  return { warnings: c.warnings };
}

export async function addRoster(tx: Tx, actor: Actor, b: {
  staffId: string; workDate: string; shift: string; stationId?: string | null; vehicleId?: string | null; note?: string | null; override?: boolean;
}) {
  const s = await one(tx, 'SELECT id, full_name, status FROM staff WHERE id = $1', [b.staffId]);
  if (!s) throw new HttpError(404, 'Không tìm thấy nhân viên');
  if (s.status === 'nghi_viec') throw new HttpError(409, `${s.full_name} đã nghỉ việc`);
  const leave = await one(tx, `SELECT 1 FROM leave_requests WHERE staff_id = $1 AND status = 'da_duyet' AND $2::date BETWEEN from_date AND to_date`, [b.staffId, b.workDate]);
  if (leave) throw new HttpError(409, `${s.full_name} nghỉ phép đã duyệt ngày ${b.workDate}`);
  const same = await many(tx, `SELECT shift FROM roster WHERE staff_id = $1 AND work_date = $2`, [b.staffId, b.workDate]);
  if (same.some((r) => r.shift === b.shift)) throw new HttpError(409, 'Đã có ca này');
  if (same.length && (b.shift === 'truc_24' || same.some((r) => r.shift === 'truc_24'))) throw new HttpError(409, `${s.full_name} đã có ca trùng giờ ngày ${b.workDate}`);
  // Sau trực 24 giờ hoặc ca đêm phải nghỉ: không xếp ca ngày/24h liền sau, trừ khi người xếp lịch xác nhận ngoại lệ (có ghi vết)
  const prev = await one(tx, `SELECT shift FROM roster WHERE staff_id = $1 AND work_date = $2::date - 1 AND shift IN ('truc_24', 'dem')`, [b.staffId, b.workDate]);
  if (prev && b.shift !== 'dem' && !b.override) {
    throw new HttpError(409, `${s.full_name} vừa ${SHIFT[prev.shift].label.toLowerCase()} hôm trước, cần nghỉ`, { code: 'REST' });
  }
  const row = await one(tx, `INSERT INTO roster(staff_id, work_date, shift, station_id, vehicle_id, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.staffId, b.workDate, b.shift, b.stationId ?? null, b.vehicleId ?? null, b.note ?? null, actor.id]);
  await audit(tx, 'system', actor, prev && b.override ? 'hr.roster_rest_override' : 'hr.roster_added', 'staff', b.staffId, { date: b.workDate, shift: b.shift });
  return row;
}

/** Bảng công tháng: giờ theo lịch, giờ thực tế (ca trên xe + chấm công), số ca đêm, ngày nghỉ */
export async function timesheet(q: Queryable, month: string) {
  const start = `${month}-01`;
  return many(q, `
    WITH m AS (SELECT $1::date AS s, ($1::date + interval '1 month')::date AS e),
    plan AS (
      SELECT r.staff_id, count(*) AS shifts,
             sum(CASE r.shift WHEN 'truc_24' THEN 24 WHEN 'hanh_chinh' THEN 8 ELSE 12 END) AS planned_hours,
             count(*) FILTER (WHERE r.shift IN ('dem', 'truc_24')) AS night_shifts
        FROM roster r, m WHERE r.work_date >= m.s AND r.work_date < m.e GROUP BY r.staff_id),
    crew AS (
      SELECT st.id AS staff_id,
             sum(extract(epoch FROM (least(coalesce(cs.ended_at, now()), m.e::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
                                    - greatest(cs.started_at, m.s::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))) / 3600) AS h
        FROM crew_shifts cs JOIN staff st ON st.user_id = cs.user_id, m
       WHERE cs.started_at < m.e::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AND coalesce(cs.ended_at, now()) > m.s::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
       GROUP BY st.id),
    att AS (
      SELECT a.staff_id, sum(extract(epoch FROM (coalesce(a.check_out, now()) - a.check_in)) / 3600) AS h
        FROM attendance a, m WHERE a.check_in >= m.s::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AND a.check_in < m.e::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
       GROUP BY a.staff_id),
    lv AS (
      SELECT l.staff_id, sum(least(l.to_date, m.e - 1) - greatest(l.from_date, m.s) + 1) AS days
        FROM leave_requests l, m WHERE l.status = 'da_duyet' AND l.from_date < m.e AND l.to_date >= m.s GROUP BY l.staff_id)
    SELECT s.id, s.code, s.full_name, s.title, s.station_id,
           coalesce(plan.shifts, 0)::int AS shifts, coalesce(plan.planned_hours, 0)::int AS planned_hours,
           coalesce(plan.night_shifts, 0)::int AS night_shifts,
           round(coalesce(crew.h, 0)::numeric, 1)::float AS crew_hours, round(coalesce(att.h, 0)::numeric, 1)::float AS office_hours,
           round((coalesce(crew.h, 0) + coalesce(att.h, 0))::numeric, 1)::float AS actual_hours,
           coalesce(lv.days, 0)::int AS leave_days
      FROM staff s LEFT JOIN plan ON plan.staff_id = s.id LEFT JOIN crew ON crew.staff_id = s.id
      LEFT JOIN att ON att.staff_id = s.id LEFT JOIN lv ON lv.staff_id = s.id
     WHERE s.status <> 'nghi_viec' OR plan.shifts > 0 OR crew.h > 0
     ORDER BY s.code`, [start]);
}
