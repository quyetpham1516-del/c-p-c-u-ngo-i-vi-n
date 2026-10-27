import type pg from 'pg';
import { SYSTEM } from './audit.js';
import { one, withTx } from './db.js';
import { autoIssue } from './inventory.js';
import { openDueStocktakes } from './stocktake.js';

/** Giờ Việt Nam hiện tại: ngày (YYYY-MM-DD) và giờ phút (HH:MM) */
export function vnClock(now = new Date()) {
  const t = new Date(now.getTime() + 7 * 3600_000).toISOString();
  return { date: t.slice(0, 10), time: t.slice(11, 16) };
}

/** Việc kho theo lịch: tự phát bù định mức, mở phiên kiểm kê đúng giờ đã cài. Gọi mỗi phút; chạy lại cũng không làm hai lần trong ngày. */
export async function runInventoryJobs(pool: pg.Pool, now = new Date()) {
  const { date, time } = vnClock(now);
  const done: string[] = [];
  const s = await one(pool, `SELECT auto_issue, to_char(auto_issue_at, 'HH24:MI') AS at, last_auto_issue_on::text AS last FROM inventory_settings WHERE id = 1`);
  if (s?.auto_issue && time >= s.at && s.last !== date) {
    const created = await withTx(pool, async (tx) => {
      const claimed = await tx.query(`UPDATE inventory_settings SET last_auto_issue_on = $1 WHERE id = 1 AND (last_auto_issue_on IS NULL OR last_auto_issue_on <> $1)`, [date]);
      return claimed.rowCount ? autoIssue(tx, SYSTEM) : [];
    });
    if (created.length) done.push(`tự phát bù định mức: ${created.map((c) => c.code).join(', ')}`);
  }
  const st = await withTx(pool, (tx) => openDueStocktakes(tx, date, time));
  if (st.opened.length) done.push(`mở phiên kiểm kê: ${st.opened.join(', ')}`);
  if (st.late) done.push(`${st.late} phiên kiểm kê quá hạn`);
  return done;
}

export function startInventoryWorker(pool: pg.Pool, log: (m: string) => void = console.log) {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { for (const m of await runInventoryJobs(pool)) log(`Kho: ${m}`); } catch (e) { log(`Kho, việc theo lịch lỗi: ${(e as Error).message}`); } finally { busy = false; }
  }, 60_000);
  t.unref();
  return t;
}
