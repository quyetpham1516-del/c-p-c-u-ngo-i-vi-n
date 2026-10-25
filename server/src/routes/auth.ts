import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { verifyPassword } from '../crypto.js';
import { one, withTx } from '../db.js';
import { guard, type Ctx, type TokenUser } from '../http.js';

export function registerAuth(app: FastifyInstance, { pool }: Ctx) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const u = await one(pool, 'SELECT * FROM users WHERE username = $1 AND active', [body.username.trim().toLowerCase()]);
    if (!u || !verifyPassword(body.password, u.password_hash)) {
      return reply.code(401).send({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
    }
    const user: TokenUser = { id: u.id, username: u.username, name: u.full_name, role: u.role };
    await withTx(pool, async (tx) => {
      await tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
      await audit(tx, 'system', { id: u.id, name: u.full_name }, 'auth.login', 'user', u.id, { ip: req.ip });
    });
    return { token: app.jwt.sign(user), user };
  });

  app.get('/api/me', { preHandler: guard() }, async (req) => {
    const shift = await one(pool, `SELECT cs.vehicle_id, cs.crew_role, v.type FROM crew_shifts cs JOIN vehicles v ON v.id = cs.vehicle_id
                                    WHERE cs.user_id = $1 AND cs.ended_at IS NULL`, [req.user.id]);
    return { user: req.user, shift: shift ?? null };
  });
}
