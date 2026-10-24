import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createPool } from './db.js';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(dir + f, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      applied.push(f);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool();
  migrate(pool)
    .then((a) => console.log(a.length ? `Đã áp dụng: ${a.join(', ')}` : 'Cơ sở dữ liệu đã mới nhất'))
    .finally(() => pool.end());
}
