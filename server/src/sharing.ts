import { createHash, randomBytes } from 'node:crypto';
import { many, one, type Queryable } from './db.js';
import { haversineKm, travelMinutes } from './fleet.js';
import { roadRoute } from './routing.js';
import { initials } from './safety.js';

/**
 * Đường dẫn chia sẻ không cần đăng nhập:
 *  - bệnh viện nhận: báo trước người bệnh đang tới (tuổi, giới, lý do, sinh hiệu mới nhất, giờ dự kiến tới) và bấm xác nhận sẵn sàng/không nhận được;
 *  - người nhà: xe đang tới, đã tới, đang chuyển đi bệnh viện nào; không có thông tin bệnh án.
 * Mã ngẫu nhiên chỉ hiện một lần, máy chủ lưu mã băm; hết hạn theo giờ, hết hiệu lực khi ca kết thúc hoặc điều phối thu hồi.
 */

export const SHARE_KIND = { benh_vien: 'Bệnh viện nhận', nguoi_nha: 'Người nhà' } as const;
export type ShareKind = keyof typeof SHARE_KIND;
export const SHARE_HOURS: Record<ShareKind, number> = { benh_vien: 6, nguoi_nha: 3 };
export const SHARE_PATH: Record<ShareKind, string> = { benh_vien: '/bv', nguoi_nha: '/theo-doi' };
const ENDED = ['closed', 'cancelled', 'transferred_115', 'advice_only'];

export const shareHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const newShareToken = () => randomBytes(18).toString('base64url');

export function smsBody(kind: ShareKind, code: string, url: string, hospital?: string | null) {
  return kind === 'benh_vien'
    ? `Medone bao truoc ca ${code} dang chuyen toi ${hospital ?? 'benh vien'}. Xem tinh trang, gio du kien toi va xac nhan tiep nhan: ${url}`
    : `Medone: xe cap cuu cho ca ${code} da duoc dieu. Theo doi xe tai: ${url}`;
}

/** Tìm đường dẫn còn hiệu lực theo mã; null nếu sai mã, hết hạn hoặc đã thu hồi */
export async function findShare(q: Queryable, token: string) {
  return one(q, `SELECT * FROM share_links WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`, [shareHash(token)]);
}

async function activeVehicle(q: Queryable, incidentId: string) {
  return one(q, `SELECT v.id, v.plate, v.type, v.status, v.lat, v.lng, v.location_at FROM assignments a JOIN vehicles v ON v.id = a.vehicle_id
                  WHERE a.incident_id = $1 AND a.ended_at IS NULL ORDER BY a.assigned_at DESC LIMIT 1`, [incidentId]);
}

const eta = async (from: { lat: number | null; lng: number | null } | null, to: { lat: number | null; lng: number | null } | null) => {
  if (!from || !to || from.lat == null || from.lng == null || to.lat == null || to.lng == null) return null;
  const a = { lat: from.lat, lng: from.lng }; const b = { lat: to.lat, lng: to.lng };
  const r = await roadRoute(a, b);
  if (r) return { km: r.km, minutes: Math.round(r.min), road: true };
  const km = haversineKm(a, b);
  return { km: Math.round(km * 10) / 10, minutes: Math.round(travelMinutes(km)) };
};

/** Nội dung trang công khai theo loại đường dẫn */
export async function shareView(q: Queryable, link: any) {
  const inc = await one(q, `SELECT id, code, status, final_priority, suggested_priority, chief_complaint, lat, lng, destination, destination_department
                              FROM incidents WHERE id = $1`, [link.incident_id]);
  const base = { kind: link.kind as ShareKind, code: inc.code, expiresAt: link.expires_at };
  if (ENDED.includes(inc.status)) return { ...base, ended: true as const };
  const times = Object.fromEntries((await many(q, 'SELECT code, at FROM incident_times WHERE incident_id = $1', [inc.id])).map((t) => [t.code, t.at]));
  const v = await activeVehicle(q, inc.id);
  const vehicle = v ? { plate: v.plate, type: v.type, positionAt: v.location_at } : null;

  if (link.kind === 'nguoi_nha') {
    const stage = inc.status === 'transporting' || inc.status === 'at_hospital' ? 'chuyen_vien' : times.T8 ? 'da_toi' : v ? 'dang_toi' : 'dang_dieu';
    return {
      ...base, ended: false as const, stage, vehicle,
      arrivedAt: times.T8 ?? null,
      eta: stage === 'dang_toi' ? await eta(v, inc) : null,
      hospital: stage === 'chuyen_vien' ? inc.destination : null,
    };
  }

  // Bệnh viện nhận: bản ePCR đang ghi trên máy tính bảng của kíp
  const t = await one(q, `SELECT t.epcr, p.full_name, p.sex, coalesce(extract(year FROM p.dob)::int, p.birth_year) AS birth_year
                            FROM transfers t LEFT JOIN patients p ON p.id = t.patient_id
                           WHERE t.incident_id = $1 ORDER BY t.updated_at DESC LIMIT 1`, [inc.id]);
  const e = t?.epcr ?? {};
  const vit = Array.isArray(e.vitals) ? e.vitals.filter((x: any) => x && typeof x === 'object') : [];
  const last = vit.length ? vit[vit.length - 1] : null;
  const h = await one(q, 'SELECT lat, lng FROM hospitals WHERE name = $1', [link.hospital]);
  const pick = (o: any, ks: string[]) => (o ? Object.fromEntries(ks.filter((k) => o[k] != null && o[k] !== '').map((k) => [k, o[k]])) : null);
  return {
    ...base, ended: false as const,
    hospital: link.hospital, department: link.department,
    priority: inc.final_priority ?? inc.suggested_priority,
    status: inc.status,
    patient: t ? { initials: initials(t.full_name), age: t.birth_year ? new Date().getFullYear() - t.birth_year : null, sex: t.sex } : null,
    chiefComplaint: e.chiefComplaint ?? inc.chief_complaint ?? null,
    diagnosis: e.diagnosis?.text ?? null,
    vitals: last ? { at: last.at ?? null, ...pick(last, ['hr', 'sbp', 'dbp', 'spo2', 'rr', 'temp', 'gcs', 'glucose']) } : null,
    arrest: e.arrest?.present === true,
    vehicle,
    leftSceneAt: times.T10 ?? null,
    arrivedAt: times.T12 ?? null,
    eta: !times.T12 && inc.status === 'transporting' ? await eta(v, h) : null,
    response: link.response ? { value: link.response, by: link.response_by, note: link.response_note, at: link.responded_at } : null,
  };
}
