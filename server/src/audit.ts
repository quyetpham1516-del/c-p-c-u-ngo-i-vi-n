import { createHash } from 'node:crypto';
import type { Queryable } from './db.js';

export interface Actor {
  id: string | null;
  name: string;
}

export const SYSTEM: Actor = { id: null, name: 'Hệ thống' };

const GENESIS = '0'.repeat(64);

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

export function eventHash(e: {
  prev_hash: string; scope: string; at: string; actor_id: string | null; action: string;
  entity: string | null; entity_id: string | null; data: unknown;
}): string {
  const body = canonical({
    prev: e.prev_hash, scope: e.scope, at: new Date(e.at).toISOString(), actor: e.actor_id,
    action: e.action, entity: e.entity, entity_id: e.entity_id, data: e.data,
  });
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Ghi một sự kiện vào nhật ký chỉ ghi thêm. Phải gọi trong giao dịch: khóa tư vấn theo scope
 * bảo đảm hai sự kiện cùng ca không cùng nối vào một mắt xích trước.
 */
export async function audit(
  tx: Queryable, scope: string, actor: Actor, action: string,
  entity: string | null = null, entityId: string | null = null, data: Record<string, unknown> = {},
): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope]);
  const prev = await tx.query('SELECT hash FROM audit_events WHERE scope = $1 ORDER BY id DESC LIMIT 1', [scope]);
  const prev_hash: string = prev.rows[0]?.hash ?? GENESIS;
  const at = new Date().toISOString();
  const hash = eventHash({ prev_hash, scope, at, actor_id: actor.id, action, entity, entity_id: entityId, data });
  await tx.query(
    `INSERT INTO audit_events(scope, at, actor_id, actor_name, action, entity, entity_id, data, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [scope, at, actor.id, actor.name, action, entity, entityId, data, prev_hash, hash],
  );
}

export interface ChainCheck {
  ok: boolean;
  count: number;
  brokenAt?: number;
  lastHash: string;
}

/** Kiểm tra lại toàn bộ chuỗi băm của một scope (ca hoặc bệnh án) */
export async function verifyChain(q: Queryable, scope: string): Promise<ChainCheck> {
  const r = await q.query('SELECT * FROM audit_events WHERE scope = $1 ORDER BY id', [scope]);
  let prev = GENESIS;
  for (const row of r.rows) {
    const expect = eventHash(row);
    if (row.prev_hash !== prev || row.hash !== expect) {
      return { ok: false, count: r.rows.length, brokenAt: Number(row.id), lastHash: prev };
    }
    prev = row.hash;
  }
  return { ok: true, count: r.rows.length, lastHash: prev };
}
