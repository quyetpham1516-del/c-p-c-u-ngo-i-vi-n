import { hashPassword } from './crypto.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

/**
 * Dữ liệu mẫu cho môi trường thử: 1 trụ sở + 2 trạm, 6 xe (mục 5.5), 10 vị trí EOC, kíp mẫu.
 * Tọa độ đặt quanh TP.HCM chỉ để minh họa; thay bằng địa bàn thật khi triển khai.
 * Mật khẩu mặc định chỉ dùng cho môi trường thử.
 */
export async function seed(pool: import('pg').Pool, password = process.env.MEDONE_SEED_PASSWORD ?? 'medone123') {
  await migrate(pool);
  const has = await pool.query('SELECT 1 FROM users LIMIT 1');
  if (has.rowCount) return false;
  const pw = hashPassword(password);
  await pool.query(`INSERT INTO stations(id, name, lat, lng) VALUES
    ('TS', 'Trụ sở chính', 10.7769, 106.7009),
    ('TR-01', 'Trạm 1', 10.8016, 106.6526),
    ('TR-02', 'Trạm 2', 10.7380, 106.7220)`);
  await pool.query(`INSERT INTO vehicles(id, plate, type, station_id, duty, status, lat, lng) VALUES
    ('MD-ALS-01', '51B-001.01', 'ALS',  'TS',    '24/7',    'S9', 10.7769, 106.7009),
    ('MD-BLS-01', '51B-001.02', 'BLS',  'TR-01', '24/7',    'S9', 10.8016, 106.6526),
    ('MD-MSU-01', '51B-001.03', 'MSU',  'TS',    '24/7',    'S9', 10.7769, 106.7009),
    ('MD-ECMO-01','51B-001.04', 'ECMO', 'TS',    'office',  'S9', 10.7769, 106.7009),
    ('MD-VC-01',  '51B-001.05', 'VC',   'TR-02', 'office',  'S9', 10.7380, 106.7220),
    ('MD-DP-01',  '51B-001.06', 'DP',   'TR-02', 'reserve', 'S9', 10.7380, 106.7220)`);
  const users: [string, string, string, string, string | null][] = [
    ['admin', 'Quản trị hệ thống', 'admin', 'Quản trị', null],
    ['truongca', 'Trưởng ca EOC', 'supervisor', 'Trưởng ca', null],
    ['qlcl', 'Cán bộ QLCL', 'qa', 'QLCL', null],
  ];
  for (let i = 1; i <= 10; i++) {
    users.push([`dpv${String(i).padStart(2, '0')}`, `Điều phối viên ${i}`, i <= 5 ? 'calltaker' : 'dispatcher', i <= 5 ? 'Call-taker' : 'Điều phối viên', null]);
  }
  const crew: [string, string, string, string][] = [
    ['bs.als', 'BS Kíp ALS', 'Bác sĩ', 'GPHN-0001'], ['dd.als', 'ĐD Kíp ALS', 'Điều dưỡng', 'GPHN-0002'], ['lx.als', 'Lái xe ALS', 'Lái xe', ''],
    ['ys.bls', 'Y sĩ Kíp BLS', 'Y sĩ', 'GPHN-0003'], ['dd.bls', 'ĐD Kíp BLS', 'Điều dưỡng', 'GPHN-0004'],
    ['bs.msu', 'BS Kíp đột quỵ', 'Bác sĩ', 'GPHN-0005'], ['ktv.msu', 'KTV CT', 'Kỹ thuật viên', 'GPHN-0006'],
    ['dd.vc', 'ĐD Xe vận chuyển', 'Điều dưỡng', 'GPHN-0007'],
  ];
  for (const [u, n, t, l] of crew) users.push([u, n, 'crew', t, l || null]);
  for (const [username, name, role, title, license] of users) {
    await pool.query('INSERT INTO users(username, full_name, role, title, license_no, password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [username, name, role, title, license, pw]);
  }
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool();
  seed(pool)
    .then((done) => console.log(done ? 'Đã tạo dữ liệu mẫu (mật khẩu: medone123 hoặc MEDONE_SEED_PASSWORD)' : 'Đã có dữ liệu, bỏ qua'))
    .finally(() => pool.end());
}
