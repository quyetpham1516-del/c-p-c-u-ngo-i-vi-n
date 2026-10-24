import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Khóa sinh ngẫu nhiên cho mỗi lần chạy kiểm thử; cơ sở dữ liệu kiểm thử lấy từ TEST_DATABASE_URL
const key = () => randomBytes(32).toString('base64url');
const testDb = process.env.TEST_DATABASE_URL;
if (!testDb) throw new Error('Chưa đặt TEST_DATABASE_URL (cơ sở dữ liệu riêng cho kiểm thử, sẽ bị xóa sạch)');

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      DATABASE_URL: testDb,
      MEDONE_JWT_SECRET: key(),
      MEDONE_DATA_KEY: key(),
      MEDONE_LOOKUP_KEY: key(),
      MEDONE_TELEPHONY_KEY: key(),
    },
  },
});
