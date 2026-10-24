import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/** Chuẩn hóa số định danh: bỏ khoảng trắng, chữ hoa (hộ chiếu có chữ) */
export function normalizeId(raw: string): string {
  return raw.replace(/[\s.-]/g, '').toUpperCase();
}

export function isValidCccd(id: string): boolean {
  return /^\d{12}$/.test(id);
}

/** AES-256-GCM: iv.tag.ciphertext (base64url) */
export function encryptId(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.dataKey, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function decryptId(enc: string): string {
  const [iv, tag, ct] = enc.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', config.dataKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** HMAC để tìm kiếm: cùng loại giấy tờ + cùng số => cùng mã băm */
export function lookupHash(idType: string, id: string, nationality = ''): string {
  return createHmac('sha256', config.lookupKey).update(`${idType}|${nationality.toUpperCase()}|${id}`).digest('hex');
}

export function maskLast4(id: string): string {
  return id.slice(-4);
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(h, 'base64url');
  const got = scryptSync(pw, Buffer.from(s, 'base64url'), expected.length);
  return timingSafeEqual(expected, got);
}
