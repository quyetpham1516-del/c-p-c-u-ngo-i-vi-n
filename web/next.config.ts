import { existsSync } from 'node:fs';
import type { NextConfig } from 'next';

// Dùng chung tệp .env ở thư mục gốc với backend (chỉ biến NEXT_PUBLIC_* được đưa xuống trình duyệt)
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
};

export default config;
