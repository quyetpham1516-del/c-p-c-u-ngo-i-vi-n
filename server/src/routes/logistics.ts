import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import {
  addAsset, addCylinder, addReading, cancelPurchaseOrder, controlledLedger, createPurchaseOrder, cylinderEvent, decidePurchaseOrder, disposeAsset,
  issuePpe, listAssets, listCylinders, logisticsAlerts, O2_KIND, o2Alerts, POINT_DEFAULTS, PPE_SELECT, purchaseSuggestion, receivePurchaseOrder,
  STOCK_APPROVERS, tempAlerts,
} from '../logistics.js';

const ALL: Role[] = ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'];
const STOCK_VIEW: Role[] = ['crew', 'dispatcher', 'supervisor', 'qa', 'admin', 'pharmacist', 'director', 'accountant'];
const STOCK_MANAGE: Role[] = ['pharmacist', 'supervisor', 'admin'];
/** Bình oxy: kíp đo áp, gắn/tháo bình trên xe; kỹ thuật quản lý vỏ bình, kiểm định */
const O2_WORK: Role[] = ['crew', 'technician', 'pharmacist', 'supervisor', 'admin'];
const ASSET_VIEW: Role[] = ['accountant', 'director', 'admin', 'technician'];
const ASSET_MANAGE: Role[] = ['accountant', 'admin'];
const PPE_MANAGE: Role[] = ['hr', 'admin'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const opt = z.string().trim().max(300).nullish();
const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
const vnToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

export function registerLogistics(app: FastifyInstance, { pool }: Ctx) {
  app.get('/api/logistics/alerts', { preHandler: guard(...STOCK_VIEW, 'technician', 'hr') }, async (req) => {
    const q = z.object({ stationId: z.string().optional() }).parse(req.query);
    return logisticsAlerts(pool, q.stationId ?? null);
  });

  /* ---------- Mua hàng ---------- */

  app.get('/api/logistics/po', { preHandler: guard(...STOCK_VIEW) }, async (req) => {
    const q = z.object({ stationId: z.string().optional(), status: z.string().optional() }).parse(req.query);
    return many(pool, `
      SELECT o.*, o.total::float AS total, s.name AS supplier_name, uc.full_name AS created_by_name, ud.full_name AS decided_by_name, p.code AS proposal_code,
             (SELECT count(*)::int FROM purchase_order_lines l WHERE l.order_id = o.id) AS line_count
        FROM purchase_orders o JOIN qm_suppliers s ON s.id = o.supplier_id JOIN users uc ON uc.id = o.created_by
        LEFT JOIN users ud ON ud.id = o.decided_by LEFT JOIN proposals p ON p.id = o.proposal_id
       WHERE ($1::text IS NULL OR o.station_id = $1) AND ($2::text IS NULL OR o.status = $2)
       ORDER BY o.created_at DESC LIMIT 200`, [q.stationId ?? null, q.status ?? null]);
  });

  app.get('/api/logistics/po/suggest', { preHandler: guard(...STOCK_VIEW) }, async (req) => {
    const q = z.object({ stationId: z.string().min(1) }).parse(req.query);
    return purchaseSuggestion(pool, q.stationId);
  });

  /** Nhà cung cấp còn hợp tác và đề xuất chi mua sắm đã duyệt, để chọn khi lập đơn */
  app.get('/api/logistics/po/options', { preHandler: guard(...STOCK_MANAGE) }, async () => ({
    suppliers: await many(pool, `SELECT id, name, category, status FROM qm_suppliers WHERE status <> 'ngung' ORDER BY (category = 'thuoc_vat_tu') DESC, name`),
    proposals: await many(pool, `SELECT id, code, title, amount::float AS amount, status FROM proposals
                                  WHERE kind = 'mua_sam' AND status IN ('da_duyet', 'da_chi') ORDER BY created_at DESC LIMIT 50`),
  }));

  app.get('/api/logistics/po/:id', { preHandler: guard(...STOCK_VIEW) }, async (req) => {
    const id = idParam(req.params);
    const o = await one(pool, `SELECT o.*, o.total::float AS total, s.name AS supplier_name, uc.full_name AS created_by_name, ud.full_name AS decided_by_name
                                 FROM purchase_orders o JOIN qm_suppliers s ON s.id = o.supplier_id JOIN users uc ON uc.id = o.created_by
                                 LEFT JOIN users ud ON ud.id = o.decided_by WHERE o.id = $1`, [id]);
    if (!o) throw new HttpError(404, 'Không tìm thấy đơn đặt hàng');
    const [lines, receipts] = await Promise.all([
      many(pool, `SELECT l.id::int AS id, l.drug_id, d.name AS drug_name, d.unit, l.qty::float AS qty, l.unit_price::float AS unit_price, l.received_qty::float AS received_qty
                    FROM purchase_order_lines l JOIN drugs d ON d.id = l.drug_id WHERE l.order_id = $1 ORDER BY d.name`, [id]),
      many(pool, `SELECT r.id, r.code, r.invoice_no, r.received_at, u.full_name AS received_by_name,
                         (SELECT json_agg(json_build_object('drug', d.name, 'lot', sl.lot, 'expiry', sl.expiry, 'qty', gl.qty::float) ORDER BY d.name)
                            FROM goods_receipt_lines gl JOIN stock_lots sl ON sl.id = gl.lot_id JOIN drugs d ON d.id = sl.drug_id WHERE gl.receipt_id = r.id) AS items
                    FROM goods_receipts r JOIN users u ON u.id = r.received_by WHERE r.order_id = $1 ORDER BY r.received_at`, [id]),
    ]);
    return { ...o, lines, receipts };
  });

  app.post('/api/logistics/po', { preHandler: guard(...STOCK_MANAGE) }, async (req) => {
    const b = z.object({
      stationId: z.string().min(1), supplierId: z.string().uuid(), expectedOn: date.nullish(), note: opt, proposalId: z.string().uuid().nullish(),
      lines: z.array(z.object({ drugId: z.number().int(), qty: z.number().positive().max(100000), unitPrice: z.number().min(0).max(1e9) })).min(1).max(200),
    }).parse(req.body);
    return withTx(pool, (tx) => createPurchaseOrder(tx, actorOf(req), b));
  });

  app.post('/api/logistics/po/:id/decide', { preHandler: guard(...(STOCK_APPROVERS as Role[])) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ approve: z.boolean(), note: opt }).parse(req.body);
    if (!b.approve && !b.note) throw new HttpError(400, 'Từ chối phải ghi lý do');
    await withTx(pool, (tx) => decidePurchaseOrder(tx, actorOf(req), id, b.approve, b.note));
    return { ok: true };
  });

  app.post('/api/logistics/po/:id/cancel', { preHandler: guard(...STOCK_MANAGE, 'director') }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ note: z.string().trim().min(3).max(300) }).parse(req.body);
    await withTx(pool, (tx) => cancelPurchaseOrder(tx, actorOf(req), req.user.role, id, b.note));
    return { ok: true };
  });

  app.post('/api/logistics/po/:id/receive', { preHandler: guard(...STOCK_MANAGE) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({
      invoiceNo: z.string().trim().max(60).nullish(), note: opt,
      lines: z.array(z.object({ lineId: z.number().int(), lot: z.string().trim().min(1).max(60), expiry: date, qty: z.number().positive().max(100000) })).min(1).max(200),
    }).parse(req.body);
    return withTx(pool, (tx) => receivePurchaseOrder(tx, actorOf(req), id, b));
  });

  /* ---------- Sổ thuốc kiểm soát đặc biệt ---------- */

  app.get('/api/logistics/controlled-ledger', { preHandler: guard('pharmacist', 'supervisor', 'qa', 'admin', 'director') }, async (req) => {
    const q = z.object({ stationId: z.string().min(1), month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.query);
    const station = await one(pool, 'SELECT id, name FROM stations WHERE id = $1', [q.stationId]);
    if (!station) throw new HttpError(404, 'Không tìm thấy điểm');
    return { station, month: q.month, drugs: await controlledLedger(pool, q.stationId, q.month) };
  });

  app.patch('/api/logistics/drugs/:id/control-class', { preHandler: guard('pharmacist', 'admin') }, async (req) => {
    const id = z.object({ id: z.coerce.number().int() }).parse(req.params).id;
    const b = z.object({ controlClass: z.enum(['gay_nghien', 'huong_than', 'tien_chat']).nullable() }).parse(req.body);
    return withTx(pool, async (tx) => {
      // Có phân loại thì cũng bật "kiểm soát đặc biệt" để bắt buộc người chứng kiến khi xuất
      const d = await one(tx, `UPDATE drugs SET control_class = $2, controlled = CASE WHEN $2::text IS NULL THEN controlled ELSE true END
                               WHERE id = $1 RETURNING id, name, controlled, control_class`, [id, b.controlClass]);
      if (!d) throw new HttpError(404, 'Không tìm thấy thuốc');
      await audit(tx, 'system', actorOf(req), 'drug.control_class_set', 'drug', String(id), b);
      return d;
    });
  });

  /* ---------- Bình oxy ---------- */

  app.get('/api/logistics/o2', { preHandler: guard(...O2_WORK, 'qa', 'dispatcher', 'director') }, async (req) => {
    const q = z.object({ stationId: z.string().optional() }).parse(req.query);
    const [cylinders, alerts] = await Promise.all([listCylinders(pool, q.stationId ?? null), o2Alerts(pool, q.stationId ?? null)]);
    return { cylinders, alerts, kinds: O2_KIND };
  });

  app.post('/api/logistics/o2', { preHandler: guard('technician', 'pharmacist', 'supervisor', 'admin') }, async (req) => {
    const b = z.object({
      code: z.string().trim().min(1).max(40), sizeL: z.number().positive().max(100), stationId: z.string().min(1),
      fullBar: z.number().int().min(100).max(300).nullish(), pressureBar: z.number().int().min(0).max(300).nullish(),
      nextTestOn: date.nullish(), supplierId: z.string().uuid().nullish(), note: opt,
    }).parse(req.body);
    return withTx(pool, (tx) => addCylinder(tx, actorOf(req), b));
  });

  app.get('/api/logistics/o2/:id/events', { preHandler: guard(...O2_WORK, 'qa', 'director') }, async (req) =>
    many(pool, `SELECT e.*, e.pressure_bar::float AS pressure_bar, u.full_name AS user_name FROM o2_events e LEFT JOIN users u ON u.id = e.user_id
                 WHERE e.cylinder_id = $1 ORDER BY e.at DESC LIMIT 100`, [idParam(req.params)]));

  app.post('/api/logistics/o2/:id/event', { preHandler: guard(...O2_WORK) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({
      kind: z.enum(['do_ap', 'gan_xe', 've_kho', 'gui_nap', 'nhan_nap', 'kiem_dinh', 'hong', 'thanh_ly']),
      pressureBar: z.number().int().min(0).max(300).nullish(), vehicleId: z.string().max(40).nullish(), nextTestOn: date.nullish(), note: opt,
    }).parse(req.body);
    // Kíp chỉ đo áp, gắn/tháo bình, báo hỏng; gửi nạp, kiểm định, thanh lý do kỹ thuật/dược/trưởng ca
    if (req.user.role === 'crew' && !['do_ap', 'gan_xe', 've_kho', 'hong'].includes(b.kind)) throw new HttpError(403, 'Kíp chỉ đo áp, gắn hoặc tháo bình, báo hỏng');
    return withTx(pool, (tx) => cylinderEvent(tx, actorOf(req), id, b));
  });

  /* ---------- Nhiệt độ bảo quản ---------- */

  app.get('/api/logistics/storage', { preHandler: guard(...STOCK_VIEW, 'ipc') }, async (req) => {
    const q = z.object({ stationId: z.string().optional() }).parse(req.query);
    const [points, alerts] = await Promise.all([
      many(pool, `SELECT p.*, p.min_c::float AS min_c, p.max_c::float AS max_c, p.max_humidity::float AS max_humidity,
                         r.at AS last_at, r.temp_c::float AS last_temp, r.humidity::float AS last_humidity, r.out_of_range AS last_out
                    FROM storage_points p
                    LEFT JOIN LATERAL (SELECT * FROM temp_readings x WHERE x.point_id = p.id ORDER BY x.at DESC LIMIT 1) r ON true
                   WHERE p.active AND ($1::text IS NULL OR p.station_id = $1) ORDER BY p.station_id, p.name`, [q.stationId ?? null]),
      tempAlerts(pool, q.stationId ?? null),
    ]);
    return { points, alerts, defaults: POINT_DEFAULTS };
  });

  app.post('/api/logistics/storage', { preHandler: guard(...STOCK_MANAGE) }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(100), kind: z.enum(['kho', 'tu_thuoc', 'tu_lanh', 'xe']), stationId: z.string().min(1), vehicleId: z.string().max(40).nullish(),
      minC: z.number().min(-30).max(40).nullish(), maxC: z.number().min(-20).max(50).nullish(), maxHumidity: z.number().min(10).max(100).nullish(),
    }).parse(req.body);
    const d = POINT_DEFAULTS[b.kind];
    const minC = b.minC ?? d.min; const maxC = b.maxC ?? d.max;
    if (minC >= maxC) throw new HttpError(400, 'Nhiệt độ thấp nhất phải nhỏ hơn cao nhất');
    return withTx(pool, async (tx) => {
      const dup = await one(tx, 'SELECT 1 FROM storage_points WHERE station_id = $1 AND name = $2', [b.stationId, b.name]);
      if (dup) throw new HttpError(409, 'Tên nơi bảo quản đã có ở điểm này');
      const p = await one(tx, `INSERT INTO storage_points(name, kind, station_id, vehicle_id, min_c, max_c, max_humidity) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.name, b.kind, b.stationId, b.vehicleId ?? null, minC, maxC, b.maxHumidity === undefined ? d.hum : b.maxHumidity]);
      await audit(tx, 'system', actorOf(req), 'logistics.storage_added', 'storage_point', p.id, { name: b.name, minC, maxC });
      return p;
    });
  });

  app.delete('/api/logistics/storage/:id', { preHandler: guard(...STOCK_MANAGE) }, async (req) => {
    const id = idParam(req.params);
    await withTx(pool, async (tx) => {
      const r = await one(tx, 'UPDATE storage_points SET active = false WHERE id = $1 RETURNING name', [id]);
      if (!r) throw new HttpError(404, 'Không tìm thấy nơi bảo quản');
      await audit(tx, 'system', actorOf(req), 'logistics.storage_retired', 'storage_point', id, { name: r.name });
    });
    return { ok: true };
  });

  app.get('/api/logistics/storage/:id/readings', { preHandler: guard(...STOCK_VIEW, 'ipc') }, async (req) => {
    const id = idParam(req.params);
    const q = z.object({ days: z.coerce.number().int().min(1).max(366).default(31) }).parse(req.query);
    return many(pool, `SELECT r.id, r.at, r.temp_c::float AS temp_c, r.humidity::float AS humidity, r.out_of_range, r.action, r.ack_at, r.ack_note,
                              u.full_name AS user_name, a.full_name AS ack_by_name
                         FROM temp_readings r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users a ON a.id = r.ack_by
                        WHERE r.point_id = $1 AND r.at > now() - make_interval(days => $2) ORDER BY r.at DESC`, [id, q.days]);
  });

  app.post('/api/logistics/storage/:id/readings', { preHandler: guard('crew', ...STOCK_MANAGE) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ tempC: z.number().min(-40).max(60), humidity: z.number().min(0).max(100).nullish(), action: opt }).parse(req.body);
    return withTx(pool, (tx) => addReading(tx, actorOf(req), id, b));
  });

  app.post('/api/logistics/readings/:id/ack', { preHandler: guard(...STOCK_MANAGE) }, async (req) => {
    const id = z.object({ id: z.coerce.number().int() }).parse(req.params).id;
    const b = z.object({ note: z.string().trim().min(3).max(300) }).parse(req.body);
    await withTx(pool, async (tx) => {
      const r = await one(tx, `UPDATE temp_readings SET ack_by = $2, ack_at = now(), ack_note = $3 WHERE id = $1 AND out_of_range AND ack_at IS NULL RETURNING point_id`,
        [id, req.user.id, b.note]);
      if (!r) throw new HttpError(409, 'Số đo không ngoài ngưỡng hoặc đã được xem xét');
      await audit(tx, 'system', actorOf(req), 'logistics.temp_ack', 'storage_point', r.point_id, { readingId: id, note: b.note });
    });
    return { ok: true };
  });

  /* ---------- Tài sản cố định ---------- */

  app.get('/api/logistics/assets', { preHandler: guard(...ASSET_VIEW) }, async (req) => {
    const q = z.object({ asOf: date.optional(), stationId: z.string().optional() }).parse(req.query);
    return listAssets(pool, q.asOf ?? vnToday(), q.stationId ?? null);
  });

  app.post('/api/logistics/assets', { preHandler: guard(...ASSET_MANAGE) }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(200), category: z.enum(['xe', 'thiet_bi_y_te', 'cntt', 'nha_cua', 'noi_that', 'khac']),
      stationId: z.string().nullish(), vehicleId: z.string().nullish(), equipmentId: z.string().uuid().nullish(),
      acquiredOn: date, cost: z.number().int().positive().max(1e12), lifeMonths: z.number().int().min(1).max(600), salvage: z.number().int().min(0).nullish(), note: opt,
    }).parse(req.body);
    return withTx(pool, (tx) => addAsset(tx, actorOf(req), b));
  });

  app.post('/api/logistics/assets/:id/dispose', { preHandler: guard(...ASSET_MANAGE, 'director') }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ disposedOn: date, note: z.string().trim().min(3).max(300) }).parse(req.body);
    await withTx(pool, (tx) => disposeAsset(tx, actorOf(req), id, b));
    return { ok: true };
  });

  /* ---------- Đồng phục, bảo hộ lao động ---------- */

  app.get('/api/logistics/ppe/items', { preHandler: guard(...ALL) }, async () =>
    many(pool, 'SELECT * FROM ppe_items WHERE active ORDER BY kind, name'));

  app.post('/api/logistics/ppe/items', { preHandler: guard(...PPE_MANAGE) }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(['dong_phuc', 'bao_ho']), unit: z.string().trim().min(1).max(20), replaceMonths: z.number().int().min(1).max(120).nullish() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const r = await one(tx, `INSERT INTO ppe_items(name, kind, unit, replace_months) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING RETURNING *`,
        [b.name, b.kind, b.unit, b.replaceMonths ?? null]);
      if (!r) throw new HttpError(409, 'Loại này đã có');
      await audit(tx, 'system', actorOf(req), 'logistics.ppe_item_added', 'ppe_item', String(r.id), b);
      return r;
    });
  });

  app.get('/api/logistics/ppe/people', { preHandler: guard(...PPE_MANAGE) }, async () =>
    many(pool, 'SELECT id, full_name, title, role FROM users WHERE active ORDER BY full_name'));

  app.get('/api/logistics/ppe', { preHandler: guard(...PPE_MANAGE, 'director') }, async (req) => {
    const q = z.object({ userId: z.string().uuid().optional(), due: z.coerce.boolean().optional() }).parse(req.query);
    return many(pool, `${PPE_SELECT}
      WHERE ($1::uuid IS NULL OR i.user_id = $1)
        AND (NOT $2 OR (u.active AND i.returned_on IS NULL AND i.due_on <= vn_today() + 30
             AND NOT EXISTS (SELECT 1 FROM ppe_issues j WHERE j.user_id = i.user_id AND j.item_id = i.item_id AND j.issued_on > i.issued_on)))
      ORDER BY i.issued_on DESC, u.full_name LIMIT 500`, [q.userId ?? null, q.due ?? false]);
  });

  app.post('/api/logistics/ppe', { preHandler: guard(...PPE_MANAGE) }, async (req) => {
    const b = z.object({ userId: z.string().uuid(), itemId: z.number().int(), qty: z.number().int().min(1).max(50).default(1), size: z.string().max(20).nullish(), issuedOn: date, note: opt }).parse(req.body);
    return withTx(pool, (tx) => issuePpe(tx, actorOf(req), b));
  });

  app.post('/api/logistics/ppe/:id/return', { preHandler: guard(...PPE_MANAGE) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ returnedOn: date, note: opt }).parse(req.body);
    await withTx(pool, async (tx) => {
      const r = await one(tx, `UPDATE ppe_issues SET returned_on = $2, note = coalesce($3, note) WHERE id = $1 AND returned_on IS NULL RETURNING user_id`, [id, b.returnedOn, b.note ?? null]);
      if (!r) throw new HttpError(409, 'Không tìm thấy lần cấp chưa trả');
      await audit(tx, 'system', actorOf(req), 'logistics.ppe_returned', 'user', r.user_id, { issueId: id });
    });
    return { ok: true };
  });

  /** Nhân viên xem đồ đã được cấp và bấm xác nhận đã nhận */
  app.get('/api/logistics/ppe/me', { preHandler: guard(...ALL) }, async (req) =>
    many(pool, `${PPE_SELECT} WHERE i.user_id = $1 ORDER BY i.issued_on DESC`, [req.user.id]));

  app.post('/api/logistics/ppe/:id/confirm', { preHandler: guard(...ALL) }, async (req) => {
    const id = idParam(req.params);
    const r = await one(pool, 'UPDATE ppe_issues SET received_at = now() WHERE id = $1 AND user_id = $2 AND received_at IS NULL RETURNING id', [id, req.user.id]);
    if (!r) throw new HttpError(409, 'Không tìm thấy lần cấp chưa xác nhận của bạn');
    return { ok: true };
  });
}
