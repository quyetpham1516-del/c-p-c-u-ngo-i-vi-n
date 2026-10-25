import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, withTx } from '../db.js';
import { actorOf, EOC_ROLES, guard, type Ctx, type Role } from '../http.js';
import { ackSos, openSos, raiseSos, resolveSos, SIGNATURE_KIND, SOS_SELECT, verifyTransfer } from '../safety.js';

const SOS_VIEW: Role[] = [...EOC_ROLES, 'qa', 'director'];
const SOS_RESOLVE: Role[] = ['dispatcher', 'supervisor', 'admin'];
const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
const lat = z.number().min(-90).max(90).nullish();
const lng = z.number().min(-180).max(180).nullish();

/** Giới hạn tra cứu mã phiếu công khai: 20 lần mỗi phút cho mỗi địa chỉ */
const VERIFY_LIMIT = 20;
const hits = new Map<string, { n: number; until: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.until < now) { hits.set(ip, { n: 1, until: now + 60_000 }); return false; }
  h.n++;
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  return h.n > VERIFY_LIMIT;
}

export function registerSafety(app: FastifyInstance, { pool, hub }: Ctx) {
  const push = (id: string) => hub.publish({ type: 'sos', id });

  app.get('/api/safety/meta', { preHandler: guard() }, async () => ({ signatureKind: SIGNATURE_KIND }));

  /* ---------- Báo khẩn: phía kíp ---------- */

  app.post('/api/crew/sos', { preHandler: guard('crew') }, async (req) => {
    const b = z.object({ lat, lng, accuracy: z.number().min(0).max(100_000).nullish(), note: z.string().trim().max(500).nullish() }).parse(req.body ?? {});
    const row = await withTx(pool, (tx) => raiseSos(tx, actorOf(req), b));
    await push(row.id);
    return row;
  });
  app.get('/api/crew/sos', { preHandler: guard('crew') }, async (req) =>
    (await one(pool, `${SOS_SELECT} WHERE s.user_id = $1 AND s.resolved_at IS NULL`, [req.user.id])) ?? null);
  app.post('/api/crew/sos/:id/cancel', { preHandler: guard('crew') }, async (req) => {
    const b = z.object({ reason: z.string().trim().min(2).max(500) }).parse(req.body);
    const id = idParam(req.params);
    const row = await withTx(pool, (tx) => resolveSos(tx, actorOf(req), id, { resolution: `Kíp hủy: ${b.reason}`, falseAlarm: true }, true));
    await push(id);
    return row;
  });

  /* ---------- Báo khẩn: phía EOC ---------- */

  app.get('/api/sos', { preHandler: guard(...SOS_VIEW) }, async () => openSos(pool));
  app.get('/api/sos/history', { preHandler: guard(...SOS_VIEW) }, async () =>
    many(pool, `${SOS_SELECT} ORDER BY s.created_at DESC LIMIT 200`));
  app.post('/api/sos/:id/ack', { preHandler: guard(...EOC_ROLES) }, async (req) => {
    const b = z.object({ note: z.string().trim().min(2).max(1000) }).parse(req.body);
    const id = idParam(req.params);
    const row = await withTx(pool, (tx) => ackSos(tx, actorOf(req), id, b.note));
    await push(id);
    return row;
  });
  app.post('/api/sos/:id/resolve', { preHandler: guard(...SOS_RESOLVE) }, async (req) => {
    const b = z.object({ resolution: z.string().trim().min(3).max(1000), falseAlarm: z.boolean().default(false) }).parse(req.body);
    const id = idParam(req.params);
    const row = await withTx(pool, (tx) => resolveSos(tx, actorOf(req), id, b, false));
    await push(id);
    return row;
  });

  /* ---------- Mã xác thực phiếu chuyển viện: công khai, không cần đăng nhập ---------- */

  app.get('/api/public/verify/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string().trim().min(5).max(30) }).parse(req.params);
    if (limited(req.ip)) return reply.code(429).send({ error: 'Tra cứu quá nhiều lần, thử lại sau một phút' });
    return verifyTransfer(pool, code, req.ip);
  });
}
