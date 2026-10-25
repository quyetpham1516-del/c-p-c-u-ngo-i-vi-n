import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { audit, type Actor } from './audit.js';
import { decryptId, encryptId } from './crypto.js';
import { many, one, type Queryable, type Tx } from './db.js';
import { HttpError, incidentScope } from './domain.js';
import type { Role } from './http.js';

/**
 * Giai đoạn L: xác thực hai lớp bằng ứng dụng điện thoại (Google Authenticator, Microsoft Authenticator...)
 * theo chuẩn TOTP (RFC 6238), và hạn mức phê duyệt cho miễn giảm phí, rút xe, hủy ca.
 */

/* ================= TOTP ================= */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Khóa base32 không hợp lệ');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const TOTP_PERIOD = 30;
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_PERIOD);

/** Kiểm mã 6 số, cho lệch đồng hồ ±1 bước (±30 giây). Trả bước thời gian khớp, null nếu sai hoặc mã đã dùng */
export function checkTotp(key: Buffer, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = totpStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (lastStep != null && s <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(code))) return s;
  }
  return null;
}

export const ISSUER = 'MedOne EOC';
export const otpauthUri = (username: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent(`${ISSUER}:${username}`)}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;

export function newTotpSecret(): { secret: string; enc: string } {
  const secret = base32Encode(randomBytes(20));
  return { secret, enc: encryptId(secret) };
}
export const totpKey = (enc: string) => base32Decode(decryptId(enc));

/* ================= Mã dự phòng ================= */

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const RECOVERY_COUNT = 10;
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_COUNT }, () => {
    let s = '';
    for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
export const recoveryHash = (code: string) => createHash('sha256').update(code.toUpperCase().replace(/[^0-9A-Z]/g, '')).digest('hex');

/** Nhập sai 5 lần thì khóa xác thực hai lớp 15 phút */
export const MFA_MAX_FAILED = 5;
export const MFA_LOCK_MINUTES = 15;

/* ================= Cài đặt bảo mật ================= */

export interface SecuritySettings { mfaRoles: Role[]; mfaEnforce: boolean; updatedAt: string; updatedBy: string | null }
export async function getSecurity(q: Queryable): Promise<SecuritySettings> {
  const s = await one(q, `SELECT s.*, u.full_name AS updated_by_name FROM security_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.id = 1`);
  return { mfaRoles: s.mfa_roles, mfaEnforce: s.mfa_enforce, updatedAt: s.updated_at, updatedBy: s.updated_by_name ?? null };
}
export const mfaRequired = (s: SecuritySettings, role: string) => s.mfaRoles.includes(role as Role);

/* ================= Hạn mức phê duyệt ================= */

export const LIMIT_ACTION: Record<string, { label: string; unit: string; hint: string }> = {
  mien_giam: {
    label: 'Duyệt miễn, giảm phí', unit: 'đồng mỗi khoản thu',
    hint: 'Người có vai trò này được duyệt miễn/giảm tới số tiền này. Vượt mức thì phải người có hạn mức cao hơn duyệt.',
  },
  rut_xe: {
    label: 'Rút xe từ ca ưu tiên thấp hơn cho ca P1', unit: 'lần mỗi ngày không cần hậu kiểm',
    hint: 'Việc khẩn nên vẫn làm ngay. Vượt số lần này thì trưởng ca phải xem lại (hậu kiểm).',
  },
  huy_ca: {
    label: 'Hủy ca đã điều xe', unit: 'lần mỗi ngày không cần hậu kiểm',
    hint: 'Hủy ca chưa điều xe không tính. Vượt số lần này thì trưởng ca phải xem lại (hậu kiểm).',
  },
};
export const REVIEW_ROLES_DECIDE: Role[] = ['supervisor', 'director', 'admin'];

export const listLimits = (q: Queryable) => many(q, `SELECT l.action, l.role, l.max_value::float8 AS max_value, l.updated_at, u.full_name AS updated_by_name
                                                      FROM approval_limits l LEFT JOIN users u ON u.id = l.updated_by ORDER BY l.action, l.role`);

/** Hạn mức của một vai trò: không có dòng = không được làm (miễn giảm) hoặc lần nào cũng phải hậu kiểm (rút xe, hủy ca) */
export async function limitFor(q: Queryable, action: string, role: string): Promise<{ exists: boolean; max: number | null }> {
  const r = await one(q, 'SELECT max_value::float8 AS max_value FROM approval_limits WHERE action = $1 AND role = $2', [action, role]);
  return r ? { exists: true, max: r.max_value } : { exists: false, max: 0 };
}

const ROLE_LABEL: Record<string, string> = {
  calltaker: 'Tiếp nhận cuộc gọi', dispatcher: 'Điều phối viên', supervisor: 'Trưởng ca', crew: 'Kíp', qa: 'Quản lý chất lượng', admin: 'Quản trị',
  pharmacist: 'Dược', technician: 'Kỹ thuật', ipc: 'Kiểm soát nhiễm khuẩn', hr: 'Nhân sự', accountant: 'Kế toán', director: 'Ban Giám đốc',
};
const vnd = (n: number) => `${n.toLocaleString('vi-VN')} đ`;

/** Kiểm hạn mức duyệt miễn/giảm: vượt thì báo ai được duyệt */
export async function assertWaiverLimit(q: Queryable, role: string, amount: number) {
  const lim = await limitFor(q, 'mien_giam', role);
  if (lim.exists && (lim.max == null || amount <= lim.max)) return;
  const higher = await many(q, `SELECT role, max_value::float8 AS max_value FROM approval_limits
                                 WHERE action = 'mien_giam' AND (max_value IS NULL OR max_value >= $1) ORDER BY max_value NULLS LAST`, [amount]);
  const who = higher.map((h) => ROLE_LABEL[h.role] ?? h.role).join(', ') || 'người có hạn mức đủ lớn';
  throw new HttpError(403, `Miễn/giảm ${vnd(amount)} vượt hạn mức của ${ROLE_LABEL[role] ?? role}${lim.exists && lim.max != null ? ` (${vnd(lim.max)})` : ''}: cần ${who} duyệt`,
    { code: 'OVER_LIMIT', limit: lim.max });
}

/**
 * Ghi một lần làm việc có hạn mức (rút xe, hủy ca đã có xe). Việc vẫn được làm ngay vì là việc khẩn;
 * vượt số lần trong ngày thì tạo một mục hậu kiểm cho trưởng ca. Trả mục hậu kiểm, hoặc null nếu trong hạn mức.
 */
export async function recordLimited(tx: Tx, actor: Actor, action: 'rut_xe' | 'huy_ca',
  ctx: { incidentId?: string | null; vehicleId?: string | null; reason: string; detail?: Record<string, unknown> }) {
  if (!actor.id) return null;
  const u = await one(tx, 'SELECT role FROM users WHERE id = $1', [actor.id]);
  await tx.query('INSERT INTO approval_usage(action, user_id) VALUES ($1,$2)', [action, actor.id]);
  const lim = await limitFor(tx, action, u?.role ?? '');
  if (lim.exists && lim.max == null) return null;
  const used = (await one(tx, `SELECT count(*)::int AS n FROM approval_usage WHERE user_id = $1 AND action = $2
                                  AND (at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`, [actor.id, action])).n;
  if (used <= (lim.max ?? 0)) return null;
  const r = await one(tx, `INSERT INTO approval_reviews(action, incident_id, vehicle_id, reason, detail, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
  [action, ctx.incidentId ?? null, ctx.vehicleId ?? null, ctx.reason, { ...(ctx.detail ?? {}), usedToday: used, limit: lim.max }, actor.id]);
  await audit(tx, ctx.incidentId ? incidentScope(ctx.incidentId) : 'system', actor, 'approval.review_created', 'approval_review', r.id,
    { action, usedToday: used, limit: lim.max });
  return r;
}

export const REVIEW_SELECT = `
  SELECT r.*, u.full_name AS created_by_name, u.role AS created_by_role, d.full_name AS decided_by_name, i.code AS incident_code
    FROM approval_reviews r JOIN users u ON u.id = r.created_by
    LEFT JOIN users d ON d.id = r.decided_by
    LEFT JOIN incidents i ON i.id = r.incident_id`;

export async function decideReview(tx: Tx, actor: Actor, id: string, b: { agree: boolean; note?: string | null }) {
  const r = await one(tx, 'SELECT * FROM approval_reviews WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw new HttpError(404, 'Không tìm thấy mục hậu kiểm');
  if (r.status !== 'cho_xem') throw new HttpError(409, 'Mục này đã được xem');
  if (r.created_by === actor.id) throw new HttpError(403, 'Không tự hậu kiểm việc của chính mình');
  if (!b.agree && !b.note?.trim()) throw new HttpError(422, 'Không đồng ý phải ghi lý do');
  const row = await one(tx, `UPDATE approval_reviews SET status = $2, decided_by = $3, decided_at = now(), note = $4 WHERE id = $1 RETURNING *`,
    [id, b.agree ? 'dong_y' : 'khong_dong_y', actor.id, b.note?.trim() || null]);
  await audit(tx, r.incident_id ? incidentScope(r.incident_id) : 'system', actor, b.agree ? 'approval.review_agreed' : 'approval.review_disagreed',
    'approval_review', id, { action: r.action, note: b.note ?? null });
  return row;
}
