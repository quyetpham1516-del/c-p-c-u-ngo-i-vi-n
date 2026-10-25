import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { hashPassword } from '../crypto.js';
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
    many(pool, `SELECT u.id, u.username, u.full_name, u.title, u.role, u.active, u.license_no, u.station_id, s.name AS station_name, u.sso_linked_at
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

  /* ---------- Tài khoản: admin tạo, đổi vai trò, khóa, đặt lại mật khẩu ---------- */
  const ROLE = z.enum(['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director']);
  const password = z.string().min(10, 'Mật khẩu dài ít nhất 10 ký tự').max(200);

  app.post('/api/users', admin, async (req) => {
    const b = z.object({
      username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'Tên đăng nhập 3–40 ký tự: chữ thường, số, . _ -'),
      fullName: z.string().trim().min(2).max(120), role: ROLE, title: z.string().trim().max(80).nullish(),
      licenseNo: z.string().trim().max(60).nullish(), stationId: z.string().nullish(), password,
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (await one(tx, 'SELECT 1 FROM users WHERE username = $1', [b.username])) throw new HttpError(409, `Tên đăng nhập ${b.username} đã có`);
      const u = await one(tx, `INSERT INTO users(username, full_name, role, title, license_no, station_id, password_hash)
                               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, username, full_name, role, title, station_id, active`,
      [b.username, b.fullName, b.role, b.title ?? null, b.licenseNo ?? null, b.stationId ?? null, hashPassword(b.password)]);
      await audit(tx, 'system', actorOf(req), 'user.created', 'user', u.id, { username: b.username, role: b.role });
      return u;
    });
  });

  app.patch('/api/users/:id', admin, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({
      fullName: z.string().trim().min(2).max(120).optional(), role: ROLE.optional(), title: z.string().trim().max(80).nullish(),
      licenseNo: z.string().trim().max(60).nullish(), active: z.boolean().optional(),
    }).parse(req.body);
    if (id === req.user.id && (b.active === false || (b.role && b.role !== 'admin'))) throw new HttpError(409, 'Không tự khóa hoặc tự bỏ quyền quản trị của chính mình');
    return withTx(pool, async (tx) => {
      const u = await one(tx, `UPDATE users SET full_name = coalesce($2, full_name), role = coalesce($3, role),
                                      title = CASE WHEN $6 THEN $4 ELSE title END, license_no = CASE WHEN $7 THEN $5 ELSE license_no END,
                                      active = coalesce($8, active)
                                WHERE id = $1 RETURNING id, username, full_name, role, title, station_id, active`,
      [id, b.fullName ?? null, b.role ?? null, b.title ?? null, b.licenseNo ?? null, 'title' in b, 'licenseNo' in b, b.active ?? null]);
      if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản');
      if (b.active === false) await tx.query('UPDATE crew_shifts SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [id]);
      await audit(tx, 'system', actorOf(req), 'user.updated', 'user', id, b);
      return u;
    });
  });

  app.post('/api/users/:id/password', admin, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ password }).parse(req.body);
    await withTx(pool, async (tx) => {
      const u = await one(tx, 'UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id', [id, hashPassword(b.password)]);
      if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản');
      await audit(tx, 'system', actorOf(req), 'user.password_reset', 'user', id);
    });
    return { ok: true };
  });

  /** Gỡ nối tài khoản đăng nhập một lần (đổi người, nối nhầm): lần đăng nhập SSO sau sẽ nối lại theo tên đăng nhập */
  app.post('/api/users/:id/sso-unlink', admin, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    await withTx(pool, async (tx) => {
      const u = await one(tx, 'UPDATE users SET sso_issuer = NULL, sso_subject = NULL, sso_linked_at = NULL WHERE id = $1 RETURNING id', [id]);
      if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản');
      await audit(tx, 'system', actorOf(req), 'user.sso_unlinked', 'user', id);
    });
    return { ok: true };
  });
}
