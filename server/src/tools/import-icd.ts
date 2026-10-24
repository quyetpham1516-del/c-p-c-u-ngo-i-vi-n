import { createPool } from '../db.js';
import { migrate } from '../migrate.js';
import { importIcd } from './importers.js';

/**
 * Nạp danh mục ICD-10 của Bộ Y tế (ví dụ tệp "DM ICD10-19_8_BYT.xlsx": cột STT, Mã, Tên bệnh, Nhóm bệnh, Hiệu lực).
 * Bản 19/08/2021 đã đi kèm mã nguồn (server/data) và tự nạp khi chạy seed/catalog; lệnh này dùng khi Bộ Y tế cập nhật.
 * Chạy: npm run import:icd -w server -- <đường dẫn tệp .xlsx hoặc .csv>
 */
const file = process.argv[2];
if (!file) {
  console.error('Cách dùng: npm run import:icd -w server -- <tệp .xlsx hoặc .csv>');
  process.exit(1);
}

const pool = createPool();
try {
  await migrate(pool);
  console.log(`Đã nạp ${await importIcd(pool, file)} mã ICD-10 từ ${file}`);
} finally {
  await pool.end();
}
