import { audit, type Actor } from './audit.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { equipmentGaps, gapText } from './equipment.js';
import { haversineKm } from './fleet.js';
import { assertDisinfected, ensureDisinfection, queueSurvey } from './quality.js';
import { evaluate, type Answers } from './triage/engine.js';
import type { Priority } from './triage/protocol.js';

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const incidentScope = (id: string) => `incident:${id}`;
export const patientScope = (id: string) => `patient:${id}`;

export const TIME_LABEL: Record<string, string> = {
  T0: 'Cuộc gọi đổ chuông', T1: 'Nhấc máy', T2: 'Xác định xong địa điểm', T3: 'Chốt mã ưu tiên',
  T4: 'Giao xe', T5: 'Kíp xác nhận lệnh', T6: 'Xe lăn bánh', T7: 'Tới hiện trường',
  T8: 'Tới bên người bệnh', T9: 'Can thiệp đầu tiên', T10: 'Rời hiện trường', T11: 'Báo trước bệnh viện',
  T12: 'Tới bệnh viện', T13: 'Bàn giao xong', T14: 'Xe sẵn sàng trở lại', T15: 'ePCR đóng và ký',
};

function vnDate(d = new Date()): Date {
  return new Date(d.getTime() + 7 * 3600_000);
}

/** Mã ca: MD-YYMMDD-NNNN theo ngày giờ Việt Nam */
export async function newIncidentCode(q: Queryable, at = new Date()): Promise<string> {
  const vn = vnDate(at);
  const day = vn.toISOString().slice(2, 10).replace(/-/g, '');
  const n = await nextCounter(q, 'incident', day);
  return `MD-${day}-${String(n).padStart(4, '0')}`;
}

/** Số chuyển viện: Năm-Số thứ tự (mục 8.6) */
export async function newTransferNumber(q: Queryable, at = new Date()): Promise<string> {
  const year = String(vnDate(at).getUTCFullYear());
  const n = await nextCounter(q, 'transfer', year);
  return `${year}-${String(n).padStart(5, '0')}`;
}

/** Số BA: cấp một lần, giữ vĩnh viễn */
export async function newBaNumber(q: Queryable): Promise<string> {
  const n = await nextCounter(q, 'ba', 'all');
  return `BA-${String(n).padStart(7, '0')}`;
}

/** Ghi mốc thời gian; mốc đã có thì giữ giá trị đầu tiên (không ghi đè) */
export async function recordTime(tx: Tx, incidentId: string, code: string, at: Date | string, source: string, actor: Actor): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO incident_times(incident_id, code, at, source) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [incidentId, code, at, source],
  );
  if (r.rowCount) {
    await audit(tx, incidentScope(incidentId), actor, 'time.recorded', 'incident', incidentId, {
      code, label: TIME_LABEL[code], at: new Date(at).toISOString(), source,
    });
    return true;
  }
  return false;
}

export async function getIncident(q: Queryable, id: string, lock = false) {
  const inc = await one(q, `SELECT * FROM incidents WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!inc) throw new HttpError(404, 'Không tìm thấy ca');
  return inc;
}

export async function incidentSummary(q: Queryable, id: string) {
  return one(q, `
    SELECT i.id, i.code, i.source, i.status, i.address, i.lat, i.lng, i.chief_complaint, i.suggested_priority,
           i.final_priority, i.final_vehicle_type, i.suggested_vehicle_type, i.created_at, i.confirmed_at, i.callback_phone,
           i.caller_phone, i.destination, i.destination_department, i.duplicate_of,
           (SELECT array_agg(a.vehicle_id) FROM assignments a WHERE a.incident_id = i.id AND a.ended_at IS NULL) AS vehicles,
           (SELECT u.full_name FROM users u WHERE u.id = i.created_by) AS created_by_name
      FROM incidents i WHERE i.id = $1`, [id]);
}

export async function incidentDetail(q: Queryable, id: string) {
  const inc = await getIncident(q, id);
  const [times, calls, assignments, transfers] = await Promise.all([
    many(q, 'SELECT code, at, source FROM incident_times WHERE incident_id = $1 ORDER BY at', [id]),
    many(q, 'SELECT id, phone, line, state, ringing_at, answered_at, ended_at FROM calls WHERE incident_id = $1 ORDER BY ringing_at', [id]),
    many(q, `SELECT a.*, u.full_name AS assigned_by_name FROM assignments a JOIN users u ON u.id = a.assigned_by
              WHERE a.incident_id = $1 ORDER BY a.assigned_at`, [id]),
    many(q, 'SELECT id, transfer_number, status, patient_id, vehicle_id FROM transfers WHERE incident_id = $1', [id]),
  ]);
  const triage = evaluate(inc.triage_answers ?? {}, inc.chief_complaint);
  const outbox = await many(q, `SELECT id, topic, created_at, sent_at, last_error FROM outbox WHERE payload->>'incidentId' = $1 ORDER BY id`, [id]);
  return { ...inc, times, calls, assignments, transfers, triage, outbox };
}

/** Ca đang mở gần cùng vị trí trong 30 phút => có thể trùng (nhiều người gọi cùng một sự việc) */
export async function findDuplicates(q: Queryable, inc: { id: string; lat: number | null; lng: number | null; caller_phone?: string | null }) {
  const open = await many(q, `
    SELECT id, code, address, lat, lng, chief_complaint, final_priority, suggested_priority, created_at, caller_phone
      FROM incidents
     WHERE id <> $1 AND duplicate_of IS NULL
       AND status NOT IN ('closed','cancelled','transferred_115','advice_only')
       AND created_at > now() - interval '30 minutes'`, [inc.id]);
  return open.filter((o) => {
    if (inc.caller_phone && o.caller_phone === inc.caller_phone) return true;
    if (inc.lat == null || inc.lng == null || o.lat == null || o.lng == null) return false;
    return haversineKm({ lat: inc.lat, lng: inc.lng }, { lat: o.lat, lng: o.lng }) <= 0.3;
  }).map((o) => ({ ...o, reason: inc.caller_phone && o.caller_phone === inc.caller_phone ? 'Cùng số gọi' : 'Trong bán kính 300 m, 30 phút' }));
}

export async function createIncident(
  tx: Tx, actor: Actor,
  input: { source: '1800' | '115'; sourceRef?: string | null; callerPhone?: string | null; t0: Date | string; t1?: Date | string },
) {
  const code = await newIncidentCode(tx, new Date(input.t0));
  const inc = await one(tx, `
    INSERT INTO incidents(code, source, source_ref, caller_phone, callback_phone, created_by, created_at)
    VALUES ($1,$2,$3,$4,$4,$5,$6) RETURNING *`,
    [code, input.source, input.sourceRef ?? null, input.callerPhone ?? null, actor.id, input.t0]);
  await audit(tx, incidentScope(inc.id), actor, 'incident.created', 'incident', inc.id, {
    code, source: input.source, sourceRef: input.sourceRef ?? null,
  });
  await recordTime(tx, inc.id, 'T0', input.t0, input.source === '1800' ? 'Tổng đài' : 'Đường nóng 115', actor);
  if (input.t1) await recordTime(tx, inc.id, 'T1', input.t1, 'Tổng đài', actor);
  return inc;
}

export async function saveTriage(tx: Tx, actor: Actor, id: string, answers: Answers, group: string | null) {
  const inc = await getIncident(tx, id, true);
  // Sau khi đã xác nhận vẫn được hỏi thêm; mã cuối cùng chỉ đổi qua bước xác nhận lại
  const result = evaluate(answers, group);
  const status = inc.confirmed_at ? inc.status : (result.complete || result.earlyActivation ? 'awaiting_confirm' : 'intake');
  await tx.query(`
    UPDATE incidents SET triage_answers = $2, chief_complaint = $3, protocol_version = $4, suggested_priority = $5,
           suggested_vehicle_type = $6, suggested_lights = $7, status = $8, updated_at = now()
     WHERE id = $1`,
  [id, answers, group, result.protocolVersion, result.priority, result.vehicleType, result.lights, status]);
  await audit(tx, incidentScope(id), actor, 'triage.answered', 'incident', id, {
    protocolVersion: result.protocolVersion, group, answers, suggestedPriority: result.priority,
    suggestedVehicle: result.vehicleType, flags: result.flags,
  });
  return result;
}

/**
 * Xác nhận bắt buộc trước khi kích hoạt (mục 5.11): người xác nhận chọn mã và loại xe cuối cùng.
 * Đổi so với máy đề xuất thì phải có lý do; lưu cả mã máy đề xuất và mã cuối cùng.
 */
export async function confirmTriage(
  tx: Tx, actor: Actor, id: string,
  input: { priority: Priority; vehicleType: string; lights: boolean; overrideReason?: string | null },
) {
  const inc = await getIncident(tx, id, true);
  if (!inc.suggested_priority) throw new HttpError(409, 'Chưa có mã đề xuất: cần trả lời câu hỏi sống còn trước');
  if (!inc.address && inc.lat == null) throw new HttpError(409, 'Cần xác định địa điểm trước khi xác nhận');
  const changed = input.priority !== inc.suggested_priority || input.vehicleType !== inc.suggested_vehicle_type;
  const reason = input.overrideReason?.trim();
  if (changed && !reason) throw new HttpError(400, 'Đổi mã hoặc loại xe so với đề xuất phải chọn lý do');
  const status = input.priority === 'P4' || input.vehicleType === 'NONE' ? 'advice_only'
    : inc.status === 'intake' || inc.status === 'awaiting_confirm' ? 'confirmed' : inc.status;
  await tx.query(`
    UPDATE incidents SET final_priority = $2, final_vehicle_type = $3, final_lights = $4, override_reason = $5,
           confirmed_by = $6, confirmed_at = now(), status = $7, updated_at = now(),
           closed_at = CASE WHEN $7 = 'advice_only' THEN now() ELSE closed_at END
     WHERE id = $1`,
  [id, input.priority, input.vehicleType, input.lights, changed ? reason : null, actor.id, status]);
  await audit(tx, incidentScope(id), actor, 'triage.confirmed', 'incident', id, {
    suggestedPriority: inc.suggested_priority, suggestedVehicle: inc.suggested_vehicle_type,
    finalPriority: input.priority, finalVehicle: input.vehicleType, lights: input.lights,
    overrideReason: changed ? reason : null,
  });
  await recordTime(tx, id, 'T3', new Date(), 'CAD', actor);
  if ((input.priority === 'P1' || input.priority === 'P2') && !inc.notified_115_at && inc.source === '1800') {
    await tx.query(`INSERT INTO outbox(topic, payload) VALUES ('notify_115', $1)`, [{ incidentId: id, code: inc.code, priority: input.priority }]);
    await tx.query('UPDATE incidents SET notified_115_at = now() WHERE id = $1', [id]);
    await audit(tx, incidentScope(id), actor, 'notify115.queued', 'incident', id, { priority: input.priority });
  }
}

export async function setVehicleStatus(
  tx: Tx, actor: Actor, vehicleId: string, status: string,
  opts: { incidentId?: string | null; lat?: number; lng?: number } = {},
) {
  const v = await one(tx, 'SELECT * FROM vehicles WHERE id = $1 FOR UPDATE', [vehicleId]);
  if (!v) throw new HttpError(404, 'Không tìm thấy xe');
  if (!/^S[1-9]$/.test(status)) throw new HttpError(400, 'Mã trạng thái không hợp lệ');
  const incidentId = opts.incidentId !== undefined ? opts.incidentId : v.current_incident_id;
  if (v.status !== status) {
    await tx.query('UPDATE vehicle_status_log SET ended_at = now() WHERE vehicle_id = $1 AND ended_at IS NULL', [vehicleId]);
    await tx.query('INSERT INTO vehicle_status_log(vehicle_id, status, incident_id, user_id) VALUES ($1,$2,$3,$4)',
      [vehicleId, status, incidentId, actor.id]);
  }
  await tx.query(`
    UPDATE vehicles SET status = $2, status_since = CASE WHEN status = $2 THEN status_since ELSE now() END,
           current_incident_id = $3, free_hint_at = CASE WHEN status = $2 THEN free_hint_at ELSE NULL END,
           lat = COALESCE($4, lat), lng = COALESCE($5, lng), location_at = CASE WHEN $4::float8 IS NULL THEN location_at ELSE now() END
     WHERE id = $1`,
  [vehicleId, status, ['S1', 'S2', 'S9'].includes(status) ? null : incidentId, opts.lat ?? null, opts.lng ?? null]);
  if (incidentId) {
    await audit(tx, incidentScope(incidentId), actor, 'vehicle.status', 'vehicle', vehicleId, { from: v.status, to: status });
  }
  return { previous: v.status, incidentId };
}

/** Ánh xạ trạng thái xe sang mốc thời gian và trạng thái ca (mục 5.2, 15.1) */
const STATUS_TIME: Record<string, { time: string; source: string; incidentStatus?: string }> = {
  S4: { time: 'T6', source: 'Nút trạng thái', incidentStatus: 'dispatched' },
  S5: { time: 'T7', source: 'Nút trạng thái', incidentStatus: 'on_scene' },
  S6: { time: 'T10', source: 'Nút trạng thái', incidentStatus: 'transporting' },
  S7: { time: 'T12', source: 'Nút trạng thái', incidentStatus: 'at_hospital' },
};

export async function crewStatus(tx: Tx, actor: Actor, vehicleId: string, status: string, pos?: { lat?: number; lng?: number }) {
  if (status === 'S1' || status === 'S2') {
    // Ca nghi lây nhiễm: chưa ký phiếu khử khuẩn đủ mức thì xe chưa được báo sẵn sàng (QLCL-05)
    const cur = await one(tx, 'SELECT current_incident_id FROM vehicles WHERE id = $1', [vehicleId]);
    if (cur?.current_incident_id) await assertDisinfected(tx, vehicleId, cur.current_incident_id);
  }
  const { incidentId } = await setVehicleStatus(tx, actor, vehicleId, status, pos);
  if (!incidentId) return;
  if (['S8', 'S1', 'S2'].includes(status)) await ensureDisinfection(tx, vehicleId, incidentId);
  const m = STATUS_TIME[status];
  if (m) {
    await recordTime(tx, incidentId, m.time, new Date(), m.source, actor);
    if (status === 'S4') {
      // Xuất phát cũng là xác nhận lệnh nếu kíp chưa bấm
      await ackAssignment(tx, actor, vehicleId);
    }
    if (m.incidentStatus) {
      await tx.query(`UPDATE incidents SET status = $2, updated_at = now() WHERE id = $1 AND status NOT IN ('closed','cancelled','transferred_115')`,
        [incidentId, m.incidentStatus]);
    }
  }
  if (status === 'S1' || status === 'S2') {
    await recordTime(tx, incidentId, 'T14', new Date(), 'Nút trạng thái', actor);
    await tx.query(`UPDATE assignments SET ended_at = now(), end_reason = 'Hoàn thành' WHERE vehicle_id = $1 AND incident_id = $2 AND ended_at IS NULL`,
      [vehicleId, incidentId]);
    const left = await one(tx, 'SELECT count(*)::int AS n FROM assignments WHERE incident_id = $1 AND ended_at IS NULL', [incidentId]);
    if (left.n === 0) {
      await tx.query(`UPDATE incidents SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1 AND status NOT IN ('cancelled','transferred_115')`, [incidentId]);
      await audit(tx, incidentScope(incidentId), actor, 'incident.closed', 'incident', incidentId, { reason: 'Xe sẵn sàng trở lại' });
      await queueSurvey(tx, incidentId);
    }
  }
}

export async function ackAssignment(tx: Tx, actor: Actor, vehicleId: string) {
  const a = await one(tx, `UPDATE assignments SET acknowledged_at = now()
                           WHERE vehicle_id = $1 AND ended_at IS NULL AND acknowledged_at IS NULL RETURNING *`, [vehicleId]);
  if (a) {
    await recordTime(tx, a.incident_id, 'T5', new Date(), 'Máy tính bảng', actor);
    await audit(tx, incidentScope(a.incident_id), actor, 'assignment.acknowledged', 'vehicle', vehicleId, {});
  }
  return a;
}

/** Bán kính tự động báo xe gần nhất (km); xa hơn phải điều phối viên xác nhận */
export const AUTO_DISPATCH_KM = Number(process.env.MEDONE_AUTO_DISPATCH_KM) > 0 ? Number(process.env.MEDONE_AUTO_DISPATCH_KM) : 5;

/** Khoảng cách xe (vị trí GPS, không có thì vị trí trạm) tới hiện trường; null nếu thiếu tọa độ */
export async function vehicleDistanceKm(q: Queryable, vehicleId: string, scene: { lat: number | null; lng: number | null }) {
  if (scene.lat == null || scene.lng == null) return null;
  const v = await one(q, `SELECT coalesce(v.lat, s.lat) AS lat, coalesce(v.lng, s.lng) AS lng
                            FROM vehicles v JOIN stations s ON s.id = v.station_id WHERE v.id = $1`, [vehicleId]);
  if (!v || v.lat == null || v.lng == null) return null;
  return Math.round(haversineKm({ lat: v.lat, lng: v.lng }, { lat: scene.lat, lng: scene.lng }) * 10) / 10;
}

export interface AssignOptions {
  divertReason?: string | null; confirmFar?: boolean; auto?: boolean;
  /** Trưởng ca cho xe thiếu thiết bị bắt buộc đi (ghi lý do vào nhật ký) */
  equipmentOverride?: string | null;
}

export async function assignVehicle(tx: Tx, actor: Actor, incidentId: string, vehicleId: string, opts: AssignOptions = {}) {
  const { divertReason } = opts;
  const inc = await getIncident(tx, incidentId, true);
  if (!inc.confirmed_at) throw new HttpError(409, 'Chưa xác nhận mã ưu tiên và loại xe: không được kích hoạt');
  if (['closed', 'cancelled', 'transferred_115', 'advice_only'].includes(inc.status)) throw new HttpError(409, 'Ca đã đóng');
  const v = await one(tx, 'SELECT * FROM vehicles WHERE id = $1 FOR UPDATE', [vehicleId]);
  if (!v) throw new HttpError(404, 'Không tìm thấy xe');
  if (!['S1', 'S2'].includes(v.status)) {
    // Rút xe từ ca thấp hơn cho ca P1 (mục 5.6)
    const cur = v.current_incident_id ? await one(tx, 'SELECT id, code, final_priority FROM incidents WHERE id = $1', [v.current_incident_id]) : null;
    const canDivert = inc.final_priority === 'P1' && cur && ['P3', 'P4', 'HEN'].includes(cur.final_priority) && ['S3', 'S4'].includes(v.status);
    if (!canDivert) throw new HttpError(409, `Xe ${vehicleId} đang ${v.status}, không sẵn sàng`);
    if (!divertReason?.trim()) throw new HttpError(400, 'Rút xe từ ca khác phải ghi lý do');
    await tx.query(`UPDATE assignments SET ended_at = now(), end_reason = $3 WHERE vehicle_id = $1 AND incident_id = $2 AND ended_at IS NULL`,
      [vehicleId, cur.id, `Rút xe cho ca P1 ${inc.code}: ${divertReason}`]);
    await tx.query(`UPDATE incidents SET status = 'confirmed', updated_at = now() WHERE id = $1`, [cur.id]);
    await audit(tx, incidentScope(cur.id), actor, 'assignment.diverted', 'vehicle', vehicleId, { toIncident: inc.code, reason: divertReason });
  }
  const gaps = (await equipmentGaps(tx, [vehicleId]))[vehicleId] ?? [];
  if (gaps.length && !opts.equipmentOverride?.trim()) {
    throw new HttpError(409, `Xe ${vehicleId} thiếu thiết bị bắt buộc: ${gapText(gaps)}. Chỉ trưởng ca được cho xe đi, kèm lý do`,
      { code: 'EQUIPMENT', vehicleId, gaps });
  }
  const distanceKm = await vehicleDistanceKm(tx, vehicleId, inc);
  if (distanceKm != null && distanceKm > AUTO_DISPATCH_KM && !opts.confirmFar) {
    throw new HttpError(409, `Xe ${vehicleId} cách hiện trường ${distanceKm} km (> ${AUTO_DISPATCH_KM} km): cần điều phối viên xác nhận`,
      { code: 'FAR', vehicleId, distanceKm, limitKm: AUTO_DISPATCH_KM });
  }
  const a = await one(tx, 'INSERT INTO assignments(incident_id, vehicle_id, assigned_by) VALUES ($1,$2,$3) RETURNING *',
    [incidentId, vehicleId, actor.id]);
  await audit(tx, incidentScope(incidentId), actor, opts.auto ? 'assignment.auto' : 'assignment.created', 'vehicle', vehicleId, {
    vehicleType: v.type, divertReason: divertReason ?? null, distanceKm,
    equipmentOverride: gaps.length ? { reason: opts.equipmentOverride, gaps: gapText(gaps) } : undefined,
    farConfirmed: distanceKm != null && distanceKm > AUTO_DISPATCH_KM ? true : undefined,
  });
  await recordTime(tx, incidentId, 'T4', new Date(), 'CAD → máy tính bảng', actor);
  await setVehicleStatus(tx, actor, vehicleId, 'S3', { incidentId });
  await tx.query(`UPDATE incidents SET status = 'dispatched', updated_at = now() WHERE id = $1 AND status IN ('confirmed','awaiting_confirm','intake')`, [incidentId]);
  return a;
}

export async function unassignVehicle(tx: Tx, actor: Actor, incidentId: string, vehicleId: string, reason: string) {
  const a = await one(tx, `UPDATE assignments SET ended_at = now(), end_reason = $3 WHERE incident_id = $1 AND vehicle_id = $2 AND ended_at IS NULL RETURNING *`,
    [incidentId, vehicleId, reason]);
  if (!a) throw new HttpError(404, 'Xe không được giao cho ca này');
  await setVehicleStatus(tx, actor, vehicleId, 'S2', { incidentId: null });
  await audit(tx, incidentScope(incidentId), actor, 'assignment.cancelled', 'vehicle', vehicleId, { reason });
}
