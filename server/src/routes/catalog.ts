import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import { adjustStock, lotsForVehicle, receiveStock } from '../stock.js';

const CATALOG_ADMIN: Role[] = ['supervisor', 'admin'];
const STOCK_VIEW: Role[] = ['crew', 'supervisor', 'qa', 'admin', 'dispatcher'];

export function registerCatalog(app: FastifyInstance, { pool }: Ctx) {
  /* ---------- Bệnh viện và khoa nhận bệnh ---------- */
  app.get('/api/hospitals', { preHandler: guard() }, async () => {
    return many(pool, `
      SELECT h.id, h.name, h.kcb_code, h.kind, h.address, h.phone, h.capabilities,
             COALESCE(json_agg(json_build_object('id', d.id, 'name', d.name) ORDER BY d.id) FILTER (WHERE d.id IS NOT NULL), '[]') AS departments
        FROM hospitals h LEFT JOIN hospital_departments d ON d.hospital_id = h.id AND d.active
       WHERE h.active GROUP BY h.id ORDER BY h.name`);
  });

  app.post('/api/hospitals', { preHandler: guard(...CATALOG_ADMIN) }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(3).max(200), address: z.string().max(300).nullish(), phone: z.string().max(50).nullish(),
      departments: z.array(z.string().trim().min(2).max(120)).max(50).default(['Khoa Cấp cứu']),
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      const h = await one(tx, 'INSERT INTO hospitals(name, address, phone) VALUES ($1,$2,$3) RETURNING *', [b.name, b.address ?? null, b.phone ?? null]);
      for (const d of b.departments) await tx.query('INSERT INTO hospital_departments(hospital_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [h.id, d]);
      await audit(tx, 'system', actorOf(req), 'hospital.created', 'hospital', String(h.id), b);
      return h;
    });
  });

  app.patch('/api/hospitals/:id', { preHandler: guard(...CATALOG_ADMIN) }, async (req) => {
    const id = z.object({ id: z.coerce.number().int() }).parse(req.params).id;
    const b = z.object({ address: z.string().max(300).nullish(), phone: z.string().max(50).nullish(), active: z.boolean().optional() }).parse(req.body);
    const h = await one(pool, `UPDATE hospitals SET address = COALESCE($2, address), phone = COALESCE($3, phone), active = COALESCE($4, active)
                               WHERE id = $1 RETURNING *`, [id, b.address ?? null, b.phone ?? null, b.active ?? null]);
    if (!h) throw new HttpError(404, 'Không tìm thấy bệnh viện');
    await withTx(pool, (tx) => audit(tx, 'system', actorOf(req), 'hospital.updated', 'hospital', String(id), b));
    return h;
  });

  app.post('/api/hospitals/:id/departments', { preHandler: guard(...CATALOG_ADMIN) }, async (req) => {
    const id = z.object({ id: z.coerce.number().int() }).parse(req.params).id;
    const b = z.object({ name: z.string().trim().min(2).max(120) }).parse(req.body);
    const d = await one(pool, `INSERT INTO hospital_departments(hospital_id, name) VALUES ($1,$2)
                               ON CONFLICT (hospital_id, name) DO UPDATE SET active = true RETURNING *`, [id, b.name]);
    await withTx(pool, (tx) => audit(tx, 'system', actorOf(req), 'hospital.department_added', 'hospital', String(id), b));
    return d;
  });

  app.delete('/api/hospitals/:id/departments/:deptId', { preHandler: guard(...CATALOG_ADMIN) }, async (req) => {
    const p = z.object({ id: z.coerce.number().int(), deptId: z.coerce.number().int() }).parse(req.params);
    await pool.query('UPDATE hospital_departments SET active = false WHERE id = $1 AND hospital_id = $2', [p.deptId, p.id]);
    await withTx(pool, (tx) => audit(tx, 'system', actorOf(req), 'hospital.department_removed', 'hospital', String(p.id), { deptId: p.deptId }));
    return { ok: true };
  });

  /* ---------- ICD-10: gõ mã hiện tên bệnh ---------- */
  app.get('/api/icd10', { preHandler: guard() }, async (req) => {
    const q = z.object({ q: z.string().trim().max(100).default('') }).parse(req.query).q;
    if (!q) return [];
    if (/^[A-Za-z][0-9]/.test(q)) {
      return many(pool, `SELECT code, name FROM icd10 WHERE active AND code ILIKE $1 ORDER BY length(code), code LIMIT 20`, [`${q.replace(/[%_]/g, '')}%`]);
    }
    return many(pool, `SELECT code, name FROM icd10 WHERE active AND lower(name) LIKE '%' || lower($1) || '%' ORDER BY length(name), code LIMIT 20`, [q.replace(/[%_]/g, '')]);
  });

  app.get('/api/icd10/:code', { preHandler: guard() }, async (req) => {
    const code = z.object({ code: z.string().max(10) }).parse(req.params).code.toUpperCase();
    // Gõ "E10.2" vẫn ra mã có dấu †/* như "E10.2†"; có thể gõ thiếu dấu chấm ("I219")
    const dotted = /^[A-Z][0-9]{3,}$/.test(code) ? `${code.slice(0, 3)}.${code.slice(3)}` : code;
    const r = await one(pool, `SELECT code, name, active FROM icd10
                                WHERE code IN ($1, $1 || '†', $1 || '*', $1 || '+')
                                ORDER BY code = $1 DESC, active DESC LIMIT 1`, [dotted]);
    if (!r) throw new HttpError(404, `Không có mã ${code} trong danh mục ICD-10`);
    return r;
  });

  app.get('/api/icd10-stats', { preHandler: guard() }, async () => one(pool, 'SELECT count(*)::int AS total FROM icd10 WHERE active'));

  /* ---------- Thuốc và kho theo số lô ---------- */
  app.get('/api/drugs', { preHandler: guard() }, async () => many(pool, 'SELECT * FROM drugs WHERE active ORDER BY name'));

  app.get('/api/stock', { preHandler: guard(...STOCK_VIEW) }, async (req) => {
    const q = z.object({ stationId: z.string().optional() }).parse(req.query);
    return many(pool, `
      SELECT l.id, l.station_id, s.name AS station_name, l.lot, l.expiry, l.qty, l.supplier, l.received_at,
             d.id AS drug_id, d.name AS drug_name, d.unit
        FROM stock_lots l JOIN drugs d ON d.id = l.drug_id JOIN stations s ON s.id = l.station_id
       WHERE ($1::text IS NULL OR l.station_id = $1)
       ORDER BY s.id, d.name, l.expiry`, [q.stationId ?? null]);
  });

  app.get('/api/stock/vehicle/:vehicleId', { preHandler: guard(...STOCK_VIEW) }, async (req) => {
    const vehicleId = z.object({ vehicleId: z.string().min(1) }).parse(req.params).vehicleId;
    return lotsForVehicle(pool, vehicleId);
  });

  app.post('/api/stock/receive', { preHandler: guard(...CATALOG_ADMIN) }, async (req) => {
    const b = z.object({
      stationId: z.string().min(1), drugId: z.number().int().nullish(), drugName: z.string().max(200).nullish(), unit: z.string().max(30).nullish(),
      lot: z.string().trim().min(1).max(60), expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), qty: z.number().positive().max(100000),
      supplier: z.string().max(200).nullish(),
    }).parse(req.body);
    return withTx(pool, (tx) => receiveStock(tx, actorOf(req), b));
  });

  app.post('/api/stock/adjust', { preHandler: guard(...CATALOG_ADMIN) }, async (req) => {
    const b = z.object({ lotId: z.string().uuid(), delta: z.number().refine((x) => x !== 0), note: z.string().trim().min(2).max(300) }).parse(req.body);
    await withTx(pool, (tx) => adjustStock(tx, actorOf(req), b.lotId, b.delta, b.note));
    return { ok: true };
  });
}
