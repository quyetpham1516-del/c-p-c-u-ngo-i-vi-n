import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx } from '../http.js';

const KIND = z.enum(['tru_so', 'tram', 'kho_trung_tam', 'diem_su_kien']);
const stationBody = {
  name: z.string().trim().min(2).max(120),
  kind: KIND,
  address: z.string().trim().max(300).nullish(),
  phone: z.string().trim().max(30).nullish(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
};

/**
 * Quản trị điểm/trạm và phân điểm: chỉ tài khoản admin quyết định có những điểm nào, xe nào đóng ở điểm nào,
 * nhân viên làm ở điểm nào. Kho thuốc, xe, kíp đều gắn với một điểm.
 */
export function registerAdmin(app: FastifyInstance, { pool, hub }: Ctx) {
  const admin = { preHandler: guard('admin') };

  app.get('/api/stations', { preHandler: guard() }, async (req) => {
    const all = req.user.role === 'admin' && (req.query as { all?: string }).all === '1';
    return many(pool, `
      SELECT s.*, (SELECT count(*)::int FROM vehicles v WHERE v.station_id = s.id) AS vehicle_count,
             (SELECT count(*)::int FROM users u WHERE u.station_id = s.id AND u.active) AS staff_count,
             (SELECT coalesce(sum(qty), 0)::float FROM stock_lots l WHERE l.station_id = s.id) AS stock_qty
        FROM stations s WHERE $1 OR s.active ORDER BY s.active DESC, (s.kind = 'tru_so') DESC, s.id`, [all]);
  });

  app.post('/api/stations', admin, async (req) => {
    const b = z.object({ id: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, 'Mã điểm chỉ gồm chữ, số, gạch ngang (2–20 ký tự)'), ...stationBody }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (await one(tx, 'SELECT 1 FROM stations WHERE id = $1', [b.id])) throw new HttpError(409, `Mã điểm ${b.id} đã có`);
      const s = await one(tx, `INSERT INTO stations(id, name, kind, address, phone, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.id, b.name, b.kind, b.address ?? null, b.phone ?? null, b.lat, b.lng]);
      await audit(tx, 'system', actorOf(req), 'station.created', 'station', b.id, b);
      return s;
    });
  });

  app.patch('/api/stations/:id', admin, async (req) => {
    const id = z.object({ id: z.string() }).parse(req.params).id;
    const b = z.object({
      name: stationBody.name.optional(), kind: KIND.optional(), address: stationBody.address, phone: stationBody.phone,
      lat: stationBody.lat.optional(), lng: stationBody.lng.optional(), active: z.boolean().optional(),
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      const cur = await one(tx, 'SELECT * FROM stations WHERE id = $1 FOR UPDATE', [id]);
      if (!cur) throw new HttpError(404, 'Không tìm thấy điểm');
      if (b.active === false) {
        const v = await one(tx, 'SELECT count(*)::int AS n FROM vehicles WHERE station_id = $1', [id]);
        if (v.n) throw new HttpError(409, `Điểm ${id} còn ${v.n} xe: chuyển xe sang điểm khác trước khi tạm ngưng`);
      }
      const s = await one(tx, `
        UPDATE stations SET name = coalesce($2, name), kind = coalesce($3, kind), address = CASE WHEN $4::boolean THEN $5 ELSE address END,
               phone = CASE WHEN $6::boolean THEN $7 ELSE phone END, lat = coalesce($8, lat), lng = coalesce($9, lng), active = coalesce($10, active)
         WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.kind ?? null, b.address !== undefined, b.address ?? null, b.phone !== undefined, b.phone ?? null,
        b.lat ?? null, b.lng ?? null, b.active ?? null]);
      await audit(tx, 'system', actorOf(req), 'station.updated', 'station', id, b);
      return s;
    });
  });

  /** Chuyển xe sang điểm khác: chỉ khi xe không đang làm nhiệm vụ */
  app.patch('/api/vehicles/:id/station', admin, async (req) => {
    const id = z.object({ id: z.string() }).parse(req.params).id;
    const b = z.object({ stationId: z.string().min(1) }).parse(req.body);
    await withTx(pool, async (tx) => {
      const v = await one(tx, 'SELECT * FROM vehicles WHERE id = $1 FOR UPDATE', [id]);
      if (!v) throw new HttpError(404, 'Không tìm thấy xe');
      if (!['S1', 'S2', 'S9'].includes(v.status) || v.current_incident_id) throw new HttpError(409, `Xe ${id} đang làm nhiệm vụ (${v.status}), chưa chuyển điểm được`);
      const s = await one(tx, 'SELECT active FROM stations WHERE id = $1', [b.stationId]);
      if (!s?.active) throw new HttpError(409, 'Điểm không tồn tại hoặc đang tạm ngưng');
      await tx.query('UPDATE vehicles SET station_id = $2 WHERE id = $1', [id, b.stationId]);
      await audit(tx, 'system', actorOf(req), 'vehicle.station_changed', 'vehicle', id, { from: v.station_id, to: b.stationId });
    });
    await hub.publish({ type: 'vehicle', id });
    return { ok: true };
  });

  app.get('/api/users', admin, async () =>
    many(pool, `SELECT u.id, u.username, u.full_name, u.title, u.role, u.active, u.station_id, s.name AS station_name
                  FROM users u LEFT JOIN stations s ON s.id = u.station_id ORDER BY u.role, u.username`));

  /** Phân điểm làm việc cho nhân viên (để trống = làm được mọi điểm) */
  app.patch('/api/users/:id/station', admin, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ stationId: z.string().min(1).nullable() }).parse(req.body);
    await withTx(pool, async (tx) => {
      if (b.stationId) {
        const s = await one(tx, 'SELECT active FROM stations WHERE id = $1', [b.stationId]);
        if (!s?.active) throw new HttpError(409, 'Điểm không tồn tại hoặc đang tạm ngưng');
      }
      const u = await one(tx, 'UPDATE users SET station_id = $2 WHERE id = $1 RETURNING username', [id, b.stationId]);
      if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản');
      await audit(tx, 'system', actorOf(req), 'user.station_changed', 'user', id, b);
    });
    return { ok: true };
  });
}
