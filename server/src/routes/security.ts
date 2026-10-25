import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import { decideReview, getSecurity, LIMIT_ACTION, listLimits, REVIEW_ROLES_DECIDE, REVIEW_SELECT } from '../security.js';

const ROLES = ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] as const;
const ROLE = z.enum(ROLES);
const LIMIT_EDIT: Role[] = ['director', 'admin'];
const REVIEW_VIEW: Role[] = [...REVIEW_ROLES_DECIDE, 'qa'];
const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;

export function registerSecurity(app: FastifyInstance, { pool, hub }: Ctx) {
  /* ---------- Chính sách xác thực hai lớp (quản trị) ---------- */

  app.get('/api/security/settings', { preHandler: guard('admin', 'director') }, async () => {
    const s = await getSecurity(pool);
    const users = await many(pool, `SELECT id, username, full_name, role, active, totp_enabled_at, cardinality(totp_recovery) AS recovery_left,
                                           mfa_locked_until > now() AS locked, last_login_at
                                      FROM users WHERE active ORDER BY role, full_name`);
    const missing = users.filter((u) => s.mfaRoles.includes(u.role) && !u.totp_enabled_at).length;
    return { settings: s, users, missing };
  });

  app.put('/api/security/settings', { preHandler: guard('admin') }, async (req) => {
    const b = z.object({ mfaRoles: z.array(ROLE).max(ROLES.length), mfaEnforce: z.boolean() }).parse(req.body);
    await withTx(pool, async (tx) => {
      await tx.query('UPDATE security_settings SET mfa_roles = $1, mfa_enforce = $2, updated_by = $3, updated_at = now() WHERE id = 1',
        [[...new Set(b.mfaRoles)], b.mfaEnforce, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'security.settings_changed', 'security_settings', '1', b);
    });
    return getSecurity(pool);
  });

  /** Mất điện thoại: quản trị xóa xác thực hai lớp để người đó cài lại (không tự đặt lại cho chính mình) */
  app.post('/api/users/:id/mfa/reset', { preHandler: guard('admin') }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    if (id === req.user.id) throw new HttpError(403, 'Không tự đặt lại xác thực hai lớp của chính mình: nhờ quản trị khác');
    await withTx(pool, async (tx) => {
      const u = await one(tx, `UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
                                      totp_recovery = '{}', mfa_failed = 0, mfa_locked_until = NULL WHERE id = $1 RETURNING username`, [id]);
      if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản');
      await audit(tx, 'system', actorOf(req), 'security.mfa_reset', 'user', id, { username: u.username, reason: b.reason });
    });
    return { ok: true };
  });

  /* ---------- Hạn mức phê duyệt ---------- */

  app.get('/api/approvals/limits', { preHandler: guard() }, async () => ({ actions: LIMIT_ACTION, limits: await listLimits(pool) }));

  /** Thay toàn bộ bảng hạn mức (Ban Giám đốc, quản trị) */
  app.put('/api/approvals/limits', { preHandler: guard(...LIMIT_EDIT) }, async (req) => {
    const b = z.object({
      limits: z.array(z.object({
        action: z.enum(Object.keys(LIMIT_ACTION) as [string, ...string[]]), role: ROLE, maxValue: z.number().int().min(0).max(1e12).nullable(),
      })).max(100),
    }).parse(req.body);
    const keys = new Set(b.limits.map((l) => `${l.action}|${l.role}`));
    if (keys.size !== b.limits.length) throw new HttpError(422, 'Mỗi vai trò chỉ có một hạn mức cho mỗi việc');
    if (!b.limits.some((l) => l.action === 'mien_giam' && l.maxValue === null)) {
      throw new HttpError(422, 'Phải có ít nhất một vai trò duyệt miễn/giảm không giới hạn (thường là Ban Giám đốc)');
    }
    await withTx(pool, async (tx) => {
      const before = await listLimits(tx);
      await tx.query('DELETE FROM approval_limits');
      for (const l of b.limits) {
        await tx.query('INSERT INTO approval_limits(action, role, max_value, updated_by) VALUES ($1,$2,$3,$4)', [l.action, l.role, l.maxValue, req.user.id]);
      }
      await audit(tx, 'system', actorOf(req), 'approval.limits_changed', 'approval_limits', null,
        { before: before.map((x) => [x.action, x.role, x.max_value]), after: b.limits.map((x) => [x.action, x.role, x.maxValue]) });
    });
    return { actions: LIMIT_ACTION, limits: await listLimits(pool) };
  });

  /* ---------- Hậu kiểm rút xe, hủy ca ---------- */

  app.get('/api/approvals/reviews', { preHandler: guard(...REVIEW_VIEW) }, async (req) => {
    const q = z.object({ status: z.enum(['cho_xem', 'dong_y', 'khong_dong_y', 'tat_ca']).default('cho_xem') }).parse(req.query);
    return many(pool, `${REVIEW_SELECT} WHERE ($1 = 'tat_ca' OR r.status = $1) ORDER BY r.created_at DESC LIMIT 300`, [q.status]);
  });
  app.post('/api/approvals/reviews/:id/decide', { preHandler: guard(...REVIEW_ROLES_DECIDE) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ agree: z.boolean(), note: z.string().trim().max(1000).nullish() }).parse(req.body);
    const r = await withTx(pool, (tx) => decideReview(tx, actorOf(req), id, b));
    await hub.publish({ type: 'approval', id });
    return r;
  });
}
