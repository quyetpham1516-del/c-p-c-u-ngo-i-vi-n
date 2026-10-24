import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { ackAssignment, crewStatus, getIncident, HttpError, incidentScope, incidentSummary, recordTime, setVehicleStatus } from '../domain.js';
import {
  estimateFree, haversineKm, STATUS_LABEL, statusMedians, suggestVehicles, travelMinutes, VEHICLE_LABEL, type VehicleRow,
} from '../fleet.js';
import { actorOf, DISPATCH_ROLES, EOC_ROLES, guard, type Ctx } from '../http.js';
import { evaluate } from '../triage/engine.js';
import { findGroup, type Priority, type VehicleType } from '../triage/protocol.js';

const BOARD_ROLES = [...EOC_ROLES, 'qa' as const];

export async function loadVehicles(q: import('../db.js').Queryable): Promise<VehicleRow[]> {
  return many<VehicleRow>(q, `
    SELECT v.*, s.name AS station_name, s.lat AS station_lat, s.lng AS station_lng
      FROM vehicles v JOIN stations s ON s.id = v.station_id ORDER BY v.id`);
}

export async function boardRows(q: import('../db.js').Queryable) {
  const [vehicles, crews, incidents, medians, waiting] = await Promise.all([
    loadVehicles(q),
    many(q, `SELECT cs.vehicle_id, u.full_name, u.title, cs.crew_role FROM crew_shifts cs JOIN users u ON u.id = cs.user_id
              WHERE cs.ended_at IS NULL ORDER BY cs.started_at`),
    many(q, `SELECT i.id, i.code, i.final_priority, i.chief_complaint, i.destination, i.lat, i.lng, i.address,
                    a.vehicle_id, a.acknowledged_at
               FROM assignments a JOIN incidents i ON i.id = a.incident_id WHERE a.ended_at IS NULL`),
    statusMedians(q),
    one(q, `SELECT count(*)::int AS n, min(ringing_at) AS oldest FROM calls WHERE state = 'ringing'`),
  ]);
  const now = new Date();
  const rows = vehicles.map((v) => {
    const inc = incidents.find((i) => i.vehicle_id === v.id) ?? null;
    let toScene: number | null = null;
    if (inc && v.status === 'S4' && v.lat != null && v.lng != null && inc.lat != null && inc.lng != null) {
      toScene = travelMinutes(haversineKm({ lat: v.lat, lng: v.lng }, { lat: inc.lat, lng: inc.lng }));
    }
    return {
      ...v,
      type_label: VEHICLE_LABEL[v.type],
      status_label: STATUS_LABEL[v.status],
      crew: crews.filter((c) => c.vehicle_id === v.id).map((c) => ({ name: c.full_name, title: c.title, role: c.crew_role })),
      incident: inc && {
        id: inc.id, code: inc.code, priority: inc.final_priority, complaint: findGroup(inc.chief_complaint)?.label ?? null,
        destination: inc.destination, address: inc.address, acknowledged: !!inc.acknowledged_at,
      },
      free: estimateFree(v, medians, now, toScene),
    };
  });
  return { vehicles: rows, waitingCalls: waiting?.n ?? 0, oldestWaitingCall: waiting?.oldest ?? null, serverTime: now.toISOString() };
}

const vehicleParam = (req: FastifyRequest) => z.object({ id: z.string().min(1).max(40) }).parse(req.params).id;

export function registerFleet(app: FastifyInstance, { pool, hub }: Ctx) {
  const pushVehicle = (id: string) => hub.publish({ type: 'vehicle', id });
  const pushIncident = async (id: string | null | undefined) => {
    if (!id) return;
    await hub.publish({ type: 'incident', id, incident: await incidentSummary(pool, id) });
  };

  /** Kíp chỉ thao tác được trên xe mình đang đăng nhập; điều phối/trưởng ca thao tác được mọi xe */
  async function assertVehicleAccess(req: FastifyRequest, vehicleId: string) {
    if (req.user.role !== 'crew') return;
    const s = await one(pool, 'SELECT 1 FROM crew_shifts WHERE user_id = $1 AND vehicle_id = $2 AND ended_at IS NULL', [req.user.id, vehicleId]);
    if (!s) throw new HttpError(403, 'Bạn không đăng nhập ca trên xe này');
  }

  app.get('/api/board', { preHandler: guard(...BOARD_ROLES) }, async () => boardRows(pool));

  app.get('/api/stations', { preHandler: guard() }, async () => many(pool, 'SELECT * FROM stations ORDER BY id'));

  app.get('/api/incidents/:id/suggest', { preHandler: guard(...EOC_ROLES) }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const inc = await getIncident(pool, id);
    const scene = inc.lat != null && inc.lng != null ? { lat: inc.lat, lng: inc.lng } : null;
    const requested = (inc.final_vehicle_type ?? inc.suggested_vehicle_type) as VehicleType | null;
    const priority = (inc.final_priority ?? inc.suggested_priority) as Priority | null;
    return suggestVehicles(await loadVehicles(pool), scene, requested, priority);
  });

  app.post('/api/vehicles/:id/status', { preHandler: guard('crew', ...DISPATCH_ROLES) }, async (req) => {
    const id = vehicleParam(req);
    const b = z.object({ status: z.string().regex(/^S[1-9]$/), lat: z.number().optional(), lng: z.number().optional(), reason: z.string().max(300).optional() }).parse(req.body);
    await assertVehicleAccess(req, id);
    const before = await one(pool, 'SELECT current_incident_id FROM vehicles WHERE id = $1', [id]);
    await withTx(pool, (tx) => crewStatus(tx, actorOf(req), id, b.status, { lat: b.lat, lng: b.lng }));
    await Promise.all([pushVehicle(id), pushIncident(before?.current_incident_id)]);
    return { ok: true };
  });

  app.post('/api/vehicles/:id/location', { preHandler: guard('crew', ...DISPATCH_ROLES) }, async (req) => {
    const id = vehicleParam(req);
    const b = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).parse(req.body);
    await assertVehicleAccess(req, id);
    await pool.query('UPDATE vehicles SET lat = $2, lng = $3, location_at = now() WHERE id = $1', [id, b.lat, b.lng]);
    await hub.publish({ type: 'vehicle.location', id, lat: b.lat, lng: b.lng });
    return { ok: true };
  });

  app.post('/api/vehicles/:id/free-hint', { preHandler: guard('crew', ...DISPATCH_ROLES) }, async (req) => {
    const id = vehicleParam(req);
    const b = z.object({ minutes: z.number().int().min(1).max(120) }).parse(req.body);
    await assertVehicleAccess(req, id);
    await pool.query(`UPDATE vehicles SET free_hint_at = now() + make_interval(mins => $2) WHERE id = $1`, [id, b.minutes]);
    await pushVehicle(id);
    return { ok: true };
  });

  app.post('/api/vehicles/:id/supplies', { preHandler: guard('crew', ...DISPATCH_ROLES) }, async (req) => {
    const id = vehicleParam(req);
    const b = z.object({ ok: z.boolean(), note: z.string().max(500).nullish() }).parse(req.body);
    await assertVehicleAccess(req, id);
    await pool.query('UPDATE vehicles SET supplies_ok = $2, supplies_note = $3 WHERE id = $1', [id, b.ok, b.note ?? null]);
    await pushVehicle(id);
    return { ok: true };
  });

  /* ---------- Ứng dụng kíp ---------- */

  app.get('/api/crew/vehicles', { preHandler: guard('crew') }, async () =>
    many(pool, `SELECT v.id, v.type, v.status, s.name AS station_name FROM vehicles v JOIN stations s ON s.id = v.station_id ORDER BY v.id`));

  app.post('/api/crew/shift', { preHandler: guard('crew') }, async (req) => {
    const b = z.object({ vehicleId: z.string().min(1), crewRole: z.string().min(1).max(60) }).parse(req.body);
    const actor = actorOf(req);
    await withTx(pool, async (tx) => {
      await tx.query('UPDATE crew_shifts SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [actor.id]);
      await tx.query('INSERT INTO crew_shifts(vehicle_id, user_id, crew_role) VALUES ($1,$2,$3)', [b.vehicleId, actor.id, b.crewRole]);
      const v = await one(tx, 'SELECT status FROM vehicles WHERE id = $1', [b.vehicleId]);
      if (!v) throw new HttpError(404, 'Không tìm thấy xe');
      if (v.status === 'S9') await setVehicleStatus(tx, actor, b.vehicleId, 'S1');
      await audit(tx, 'system', actor, 'crew.shift_started', 'vehicle', b.vehicleId, { crewRole: b.crewRole });
    });
    await pushVehicle(b.vehicleId);
    return { ok: true };
  });

  app.delete('/api/crew/shift', { preHandler: guard('crew') }, async (req) => {
    const actor = actorOf(req);
    const s = await one(pool, 'UPDATE crew_shifts SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL RETURNING vehicle_id', [actor.id]);
    if (s) {
      await withTx(pool, (tx) => audit(tx, 'system', actor, 'crew.shift_ended', 'vehicle', s.vehicle_id));
      await pushVehicle(s.vehicle_id);
    }
    return { ok: true };
  });

  app.get('/api/crew/current', { preHandler: guard('crew', ...DISPATCH_ROLES) }, async (req) => {
    const shift = await one(pool, `SELECT cs.vehicle_id, cs.crew_role FROM crew_shifts cs WHERE cs.user_id = $1 AND cs.ended_at IS NULL`, [req.user.id]);
    if (!shift) return { shift: null };
    const vehicle = (await boardRows(pool)).vehicles.find((v) => v.id === shift.vehicle_id);
    const a = await one(pool, 'SELECT * FROM assignments WHERE vehicle_id = $1 AND ended_at IS NULL', [shift.vehicle_id]);
    let incident = null;
    if (a) {
      const i = await getIncident(pool, a.incident_id);
      const times = await many(pool, 'SELECT code, at FROM incident_times WHERE incident_id = $1', [a.incident_id]);
      const transfers = await many(pool, 'SELECT id, transfer_number, status, patient_id FROM transfers WHERE incident_id = $1 AND vehicle_id = $2', [a.incident_id, shift.vehicle_id]);
      incident = {
        id: i.id, code: i.code, priority: i.final_priority, lights: i.final_lights, address: i.address, addressNote: i.address_note,
        lat: i.lat, lng: i.lng, complaint: findGroup(i.chief_complaint)?.label ?? null,
        flags: evaluate(i.triage_answers ?? {}, i.chief_complaint).flags, callbackPhone: i.callback_phone, notes: i.notes,
        patientCount: i.patient_count, destination: i.destination, triageAnswers: i.triage_answers,
        acknowledged: !!a.acknowledged_at, times, transfers,
      };
    }
    return { shift, vehicle, incident };
  });

  app.post('/api/crew/ack', { preHandler: guard('crew') }, async (req) => {
    const shift = await one(pool, 'SELECT vehicle_id FROM crew_shifts WHERE user_id = $1 AND ended_at IS NULL', [req.user.id]);
    if (!shift) throw new HttpError(409, 'Chưa đăng nhập ca');
    const a = await withTx(pool, (tx) => ackAssignment(tx, actorOf(req), shift.vehicle_id));
    await Promise.all([pushVehicle(shift.vehicle_id), pushIncident(a?.incident_id)]);
    return { ok: !!a };
  });

  /** Mốc không đổi trạng thái xe: T8 tới bên người bệnh, T9 can thiệp đầu tiên, T13 bàn giao xong */
  app.post('/api/crew/milestone', { preHandler: guard('crew') }, async (req) => {
    const b = z.object({ code: z.enum(['T8', 'T9', 'T13']), at: z.string().datetime().optional() }).parse(req.body);
    const shift = await one(pool, 'SELECT vehicle_id FROM crew_shifts WHERE user_id = $1 AND ended_at IS NULL', [req.user.id]);
    if (!shift) throw new HttpError(409, 'Chưa đăng nhập ca');
    const a = await one(pool, 'SELECT incident_id FROM assignments WHERE vehicle_id = $1 AND ended_at IS NULL', [shift.vehicle_id]);
    if (!a) throw new HttpError(409, 'Xe không có ca đang làm');
    const source = b.code === 'T13' ? 'Máy tính bảng (bàn giao)' : 'Nút trên máy tính bảng';
    const added = await withTx(pool, (tx) => recordTime(tx, a.incident_id, b.code, b.at ?? new Date(), source, actorOf(req)));
    await pushIncident(a.incident_id);
    return { ok: true, added };
  });
}
