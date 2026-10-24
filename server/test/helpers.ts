import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { seed } from '../src/seed.js';

// Mật khẩu sinh ngẫu nhiên cho mỗi lần chạy kiểm thử
const testPassword = randomBytes(12).toString('base64url');

export async function freshApp() {
  const pool = createPool();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed(pool, testPassword);
  const { app } = await buildApp(pool);
  return { app, pool };
}

export async function login(app: FastifyInstance, username: string): Promise<(method: string, url: string, body?: unknown) => Promise<any>> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: testPassword } });
  if (r.statusCode !== 200) throw new Error(`login ${username}: ${r.body}`);
  const token = r.json().token;
  return async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${token}` } });
    const json = res.body ? res.json() : null;
    return { http: res.statusCode, ...((json && typeof json === 'object' && !Array.isArray(json)) ? json : { data: json }) };
  };
}
