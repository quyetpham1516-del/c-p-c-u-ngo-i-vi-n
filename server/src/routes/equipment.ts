import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import {
  createEquipment, createInstrumentSet, equipmentDue, equipmentEvent, equipmentGaps, finishSterilization, markSetUsed, startSterilization,
} from '../equipment.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';

const EQ_MANAGE: Role[] = ['technician', 'supervisor', 'admin'];
const STERILE: Role[] = ['ipc', 'technician', 'supervisor', 'admin'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const opt = z.string().trim().max(500).nullish();

export function registerEquipment(app: FastifyInstance, { pool, hub }: Ctx) {
  const pushVehicle = async (id: string | null | undefined) => { if (id) await hub.publish({ type: 'vehicle', id }); };

  async function crewVehicle(req: FastifyRequest): Promise<string | null> {
    const s = await one(pool, 'SELECT vehicle_id FROM crew_shifts WHERE user_id = $1 AND ended_at IS NULL', [req.user.id]);
    return s?.vehicle_id ?? null;
  }

  /* ---------- Danh mục loại thiết bị, thiết bị bắt buộc theo loại xe ---------- */

  app.get('/api/equipment-types', { preHandler: guard() }, async () =>
    many(pool, `SELECT t.*, coalesce(json_object_agg(r.vehicle_type, r.qty) FILTER (WHERE r.vehicle_type IS NOT NULL), '{}') AS required
                  FROM equipment_types t LEFT JOIN vehicle_required_equipment r ON r.equipment_type_id = t.id
                 GROUP BY t.id ORDER BY t.name`));

  const typeBody = z.object({
    name: z.string().trim().min(2).max(120), maintenanceDays: z.number().int().min(1).max(3650).nullish(),
    inspectionDays: z.number().int().min(1).max(3650).nullish(), calibrationDays: z.number().int().min(1).max(3650).nullish(),
    active: z.boolean().optional(),
  });

  app.post('/api/equipment-types', { preHandler: guard('technician', 'admin') }, async (req) => {
    const b = typeBody.parse(req.body);
    return withTx(pool, async (tx) => {
      const t = await one(tx, `INSERT INTO equipment_types(name, maintenance_days, inspection_days, calibration_days) VALUES ($1,$2,$3,$4)
                               ON CONFLICT (name) DO NOTHING RETURNING *`, [b.name, b.maintenanceDays ?? null, b.inspectionDays ?? null, b.calibrationDays ?? null]);
      if (!t) throw new HttpError(409, 'Loại thiết bị đã có');
      await audit(tx, 'system', actorOf(req), 'equipment_type.created', 'equipment_type', String(t.id), b);
      return t;
    });
  });

  app.patch('/api/equipment-types/:id', { preHandler: guard('technician', 'admin') }, async (req) => {
    const id = z.object({ id: z.coerce.number().int() }).parse(req.params).id;
    const b = typeBody.partial().parse(req.body);
    return withTx(pool, async (tx) => {
      const t = await one(tx, `UPDATE equipment_types SET name = coalesce($2, name),
                                      maintenance_days = CASE WHEN $6 THEN $3 ELSE maintenance_days END,
                                      inspection_days = CASE WHEN $7 THEN $4 ELSE inspection_days END,
                                      calibration_days = CASE WHEN $8 THEN $5 ELSE calibration_days END,
                                      active = coalesce($9, active)
                                WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.maintenanceDays ?? null, b.inspectionDays ?? null, b.calibrationDays ?? null,
        'maintenanceDays' in b, 'inspectionDays' in b, 'calibrationDays' in b, b.active ?? null]);
      if (!t) throw new HttpError(404, 'Không tìm thấy loại thiết bị');
      await audit(tx, 'system', actorOf(req), 'equipment_type.updated', 'equipment_type', String(id), b);
      return t;
    });
  });

  app.put('/api/vehicle-required-equipment', { preHandler: guard('technician', 'admin') }, async (req) => {
    const b = z.object({ vehicleType: z.string().min(1).max(10), typeId: z.number().int(), qty: z.number().int().min(0).max(20) }).parse(req.body);
    await withTx(pool, async (tx) => {
      if (b.qty === 0) await tx.query('DELETE FROM vehicle_required_equipment WHERE vehicle_type = $1 AND equipment_type_id = $2', [b.vehicleType, b.typeId]);
      else {
        await tx.query(`INSERT INTO vehicle_required_equipment(vehicle_type, equipment_type_id, qty) VALUES ($1,$2,$3)
                        ON CONFLICT (vehicle_type, equipment_type_id) DO UPDATE SET qty = EXCLUDED.qty`, [b.vehicleType, b.typeId, b.qty]);
      }
      await audit(tx, 'system', actorOf(req), 'equipment.required_set', 'vehicle_type', b.vehicleType, b);
    });
    await hub.publish({ type: 'vehicle', id: '*' });
    return { ok: true };
  });

  /* ---------- Thiết bị theo số seri ---------- */

  app.get('/api/equipment', { preHandler: guard() }, async (req) => {
    const q = z.object({ stationId: z.string().optional(), vehicleId: z.string().optional(), status: z.string().optional(), all: z.string().optional() }).parse(req.query);
    return many(pool, `
      SELECT e.*, t.name AS type_name,
             (e.next_inspection < vn_today() OR e.next_calibration < vn_today()) AS overdue,
             (e.next_maintenance < vn_today()) AS maintenance_overdue
        FROM equipment e JOIN equipment_types t ON t.id = e.type_id
       WHERE ($1::text IS NULL OR e.station_id = $1) AND ($2::text IS NULL OR e.vehicle_id = $2)
         AND ($3::text IS NULL OR e.status = $3) AND ($4 OR e.status <> 'thanh_ly')
       ORDER BY e.station_id, e.vehicle_id NULLS LAST, t.name, e.serial`, [q.stationId ?? null, q.vehicleId ?? null, q.status ?? null, q.all === '1']);
  });

  app.post('/api/equipment', { preHandler: guard(...EQ_MANAGE) }, async (req) => {
    const b = z.object({
      typeId: z.number().int(), serial: z.string().trim().min(2).max(80), model: opt, stationId: z.string().min(1), vehicleId: z.string().nullish(),
      nextMaintenance: date.nullish(), nextInspection: date.nullish(), nextCalibration: date.nullish(), note: opt,
    }).parse(req.body);
    const e = await withTx(pool, (tx) => createEquipment(tx, actorOf(req), b));
    await pushVehicle(e.vehicle_id);
    return e;
  });

  app.get('/api/equipment/due', { preHandler: guard() }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(0).max(365).default(30), stationId: z.string().optional() }).parse(req.query);
    return equipmentDue(pool, q.days, q.stationId ?? null);
  });

  /** Xe nào đang thiếu thiết bị bắt buộc (dùng cho bảng đội xe và trang thiết bị) */
  app.get('/api/equipment/readiness', { preHandler: guard() }, async () => {
    const [vehicles, gaps] = await Promise.all([many(pool, 'SELECT id, type, station_id, status FROM vehicles ORDER BY id'), equipmentGaps(pool)]);
    return vehicles.map((v) => ({ ...v, ok: !(gaps[v.id]?.length), gaps: gaps[v.id] ?? [] }));
  });

  /* ---------- Mã QR: nhãn dán trên thiết bị, bộ dụng cụ; quét bằng điện thoại mở trang /tb/<mã> ---------- */

  app.get('/api/qr/:code', { preHandler: guard() }, async (req) => {
    const { code } = z.object({ code: z.string().trim().min(3).max(40) }).parse(req.params);
    const e = await one(pool, 'SELECT id FROM equipment WHERE qr_code = $1 OR upper(asset_code) = upper($1) OR serial = $1', [code]);
    if (e) return { kind: 'equipment', id: e.id };
    const s = await one(pool, 'SELECT id FROM instrument_sets WHERE qr_code = $1 OR upper(code) = upper($1)', [code]);
    if (s) return { kind: 'instrument_set', id: s.id };
    throw new HttpError(404, 'Mã không khớp thiết bị hay bộ dụng cụ nào');
  });

  app.get('/api/equipment/:id', { preHandler: guard() }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const e = await one(pool, `
      SELECT e.*, t.name AS type_name, st.name AS station_name,
             (e.next_inspection < vn_today() OR e.next_calibration < vn_today()) AS overdue, (e.next_maintenance < vn_today()) AS maintenance_overdue,
             (SELECT max(at) FROM equipment_events ev WHERE ev.equipment_id = e.id AND ev.kind = 'kiem_tra') AS last_check
        FROM equipment e JOIN equipment_types t ON t.id = e.type_id JOIN stations st ON st.id = e.station_id WHERE e.id = $1`, [id]);
    if (!e) throw new HttpError(404, 'Không tìm thấy thiết bị');
    const crewVehicleId = req.user.role === 'crew' ? await crewVehicle(req) : null;
    return { ...e, onMyVehicle: !!crewVehicleId && crewVehicleId === e.vehicle_id };
  });

  app.get('/api/instrument-sets/:id', { preHandler: guard() }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const s = await one(pool, `
      SELECT s.*, st.name AS station_name, (s.status = 'san_sang' AND s.sterile_until < vn_today()) AS sterile_expired, i.code AS last_incident_code
        FROM instrument_sets s JOIN stations st ON st.id = s.station_id LEFT JOIN incidents i ON i.id = s.last_incident_id WHERE s.id = $1`, [id]);
    if (!s) throw new HttpError(404, 'Không tìm thấy bộ dụng cụ');
    const crewVehicleId = req.user.role === 'crew' ? await crewVehicle(req) : null;
    return { ...s, onMyVehicle: !!crewVehicleId && crewVehicleId === s.vehicle_id };
  });

  /** Sửa thông tin thiết bị: model, ghi chú, hướng dẫn sử dụng hiện khi quét tem */
  app.patch('/api/equipment/:id', { preHandler: guard(...EQ_MANAGE) }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ model: opt, note: opt, manualUrl: z.string().url().max(1000).nullish(), manualText: z.string().max(4000).nullish() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const e = await one(tx, `UPDATE equipment SET model = CASE WHEN $2 THEN $3 ELSE model END, note = CASE WHEN $4 THEN $5 ELSE note END,
                                      manual_url = CASE WHEN $6 THEN $7 ELSE manual_url END, manual_text = CASE WHEN $8 THEN $9 ELSE manual_text END
                                WHERE id = $1 RETURNING *`,
      [id, 'model' in b, b.model ?? null, 'note' in b, b.note ?? null, 'manualUrl' in b, b.manualUrl ?? null, 'manualText' in b, b.manualText ?? null]);
      if (!e) throw new HttpError(404, 'Không tìm thấy thiết bị');
      await audit(tx, 'system', actorOf(req), 'equipment.updated', 'equipment', id, b);
      return e;
    });
  });

  /** Cấp mã QR mới khi nhãn bị mất hoặc lộ; nhãn cũ hết tác dụng */
  app.post('/api/qr/reissue', { preHandler: guard(...EQ_MANAGE, 'ipc') }, async (req) => {
    const b = z.object({ kind: z.enum(['equipment', 'instrument_set']), id: z.string().uuid() }).parse(req.body);
    if (b.kind === 'equipment' && req.user.role === 'ipc') throw new HttpError(403, 'Không có quyền');
    const table = b.kind === 'equipment' ? 'equipment' : 'instrument_sets';
    return withTx(pool, async (tx) => {
      const r = await one(tx, `UPDATE ${table} SET qr_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 16) WHERE id = $1 RETURNING id, qr_code`, [b.id]);
      if (!r) throw new HttpError(404, 'Không tìm thấy');
      await audit(tx, 'system', actorOf(req), 'qr.reissued', b.kind, b.id, {});
      return r;
    });
  });

  app.get('/api/equipment/:id/events', { preHandler: guard() }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return many(pool, `SELECT ev.*, u.full_name AS user_name FROM equipment_events ev LEFT JOIN users u ON u.id = ev.user_id
                        WHERE ev.equipment_id = $1 ORDER BY ev.at DESC`, [id]);
  });

  app.post('/api/equipment/:id/events', { preHandler: guard('crew', ...EQ_MANAGE, 'ipc') }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({
      kind: z.enum(['kiem_tra', 've_sinh', 'bao_duong', 'kiem_dinh', 'hieu_chuan', 'bao_hong', 'sua_xong', 'dieu_chuyen', 'thanh_ly']),
      note: opt, certNo: z.string().trim().max(80).nullish(), nextDue: date.nullish(), stationId: z.string().nullish(), vehicleId: z.string().nullish(),
    }).parse(req.body);
    const before = await one(pool, 'SELECT vehicle_id FROM equipment WHERE id = $1', [id]);
    if (!before) throw new HttpError(404, 'Không tìm thấy thiết bị');
    // Kíp và KSNK chỉ được kiểm tra nhanh, báo hỏng; kíp chỉ thao tác với thiết bị trên xe mình
    if (req.user.role === 'crew' || req.user.role === 'ipc') {
      if (!['bao_hong', 'kiem_tra', 've_sinh'].includes(b.kind)) throw new HttpError(403, 'Chỉ được kiểm tra, vệ sinh, báo hỏng; bảo dưỡng, kiểm định do bộ phận kỹ thuật ghi');
      if (req.user.role === 'crew' && before.vehicle_id !== await crewVehicle(req)) throw new HttpError(403, 'Thiết bị không nằm trên xe bạn đang trực');
    }
    const e = await withTx(pool, (tx) => equipmentEvent(tx, actorOf(req), id, b));
    await Promise.all([pushVehicle(before.vehicle_id), before.vehicle_id !== e.vehicle_id ? pushVehicle(e.vehicle_id) : null]);
    return e;
  });

  /* ---------- Dụng cụ dùng lại và tiệt khuẩn ---------- */

  app.get('/api/instrument-sets', { preHandler: guard() }, async (req) => {
    const q = z.object({ stationId: z.string().optional(), vehicleId: z.string().optional(), status: z.string().optional() }).parse(req.query);
    return many(pool, `
      SELECT s.*, (s.status = 'san_sang' AND s.sterile_until < vn_today()) AS sterile_expired, i.code AS last_incident_code
        FROM instrument_sets s LEFT JOIN incidents i ON i.id = s.last_incident_id
       WHERE ($1::text IS NULL OR s.station_id = $1) AND ($2::text IS NULL OR s.vehicle_id = $2) AND ($3::text IS NULL OR s.status = $3)
       ORDER BY s.station_id, s.vehicle_id NULLS LAST, s.code`, [q.stationId ?? null, q.vehicleId ?? null, q.status ?? null]);
  });

  app.post('/api/instrument-sets', { preHandler: guard(...STERILE) }, async (req) => {
    const b = z.object({ code: z.string().trim().min(2).max(40), name: z.string().trim().min(2).max(120), stationId: z.string().min(1), vehicleId: z.string().nullish() }).parse(req.body);
    return withTx(pool, (tx) => createInstrumentSet(tx, actorOf(req), b));
  });

  app.post('/api/instrument-sets/:id/used', { preHandler: guard('crew', ...STERILE) }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ incidentId: z.string().uuid().nullish() }).parse(req.body ?? {});
    if (req.user.role === 'crew') {
      const s = await one(pool, 'SELECT vehicle_id FROM instrument_sets WHERE id = $1', [id]);
      if (!s || s.vehicle_id !== await crewVehicle(req)) throw new HttpError(403, 'Bộ dụng cụ không nằm trên xe bạn đang trực');
    }
    await withTx(pool, (tx) => markSetUsed(tx, actorOf(req), id, b.incidentId));
    return { ok: true };
  });

  app.post('/api/instrument-sets/:id/move', { preHandler: guard(...STERILE) }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ stationId: z.string().min(1), vehicleId: z.string().nullish() }).parse(req.body);
    await withTx(pool, async (tx) => {
      if (b.vehicleId) {
        const v = await one(tx, 'SELECT station_id FROM vehicles WHERE id = $1', [b.vehicleId]);
        if (!v || v.station_id !== b.stationId) throw new HttpError(409, 'Xe không thuộc điểm đã chọn');
      }
      const r = await tx.query('UPDATE instrument_sets SET station_id = $2, vehicle_id = $3 WHERE id = $1', [id, b.stationId, b.vehicleId ?? null]);
      if (!r.rowCount) throw new HttpError(404, 'Không tìm thấy bộ dụng cụ');
      await audit(tx, 'system', actorOf(req), 'instrument.moved', 'instrument_set', id, b);
    });
    return { ok: true };
  });

  app.get('/api/sterilization-batches', { preHandler: guard() }, async () =>
    many(pool, `SELECT b.*, us.full_name AS started_by_name, uf.full_name AS finished_by_name,
                       (SELECT array_agg(s.code ORDER BY s.code) FROM sterilization_items i JOIN instrument_sets s ON s.id = i.set_id WHERE i.batch_id = b.id) AS sets
                  FROM sterilization_batches b LEFT JOIN users us ON us.id = b.started_by LEFT JOIN users uf ON uf.id = b.finished_by
                 ORDER BY b.started_at DESC LIMIT 200`));

  app.post('/api/sterilization-batches', { preHandler: guard(...STERILE) }, async (req) => {
    const b = z.object({
      method: z.enum(['hap_uot', 'eo', 'plasma']), stationId: z.string().min(1), setIds: z.array(z.string().uuid()).min(1).max(100),
      shelfDays: z.number().int().min(1).max(365).optional(), note: opt,
    }).parse(req.body);
    return withTx(pool, (tx) => startSterilization(tx, actorOf(req), b));
  });

  app.post('/api/sterilization-batches/:id/finish', { preHandler: guard(...STERILE) }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ indicatorOk: z.boolean(), biOk: z.boolean().nullish(), note: opt }).parse(req.body);
    return withTx(pool, (tx) => finishSterilization(tx, actorOf(req), id, b));
  });
}
