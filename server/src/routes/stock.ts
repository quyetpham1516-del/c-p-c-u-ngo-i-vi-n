import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import { importParWorkbook, ITEM_KIND, parWorkbook } from '../items.js';
import { centralStation } from '../inventory.js';
import {
  caseRestockList, createDisposal, createStocktake, pendingRestock, restockForTransfer, decideVoucher, lotsForVehicle, orderSuggestion, receiveStock, restockVehicle, returnFromVehicle,
  STOCK_APPROVERS, stockAlerts, transferBetweenStations, vehicleParStatus,
} from '../stock.js';

const STOCK_VIEW: Role[] = ['crew', 'dispatcher', 'supervisor', 'qa', 'admin', 'pharmacist', 'director'];
const STOCK_MANAGE: Role[] = ['pharmacist', 'supervisor', 'admin'];
/** Không xem kho tổng: điều phối viên chỉ cần cơ số xe, kho điểm */
const NO_CENTRAL: Role[] = ['dispatcher', 'calltaker'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const lines = z.array(z.object({ lotId: z.string().uuid(), qty: z.number().positive().max(100000) })).min(1).max(200);
const opt = z.string().trim().max(300).nullish();

export function registerStock(app: FastifyInstance, { pool }: Ctx) {
  /** Kíp chỉ thao tác cơ số trên xe mình đang đăng nhập ca */
  async function assertVehicle(req: FastifyRequest, vehicleId: string) {
    if (req.user.role !== 'crew') {
      if (!STOCK_MANAGE.includes(req.user.role)) throw new HttpError(403, 'Không có quyền thao tác kho');
      return;
    }
    const s = await one(pool, 'SELECT 1 FROM crew_shifts WHERE user_id = $1 AND vehicle_id = $2 AND ended_at IS NULL', [req.user.id, vehicleId]);
    if (!s) throw new HttpError(403, 'Bạn không đăng nhập ca trên xe này');
  }
  const vehicleParam = (req: FastifyRequest) => z.object({ vehicleId: z.string().min(1).max(40) }).parse(req.params).vehicleId;

  /** Tồn kho: kho điểm, cơ số trên xe, hoặc cả hai */
  app.get('/api/stock', { preHandler: guard(...STOCK_VIEW) }, async (req) => {
    const q = z.object({ stationId: z.string().optional(), vehicleId: z.string().optional(), place: z.enum(['kho', 'xe', 'all']).default('kho') }).parse(req.query);
    const hidden = NO_CENTRAL.includes(req.user.role) ? await centralStation(pool) : null;
    if (hidden && q.stationId === hidden) throw new HttpError(403, 'Điều phối viên không xem kho tổng');
    return many(pool, `
      SELECT l.id, l.station_id, s.name AS station_name, l.vehicle_id, l.lot, l.expiry, l.qty, l.supplier, l.received_at,
             d.id AS drug_id, d.name AS drug_name, d.unit, d.controlled, (l.expiry - vn_today()) AS days_left
        FROM stock_lots l JOIN drugs d ON d.id = l.drug_id JOIN stations s ON s.id = l.station_id
       WHERE ($1::text IS NULL OR l.station_id = $1)
         AND ($2::text IS NULL OR l.vehicle_id = $2)
         AND ($3 = 'all' OR ($3 = 'kho' AND l.vehicle_id IS NULL) OR ($3 = 'xe' AND l.vehicle_id IS NOT NULL))
         AND (l.qty > 0 OR l.received_at > now() - interval '30 days')
         AND ($4::text IS NULL OR l.station_id <> $4)
       ORDER BY s.id, l.vehicle_id NULLS FIRST, d.name, l.expiry`, [q.stationId ?? null, q.vehicleId ?? null, q.vehicleId ? 'all' : q.place, hidden]);
  });

  /** Lô dùng được cho ePCR của xe: cơ số trên xe trước, kho điểm sau */
  app.get('/api/stock/vehicle/:vehicleId', { preHandler: guard(...STOCK_VIEW) }, async (req) =>
    lotsForVehicle(pool, vehicleParam(req), (req.query as { all?: string }).all === '1'));

  /** Phiếu đã ký của xe còn chờ bù cơ số sau ca */
  app.get('/api/stock/vehicle/:vehicleId/pending-restock', { preHandler: guard(...STOCK_VIEW) }, async (req) => pendingRestock(pool, vehicleParam(req)));

  /** Danh sách bù sau ca: từng thứ đã dùng trên xe; điều dưỡng bù rồi bấm xác nhận */
  app.get('/api/transfers/:id/restock', { preHandler: guard(...STOCK_VIEW) }, async (req) =>
    caseRestockList(pool, z.object({ id: z.string().uuid() }).parse(req.params).id));

  app.post('/api/transfers/:id/restock', { preHandler: guard('crew', ...STOCK_MANAGE) }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ witness: opt, items: z.array(z.object({ drugId: z.number().int(), qty: z.number().positive().max(100000) })).max(300).optional() }).parse(req.body ?? {});
    const t = await one(pool, 'SELECT vehicle_id FROM transfers WHERE id = $1', [id]);
    if (!t?.vehicle_id) throw new HttpError(404, 'Không tìm thấy phiếu có gắn xe');
    await assertVehicle(req, t.vehicle_id);
    return withTx(pool, (tx) => restockForTransfer(tx, actorOf(req), id, b.witness, b.items));
  });

  app.get('/api/stock/vehicle/:vehicleId/par', { preHandler: guard(...STOCK_VIEW) }, async (req) => vehicleParStatus(pool, vehicleParam(req)));

  app.post('/api/stock/vehicle/:vehicleId/restock', { preHandler: guard('crew', ...STOCK_MANAGE) }, async (req) => {
    const vehicleId = vehicleParam(req);
    const b = z.object({ witness: opt }).parse(req.body ?? {});
    await assertVehicle(req, vehicleId);
    return withTx(pool, (tx) => restockVehicle(tx, actorOf(req), vehicleId, b.witness));
  });

  app.post('/api/stock/vehicle/:vehicleId/return', { preHandler: guard('crew', ...STOCK_MANAGE) }, async (req) => {
    const vehicleId = vehicleParam(req);
    const b = z.object({ lines, witness: opt, note: opt }).parse(req.body);
    await assertVehicle(req, vehicleId);
    return withTx(pool, (tx) => returnFromVehicle(tx, actorOf(req), vehicleId, b.lines, b.witness, b.note));
  });

  app.post('/api/stock/receive', { preHandler: guard(...STOCK_MANAGE) }, async (req) => {
    const b = z.object({
      stationId: z.string().min(1), drugId: z.number().int().nullish(), drugName: z.string().max(200).nullish(), unit: z.string().max(30).nullish(),
      lot: z.string().trim().max(60).nullish(), expiry: date.nullish(), qty: z.number().positive().max(100000), supplier: z.string().max(200).nullish(),
    }).parse(req.body);
    return withTx(pool, (tx) => receiveStock(tx, actorOf(req), b));
  });

  app.post('/api/stock/transfer', { preHandler: guard(...STOCK_MANAGE) }, async (req) => {
    const b = z.object({ fromStation: z.string().min(1), toStation: z.string().min(1), lines, witness: opt, note: opt }).parse(req.body);
    return withTx(pool, (tx) => transferBetweenStations(tx, actorOf(req), b.fromStation, b.toStation, b.lines, b.witness, b.note));
  });

  app.post('/api/stock/stocktake', { preHandler: guard(...STOCK_MANAGE) }, async (req) => {
    const b = z.object({
      stationId: z.string().min(1), vehicleId: z.string().nullish(), note: opt,
      lines: z.array(z.object({ lotId: z.string().uuid(), counted: z.number().min(0).max(100000) })).min(1).max(500),
    }).parse(req.body);
    return withTx(pool, (tx) => createStocktake(tx, actorOf(req), b));
  });

  app.post('/api/stock/disposal', { preHandler: guard(...STOCK_MANAGE) }, async (req) => {
    const b = z.object({ stationId: z.string().min(1), lines, note: z.string().trim().min(3).max(300), witness: opt }).parse(req.body);
    return withTx(pool, (tx) => createDisposal(tx, actorOf(req), b));
  });

  app.get('/api/stock/vouchers', { preHandler: guard(...STOCK_VIEW) }, async (req) => {
    const q = z.object({ status: z.string().optional(), stationId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return many(pool, `
      SELECT v.*, uc.full_name AS created_by_name, ud.full_name AS decided_by_name,
             (SELECT count(*)::int FROM stock_voucher_lines l WHERE l.voucher_id = v.id) AS line_count
        FROM stock_vouchers v JOIN users uc ON uc.id = v.created_by LEFT JOIN users ud ON ud.id = v.decided_by
       WHERE ($1::text IS NULL OR v.status = $1) AND ($2::text IS NULL OR v.station_id = $2 OR v.to_station_id = $2)
       ORDER BY v.created_at DESC LIMIT $3`, [q.status ?? null, q.stationId ?? null, q.limit]);
  });

  app.get('/api/stock/vouchers/:id', { preHandler: guard(...STOCK_VIEW) }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const v = await one(pool, `SELECT v.*, uc.full_name AS created_by_name, ud.full_name AS decided_by_name
                                 FROM stock_vouchers v JOIN users uc ON uc.id = v.created_by LEFT JOIN users ud ON ud.id = v.decided_by
                                WHERE v.id = $1`, [id]);
    if (!v) throw new HttpError(404, 'Không tìm thấy phiếu');
    const items = await many(pool, `SELECT vl.*, l.lot, l.expiry, l.vehicle_id, d.name AS drug_name, d.unit
                                      FROM stock_voucher_lines vl JOIN stock_lots l ON l.id = vl.lot_id JOIN drugs d ON d.id = l.drug_id
                                     WHERE vl.voucher_id = $1 ORDER BY d.name`, [id]);
    return { ...v, items };
  });

  app.post('/api/stock/vouchers/:id/decide', { preHandler: guard(...(STOCK_APPROVERS as Role[])) }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ approve: z.boolean(), note: opt }).parse(req.body);
    if (!b.approve && !b.note) throw new HttpError(400, 'Từ chối phải ghi lý do');
    await withTx(pool, (tx) => decideVoucher(tx, actorOf(req), id, b.approve, b.note));
    return { ok: true };
  });

  app.get('/api/stock/alerts', { preHandler: guard(...STOCK_VIEW) }, async (req) => {
    const q = z.object({ stationId: z.string().optional(), days: z.coerce.number().int().min(1).max(365).default(90) }).parse(req.query);
    const hidden = NO_CENTRAL.includes(req.user.role) ? await centralStation(pool) : null;
    if (hidden && q.stationId === hidden) throw new HttpError(403, 'Điều phối viên không xem kho tổng');
    const a = await stockAlerts(pool, q.stationId ?? null, q.days);
    if (!hidden) return a;
    const keep = (r: { station_id: string }) => r.station_id !== hidden;
    return { ...a, expired: a.expired.filter(keep), expiring: a.expiring.filter(keep), belowMin: a.belowMin.filter(keep) };
  });

  app.get('/api/stock/order-suggestion', { preHandler: guard(...STOCK_VIEW) }, async (req) => {
    const q = z.object({ stationId: z.string().min(1) }).parse(req.query);
    return orderSuggestion(pool, q.stationId);
  });

  /* ---------- Định mức kho điểm, cơ số chuẩn theo loại xe, thuộc tính thuốc ---------- */

  app.get('/api/stock/minimums', { preHandler: guard(...STOCK_VIEW) }, async (req) => {
    const q = z.object({ stationId: z.string().min(1) }).parse(req.query);
    return many(pool, `SELECT m.drug_id, d.name AS drug_name, d.unit, m.min_qty FROM stock_minimums m JOIN drugs d ON d.id = m.drug_id
                        WHERE m.station_id = $1 ORDER BY d.name`, [q.stationId]);
  });

  app.put('/api/stock/minimums', { preHandler: guard(...STOCK_MANAGE) }, async (req) => {
    const b = z.object({ stationId: z.string().min(1), drugId: z.number().int(), minQty: z.number().min(0).max(100000) }).parse(req.body);
    await withTx(pool, async (tx) => {
      if (b.minQty === 0) await tx.query('DELETE FROM stock_minimums WHERE station_id = $1 AND drug_id = $2', [b.stationId, b.drugId]);
      else {
        await tx.query(`INSERT INTO stock_minimums(station_id, drug_id, min_qty) VALUES ($1,$2,$3)
                        ON CONFLICT (station_id, drug_id) DO UPDATE SET min_qty = EXCLUDED.min_qty`, [b.stationId, b.drugId, b.minQty]);
      }
      await audit(tx, 'system', actorOf(req), 'stock.minimum_set', 'station', b.stationId, b);
    });
    return { ok: true };
  });

  app.get('/api/par-levels', { preHandler: guard(...STOCK_VIEW) }, async () =>
    many(pool, `SELECT p.vehicle_type, p.drug_id, d.name AS drug_name, d.unit, p.qty FROM par_levels p JOIN drugs d ON d.id = p.drug_id
                 ORDER BY p.vehicle_type, d.name`));

  app.put('/api/par-levels', { preHandler: guard('pharmacist', 'admin') }, async (req) => {
    const b = z.object({ vehicleType: z.string().min(1).max(10), drugId: z.number().int(), qty: z.number().min(0).max(10000) }).parse(req.body);
    await withTx(pool, async (tx) => {
      if (b.qty === 0) await tx.query('DELETE FROM par_levels WHERE vehicle_type = $1 AND drug_id = $2', [b.vehicleType, b.drugId]);
      else {
        await tx.query(`INSERT INTO par_levels(vehicle_type, drug_id, qty) VALUES ($1,$2,$3)
                        ON CONFLICT (vehicle_type, drug_id) DO UPDATE SET qty = EXCLUDED.qty`, [b.vehicleType, b.drugId, b.qty]);
      }
      await audit(tx, 'system', actorOf(req), 'stock.par_set', 'vehicle_type', b.vehicleType, b);
    });
    return { ok: true };
  });

  app.patch('/api/drugs/:id', { preHandler: guard('pharmacist', 'admin') }, async (req) => {
    const id = z.object({ id: z.coerce.number().int() }).parse(req.params).id;
    const b = z.object({ controlled: z.boolean().optional(), active: z.boolean().optional(), unit: z.string().trim().min(1).max(30).optional() }).parse(req.body);
    const d = await withTx(pool, async (tx) => {
      const r = await one(tx, `UPDATE drugs SET controlled = coalesce($2, controlled), active = coalesce($3, active), unit = coalesce($4, unit)
                               WHERE id = $1 RETURNING *`, [id, b.controlled ?? null, b.active ?? null, b.unit ?? null]);
      if (!r) throw new HttpError(404, 'Không tìm thấy thuốc');
      await audit(tx, 'system', actorOf(req), 'drug.updated', 'drug', String(id), b);
      return r;
    });
    return d;
  });

  /* ---------- Danh mục hàng hóa chia nhóm, cơ số chuẩn dạng Excel ---------- */

  app.get('/api/item-groups', { preHandler: guard() }, async () => many(pool, 'SELECT * FROM item_groups ORDER BY sort, name'));

  app.post('/api/item-groups', { preHandler: guard('pharmacist', 'admin') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(80), sort: z.number().int().min(0).max(1000).default(90) }).parse(req.body);
    const code = b.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    return withTx(pool, async (tx) => {
      const g = await one(tx, 'INSERT INTO item_groups(code, name, sort) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *', [code || `nhom_${Date.now()}`, b.name, b.sort]);
      if (!g) throw new HttpError(409, 'Nhóm này đã có');
      await audit(tx, 'system', actorOf(req), 'item_group.created', 'item_group', g.code, b);
      return g;
    });
  });

  app.get('/api/items', { preHandler: guard(...STOCK_VIEW, 'accountant') }, async (req) => {
    const q = z.object({ all: z.coerce.boolean().optional() }).parse(req.query);
    return many(pool, `SELECT d.*, d.sell_price::float AS sell_price, g.name AS group_name FROM drugs d JOIN item_groups g ON g.code = d.group_code
                        WHERE ($1 OR d.active) ORDER BY g.sort, d.name`, [q.all ?? false]);
  });

  const ItemBody = z.object({
    name: z.string().trim().min(2).max(200), unit: z.string().trim().min(1).max(30), kind: z.enum(Object.keys(ITEM_KIND) as [string, ...string[]]),
    groupCode: z.string().min(1).max(40), code: z.string().trim().max(40).nullish(), trackLot: z.boolean().optional(),
    billable: z.boolean().optional(), sellPrice: z.number().int().min(0).max(1e9).nullish(), controlled: z.boolean().optional(), active: z.boolean().optional(),
  });

  app.post('/api/items', { preHandler: guard('pharmacist', 'admin') }, async (req) => {
    const b = ItemBody.parse(req.body);
    return withTx(pool, async (tx) => {
      if (await one(tx, 'SELECT 1 FROM drugs WHERE lower(name) = lower($1)', [b.name])) throw new HttpError(409, 'Tên hàng đã có trong danh mục');
      const d = await one(tx, `INSERT INTO drugs(name, unit, kind, group_code, code, track_lot, billable, sell_price, controlled)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.name, b.unit, b.kind, b.groupCode, b.code || null, b.trackLot ?? ['thuoc', 'dich_truyen'].includes(b.kind), b.billable ?? false, b.sellPrice ?? null, b.controlled ?? false]);
      await audit(tx, 'system', actorOf(req), 'item.created', 'drug', String(d.id), b);
      return d;
    });
  });

  app.patch('/api/items/:id', { preHandler: guard('pharmacist', 'admin') }, async (req) => {
    const id = z.object({ id: z.coerce.number().int() }).parse(req.params).id;
    const b = ItemBody.partial().parse(req.body);
    const map: Record<string, string> = { name: 'name', unit: 'unit', kind: 'kind', groupCode: 'group_code', code: 'code', trackLot: 'track_lot', billable: 'billable', sellPrice: 'sell_price', controlled: 'controlled', active: 'active' };
    const keys = Object.keys(b).filter((k) => map[k]) as (keyof typeof b)[];
    if (!keys.length) throw new HttpError(400, 'Không có gì để sửa');
    return withTx(pool, async (tx) => {
      const d = await one(tx, `UPDATE drugs SET ${keys.map((k, i) => `${map[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
        [id, ...keys.map((k) => (k === 'code' ? (b.code || null) : b[k]))]);
      if (!d) throw new HttpError(404, 'Không tìm thấy mặt hàng');
      await audit(tx, 'system', actorOf(req), 'item.updated', 'drug', String(id), b);
      return d;
    });
  });

  app.get('/api/par-levels/excel', { preHandler: guard(...STOCK_VIEW) }, async (req, reply) => {
    const q = z.object({ types: z.string().max(200).optional() }).parse(req.query);
    const all = (await many(pool, 'SELECT DISTINCT type FROM vehicles ORDER BY type')).map((r) => r.type as string);
    const types = q.types ? q.types.split(',').map((t) => t.trim().toUpperCase()).filter((t) => all.includes(t)) : all;
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="co-so-xe-${types.join('-')}.xlsx"`);
    return reply.send(await parWorkbook(pool, types));
  });

  app.post('/api/par-levels/import', { preHandler: guard('pharmacist', 'admin'), bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const b = z.object({ file: z.string().min(10).max(8_000_000) }).parse(req.body);
    return withTx(pool, (tx) => importParWorkbook(tx, actorOf(req), Buffer.from(b.file, 'base64')));
  });
}
