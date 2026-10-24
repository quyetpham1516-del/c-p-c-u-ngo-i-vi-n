import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { hashPassword } from './crypto.js';
import { createPool, withTx } from './db.js';
import { migrate } from './migrate.js';
import { restockVehicle } from './stock.js';

/**
 * Dữ liệu mẫu cho các phân hệ quản trị (chỉ dùng cho môi trường thử): tài khoản cho các vai trò mới,
 * thiết bị bắt buộc trên từng xe mẫu (số seri MAU-...), bù cơ số thuốc cho xe từ kho điểm, bộ dụng cụ mẫu.
 * Chạy lại nhiều lần không tạo trùng: xe đã có thiết bị thì bỏ qua, tài khoản đã có thì bỏ qua.
 */

export const DEMO_STAFF: [string, string, string, string][] = [
  ['duoc', 'Dược sĩ kho', 'pharmacist', 'Dược sĩ'],
  ['kythuat', 'Kỹ sư thiết bị', 'technician', 'Kỹ thuật'],
  ['ksnk', 'Điều dưỡng KSNK', 'ipc', 'KSNK'],
  ['nhansu', 'Cán bộ hành chính – nhân sự', 'hr', 'Hành chính'],
  ['ketoan', 'Kế toán – thu ngân', 'accountant', 'Kế toán'],
  ['giamdoc', 'Ban Giám đốc', 'director', 'Giám đốc'],
];

export async function seedDemoOps(pool: pg.Pool, password: string): Promise<{ users: number; equipment: number; restocked: number; sets: number }> {
  let users = 0;
  const pw = hashPassword(password);
  for (const [username, name, role, title] of DEMO_STAFF) {
    const r = await pool.query(`INSERT INTO users(username, full_name, role, title, password_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO NOTHING`,
      [username, name, role, title, pw]);
    users += r.rowCount ?? 0;
  }
  const admin = (await pool.query(`SELECT id, full_name FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`)).rows[0];
  const actor = { id: admin.id as string, name: admin.full_name as string };

  let equipment = 0;
  const vehicles = (await pool.query(`SELECT v.id, v.type, v.station_id FROM vehicles v
                                       WHERE NOT EXISTS (SELECT 1 FROM equipment e WHERE e.vehicle_id = v.id) ORDER BY v.id`)).rows;
  for (const v of vehicles) {
    const req = (await pool.query(`SELECT t.id, t.name, t.inspection_days, t.calibration_days, t.maintenance_days, r.qty
                                     FROM vehicle_required_equipment r JOIN equipment_types t ON t.id = r.equipment_type_id
                                    WHERE r.vehicle_type = $1 ORDER BY t.id`, [v.type])).rows;
    let n = 0;
    for (const t of req) {
      for (let i = 0; i < t.qty; i++) {
        n++;
        await pool.query(`INSERT INTO equipment(type_id, serial, model, station_id, vehicle_id, next_maintenance, next_inspection, next_calibration, note)
                          VALUES ($1, $2, 'Mẫu', $3, $4,
                                  current_date + make_interval(days => coalesce($5, 180)),
                                  CASE WHEN $6::int IS NULL THEN NULL ELSE current_date + interval '1 year' END::date,
                                  CASE WHEN $7::int IS NULL THEN NULL ELSE current_date + interval '1 year' END::date,
                                  'Dữ liệu mẫu') ON CONFLICT (serial) DO NOTHING`,
        [t.id, `MAU-${v.id}-${String(n).padStart(2, '0')}`, v.station_id, v.id, t.maintenance_days, t.inspection_days, t.calibration_days]);
        equipment++;
      }
    }
  }

  let restocked = 0;
  for (const v of (await pool.query('SELECT id FROM vehicles ORDER BY id')).rows) {
    const r = await withTx(pool, (tx) => restockVehicle(tx, actor, v.id, 'Dữ liệu mẫu'));
    if (r.lines) restocked++;
  }

  let sets = 0;
  for (const v of (await pool.query(`SELECT id, station_id FROM vehicles WHERE type IN ('ALS', 'DP', 'BLS') ORDER BY id`)).rows) {
    for (const [code, name] of [['NKQ', 'Bộ đặt nội khí quản'], ['DS', 'Bộ đỡ sanh'], ['TP', 'Bộ tiểu phẫu']]) {
      const r = await pool.query(`INSERT INTO instrument_sets(code, name, station_id, vehicle_id, status, sterile_until, cycles)
                                  VALUES ($1, $2, $3, $4, 'san_sang', current_date + 30, 1) ON CONFLICT (code) DO NOTHING`,
      [`${code}-${v.id}`, name, v.station_id, v.id]);
      sets += r.rowCount ?? 0;
    }
  }
  return { users, equipment, restocked, sets };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool();
  const given = process.env.MEDONE_SEED_PASSWORD;
  const password = given || randomBytes(9).toString('base64url');
  migrate(pool)
    .then(() => seedDemoOps(pool, password))
    .then((r) => {
      console.log(`Dữ liệu mẫu: ${r.users} tài khoản mới, ${r.equipment} thiết bị, bù cơ số ${r.restocked} xe, ${r.sets} bộ dụng cụ`);
      if (r.users && !given) console.log(`Mật khẩu của các tài khoản mới (chỉ hiện một lần): ${password}`);
    })
    .finally(() => pool.end());
}
