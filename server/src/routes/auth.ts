import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { verifyPassword } from '../crypto.js';
import { one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { guardSetup, type Ctx, type TokenUser } from '../http.js';
import {
  checkTotp, getSecurity, MFA_LOCK_MINUTES, MFA_MAX_FAILED, mfaRequired, newRecoveryCodes, newTotpSecret, otpauthUri, recoveryHash, totpKey,
} from '../security.js';

const CHALLENGE_TTL = '5m';

export function registerAuth(app: FastifyInstance, { pool }: Ctx) {
  /** Cấp phiên đăng nhập; vai trò bắt buộc xác thực hai lớp mà chưa cài thì phiên chỉ vào được trang cài đặt */
  const issue = async (u: any) => {
    const s = await getSecurity(pool);
    const mustSetup = s.mfaEnforce && mfaRequired(s, u.role) && !u.totp_enabled_at;
    const user: TokenUser = { id: u.id, username: u.username, name: u.full_name, role: u.role, ...(mustSetup ? { mfaSetup: true } : {}) };
    return { token: app.jwt.sign(user), user, mfaSetupRequired: mustSetup };
  };
  const passwordOk = async (userId: string, password: string) => {
    const u = await one(pool, 'SELECT password_hash FROM users WHERE id = $1 AND active', [userId]);
    if (!u || !verifyPassword(password, u.password_hash)) throw new HttpError(422, 'Mật khẩu không đúng');
  };

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const u = await one(pool, 'SELECT * FROM users WHERE username = $1 AND active', [body.username.trim().toLowerCase()]);
    if (!u || !verifyPassword(body.password, u.password_hash)) {
      return reply.code(401).send({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
    }
    if (u.totp_enabled_at) {
      // Đúng mật khẩu, còn bước mã 6 số: trả vé tạm 5 phút, chưa phải phiên đăng nhập
      return { mfaRequired: true, challenge: app.jwt.sign({ id: u.id, typ: 'mfa_challenge' } as TokenUser, { expiresIn: CHALLENGE_TTL }) };
    }
    const r = await issue(u);
    await withTx(pool, async (tx) => {
      await tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
      await audit(tx, 'system', { id: u.id, name: u.full_name }, 'auth.login', 'user', u.id, { ip: req.ip, mfa: false });
    });
    return r;
  });

  /** Bước 2: mã 6 số trong ứng dụng xác thực, hoặc một mã dự phòng (dùng một lần) */
  app.post('/api/auth/mfa', async (req, reply) => {
    const b = z.object({ challenge: z.string().min(10), code: z.string().trim().min(6).max(20) }).parse(req.body);
    let ch: TokenUser;
    try { ch = app.jwt.verify<TokenUser>(b.challenge); } catch { return reply.code(401).send({ error: 'Hết thời gian nhập mã, đăng nhập lại' }); }
    if (ch.typ !== 'mfa_challenge') return reply.code(401).send({ error: 'Đăng nhập lại' });
    return withTx(pool, async (tx) => {
      const u = await one(tx, 'SELECT * FROM users WHERE id = $1 AND active FOR UPDATE', [ch.id]);
      if (!u || !u.totp_enabled_at) throw new HttpError(401, 'Đăng nhập lại');
      if (u.mfa_locked_until && new Date(u.mfa_locked_until) > new Date()) {
        const at = new Date(u.mfa_locked_until).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
        throw new HttpError(429, `Nhập sai quá nhiều lần, thử lại sau ${at}`);
      }
      const code = b.code.replace(/\s/g, '');
      let method: 'totp' | 'recovery' | null = null;
      if (/^\d{6}$/.test(code)) {
        const step = checkTotp(totpKey(u.totp_secret_enc), code, u.totp_last_step == null ? null : Number(u.totp_last_step));
        if (step != null) {
          method = 'totp';
          await tx.query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [u.id, step]);
        }
      } else {
        const h = recoveryHash(code);
        if ((u.totp_recovery as string[]).includes(h)) {
          method = 'recovery';
          await tx.query('UPDATE users SET totp_recovery = array_remove(totp_recovery, $2) WHERE id = $1', [u.id, h]);
        }
      }
      const actor = { id: u.id, name: u.full_name };
      if (!method) {
        const failed = u.mfa_failed + 1;
        const lock = failed >= MFA_MAX_FAILED;
        await tx.query(`UPDATE users SET mfa_failed = $2, mfa_locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE mfa_locked_until END WHERE id = $1`,
          [u.id, lock ? 0 : failed, lock, MFA_LOCK_MINUTES]);
        await audit(tx, 'system', actor, lock ? 'auth.mfa_locked' : 'auth.mfa_failed', 'user', u.id, { ip: req.ip, failed });
        // Lỗi nghiệp vụ trả về sau khi đã ghi số lần sai: không ném lỗi để giao dịch không bị hoàn tác
        return reply.code(422).send({ error: lock ? `Nhập sai ${MFA_MAX_FAILED} lần: tạm khóa ${MFA_LOCK_MINUTES} phút` : `Mã không đúng (còn ${MFA_MAX_FAILED - failed} lần thử)` });
      }
      await tx.query('UPDATE users SET mfa_failed = 0, mfa_locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
      await audit(tx, 'system', actor, 'auth.login', 'user', u.id, { ip: req.ip, mfa: method });
      const left = method === 'recovery' ? (u.totp_recovery as string[]).length - 1 : undefined;
      return { ...(await issue(u)), recoveryLeft: left };
    });
  });

  app.get('/api/me', { preHandler: guardSetup() }, async (req) => {
    const shift = await one(pool, `SELECT cs.vehicle_id, cs.crew_role, v.type FROM crew_shifts cs JOIN vehicles v ON v.id = cs.vehicle_id
                                    WHERE cs.user_id = $1 AND cs.ended_at IS NULL`, [req.user.id]);
    return { user: req.user, shift: shift ?? null };
  });

  /* ---------- Tự cài xác thực hai lớp ---------- */

  app.get('/api/auth/mfa', { preHandler: guardSetup() }, async (req) => {
    const u = await one(pool, 'SELECT totp_enabled_at, totp_pending_enc IS NOT NULL AS pending, cardinality(totp_recovery) AS recovery_left FROM users WHERE id = $1', [req.user.id]);
    const s = await getSecurity(pool);
    return { enabled: !!u.totp_enabled_at, enabledAt: u.totp_enabled_at, pending: u.pending, recoveryLeft: u.recovery_left,
      required: mfaRequired(s, req.user.role), enforce: s.mfaEnforce };
  });

  /** Tạo khóa mới (nhập lại mật khẩu để người mượn máy không tự gắn điện thoại của họ vào tài khoản) */
  app.post('/api/auth/mfa/setup', { preHandler: guardSetup() }, async (req) => {
    const b = z.object({ password: z.string().min(1) }).parse(req.body);
    await passwordOk(req.user.id, b.password);
    const u = await one(pool, 'SELECT username, totp_enabled_at FROM users WHERE id = $1', [req.user.id]);
    if (u.totp_enabled_at) throw new HttpError(409, 'Đã bật xác thực hai lớp');
    const { secret, enc } = newTotpSecret();
    await pool.query('UPDATE users SET totp_pending_enc = $2 WHERE id = $1', [req.user.id, enc]);
    return { secret, uri: otpauthUri(u.username, secret) };
  });

  /** Nhập mã đầu tiên từ ứng dụng để xác nhận đã quét đúng; trả mã dự phòng một lần duy nhất */
  app.post('/api/auth/mfa/enable', { preHandler: guardSetup() }, async (req) => {
    const b = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Nhập 6 chữ số trong ứng dụng') }).parse(req.body);
    return withTx(pool, async (tx) => {
      const u = await one(tx, 'SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      if (u.totp_enabled_at) throw new HttpError(409, 'Đã bật xác thực hai lớp');
      if (!u.totp_pending_enc) throw new HttpError(409, 'Tạo mã QR trước');
      const step = checkTotp(totpKey(u.totp_pending_enc), b.code, null);
      if (step == null) throw new HttpError(422, 'Mã không đúng: kiểm tra giờ trên điện thoại đã tự động chưa, rồi nhập mã mới');
      const codes = newRecoveryCodes();
      await tx.query(`UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = now(), totp_last_step = $2,
                             totp_recovery = $3, mfa_failed = 0, mfa_locked_until = NULL WHERE id = $1`, [u.id, step, codes.map(recoveryHash)]);
      await audit(tx, 'system', { id: u.id, name: u.full_name }, 'auth.mfa_enabled', 'user', u.id, {});
      return { ...(await issue({ ...u, totp_enabled_at: new Date() })), recoveryCodes: codes };
    });
  });

  app.post('/api/auth/mfa/recovery', { preHandler: guardSetup() }, async (req) => {
    const b = z.object({ password: z.string().min(1), code: z.string().trim().regex(/^\d{6}$/) }).parse(req.body);
    await passwordOk(req.user.id, b.password);
    return withTx(pool, async (tx) => {
      const u = await one(tx, 'SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      if (!u.totp_enabled_at) throw new HttpError(409, 'Chưa bật xác thực hai lớp');
      const step = checkTotp(totpKey(u.totp_secret_enc), b.code, u.totp_last_step == null ? null : Number(u.totp_last_step));
      if (step == null) throw new HttpError(422, 'Mã không đúng');
      const codes = newRecoveryCodes();
      await tx.query('UPDATE users SET totp_recovery = $2, totp_last_step = $3 WHERE id = $1', [u.id, codes.map(recoveryHash), step]);
      await audit(tx, 'system', { id: u.id, name: u.full_name }, 'auth.mfa_recovery_renewed', 'user', u.id, {});
      return { recoveryCodes: codes };
    });
  });

  app.post('/api/auth/mfa/disable', { preHandler: guardSetup() }, async (req) => {
    const b = z.object({ password: z.string().min(1), code: z.string().trim().regex(/^\d{6}$/) }).parse(req.body);
    const s = await getSecurity(pool);
    if (mfaRequired(s, req.user.role)) throw new HttpError(409, 'Vai trò của bạn bắt buộc dùng xác thực hai lớp. Mất điện thoại thì nhờ quản trị đặt lại');
    await passwordOk(req.user.id, b.password);
    return withTx(pool, async (tx) => {
      const u = await one(tx, 'SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      if (!u.totp_enabled_at) throw new HttpError(409, 'Chưa bật xác thực hai lớp');
      if (checkTotp(totpKey(u.totp_secret_enc), b.code, u.totp_last_step == null ? null : Number(u.totp_last_step)) == null) throw new HttpError(422, 'Mã không đúng');
      await tx.query(`UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery = '{}' WHERE id = $1`, [u.id]);
      await audit(tx, 'system', { id: u.id, name: u.full_name }, 'auth.mfa_disabled', 'user', u.id, {});
      return { ok: true };
    });
  });
}
