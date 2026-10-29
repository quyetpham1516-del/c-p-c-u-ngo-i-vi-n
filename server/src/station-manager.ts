import { many, one, type Queryable } from './db.js';
import { HttpError } from './domain.js';
import { centralStation, shortages } from './inventory.js';

/**
 * Quản lý điểm và người thay (người dự phòng có đủ quyền khi quản lý vắng). Quản trị gán trong nhân viên của điểm.
 * Quản lý điểm lập phiếu đề xuất, ký nhận phiếu đề xuất và phiếu lĩnh, kiểm kê kho điểm, xem nhân sự, xe, thiết bị của điểm.
 */

export async function managersOf(q: Queryable, stationId: string): Promise<{ manager_id: string | null; deputy_id: string | null } | null> {
  return (await one(q, 'SELECT manager_id, deputy_id FROM stations WHERE id = $1', [stationId])) ?? null;
}

export async function isStationManager(q: Queryable, userId: string, stationId: string) {
  const m = await managersOf(q, stationId);
  return !!m && (m.manager_id === userId || m.deputy_id === userId);
}

/** Các điểm người này đang quản lý hoặc làm người thay */
export async function managedStations(q: Queryable, userId: string) {
  return many(q, `SELECT id, name, CASE WHEN manager_id = $1 THEN 'quan_ly' ELSE 'nguoi_thay' END AS as_role
                    FROM stations WHERE active AND (manager_id = $1 OR deputy_id = $1) ORDER BY id`, [userId]);
}

/** Người làm ở điểm (được phân điểm, hoặc đang nhận ca trên xe của điểm) */
export async function worksAt(q: Queryable, userId: string, stationId: string) {
  return !!(await one(q, `SELECT 1 FROM users u WHERE u.id = $1 AND (u.station_id = $2 OR EXISTS (
                            SELECT 1 FROM crew_shifts cs JOIN vehicles v ON v.id = cs.vehicle_id WHERE cs.user_id = u.id AND cs.ended_at IS NULL AND v.station_id = $2))`,
  [userId, stationId]));
}

/** Quyền với phiếu của điểm: ai lập phiếu đề xuất, ai lập phiếu đề xuất khẩn, ai ký nhận */
export async function stationSlipRights(q: Queryable, user: { id: string; role: string }, stationId: string) {
  const m = await managersOf(q, stationId);
  if (!m) throw new HttpError(404, 'Không tìm thấy điểm');
  const manager = m.manager_id === user.id || m.deputy_id === user.id;
  const hasManager = !!(m.manager_id || m.deputy_id);
  const staff = ['crew', 'supervisor'].includes(user.role) && await worksAt(q, user.id, stationId);
  return {
    manager, hasManager,
    // Điểm đã có quản lý: chỉ quản lý, người thay lập và ký nhận; kíp chỉ báo thiếu (hoặc phiếu khẩn). Chưa gán quản lý: kíp của điểm làm như cũ.
    canPropose: manager || (!hasManager && staff),
    canUrgent: !manager && hasManager && staff,
    canReceive: manager || (!hasManager && staff),
    canReport: staff || manager,
  };
}

/** Tổng quan một điểm cho quản lý điểm: nhân sự, xe, kho, thiết bị, phiếu, kiểm kê, bàn giao */
export async function stationOverview(q: Queryable, stationId: string) {
  const station = await one(q, `SELECT s.id, s.name, s.kind, s.manager_id, s.deputy_id,
                                       (SELECT full_name FROM users WHERE id = s.manager_id) AS manager_name,
                                       (SELECT full_name FROM users WHERE id = s.deputy_id) AS deputy_name
                                  FROM stations s WHERE s.id = $1`, [stationId]);
  if (!station) throw new HttpError(404, 'Không tìm thấy điểm');
  const central = await centralStation(q);
  const [staff, vehicles, duty, below, expiring, equipment, slips, shortageReports, stocktake, handovers] = await Promise.all([
    many(q, `SELECT u.id, u.full_name, u.title, u.role, u.license_no, cs.vehicle_id AS on_shift_vehicle, cs.crew_role, cs.started_at
               FROM users u LEFT JOIN crew_shifts cs ON cs.user_id = u.id AND cs.ended_at IS NULL
              WHERE u.active AND (u.station_id = $1 OR cs.vehicle_id IN (SELECT id FROM vehicles WHERE station_id = $1))
              ORDER BY (cs.id IS NULL), u.full_name`, [stationId]),
    many(q, `SELECT v.id, v.type, v.status, v.plate,
                    (SELECT count(*)::int FROM crew_shifts cs WHERE cs.vehicle_id = v.id AND cs.ended_at IS NULL) AS crew_on,
                    (SELECT h.status FROM vehicle_handovers h WHERE h.vehicle_id = v.id AND h.status <> 'da_khoa' ORDER BY h.created_at DESC LIMIT 1) AS handover
               FROM vehicles v WHERE v.station_id = $1 ORDER BY v.id`, [stationId]),
    many(q, `SELECT d.id, d.vehicle_id, d.place, d.starts_at, d.ends_at FROM duty_posts d
              WHERE d.status <> 'huy' AND d.ends_at > now() AND (d.station_id = $1 OR d.vehicle_id IN (SELECT id FROM vehicles WHERE station_id = $1))
              ORDER BY d.starts_at LIMIT 20`, [stationId]),
    stationId === central ? Promise.resolve([]) : shortages(q, stationId),
    many(q, `SELECT d.name AS drug_name, d.unit, l.lot, l.expiry::text AS expiry, l.qty::float AS qty, l.vehicle_id
               FROM stock_lots l JOIN drugs d ON d.id = l.drug_id
              WHERE l.station_id = $1 AND l.qty > 0 AND l.expiry <= vn_today() + 30 ORDER BY l.expiry LIMIT 50`, [stationId]),
    many(q, `SELECT e.id, t.name, e.serial, e.asset_code, e.status, e.vehicle_id,
                    least(e.next_maintenance, e.next_inspection, e.next_calibration)::text AS next_due
               FROM equipment e JOIN equipment_types t ON t.id = e.type_id
              WHERE e.station_id = $1 AND (e.status IN ('hong', 'bao_tri')
                 OR least(e.next_maintenance, e.next_inspection, e.next_calibration) <= vn_today() + 14) AND e.status <> 'thanh_ly'
              ORDER BY e.status, t.name`, [stationId]),
    many(q, `SELECT r.id, r.code, r.source, r.status, r.urgent, r.created_at FROM stock_requisitions r
              WHERE r.station_id = $1 AND r.status IN ('cho_duyet', 'da_duyet', 'da_xuat') ORDER BY r.created_at DESC`, [stationId]),
    many(q, `SELECT s.id, s.drug_id, coalesce(d.name, s.item_text) AS item, d.unit, s.qty::float AS qty, s.note, s.reported_at, u.full_name AS reported_by_name
               FROM station_shortages s LEFT JOIN drugs d ON d.id = s.drug_id JOIN users u ON u.id = s.reported_by
              WHERE s.station_id = $1 AND s.closed_at IS NULL ORDER BY s.reported_at`, [stationId]),
    one(q, `SELECT id, due_date::text AS due_date, status FROM stocktake_sessions WHERE station_id = $1 ORDER BY due_date DESC LIMIT 1`, [stationId]),
    many(q, `SELECT h.id, h.vehicle_id, h.status, h.created_at FROM vehicle_handovers h JOIN vehicles v ON v.id = h.vehicle_id
              WHERE v.station_id = $1 AND h.status <> 'da_khoa' ORDER BY h.created_at`, [stationId]),
  ]);
  return { station, isCentral: stationId === central, staff, vehicles, duty, belowMin: below, expiring, equipment, slips, shortages: shortageReports, stocktake, handovers };
}
