import pg from 'pg';
import { config } from './config.js';

// Trả timestamptz dạng chuỗi ISO, để JSON gửi xuống giao diện ổn định
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url = config.databaseUrl): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 30 });
}

export async function withTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T = any>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await q.query(sql, params);
  return r.rows[0] as T | undefined;
}

export async function many<T = any>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await q.query(sql, params);
  return r.rows as T[];
}

/** Bộ đếm theo kỳ (năm, ngày...) — dùng cho Mã ca, Số BA, Số chuyển viện */
export async function nextCounter(q: Queryable, name: string, period: string): Promise<number> {
  const r = await q.query(
    `INSERT INTO counters(name, period, value) VALUES ($1, $2, 1)
     ON CONFLICT (name, period) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [name, period],
  );
  return Number(r.rows[0].value);
}
