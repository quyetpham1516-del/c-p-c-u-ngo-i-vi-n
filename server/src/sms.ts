import type pg from 'pg';
import { many } from './db.js';

/**
 * Gửi hàng đợi tin nhắn (message_outbox) qua cổng SMS của nhà cung cấp đơn vị đã ký hợp đồng.
 * Cấu hình trong .env: MEDONE_SMS_URL (địa chỉ nhận yêu cầu POST JSON {to, message, purpose, ref}) và MEDONE_SMS_TOKEN (gửi kèm
 * header Authorization: Bearer). Không cấu hình thì tin nằm trong hàng đợi để gửi tay như trước (Chất lượng → Tin nhắn).
 * Mỗi tin thử tối đa 3 lần rồi chuyển "lỗi".
 */

export const SMS_MAX_ATTEMPTS = 3;

export function smsConfig() {
  const url = process.env.MEDONE_SMS_URL?.trim();
  return url ? { url, token: process.env.MEDONE_SMS_TOKEN?.trim() || null } : null;
}

export async function sendPending(pool: pg.Pool, cfg = smsConfig(), doFetch: typeof fetch = fetch) {
  if (!cfg) return { sent: 0, failed: 0 };
  const rows = await many(pool, `UPDATE message_outbox SET attempts = attempts + 1
                                  WHERE id IN (SELECT id FROM message_outbox WHERE status = 'cho_gui' AND channel = 'sms' AND attempts < $1
                                                ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED)
                                  RETURNING id, to_phone, body, purpose, ref_id, attempts`, [SMS_MAX_ATTEMPTS]);
  let sent = 0; let failed = 0;
  for (const m of rows) {
    try {
      const res = await doFetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
        body: JSON.stringify({ to: m.to_phone, message: m.body, purpose: m.purpose, ref: m.ref_id }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pool.query(`UPDATE message_outbox SET status = 'da_gui', sent_at = now(), error = NULL WHERE id = $1`, [m.id]);
      sent++;
    } catch (e) {
      const last = m.attempts >= SMS_MAX_ATTEMPTS;
      await pool.query(`UPDATE message_outbox SET status = $2, error = $3 WHERE id = $1`, [m.id, last ? 'loi' : 'cho_gui', String((e as Error).message).slice(0, 300)]);
      failed++;
    }
  }
  return { sent, failed };
}

/** Chạy nền mỗi 15 giây khi có cấu hình cổng SMS */
export function startSmsWorker(pool: pg.Pool, log: (m: string) => void = console.log) {
  const cfg = smsConfig();
  if (!cfg) return null;
  log('Cổng SMS: đã bật gửi tự động hàng đợi tin nhắn');
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await sendPending(pool, cfg); } catch (e) { log(`Cổng SMS lỗi: ${(e as Error).message}`); } finally { busy = false; }
  }, 15_000);
  t.unref();
  return t;
}
