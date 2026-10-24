import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Tạo tệp .env ở thư mục gốc với khóa bí mật ngẫu nhiên. Không ghi đè nếu tệp đã có.
 * Tệp .env nằm trong .gitignore, không bao giờ đưa lên GitHub.
 */
const file = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(file)) {
  console.log('Đã có tệp .env, giữ nguyên.');
  process.exit(0);
}
const key = () => randomBytes(32).toString('base64url');
const dbPassword = randomBytes(18).toString('base64url');
const db = (name: string) => `postgres://medone:${dbPassword}@localhost:5432/${name}`;

writeFileSync(file, `# Sinh bởi "npm run setup" lúc ${new Date().toISOString()}. Không đưa tệp này lên Git.
# Mất MEDONE_DATA_KEY là mất khả năng đọc số CCCD đã lưu: cất khóa ở nơi an toàn.

# Cơ sở dữ liệu PostgreSQL (docker compose dùng POSTGRES_PASSWORD để tạo tài khoản medone)
POSTGRES_PASSWORD=${dbPassword}
DATABASE_URL=${db('medone')}
TEST_DATABASE_URL=${db('medone_test')}
LOAD_DATABASE_URL=${db('medone_load')}

# Backend Fastify
PORT=8080
MEDONE_JWT_SECRET=${key()}
MEDONE_DATA_KEY=${key()}
MEDONE_LOOKUP_KEY=${key()}
MEDONE_TELEPHONY_KEY=${key()}
MEDONE_WEB_ORIGIN=http://localhost:3000

# Frontend Next.js: địa chỉ backend mà trình duyệt gọi tới
NEXT_PUBLIC_API_URL=http://localhost:8080
`, { mode: 0o600 });
console.log(`Đã tạo ${file} với khóa ngẫu nhiên.`);
console.log(`Tạo tài khoản PostgreSQL tương ứng (nếu không dùng docker compose):
  CREATE ROLE medone LOGIN PASSWORD '${dbPassword}';
  CREATE DATABASE medone OWNER medone; CREATE DATABASE medone_test OWNER medone; CREATE DATABASE medone_load OWNER medone;`);
