import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { giveHandover, handoverDetail, HANDOVER_STATUS, receiveHandover } from '../handover.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';

const VIEW: Role[] = ['calltaker', 'dispatcher', 'supervisor', 'qa', 'admin', 'director', 'pharmacist'];
const COND = z.enum(['tot', 'thieu', 'hong', 'het_han']);

export function registerHandover(app: FastifyInstance, { pool }: Ctx) {
  const idOf = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
  const LIST = `SELECT h.id, h.vehicle_id, h.status, h.reminded_at, h.giver_signed_at, h.receiver_signed_at, h.created_at,
                       gu.full_name AS giver_name, ru.full_name AS receiver_name, h.outgoing, h.incoming
                  FROM vehicle_handovers h LEFT JOIN users gu ON gu.id = h.giver_id LEFT JOIN users ru ON ru.id = h.receiver_id`;

  /** Kíp: biên bản mình là người giao hoặc nhận (đang mở, hoặc đã khóa trong 24 giờ) */
  app.get('/api/handovers/mine', { preHandler: guard('crew') }, async (req) =>
    many(pool, `${LIST} WHERE $1 = ANY(h.outgoing || h.incoming) AND (h.status <> 'da_khoa' OR h.receiver_signed_at > now() - interval '24 hours')
                ORDER BY (h.status <> 'da_khoa') DESC, h.created_at DESC`, [req.user.id]));

  app.get('/api/handovers', { preHandler: guard(...VIEW) }, async (req) => {
    const q = z.object({ vehicleId: z.string().optional(), open: z.enum(['1']).optional() }).parse(req.query);
    return many(pool, `${LIST} WHERE ($1::text IS NULL OR h.vehicle_id = $1) AND ($2::boolean IS NOT TRUE OR h.status <> 'da_khoa')
                       ORDER BY (h.status <> 'da_khoa') DESC, h.created_at DESC LIMIT 200`, [q.vehicleId ?? null, q.open === '1']);
  });

  async function involved(req: FastifyRequest, id: string) {
    if (VIEW.includes(req.user.role)) return;
    const h = await one(pool, 'SELECT 1 FROM vehicle_handovers WHERE id = $1 AND $2 = ANY(outgoing || incoming)', [id, req.user.id]);
    if (!h) throw new HttpError(404, 'Không tìm thấy biên bản bàn giao');
  }

  app.get('/api/handovers/:id', { preHandler: guard(...VIEW, 'crew') }, async (req) => {
    const id = idOf(req.params);
    await involved(req, id);
    return handoverDetail(pool, id);
  });

  app.post('/api/handovers/:id/give', { preHandler: guard('crew') }, async (req) => {
    const id = idOf(req.params);
    const b = z.object({
      items: z.array(z.object({ drugId: z.number().int(), counted: z.number().min(0).max(100000), condition: COND, note: z.string().trim().max(200).nullish() })).max(500),
      equipment: z.array(z.object({ id: z.string().uuid(), condition: COND, note: z.string().trim().max(200).nullish() })).max(200),
      note: z.string().trim().max(1000).nullish(),
    }).parse(req.body);
    return withTx(pool, (tx) => giveHandover(tx, actorOf(req), id, b));
  });

  app.post('/api/handovers/:id/receive', { preHandler: guard('crew') }, async (req) => {
    const id = idOf(req.params);
    const b = z.object({ agree: z.boolean(), note: z.string().trim().max(1000).nullish() }).parse(req.body);
    await withTx(pool, (tx) => receiveHandover(tx, actorOf(req), id, b));
    return handoverDetail(pool, id);
  });

  app.get('/api/handover-settings', { preHandler: guard() }, async () => ({
    ...(await one(pool, 'SELECT position, grace_minutes FROM handover_settings WHERE id = 1')), statuses: HANDOVER_STATUS,
  }));

  /** Vị trí phụ trách bàn giao, số phút được chậm. Đã khóa cấu hình thì trưởng nhóm kíp đề xuất, quản trị duyệt. */
  app.put('/api/handover-settings', { preHandler: guard('admin') }, async (req) => {
    const b = z.object({ position: z.string().trim().min(1).max(60), graceMinutes: z.number().int().min(5).max(240) }).parse(req.body);
    await withTx(pool, async (tx) => {
      if (!(await one(tx, 'SELECT 1 FROM crew_roles WHERE name = $1 AND active', [b.position]))) throw new HttpError(400, `Không có vị trí "${b.position}"`);
      await tx.query('UPDATE handover_settings SET position = $1, grace_minutes = $2 WHERE id = 1', [b.position, b.graceMinutes]);
      await audit(tx, 'system', actorOf(req), 'handover.settings', 'handover_settings', '1', b);
    });
    return { ok: true };
  });
}
