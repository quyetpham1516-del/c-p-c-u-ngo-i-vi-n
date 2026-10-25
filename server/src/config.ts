import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Đọc tệp .env ở thư mục gốc (nếu có). Biến đã có sẵn trong môi trường thì giữ nguyên.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Thiếu biến môi trường ${name}`);
  return v;
}

/** Khóa bí mật không có giá trị mặc định trong mã nguồn: thiếu là dừng, kể cả khi chạy thử. */
function secret(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Chưa đặt ${name}. Chạy "npm run setup" để tạo tệp .env có khóa ngẫu nhiên.`);
  if (v.length < 32) throw new Error(`${name} phải dài ít nhất 32 ký tự`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: secret('DATABASE_URL'),
  jwtSecret: secret('MEDONE_JWT_SECRET'),
  // Khóa mã hóa số định danh (32 byte) và khóa HMAC tìm kiếm — tách riêng nhau
  dataKey: createHash('sha256').update(secret('MEDONE_DATA_KEY')).digest(),
  lookupKey: createHash('sha256').update(secret('MEDONE_LOOKUP_KEY')).digest(),
  // Khóa cho tổng đài SIP gọi webhook báo cuộc gọi đến/bỏ dở
  telephonyKey: secret('MEDONE_TELEPHONY_KEY'),
  // Địa chỉ frontend Next.js được phép gọi API (CORS), cách nhau bằng dấu phẩy
  webOrigins: env('MEDONE_WEB_ORIGIN', 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
  /** Cho trang web mở bằng địa chỉ mạng nội bộ (192.168.x.x, 10.x.x.x, 172.16–31.x.x, *.local) gọi API, để điện thoại cùng Wi-Fi quét tem QR được.
   *  Mặc định bật khi không chạy production; đặt MEDONE_ALLOW_LAN=0 để tắt, =1 để bật cả ở production. */
  allowLan: env('MEDONE_ALLOW_LAN', isProd ? '0' : '1') === '1',
  boardTickMs: Number(env('MEDONE_BOARD_TICK_MS', '5000')),
  isProd,
};
