import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, type Ctx } from '../http.js';
import { notificationsFor } from '../notify.js';

/** Nút chuông: nhắc việc còn quên theo vai trò và tin gửi tới tài khoản */
export function registerNotify(app: FastifyInstance, { pool }: Ctx) {
  app.get('/api/notifications', { preHandler: guard() }, async (req) => notificationsFor(pool, { id: req.user.id, role: req.user.role }));

  app.post('/api/notifications/:id/read', { preHandler: guard() }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    await pool.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL', [id, req.user.id]);
    return { ok: true };
  });

  app.post('/api/notifications/read-all', { preHandler: guard() }, async (req) => {
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
    return { ok: true };
  });
}
