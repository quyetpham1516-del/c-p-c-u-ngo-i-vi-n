import { buildApp } from './app.js';
import { seedCatalog } from './catalog.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { startSmsWorker } from './sms.js';

const pool = createPool();
await migrate(pool);
// Danh mục đi kèm (bệnh viện, thuốc, loại thiết bị, thiết bị bắt buộc, cơ số chuẩn): chỉ thêm phần còn thiếu, không ghi đè chỗ đã sửa
await seedCatalog(pool);
const { app } = await buildApp(pool, { logger: true });
await app.listen({ port: config.port, host: config.host });
startSmsWorker(pool, (m) => app.log.info(m));

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
