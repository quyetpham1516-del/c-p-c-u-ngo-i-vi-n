import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { withTx } from '../src/db.js';
import { assertWaiverLimit, base32Decode, base32Encode, checkTotp, hotp, recordLimited, totpStep } from '../src/security.js';
import { freshApp, login, testPassword } from './helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;
const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
const raw = (method: string, url: string, body?: unknown, tok?: string) =>
  app.inject({ method: method as any, url, payload: body as any, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
const pwLogin = async (username: string) => (await raw('POST', '/api/auth/login', { username, password: testPassword })).json();
/** Mã hiện tại (bước +k) của khóa base32 */
const codeOf = (secret: string, k = 0) => hotp(base32Decode(secret), totpStep() + k);

beforeAll(async () => {
  ({ app, pool } = await freshApp());
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('TOTP theo RFC 6238', () => {
  it('khớp vector chuẩn và mã hóa base32', () => {
    const key = Buffer.from('12345678901234567890');
    expect(base32Encode(key)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(key)).toBe(true);
    expect(hotp(key, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(key, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(hotp(key, Math.floor(1234567890 / 30), 8)).toBe('89005924');
  });

  it('cho lệch ±30 giây, không nhận mã đã dùng', () => {
    const key = Buffer.from('12345678901234567890');
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(checkTotp(key, hotp(key, step - 1), null, now)).toBe(step - 1);
    expect(checkTotp(key, hotp(key, step + 1), null, now)).toBe(step + 1);
    expect(checkTotp(key, hotp(key, step + 2), null, now)).toBeNull();
    expect(checkTotp(key, hotp(key, step), step, now)).toBeNull();
    expect(checkTotp(key, 'abcdef', null, now)).toBeNull();
  });
});

describe('xác thực hai lớp', () => {
  let secret = '';
  let recovery: string[] = [];

  it('kế toán tự cài: nhập lại mật khẩu, quét QR, nhập mã đầu tiên, nhận 10 mã dự phòng', async () => {
    const r = await pwLogin('ketoan');
    expect(r.token).toBeTruthy();
    expect(r.mfaSetupRequired).toBe(false);
    const st = (await raw('GET', '/api/auth/mfa', undefined, r.token)).json();
    expect(st).toMatchObject({ enabled: false, required: true, enforce: false });
    expect((await raw('POST', '/api/auth/mfa/setup', { password: 'sai-mat-khau' }, r.token)).statusCode).toBe(422);
    const s = (await raw('POST', '/api/auth/mfa/setup', { password: testPassword }, r.token)).json();
    expect(s.uri).toMatch(/^otpauth:\/\/totp\/MedOne%20EOC%3Aketoan\?secret=[A-Z2-7]+&issuer=MedOne%20EOC/);
    secret = s.secret;
    expect((await one(`SELECT totp_pending_enc FROM users WHERE username = 'ketoan'`)).totp_pending_enc).not.toContain(secret);
    expect((await raw('POST', '/api/auth/mfa/enable', { code: '000000' }, r.token)).statusCode).toBe(422);
    const en = (await raw('POST', '/api/auth/mfa/enable', { code: codeOf(secret) }, r.token)).json();
    expect(en.recoveryCodes).toHaveLength(10);
    recovery = en.recoveryCodes;
    const row = await one(`SELECT totp_enabled_at, totp_recovery FROM users WHERE username = 'ketoan'`);
    expect(row.totp_enabled_at).toBeTruthy();
    expect(row.totp_recovery.join()).not.toContain(recovery[0]);
  });

  it('đăng nhập lại phải qua bước mã 6 số; vé tạm không dùng làm phiên; mã không dùng lại được', async () => {
    const r = await pwLogin('ketoan');
    expect(r.mfaRequired).toBe(true);
    expect(r.token).toBeUndefined();
    expect((await raw('GET', '/api/me', undefined, r.challenge)).statusCode).toBe(401);
    expect((await raw('GET', '/api/finance/summary', undefined, r.challenge)).statusCode).toBe(401);
    // Mã của bước đã dùng lúc bật thì không nhận nữa
    expect((await raw('POST', '/api/auth/mfa', { challenge: r.challenge, code: codeOf(secret) })).statusCode).toBe(422);
    const ok = (await raw('POST', '/api/auth/mfa', { challenge: r.challenge, code: codeOf(secret, 1) })).json();
    expect(ok.token).toBeTruthy();
    expect((await raw('GET', '/api/finance/summary', undefined, ok.token)).statusCode).toBe(200);
    expect((await raw('POST', '/api/auth/mfa', { challenge: r.challenge, code: codeOf(secret, 1) })).statusCode).toBe(422);
  });

  it('mã dự phòng dùng một lần; kế toán không tự tắt được vì vai trò bắt buộc', async () => {
    const r = await pwLogin('ketoan');
    const ok = (await raw('POST', '/api/auth/mfa', { challenge: r.challenge, code: recovery[0].toLowerCase() })).json();
    expect(ok.token).toBeTruthy();
    expect(ok.recoveryLeft).toBe(9);
    const again = await pwLogin('ketoan');
    expect((await raw('POST', '/api/auth/mfa', { challenge: again.challenge, code: recovery[0] })).statusCode).toBe(422);
    expect((await raw('POST', '/api/auth/mfa/disable', { password: testPassword, code: '123456' }, ok.token)).statusCode).toBe(409);
  });

  it('nhập sai 5 lần thì khóa 15 phút, kể cả mã đúng; quản trị đặt lại khi mất điện thoại', async () => {
    const r = await pwLogin('ketoan');
    // Lần sai trước đó (dùng lại mã dự phòng) đã tính một lần
    for (let i = 0; i < 3; i++) expect((await raw('POST', '/api/auth/mfa', { challenge: r.challenge, code: '000000' })).json().error).toMatch(/còn/);
    expect((await raw('POST', '/api/auth/mfa', { challenge: r.challenge, code: '000000' })).json().error).toMatch(/tạm khóa/);
    expect((await raw('POST', '/api/auth/mfa', { challenge: r.challenge, code: codeOf(secret, 1) })).statusCode).toBe(429);
    const audit = await one(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.mfa_locked'`);
    expect(audit.n).toBe(1);

    const admin = await login(app, 'admin');
    const me = await one(`SELECT id FROM users WHERE username = 'admin'`);
    expect((await admin('POST', `/api/users/${me.id}/mfa/reset`, { reason: 'Thử' })).http).toBe(403);
    const kt = await one(`SELECT id FROM users WHERE username = 'ketoan'`);
    expect((await admin('POST', `/api/users/${kt.id}/mfa/reset`, { reason: 'Mất điện thoại' })).http).toBe(200);
    expect((await pwLogin('ketoan')).token).toBeTruthy();
  });

  it('bật bắt buộc: điều phối chưa cài chỉ vào được trang cài đặt, cài xong dùng bình thường', async () => {
    const admin = await login(app, 'admin');
    const ketoan = await login(app, 'ketoan');
    expect((await ketoan('PUT', '/api/security/settings', { mfaRoles: ['dispatcher'], mfaEnforce: true })).http).toBe(403);
    expect((await admin('PUT', '/api/security/settings', { mfaRoles: ['dispatcher'], mfaEnforce: true })).mfaEnforce).toBe(true);
    const st = await admin('GET', '/api/security/settings');
    expect(st.missing).toBe(5);   // dpv06–dpv10

    const r = await pwLogin('dpv06');
    expect(r.mfaSetupRequired).toBe(true);
    const blocked = (await raw('GET', '/api/incidents', undefined, r.token));
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().details.code).toBe('MFA_SETUP_REQUIRED');
    expect((await raw('GET', '/api/me', undefined, r.token)).statusCode).toBe(200);
    const s = (await raw('POST', '/api/auth/mfa/setup', { password: testPassword }, r.token)).json();
    const en = (await raw('POST', '/api/auth/mfa/enable', { code: codeOf(s.secret) }, r.token)).json();
    expect(en.mfaSetupRequired).toBe(false);
    expect((await raw('GET', '/api/incidents', undefined, en.token)).statusCode).toBe(200);
    // Kế toán không còn trong danh sách bắt buộc: đăng nhập thường
    expect((await pwLogin('ketoan')).mfaSetupRequired).toBe(false);
    await admin('PUT', '/api/security/settings', { mfaRoles: ['dispatcher', 'supervisor', 'accountant', 'director', 'admin'], mfaEnforce: false });
  });
});

describe('hạn mức phê duyệt', () => {
  it('miễn/giảm: kế toán duyệt tới 500.000 đ, vượt thì cần Ban Giám đốc', async () => {
    await expect(assertWaiverLimit(pool, 'accountant', 500_000)).resolves.toBeUndefined();
    await expect(assertWaiverLimit(pool, 'accountant', 500_001)).rejects.toThrow(/Ban Giám đốc/);
    await expect(assertWaiverLimit(pool, 'director', 50_000_000)).resolves.toBeUndefined();
    await expect(assertWaiverLimit(pool, 'supervisor', 1)).rejects.toThrow(/vượt hạn mức/);
  });

  it('hủy ca đã điều xe: điều phối viên vượt hạn mức thì trưởng ca hậu kiểm; ca chưa điều xe không tính', async () => {
    const dpv = await login(app, 'dpv07');
    const sup = await login(app, 'truongca');
    const mk = async (code: string, served: boolean) => {
      const id = (await one(`INSERT INTO incidents(code, source, status) VALUES ($1, '1800', 'confirmed') RETURNING id`, [code])).id;
      if (served) await pool.query(`INSERT INTO assignments(incident_id, vehicle_id, assigned_by, ended_at, end_reason)
                                     SELECT $1, 'MD-BLS-01', id, now(), 'Gia đình tự chở' FROM users WHERE username = 'dpv07'`, [id]);
      return id;
    };
    expect((await dpv('POST', `/api/incidents/${await mk('HC-1', false)}/close`, { status: 'cancelled', reason: 'Gọi nhầm' })).http).toBe(200);
    expect((await sup('GET', '/api/approvals/reviews')).data).toHaveLength(0);
    const served = await mk('HC-2', true);
    expect((await dpv('POST', `/api/incidents/${served}/close`, { status: 'cancelled', reason: 'Gia đình tự chở đi' })).http).toBe(200);
    const list = (await sup('GET', '/api/approvals/reviews')).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ action: 'huy_ca', incident_code: 'HC-2', created_by_role: 'dispatcher', status: 'cho_xem' });

    expect((await dpv('POST', `/api/approvals/reviews/${list[0].id}/decide`, { agree: true })).http).toBe(403);
    expect((await sup('POST', `/api/approvals/reviews/${list[0].id}/decide`, { agree: false })).http).toBe(422);
    const d = await sup('POST', `/api/approvals/reviews/${list[0].id}/decide`, { agree: false, note: 'Phải gọi lại xác minh trước khi hủy' });
    expect(d.status).toBe('khong_dong_y');
    expect((await sup('POST', `/api/approvals/reviews/${list[0].id}/decide`, { agree: true })).http).toBe(409);
    // Trưởng ca không giới hạn: hủy không tạo hậu kiểm
    expect((await sup('POST', `/api/incidents/${await mk('HC-3', true)}/close`, { status: 'cancelled', reason: 'Trùng ca' })).http).toBe(200);
    expect((await sup('GET', '/api/approvals/reviews')).data).toHaveLength(0);
  });

  it('Ban Giám đốc sửa hạn mức: rút xe được 1 lần mỗi ngày, lần thứ 2 mới hậu kiểm', async () => {
    const gd = await login(app, 'giamdoc');
    const dpv = await login(app, 'dpv08');
    const cur = (await gd('GET', '/api/approvals/limits')).limits.map((l: any) => ({ action: l.action, role: l.role, maxValue: l.max_value }));
    const noTop = cur.filter((l: any) => !(l.action === 'mien_giam' && l.maxValue === null));
    expect((await gd('PUT', '/api/approvals/limits', { limits: noTop })).http).toBe(422);
    expect((await dpv('PUT', '/api/approvals/limits', { limits: cur })).http).toBe(403);
    const next = cur.map((l: any) => (l.action === 'rut_xe' && l.role === 'dispatcher' ? { ...l, maxValue: 1 } : l));
    const saved = await gd('PUT', '/api/approvals/limits', { limits: next });
    expect(saved.limits.find((l: any) => l.action === 'rut_xe' && l.role === 'dispatcher').max_value).toBe(1);

    const u = await one(`SELECT id, full_name FROM users WHERE username = 'dpv08'`);
    const actor = { id: u.id, name: u.full_name };
    expect(await withTx(pool, (tx) => recordLimited(tx, actor, 'rut_xe', { reason: 'Ca P1 ngừng tim' }))).toBeNull();
    const second = await withTx(pool, (tx) => recordLimited(tx, actor, 'rut_xe', { reason: 'Ca P1 đa chấn thương' }));
    expect(second?.detail).toMatchObject({ usedToday: 2, limit: 1 });
  });
});
