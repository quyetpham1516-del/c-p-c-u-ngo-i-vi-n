import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { many, one, withTx } from '../db.js';
import {
  assignVehicle, AUTO_DISPATCH_KM, confirmTriage, createIncident, findDuplicates, getIncident, HttpError, incidentDetail,
  incidentScope, incidentSummary, recordTime, saveTriage, unassignVehicle,
} from '../domain.js';
import { queueSurvey } from '../quality.js';
import { evaluate } from '../triage/engine.js';
import { protocolDescriptor, type Priority, type VehicleType } from '../triage/protocol.js';
import { suggestVehicles } from '../fleet.js';
import { loadVehicles } from './fleet.js';
import { actorOf, DISPATCH_ROLES, EOC_ROLES, guard, type Ctx } from '../http.js';

const PRIORITY = z.enum(['P1', 'P2', 'P3', 'P4', 'HEN']);
const VEHICLE = z.enum(['ALS', 'BLS', 'MSU', 'ECMO', 'VC', 'NONE']);
const idParam = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;

export function registerEoc(app: FastifyInstance, { pool, hub }: Ctx) {
  const eoc = { preHandler: guard(...EOC_ROLES) };
  const dispatch = { preHandler: guard(...DISPATCH_ROLES) };

  const pushIncident = async (id: string) => {
    const s = await incidentSummary(pool, id);
    await hub.publish({ type: 'incident', id, incident: s });
  };
  const pushCall = async (id: string) => {
    const c = await one(pool, 'SELECT id, phone, line, state, ringing_at, answered_at, ended_at, incident_id, operator_id FROM calls WHERE id = $1', [id]);
    await hub.publish({ type: 'call', id, call: c });
  };

  app.get('/api/protocol', { preHandler: guard() }, async () => protocolDescriptor());

  app.post('/api/triage/evaluate', { preHandler: guard() }, async (req) => {
    const b = z.object({ answers: z.record(z.string(), z.string()), group: z.string().nullish() }).parse(req.body);
    return evaluate(b.answers, b.group);
  });

  /* ---------- Cuộc gọi (tổng đài báo qua webhook) ---------- */

  const telephonyAuth = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (req.headers['x-medone-telephony-key'] === config.telephonyKey) return;
    return guard(...EOC_ROLES)(req, reply);
  };

  app.post('/api/telephony/ring', { preHandler: telephonyAuth }, async (req) => {
    const b = z.object({ phone: z.string().min(3).max(20), line: z.enum(['1800', '115']).default('1800'), recordingRef: z.string().optional() }).parse(req.body);
    const c = await one(pool, 'INSERT INTO calls(phone, line, recording_ref) VALUES ($1,$2,$3) RETURNING *', [b.phone, b.line, b.recordingRef ?? null]);
    await pushCall(c.id);
    return c;
  });

  app.post('/api/telephony/abandon', { preHandler: telephonyAuth }, async (req) => {
    const b = z.object({ callId: z.string().uuid() }).parse(req.body);
    const c = await one(pool, `UPDATE calls SET state = 'abandoned', ended_at = now() WHERE id = $1 AND state = 'ringing' RETURNING id`, [b.callId]);
    if (c) await pushCall(c.id);
    return { ok: !!c };
  });

  app.get('/api/calls', eoc, async (req) => {
    const q = z.object({ state: z.enum(['ringing', 'abandoned', 'answered']).default('ringing') }).parse(req.query);
    const extra = q.state === 'abandoned' ? 'AND callback_done_at IS NULL' : '';
    return many(pool, `SELECT id, phone, line, state, ringing_at, answered_at, ended_at, incident_id, operator_id FROM calls
                        WHERE state = $1 ${extra} ORDER BY ringing_at LIMIT 500`, [q.state]);
  });

  /** Nhận cuộc gọi: tạo ca mới, Mã ca sinh tại T0 (giờ chuông reo) */
  app.post('/api/calls/:id/answer', eoc, async (req) => {
    const id = idParam(req);
    const actor = actorOf(req);
    const b = z.object({ attachTo: z.string().uuid().optional() }).parse(req.body ?? {});
    const out = await withTx(pool, async (tx) => {
      const call = await one(tx, `SELECT * FROM calls WHERE id = $1 FOR UPDATE SKIP LOCKED`, [id]);
      if (!call) throw new HttpError(409, 'Cuộc gọi đang được người khác nhận');
      if (call.state !== 'ringing') throw new HttpError(409, 'Cuộc gọi không còn chờ');
      let incidentId = b.attachTo;
      if (incidentId) {
        await getIncident(tx, incidentId);
        await audit(tx, incidentScope(incidentId), actor, 'call.attached', 'call', id, { phone: call.phone });
      } else {
        const inc = await createIncident(tx, actor, {
          source: call.line === '115' ? '115' : '1800', callerPhone: call.phone, t0: call.ringing_at, t1: new Date(),
        });
        incidentId = inc.id;
      }
      await tx.query(`UPDATE calls SET state = 'answered', answered_at = now(), operator_id = $2, incident_id = $3 WHERE id = $1`,
        [id, actor.id, incidentId]);
      return incidentId!;
    });
    await Promise.all([pushCall(id), pushIncident(out)]);
    return incidentDetail(pool, out);
  });

  app.post('/api/calls/:id/end', eoc, async (req) => {
    const id = idParam(req);
    await pool.query(`UPDATE calls SET state = 'ended', ended_at = now() WHERE id = $1 AND state = 'answered'`, [id]);
    await pushCall(id);
    return { ok: true };
  });

  app.post('/api/calls/:id/callback-done', eoc, async (req) => {
    const id = idParam(req);
    await pool.query('UPDATE calls SET callback_done_at = now() WHERE id = $1', [id]);
    await withTx(pool, (tx) => audit(tx, 'system', actorOf(req), 'call.callback_done', 'call', id));
    await pushCall(id);
    return { ok: true };
  });

  /* ---------- Ca ---------- */

  /** Tạo ca thủ công: ca nhận qua đường nóng 115 hoặc cuộc gọi không qua tổng đài */
  app.post('/api/incidents', eoc, async (req) => {
    const b = z.object({
      source: z.enum(['1800', '115']),
      sourceRef: z.string().max(60).nullish(),
      callerPhone: z.string().max(20).nullish(),
      t0: z.string().datetime().optional(),
    }).parse(req.body);
    const actor = actorOf(req);
    const inc = await withTx(pool, (tx) => createIncident(tx, actor, {
      source: b.source, sourceRef: b.sourceRef, callerPhone: b.callerPhone, t0: b.t0 ?? new Date(), t1: new Date(),
    }));
    await pushIncident(inc.id);
    return incidentDetail(pool, inc.id);
  });

  app.get('/api/incidents', eoc, async (req) => {
    const q = z.object({ scope: z.enum(['open', 'recent']).default('open') }).parse(req.query);
    const where = q.scope === 'open'
      ? `i.status NOT IN ('closed','cancelled','transferred_115','advice_only')`
      : `i.created_at > now() - interval '24 hours'`;
    return many(pool, `
      SELECT i.id, i.code, i.source, i.status, i.address, i.lat, i.lng, i.chief_complaint, i.suggested_priority,
             i.final_priority, i.final_vehicle_type, i.suggested_vehicle_type, i.created_at, i.confirmed_at,
             i.callback_phone, i.caller_phone, i.destination, i.destination_department, i.duplicate_of,
             (SELECT array_agg(a.vehicle_id) FROM assignments a WHERE a.incident_id = i.id AND a.ended_at IS NULL) AS vehicles,
             (SELECT u.full_name FROM users u WHERE u.id = i.created_by) AS created_by_name
        FROM incidents i WHERE ${where} ORDER BY i.created_at DESC LIMIT 500`);
  });

  app.get('/api/incidents/:id', eoc, async (req) => {
    const id = idParam(req);
    const d = await incidentDetail(pool, id);
    return { ...d, duplicates: await findDuplicates(pool, d) };
  });

  app.patch('/api/incidents/:id', eoc, async (req) => {
    const id = idParam(req);
    const b = z.object({
      address: z.string().max(500).nullish(),
      addressNote: z.string().max(500).nullish(),
      lat: z.number().min(-90).max(90).nullish(),
      lng: z.number().min(-180).max(180).nullish(),
      callbackPhone: z.string().max(20).nullish(),
      callerName: z.string().max(120).nullish(),
      patientCount: z.number().int().min(1).max(500).optional(),
      notes: z.string().max(4000).nullish(),
      source: z.enum(['1800', '115']).optional(),
      sourceRef: z.string().max(60).nullish(),
      infectionRisk: z.enum(['tiep_xuc', 'giot_ban', 'khong_khi']).nullish(),
    }).parse(req.body);
    const actor = actorOf(req);
    const map: Record<string, string> = {
      address: 'address', addressNote: 'address_note', lat: 'lat', lng: 'lng', callbackPhone: 'callback_phone',
      callerName: 'caller_name', patientCount: 'patient_count', notes: 'notes', source: 'source', sourceRef: 'source_ref',
      infectionRisk: 'infection_risk',
    };
    const keys = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    if (!keys.length) return incidentDetail(pool, id);
    await withTx(pool, async (tx) => {
      const before = await getIncident(tx, id, true);
      const sets = keys.map((k, i) => `${map[k]} = $${i + 2}`).join(', ');
      await tx.query(`UPDATE incidents SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => (b as Record<string, unknown>)[k])]);
      const changes: Record<string, unknown> = {};
      for (const k of keys) changes[k] = { from: before[map[k]], to: (b as Record<string, unknown>)[k] };
      await audit(tx, incidentScope(id), actor, 'incident.updated', 'incident', id, changes);
      const hasLocation = (b.address ?? before.address) && (b.callbackPhone ?? before.callback_phone);
      if (hasLocation) await recordTime(tx, id, 'T2', new Date(), 'CAD', actor);
    });
    await pushIncident(id);
    const d = await incidentDetail(pool, id);
    return { ...d, duplicates: await findDuplicates(pool, d) };
  });

  app.put('/api/incidents/:id/triage', eoc, async (req) => {
    const id = idParam(req);
    const b = z.object({ answers: z.record(z.string(), z.string()), group: z.string().nullish() }).parse(req.body);
    const result = await withTx(pool, (tx) => saveTriage(tx, actorOf(req), id, b.answers, b.group ?? null));
    await pushIncident(id);
    return result;
  });

  app.post('/api/incidents/:id/confirm', eoc, async (req) => {
    const id = idParam(req);
    const b = z.object({ priority: PRIORITY, vehicleType: VEHICLE, lights: z.boolean(), overrideReason: z.string().max(500).nullish() }).parse(req.body);
    await withTx(pool, (tx) => confirmTriage(tx, actorOf(req), id, b));
    await pushIncident(id);
    return incidentDetail(pool, id);
  });

  app.post('/api/incidents/:id/assign', dispatch, async (req) => {
    const id = idParam(req);
    const b = z.object({
      vehicleId: z.string().min(1), divertReason: z.string().max(500).nullish(), confirmFar: z.boolean().optional(),
      equipmentOverride: z.string().trim().max(500).nullish(),
    }).parse(req.body);
    if (b.equipmentOverride && !['supervisor', 'admin'].includes(req.user.role)) throw new HttpError(403, 'Chỉ trưởng ca được cho xe thiếu thiết bị đi');
    await withTx(pool, (tx) => assignVehicle(tx, actorOf(req), id, b.vehicleId, { divertReason: b.divertReason, confirmFar: b.confirmFar, equipmentOverride: b.equipmentOverride }));
    await Promise.all([pushIncident(id), hub.publish({ type: 'vehicle', id: b.vehicleId })]);
    return incidentDetail(pool, id);
  });

  /**
   * Tự động báo xe rảnh phù hợp gần nhất: trong bán kính AUTO_DISPATCH_KM thì giao luôn (xe nhận chuông báo ngay),
   * xa hơn thì trả về xe đề xuất để điều phối viên xác nhận.
   */
  app.post('/api/incidents/:id/auto-assign', dispatch, async (req) => {
    const id = idParam(req);
    const inc = await getIncident(pool, id);
    if (inc.lat == null || inc.lng == null) throw new HttpError(409, 'Chưa có vị trí hiện trường trên bản đồ: không tính được xe gần nhất');
    const requested = (inc.final_vehicle_type ?? inc.suggested_vehicle_type) as VehicleType | null;
    const priority = (inc.final_priority ?? inc.suggested_priority) as Priority | null;
    const { suggestions, advice } = suggestVehicles(await loadVehicles(pool), { lat: inc.lat, lng: inc.lng }, requested, priority);
    const best = suggestions[0];
    if (!best) throw new HttpError(409, 'Không còn xe rảnh phù hợp: đưa vào hàng chờ, rút xe ca thấp hơn hoặc chuyển 115', { code: 'NO_VEHICLE', advice });
    if (best.distanceKm != null && best.distanceKm > AUTO_DISPATCH_KM) {
      return { assigned: false, candidate: best, distanceKm: best.distanceKm, limitKm: AUTO_DISPATCH_KM,
        message: `Xe rảnh gần nhất là ${best.vehicleId}, cách ${best.distanceKm} km (> ${AUTO_DISPATCH_KM} km). Xác nhận để giao.` };
    }
    await withTx(pool, (tx) => assignVehicle(tx, actorOf(req), id, best.vehicleId, { auto: true }));
    await Promise.all([pushIncident(id), hub.publish({ type: 'vehicle', id: best.vehicleId })]);
    return { assigned: true, candidate: best, distanceKm: best.distanceKm, limitKm: AUTO_DISPATCH_KM, incident: await incidentDetail(pool, id) };
  });

  app.post('/api/incidents/:id/unassign', dispatch, async (req) => {
    const id = idParam(req);
    const b = z.object({ vehicleId: z.string().min(1), reason: z.string().min(2).max(500) }).parse(req.body);
    await withTx(pool, (tx) => unassignVehicle(tx, actorOf(req), id, b.vehicleId, b.reason));
    await Promise.all([pushIncident(id), hub.publish({ type: 'vehicle', id: b.vehicleId })]);
    return incidentDetail(pool, id);
  });

  app.post('/api/incidents/:id/prealert', dispatch, async (req) => {
    const id = idParam(req);
    const b = z.object({
      hospital: z.string().min(2).max(200), department: z.string().max(200).nullish(), note: z.string().max(1000).optional(),
    }).parse(req.body);
    const actor = actorOf(req);
    await withTx(pool, async (tx) => {
      await tx.query('UPDATE incidents SET destination = $2, destination_department = $3, updated_at = now() WHERE id = $1',
        [id, b.hospital, b.department || null]);
      await recordTime(tx, id, 'T11', new Date(), 'CAD', actor);
      await audit(tx, incidentScope(id), actor, 'hospital.prealert', 'incident', id, b);
    });
    await pushIncident(id);
    return incidentDetail(pool, id);
  });

  app.post('/api/incidents/:id/transfer-115', dispatch, async (req) => {
    const id = idParam(req);
    const b = z.object({ reason: z.string().min(2).max(500) }).parse(req.body);
    const actor = actorOf(req);
    await withTx(pool, async (tx) => {
      const inc = await getIncident(tx, id, true);
      const active = await one(tx, 'SELECT count(*)::int AS n FROM assignments WHERE incident_id = $1 AND ended_at IS NULL', [id]);
      if (active.n) throw new HttpError(409, 'Ca đang có xe, hủy giao xe trước khi chuyển 115');
      await tx.query(`UPDATE incidents SET status = 'transferred_115', closed_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await tx.query(`INSERT INTO outbox(topic, payload) VALUES ('transfer_115', $1)`, [{ incidentId: id, code: inc.code, reason: b.reason }]);
      await audit(tx, incidentScope(id), actor, 'incident.transferred_115', 'incident', id, b);
    });
    await pushIncident(id);
    return incidentDetail(pool, id);
  });

  app.post('/api/incidents/:id/close', eoc, async (req) => {
    const id = idParam(req);
    const b = z.object({
      status: z.enum(['closed', 'cancelled', 'advice_only']).default('closed'),
      reason: z.string().min(2).max(500),
      duplicateOf: z.string().uuid().optional(),
    }).parse(req.body);
    const actor = actorOf(req);
    await withTx(pool, async (tx) => {
      await getIncident(tx, id, true);
      const active = await one(tx, 'SELECT count(*)::int AS n FROM assignments WHERE incident_id = $1 AND ended_at IS NULL', [id]);
      if (active.n) throw new HttpError(409, 'Ca còn xe đang làm nhiệm vụ');
      await tx.query(`UPDATE incidents SET status = $2, duplicate_of = $3, closed_at = now(), updated_at = now() WHERE id = $1`,
        [id, b.status, b.duplicateOf ?? null]);
      await audit(tx, incidentScope(id), actor, 'incident.closed', 'incident', id, b);
      const served = await one(tx, 'SELECT 1 FROM assignments WHERE incident_id = $1 LIMIT 1', [id]);
      if (b.status === 'closed' && served) await queueSurvey(tx, id);
      if (b.duplicateOf) {
        await audit(tx, incidentScope(b.duplicateOf), actor, 'incident.duplicate_linked', 'incident', id, {});
        await tx.query(`UPDATE calls SET incident_id = $2 WHERE incident_id = $1`, [id, b.duplicateOf]);
      }
    });
    await pushIncident(id);
    return incidentDetail(pool, id);
  });

  // Gửi thông báo 115 qua outbox: khi 115 chưa có API, giữ ở trạng thái chờ để ĐPV gọi đường nóng
  app.post('/api/outbox/:id/mark-sent', dispatch, async (req) => {
    const id = z.object({ id: z.coerce.number() }).parse(req.params).id;
    const row = await one(pool, `UPDATE outbox SET sent_at = now(), last_error = 'Đã báo qua điện thoại nóng' WHERE id = $1 AND sent_at IS NULL RETURNING *`, [id]);
    if (row?.payload?.incidentId) {
      await withTx(pool, (tx) => audit(tx, incidentScope(row.payload.incidentId), actorOf(req), 'outbox.manual_sent', 'outbox', String(id), { topic: row.topic }));
      await pushIncident(row.payload.incidentId);
    }
    return { ok: !!row };
  });

}
