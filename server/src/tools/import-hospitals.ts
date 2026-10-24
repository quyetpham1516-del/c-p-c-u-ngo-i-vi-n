import { createPool } from '../db.js';
import { migrate } from '../migrate.js';
import { importHospitals } from './importers.js';

/**
 * Nạp danh sách bệnh viện nhận bệnh từ tệp .xlsx/.csv có các cột: "Tên bệnh viện", tùy chọn "Mã KCB",
 * "Khoa" (nhiều khoa cách nhau bằng dấu ;), "Địa chỉ", "Số điện thoại", "Nhóm".
 * Danh sách cơ sở KCB TP.HCM (BHXH, quý 3/2022) đã đi kèm mã nguồn và tự nạp khi chạy seed/catalog.
 * Chạy: npm run import:hospitals -w server -- <tệp>
 */
const file = process.argv[2];
if (!file) {
  console.error('Cách dùng: npm run import:hospitals -w server -- <tệp .xlsx hoặc .csv>');
  process.exit(1);
}

const pool = createPool();
try {
  await migrate(pool);
  const r = await importHospitals(pool, file);
  console.log(`Đã thêm ${r.hospitals} bệnh viện mới và ${r.departments} khoa từ ${file}`);
} finally {
  await pool.end();
}
