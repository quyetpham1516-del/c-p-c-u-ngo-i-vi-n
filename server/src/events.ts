import type pg from 'pg';
import type { WebSocket } from 'ws';

/**
 * Phát sự kiện thời gian thực tới mọi màn hình. Dùng LISTEN/NOTIFY của PostgreSQL để
 * nhiều tiến trình máy chủ cùng phát được (không cần Redis/Kafka ở giai đoạn MVP).
 */
export type HubEvent = { type: string; [k: string]: unknown };

const CHANNEL = 'medone_events';

export class Hub {
  private clients = new Set<WebSocket>();
  private listener?: pg.PoolClient;

  constructor(private pool: pg.Pool) {}

  async start(): Promise<void> {
    this.listener = await this.pool.connect();
    this.listener.on('notification', (msg) => {
      if (msg.channel === CHANNEL && msg.payload) this.fanout(msg.payload);
    });
    await this.listener.query(`LISTEN ${CHANNEL}`);
  }

  async stop(): Promise<void> {
    if (this.listener) {
      await this.listener.query(`UNLISTEN ${CHANNEL}`).catch(() => {});
      this.listener.release();
      this.listener = undefined;
    }
    for (const c of this.clients) c.close();
  }

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
  }

  get size(): number {
    return this.clients.size;
  }

  /** Gửi qua NOTIFY (payload tối đa ~8 KB) để mọi tiến trình đều nhận */
  async publish(ev: HubEvent): Promise<void> {
    const payload = JSON.stringify({ ...ev, ts: Date.now() });
    if (Buffer.byteLength(payload) > 7900) {
      await this.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ type: ev.type, id: ev.id, refetch: true, ts: Date.now() })]);
      return;
    }
    await this.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
  }

  private fanout(payload: string): void {
    for (const c of this.clients) {
      if (c.readyState === 1) c.send(payload);
    }
  }
}
