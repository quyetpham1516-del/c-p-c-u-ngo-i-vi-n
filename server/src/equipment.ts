import { audit, type Actor } from './audit.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';

/**
 * Trang thiết bị theo số seri và dụng cụ dùng lại (QLCL-15).
 * Một thiết bị dùng được khi đang lắp trên xe, trạng thái hoạt động, và chưa quá hạn kiểm định, hiệu chuẩn.
 * Xe thiếu thiết bị bắt buộc theo loại xe thì không được giao (trưởng ca có thể cho đi kèm lý do, ghi nhật ký).
 */

export const EQUIPMENT_STATUS: Record<string, string> = { hoat_dong: 'Hoạt động', hong: 'Hỏng', bao_tri: 'Đang bảo trì', thanh_ly: 'Thanh lý' };

export interface EquipmentGap {
  typeId: number;
  type: string;
  need: number;
  have: number;
  /** Lý do các thiết bị cùng loại trên xe không tính: hỏng, quá hạn kiểm định... */
  issues: string[];
}

/** Thiết bị bắt buộc còn thiếu của từng xe (rỗng = đủ) */
export async function equipmentGaps(q: Queryable, vehicleIds?: string[]): Promise<Record<string, EquipmentGap[]>> {
  const rows = await many(q, `
    SELECT v.id AS vehicle_id, r.equipment_type_id AS type_id, t.name AS type, r.qty AS need,
           count(e.id) FILTER (WHERE e.status = 'hoat_dong'
                                 AND (e.next_inspection IS NULL OR e.next_inspection >= vn_today())
                                 AND (e.next_calibration IS NULL OR e.next_calibration >= vn_today()))::int AS have,
           coalesce(array_agg(
             e.serial || ': ' || CASE
               WHEN e.status <> 'hoat_dong' THEN CASE e.status WHEN 'hong' THEN 'hỏng' WHEN 'bao_tri' THEN 'đang bảo trì' ELSE 'thanh lý' END
               WHEN e.next_inspection < vn_today() THEN 'quá hạn kiểm định ' || e.next_inspection
               ELSE 'quá hạn hiệu chuẩn ' || e.next_calibration END
           ) FILTER (WHERE e.id IS NOT NULL AND (e.status <> 'hoat_dong' OR e.next_inspection < vn_today() OR e.next_calibration < vn_today())), '{}') AS issues
      FROM vehicles v
      JOIN vehicle_required_equipment r ON r.vehicle_type = v.type
      JOIN equipment_types t ON t.id = r.equipment_type_id
      LEFT JOIN equipment e ON e.vehicle_id = v.id AND e.type_id = r.equipment_type_id
     WHERE ($1::text[] IS NULL OR v.id = ANY($1))
     GROUP BY v.id, r.equipment_type_id, t.name, r.qty`, [vehicleIds ?? null]);
  const out: Record<string, EquipmentGap[]> = {};
  for (const r of rows) {
    out[r.vehicle_id] ??= [];
    if (r.have < r.need) out[r.vehicle_id].push({ typeId: r.type_id, type: r.type, need: r.need, have: r.have, issues: r.issues });
  }
  return out;
}

export function gapText(gaps: EquipmentGap[]): string {
  return gaps.map((g) => `${g.type} (có ${g.have}/${g.need}${g.issues.length ? `; ${g.issues.join(', ')}` : ''})`).join('; ');
}

function addDays(days: number | null | undefined, from = new Date()): string | null {
  if (!days) return null;
  return new Date(from.getTime() + 7 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
}

async function placeCheck(tx: Tx, stationId: string, vehicleId: string | null) {
  const s = await one(tx, 'SELECT active FROM stations WHERE id = $1', [stationId]);
  if (!s) throw new HttpError(404, 'Không tìm thấy điểm');
  if (vehicleId) {
    const v = await one(tx, 'SELECT station_id FROM vehicles WHERE id = $1', [vehicleId]);
    if (!v) throw new HttpError(404, 'Không tìm thấy xe');
    if (v.station_id !== stationId) throw new HttpError(409, `Xe ${vehicleId} thuộc điểm ${v.station_id}, không phải ${stationId}`);
  }
}

export async function createEquipment(tx: Tx, actor: Actor, b: {
  typeId: number; serial: string; model?: string | null; stationId: string; vehicleId?: string | null;
  nextMaintenance?: string | null; nextInspection?: string | null; nextCalibration?: string | null; note?: string | null;
}) {
  const t = await one(tx, 'SELECT * FROM equipment_types WHERE id = $1', [b.typeId]);
  if (!t) throw new HttpError(404, 'Không tìm thấy loại thiết bị');
  await placeCheck(tx, b.stationId, b.vehicleId ?? null);
  const dup = await one(tx, 'SELECT 1 FROM equipment WHERE serial = $1', [b.serial.trim()]);
  if (dup) throw new HttpError(409, `Số seri ${b.serial} đã có`);
  const e = await one(tx, `INSERT INTO equipment(type_id, serial, model, station_id, vehicle_id, next_maintenance, next_inspection, next_calibration, note)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [b.typeId, b.serial.trim(), b.model ?? null, b.stationId, b.vehicleId ?? null,
    b.nextMaintenance ?? addDays(t.maintenance_days), b.nextInspection ?? null, b.nextCalibration ?? null, b.note ?? null]);
  await tx.query(`INSERT INTO equipment_events(equipment_id, kind, user_id, note) VALUES ($1, 'nhap', $2, $3)`, [e.id, actor.id, b.note ?? null]);
  await audit(tx, 'system', actor, 'equipment.created', 'equipment', e.id, { serial: e.serial, type: t.name, stationId: b.stationId, vehicleId: b.vehicleId ?? null });
  return e;
}

/**
 * Ghi một sự kiện cho thiết bị: bảo dưỡng, kiểm định, hiệu chuẩn (tự tính hạn kế tiếp theo chu kỳ của loại),
 * báo hỏng, sửa xong, chuyển chỗ, thanh lý.
 */
export async function equipmentEvent(tx: Tx, actor: Actor, id: string, b: {
  kind: 'kiem_tra' | 've_sinh' | 'bao_duong' | 'kiem_dinh' | 'hieu_chuan' | 'bao_hong' | 'sua_xong' | 'dieu_chuyen' | 'thanh_ly';
  note?: string | null; certNo?: string | null; nextDue?: string | null; stationId?: string | null; vehicleId?: string | null;
}) {
  const e = await one(tx, `SELECT e.*, t.name AS type_name, t.maintenance_days, t.inspection_days, t.calibration_days
                             FROM equipment e JOIN equipment_types t ON t.id = e.type_id WHERE e.id = $1 FOR UPDATE OF e`, [id]);
  if (!e) throw new HttpError(404, 'Không tìm thấy thiết bị');
  if (e.status === 'thanh_ly') throw new HttpError(409, 'Thiết bị đã thanh lý');
  let nextDue: string | null = null;
  switch (b.kind) {
    case 'kiem_tra':
      // Kiểm tra nhanh đầu ca (quét QR): chỉ xác nhận thiết bị đang hoạt động tốt; thiết bị hỏng phải báo hỏng hoặc sửa xong trước
      if (e.status !== 'hoat_dong') throw new HttpError(409, 'Thiết bị đang không ở trạng thái hoạt động; báo kỹ thuật xử lý trước');
      break;
    case 've_sinh':
      break;
    case 'bao_duong':
      nextDue = b.nextDue ?? addDays(e.maintenance_days);
      await tx.query(`UPDATE equipment SET next_maintenance = $2, status = CASE WHEN status = 'bao_tri' THEN 'hoat_dong' ELSE status END WHERE id = $1`, [id, nextDue]);
      break;
    case 'kiem_dinh':
      if (!b.certNo?.trim()) throw new HttpError(400, 'Kiểm định phải ghi số giấy chứng nhận');
      nextDue = b.nextDue ?? addDays(e.inspection_days ?? 365);
      await tx.query('UPDATE equipment SET next_inspection = $2 WHERE id = $1', [id, nextDue]);
      break;
    case 'hieu_chuan':
      if (!b.certNo?.trim()) throw new HttpError(400, 'Hiệu chuẩn phải ghi số giấy chứng nhận');
      nextDue = b.nextDue ?? addDays(e.calibration_days ?? 365);
      await tx.query('UPDATE equipment SET next_calibration = $2 WHERE id = $1', [id, nextDue]);
      break;
    case 'bao_hong':
      if (!b.note?.trim()) throw new HttpError(400, 'Mô tả hỏng hóc');
      await tx.query(`UPDATE equipment SET status = 'hong' WHERE id = $1`, [id]);
      break;
    case 'sua_xong':
      await tx.query(`UPDATE equipment SET status = 'hoat_dong' WHERE id = $1`, [id]);
      break;
    case 'dieu_chuyen': {
      const stationId = b.stationId ?? e.station_id;
      await placeCheck(tx, stationId, b.vehicleId ?? null);
      await tx.query('UPDATE equipment SET station_id = $2, vehicle_id = $3 WHERE id = $1', [id, stationId, b.vehicleId ?? null]);
      break;
    }
    case 'thanh_ly':
      if (!b.note?.trim()) throw new HttpError(400, 'Ghi lý do thanh lý');
      await tx.query(`UPDATE equipment SET status = 'thanh_ly', vehicle_id = NULL WHERE id = $1`, [id]);
      break;
  }
  const note = b.kind === 'dieu_chuyen'
    ? [`${e.vehicle_id ?? e.station_id} → ${b.vehicleId ?? b.stationId ?? e.station_id}`, b.note].filter(Boolean).join('. ') : b.note ?? null;
  await tx.query('INSERT INTO equipment_events(equipment_id, kind, user_id, note, cert_no, next_due) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, b.kind, actor.id, note, b.certNo ?? null, nextDue]);
  await audit(tx, 'system', actor, `equipment.${b.kind}`, 'equipment', id, { serial: e.serial, note, certNo: b.certNo ?? null, nextDue });
  return one(tx, 'SELECT * FROM equipment WHERE id = $1', [id]);
}

/** Thiết bị đến hạn bảo dưỡng, kiểm định, hiệu chuẩn trong N ngày tới (kể cả đã quá hạn) */
export async function equipmentDue(q: Queryable, days = 30, stationId: string | null = null) {
  return many(q, `
    SELECT e.id, e.serial, e.model, e.station_id, e.vehicle_id, e.status, t.name AS type_name, x.kind, x.due, (x.due - vn_today()) AS days_left
      FROM equipment e JOIN equipment_types t ON t.id = e.type_id
      CROSS JOIN LATERAL (VALUES ('bao_duong', e.next_maintenance), ('kiem_dinh', e.next_inspection), ('hieu_chuan', e.next_calibration)) AS x(kind, due)
     WHERE e.status <> 'thanh_ly' AND x.due IS NOT NULL AND x.due < vn_today() + $1::int
       AND ($2::text IS NULL OR e.station_id = $2)
     ORDER BY x.due`, [days, stationId]);
}

/* ---------- Dụng cụ dùng lại và tiệt khuẩn ---------- */

export const SET_STATUS: Record<string, string> = { san_sang: 'Sẵn sàng', da_dung: 'Đã dùng, chờ tiệt khuẩn', dang_tiet_khuan: 'Đang tiệt khuẩn', hong: 'Hỏng' };

export async function createInstrumentSet(tx: Tx, actor: Actor, b: { code: string; name: string; stationId: string; vehicleId?: string | null }) {
  await placeCheck(tx, b.stationId, b.vehicleId ?? null);
  const dup = await one(tx, 'SELECT 1 FROM instrument_sets WHERE code = $1', [b.code.trim()]);
  if (dup) throw new HttpError(409, `Mã bộ dụng cụ ${b.code} đã có`);
  // Bộ mới nhận về chưa qua tiệt khuẩn tại Medone: để trạng thái chờ tiệt khuẩn
  const s = await one(tx, `INSERT INTO instrument_sets(code, name, station_id, vehicle_id, status) VALUES ($1,$2,$3,$4,'da_dung') RETURNING *`,
    [b.code.trim(), b.name.trim(), b.stationId, b.vehicleId ?? null]);
  await audit(tx, 'system', actor, 'instrument.created', 'instrument_set', s.id, { code: s.code, name: s.name });
  return s;
}

/** Kíp báo đã dùng bộ dụng cụ cho ca (kèm mã ca nếu có): bộ chuyển sang chờ tiệt khuẩn */
export async function markSetUsed(tx: Tx, actor: Actor, setId: string, incidentId?: string | null) {
  const s = await one(tx, 'SELECT * FROM instrument_sets WHERE id = $1 FOR UPDATE', [setId]);
  if (!s) throw new HttpError(404, 'Không tìm thấy bộ dụng cụ');
  if (s.status !== 'san_sang') throw new HttpError(409, `Bộ ${s.code} đang ở trạng thái "${SET_STATUS[s.status]}", không dùng được`);
  await tx.query(`UPDATE instrument_sets SET status = 'da_dung', last_used_at = now(), last_incident_id = $2 WHERE id = $1`, [setId, incidentId ?? null]);
  await audit(tx, 'system', actor, 'instrument.used', 'instrument_set', setId, { code: s.code, incidentId: incidentId ?? null });
}

export async function startSterilization(tx: Tx, actor: Actor, b: { method: 'hap_uot' | 'eo' | 'plasma'; stationId: string; setIds: string[]; shelfDays?: number; note?: string | null }) {
  const sets = await many(tx, 'SELECT * FROM instrument_sets WHERE id = ANY($1) FOR UPDATE', [b.setIds]);
  if (sets.length !== b.setIds.length) throw new HttpError(404, 'Có bộ dụng cụ không tồn tại');
  const bad = sets.filter((s) => s.status !== 'da_dung');
  if (bad.length) throw new HttpError(409, `Chỉ đưa vào lô hấp các bộ đã dùng: ${bad.map((s) => s.code).join(', ')}`);
  const year = new Date().getFullYear();
  const n = await nextCounter(tx, 'sterilization', String(year));
  const batch = await one(tx, `INSERT INTO sterilization_batches(code, method, station_id, started_by, shelf_days, note)
                               VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
  [`TK-${year}-${String(n).padStart(5, '0')}`, b.method, b.stationId, actor.id, b.shelfDays ?? 30, b.note ?? null]);
  for (const s of sets) await tx.query('INSERT INTO sterilization_items(batch_id, set_id) VALUES ($1,$2)', [batch.id, s.id]);
  await tx.query(`UPDATE instrument_sets SET status = 'dang_tiet_khuan' WHERE id = ANY($1)`, [b.setIds]);
  await audit(tx, 'system', actor, 'sterilization.started', 'sterilization_batch', batch.id, { code: batch.code, sets: sets.map((s) => s.code) });
  return batch;
}

/**
 * Kết thúc lô tiệt khuẩn: chỉ thị đạt thì các bộ sẵn sàng với hạn vô khuẩn = hôm nay + số ngày bảo quản;
 * không đạt thì các bộ trở lại chờ tiệt khuẩn.
 */
export async function finishSterilization(tx: Tx, actor: Actor, id: string, b: { indicatorOk: boolean; biOk?: boolean | null; note?: string | null }) {
  const batch = await one(tx, 'SELECT * FROM sterilization_batches WHERE id = $1 FOR UPDATE', [id]);
  if (!batch) throw new HttpError(404, 'Không tìm thấy lô tiệt khuẩn');
  if (batch.status !== 'dang_chay') throw new HttpError(409, 'Lô đã kết thúc');
  const passed = b.indicatorOk && b.biOk !== false;
  await tx.query(`UPDATE sterilization_batches SET status = $2, finished_at = now(), finished_by = $3, indicator_ok = $4, bi_ok = $5,
                         note = coalesce($6, note) WHERE id = $1`, [id, passed ? 'dat' : 'khong_dat', actor.id, b.indicatorOk, b.biOk ?? null, b.note ?? null]);
  const setIds = (await many(tx, 'SELECT set_id FROM sterilization_items WHERE batch_id = $1', [id])).map((r) => r.set_id);
  if (passed) {
    await tx.query(`UPDATE instrument_sets SET status = 'san_sang', cycles = cycles + 1, sterile_until = $2 WHERE id = ANY($1)`,
      [setIds, addDays(batch.shelf_days)]);
  } else {
    await tx.query(`UPDATE instrument_sets SET status = 'da_dung' WHERE id = ANY($1)`, [setIds]);
  }
  await audit(tx, 'system', actor, passed ? 'sterilization.passed' : 'sterilization.failed', 'sterilization_batch', id, { code: batch.code, indicatorOk: b.indicatorOk, biOk: b.biOk ?? null });
  return { passed, sets: setIds.length };
}
