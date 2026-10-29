import { HttpError } from './domain.js';
import { encryptId, isValidCccd, lookupHash, maskLast4, normalizeId } from './crypto.js';
import { one, type Queryable } from './db.js';

/** Chức danh phải có chứng chỉ hành nghề: Bác sĩ, Y sĩ, Điều dưỡng (kể cả viết tắt BS, YS, ĐD) */
export function needsLicense(title: string | null | undefined): boolean {
  const t = (title ?? '').trim().toLowerCase().normalize('NFC');
  return /^(bác sĩ|bác sỹ|y sĩ|y sỹ|điều dưỡng|bs|ys|đd|dd)(\s|$|\.)/.test(t);
}

const SHORT: [RegExp, string][] = [
  [/^(bác s[ĩỹ]|bs)(?=\s|$|\.)/i, 'BS'], [/^(y s[ĩỹ]|ys)(?=\s|$|\.)/i, 'YS'], [/^(điều dưỡng|đd|dd)(?=\s|$|\.)/i, 'ĐD'],
  [/^(lái xe|lx)(?=\s|$|\.)/i, 'LX'], [/^(kỹ thuật viên|ktv)(?=\s|$|\.)/i, 'KTV'], [/^(cấp cứu viên|ccv)(?=\s|$|\.)/i, 'CCV'],
];

/** Chức danh viết tắt để hiện trên bảng xe: Y sĩ → YS */
export function shortTitle(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  for (const [re, s] of SHORT) if (re.test(t)) return s;
  return t;
}

/** "YS Tân": chức danh viết tắt + tên gọi (chữ cuối của họ tên) */
export function leaderLabel(title: string | null | undefined, fullName: string): string {
  const given = fullName.trim().split(/\s+/).pop() ?? fullName;
  return [shortTitle(title), given].filter(Boolean).join(' ');
}

export function normalizeTaxCode(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === '') return null;
  const t = raw.replace(/[\s.-]/g, '');
  if (!/^\d{10}(\d{3})?$/.test(t)) throw new HttpError(400, 'Mã số thuế gồm 10 hoặc 13 chữ số');
  return t;
}

/** Số căn cước: kiểm tra 12 số, không trùng người khác; trả về bản mã hóa, 4 số cuối và mã băm để tra trùng */
export async function sealCccd(q: Queryable, raw: string, exceptUserId: string | null) {
  const id = normalizeId(raw);
  if (!isValidCccd(id)) throw new HttpError(400, 'Số căn cước gồm 12 chữ số');
  const hash = lookupHash('cccd_user', id);
  if (await one(q, 'SELECT 1 FROM users WHERE cccd_hash = $1 AND ($2::uuid IS NULL OR id <> $2)', [hash, exceptUserId])) {
    throw new HttpError(409, 'Số căn cước này đã gắn với tài khoản khác');
  }
  return { enc: encryptId(id), last4: maskLast4(id), hash };
}

/** Kiểm tra theo loại tài khoản: cá nhân có căn cước, tổ chức có mã số thuế; chứng chỉ hành nghề theo chức danh */
export function checkAccount(a: { accountType: string; title?: string | null; licenseNo?: string | null; taxCode?: string | null; hasCccd: boolean; creating: boolean }) {
  if (a.accountType === 'to_chuc') {
    if (!a.taxCode) throw new HttpError(400, 'Tài khoản tổ chức cần mã số thuế');
    if (a.hasCccd) throw new HttpError(400, 'Tài khoản tổ chức không ghi số căn cước');
  } else {
    if (a.taxCode) throw new HttpError(400, 'Tài khoản cá nhân không ghi mã số thuế');
    if (a.creating && !a.hasCccd) throw new HttpError(400, 'Tài khoản cá nhân cần số căn cước (12 số)');
  }
  if (needsLicense(a.title) && !a.licenseNo?.trim()) throw new HttpError(400, `Chức danh ${a.title} cần số chứng chỉ hành nghề`);
}
