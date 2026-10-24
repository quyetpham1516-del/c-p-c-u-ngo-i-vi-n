import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type pg from 'pg';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './domain.js';
import { Hub } from './events.js';
import { registerEoc } from './routes/eoc.js';
import { registerFleet } from './routes/fleet.js';
import { registerRecords } from './routes/records.js';
import { registerAuth } from './routes/auth.js';
import { registerAdmin } from './routes/admin.js';
import { registerCatalog } from './routes/catalog.js';
import { registerEquipment } from './routes/equipment.js';
import { registerStock } from './routes/stock.js';
import type { Ctx } from './http.js';

export * from './http.js';

export async function buildApp(pool: pg.Pool, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  const hub = new Hub(pool);
  await hub.start();
  const ctx: Ctx = { pool, hub };

  await app.register(cors, { origin: config.webOrigins });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: '14h' } });
  await app.register(websocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Dữ liệu không hợp lệ', details: err.issues });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') return reply.code(409).send({ error: 'Dữ liệu bị trùng (đã tồn tại)' });
    app.log.error(err);
    return reply.code(500).send({ error: 'Lỗi máy chủ' });
  });

  app.get('/api/health', async () => ({ ok: true, clients: hub.size }));

  app.get('/ws', { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string }).token;
    try {
      app.jwt.verify(token ?? '');
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
    hub.add(socket);
    socket.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  });

  registerAuth(app, ctx);
  registerEoc(app, ctx);
  registerFleet(app, ctx);
  registerRecords(app, ctx);
  registerCatalog(app, ctx);
  registerStock(app, ctx);
  registerEquipment(app, ctx);
  registerAdmin(app, ctx);

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Không tìm thấy' }));

  app.addHook('onClose', async () => {
    await hub.stop();
  });
  return { app, ctx };
}
