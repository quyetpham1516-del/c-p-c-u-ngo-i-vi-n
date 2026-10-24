import { createHash } from 'node:crypto';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Thiếu biến môi trường ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

function secret(name: string, devValue: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Môi trường production bắt buộc đặt ${name}`);
  return devValue;
}

export const config = {
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: env('DATABASE_URL', 'postgres://medone:medone@localhost:5432/medone'),
  jwtSecret: secret('MEDONE_JWT_SECRET', 'dev-only-jwt-secret-change-me'),
  // Khóa mã hóa số định danh (32 byte) và khóa HMAC tìm kiếm — tách riêng nhau
  dataKey: createHash('sha256').update(secret('MEDONE_DATA_KEY', 'dev-only-data-key')).digest(),
  lookupKey: createHash('sha256').update(secret('MEDONE_LOOKUP_KEY', 'dev-only-lookup-key')).digest(),
  // Khóa cho tổng đài SIP gọi webhook báo cuộc gọi đến/bỏ dở
  telephonyKey: secret('MEDONE_TELEPHONY_KEY', 'dev-only-telephony-key'),
  webDist: env('MEDONE_WEB_DIST', new URL('../../web/dist', import.meta.url).pathname),
  boardTickMs: Number(env('MEDONE_BOARD_TICK_MS', '5000')),
  isProd,
};
