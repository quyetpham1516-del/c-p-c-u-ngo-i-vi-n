import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptId, encryptId } from './crypto.js';
import { one, type Queryable } from './db.js';
import { HttpError } from './domain.js';
import { haversineKm } from './fleet.js';

/**
 * Chấm công bằng mã QR tại trạm. Máy tính bảng ở trạm hiện mã đổi mỗi 30 giây (HMAC theo khóa riêng của trạm),
 * nhân viên quét bằng điện thoại đã đăng nhập; máy chủ kiểm tra mã còn hạn và vị trí GPS trong bán kính trạm.
 * Mã chụp gửi cho người khác hết hạn sau khoảng một phút; người ở xa trạm bị từ chối hoặc đánh dấu để nhân sự xem lại.
 */

export const QR_STEP_S = 30;
/** Nhận mã của 2 bước trước (mạng chậm, quét chậm) và 1 bước sau (lệch đồng hồ) */
const ACCEPT_BEHIND = 2;
const ACCEPT_AHEAD = 1;
/** Quét lại trong khoảng này coi là bấm nhầm, không đảo vào/ra */
export const REPEAT_GUARD_S = 120;
/** Sai số GPS trên mức này vẫn nhận nhưng đánh dấu */
export const LOW_ACCURACY_M = 100;

export const FLAG: Record<string, string> = {
  khong_vi_tri: 'Không gửi vị trí',
  sai_so_lon: 'Vị trí sai số lớn',
  ra_khac_tram: 'Ra ở trạm khác',
  thu_cong: 'Chấm công thủ công trên web',
};

export const qrStep = (ms = Date.now()) => Math.floor(ms / 1000 / QR_STEP_S);

const sign = (secret: string, stationId: string, step: number) =>
  createHmac('sha256', secret).update(`${stationId}.${step}`).digest('base64url').slice(0, 16);

export function makeToken(secret: string, stationId: string, step = qrStep()) {
  return `${stationId}.${step}.${sign(secret, stationId, step)}`;
}

export function parseToken(token: string) {
  const m = /^([A-Za-z0-9_-]{1,32})\.(\d{1,12})\.([A-Za-z0-9_-]{16})$/.exec(token.trim());
  if (!m) return null;
  return { stationId: m[1], step: Number(m[2]), mac: m[3] };
}

/** Mã hợp lệ của trạm và còn hạn */
export function verifyToken(secret: string, t: { stationId: string; step: number; mac: string }, now = qrStep()) {
  if (t.step < now - ACCEPT_BEHIND || t.step > now + ACCEPT_AHEAD) return false;
  const a = Buffer.from(sign(secret, t.stationId, t.step));
  const b = Buffer.from(t.mac);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const kioskHash = (key: string) => createHash('sha256').update(key).digest('hex');

export function newKioskCredentials() {
  const secret = randomBytes(32).toString('base64url');
  const key = randomBytes(24).toString('base64url');
  return { secretEnc: encryptId(secret), key, keyHash: kioskHash(key) };
}

export async function stationQr(q: Queryable, stationId: string) {
  return one(q, `SELECT s.id, s.name, s.lat, s.lng, s.active, a.secret_enc, a.kiosk_key_hash, a.radius_m, a.require_gps
                   FROM stations s JOIN station_attendance a ON a.station_id = s.id WHERE s.id = $1`, [stationId]);
}

export function stationSecret(row: { secret_enc: string }) {
  return decryptId(row.secret_enc);
}

/** Khóa máy chiếu mã đúng không (so sánh mã băm, thời gian không đổi) */
export function kioskKeyOk(row: { kiosk_key_hash: string }, key: string | undefined) {
  if (!key) return false;
  const a = Buffer.from(kioskHash(key));
  const b = Buffer.from(row.kiosk_key_hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Kiểm tra vị trí người quét so với trạm. Trừ đi sai số (tối đa 100 m) để không từ chối oan người đứng sát mép bán kính.
 * Trả về khoảng cách và cờ cần xem lại; ném lỗi khi thiếu vị trí bắt buộc hoặc ở xa trạm.
 */
export function checkLocation(
  st: { lat: number; lng: number; radius_m: number; require_gps: boolean; name: string },
  pos: { lat?: number | null; lng?: number | null; accuracy?: number | null },
) {
  const flags: string[] = [];
  if (pos.lat == null || pos.lng == null) {
    if (st.require_gps) throw new HttpError(422, 'Cần bật định vị trên điện thoại để chấm công tại trạm', { code: 'GPS_REQUIRED' });
    flags.push('khong_vi_tri');
    return { distance: null as number | null, accuracy: null as number | null, flags };
  }
  const distance = Math.round(haversineKm({ lat: pos.lat, lng: pos.lng }, st) * 1000);
  const accuracy = pos.accuracy == null ? null : Math.round(pos.accuracy);
  const slack = Math.min(accuracy ?? 0, LOW_ACCURACY_M);
  if (distance - slack > st.radius_m) {
    throw new HttpError(422, `Bạn đang cách ${st.name} khoảng ${distance.toLocaleString('vi-VN')} m, ngoài bán kính ${st.radius_m} m`, { code: 'TOO_FAR', distance });
  }
  if (accuracy != null && accuracy > LOW_ACCURACY_M) flags.push('sai_so_lon');
  return { distance, accuracy, flags };
}
