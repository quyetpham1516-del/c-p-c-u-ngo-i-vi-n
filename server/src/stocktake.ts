import type { Actor } from './audit.js';
import { many, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';
import { centralStation, notifyCentral, notifyStation } from './inventory.js';
import { createStocktake } from './stock.js';
import { buildStocktakeReport } from './inventory-report.js';

/**
 * Lịch kiểm kê: đến giờ thì mở phiên kiểm kê cho từng kho (kho điểm hằng ngày, kho tổng cuối tháng).
 * Phiên kiểm kê là kiểm toàn bộ: phải đếm đủ mọi lô đang có trong kho. Nộp xong thành phiếu kiểm kê;
 * có chênh lệch thì chờ người thứ hai duyệt (người lập không tự duyệt). Quá ngày chưa nộp thì báo trễ.
 */

export const FREQ_LABEL: Record<string, string> = { hang_ngay: 'Hằng ngày', hang_tuan: 'Thứ Hai hằng tuần', cuoi_thang: 'Ngày cuối tháng' };

/** Hôm nay có phải ngày kiểm kê theo tần suất không */
export function isDue(frequency: string, date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  if (frequency === 'hang_ngay') return true;
  if (frequency === 'hang_tuan') return d.getUTCDay() === 1;
  const next = new Date(d.getTime() + 86_400_000);
  return next.getUTCMonth() !== d.getUTCMonth();
}

/** Mở phiên kiểm kê đến hạn (gọi mỗi phút; mỗi kho một phiên mỗi ngày) và đánh dấu phiên quá hạn */
export async function openDueStocktakes(tx: Tx, date: string, time: string) {
  const opened: string[] = [];
  const central = await centralStation(tx);
  for (const s of await many(tx, `SELECT scope, frequency, to_char(at, 'HH24:MI') AS at, blind FROM stocktake_schedules WHERE active`)) {
    if (time < s.at || !isDue(s.frequency, date)) continue;
    const stations = s.scope === 'kho_tong'
      ? (central ? [central] : [])
      : (await many(tx, `SELECT id FROM stations WHERE active AND id IS DISTINCT FROM $1 ORDER BY id`, [central])).map((r) => r.id);
    for (const st of stations) {
      const r = await tx.query(`INSERT INTO stocktake_sessions(station_id, scope, due_date, blind) VALUES ($1,$2,$3,$4) ON CONFLICT (station_id, due_date) DO NOTHING`,
        [st, s.scope, date, s.blind]);
      if (!r.rowCount) continue;
      opened.push(st);
      const title = `Đến giờ kiểm kê ${s.scope === 'kho_tong' ? 'kho tổng' : `kho ${st}`} (${date})`;
      if (s.scope === 'kho_tong') await notifyCentral(tx, title, 'Đếm toàn bộ lô trong kho rồi nộp', false, '/kho#kiem-ke', 'stocktake');
      else await notifyStation(tx, st, title, 'Đếm toàn bộ lô trong kho điểm rồi nộp', '/kho#kiem-ke', 'stocktake');
    }
  }
  const late = await many(tx, `UPDATE stocktake_sessions SET status = 'qua_han' WHERE status = 'mo' AND due_date < $1 RETURNING station_id, scope, due_date::text`, [date]);
  for (const l of late) {
    const title = `Quá hạn kiểm kê ${l.scope === 'kho_tong' ? 'kho tổng' : `kho ${l.station_id}`} ngày ${l.due_date}`;
    if (l.scope === 'kho_tong') await notifyCentral(tx, title, null, true, '/kho#kiem-ke', 'stocktake');
    else await notifyStation(tx, l.station_id, title, null, '/kho#kiem-ke', 'stocktake');
  }
  return { opened, late: late.length };
}

/** Danh sách lô phải đếm. Kiểm mù thì không trả số sổ sách. */
export async function sessionDetail(q: Queryable, id: string) {
  const s = await one(q, `SELECT ss.*, ss.due_date::text AS due_date, st.name AS station_name, v.code AS voucher_code, v.status AS voucher_status, u.full_name AS submitted_by_name
                            FROM stocktake_sessions ss JOIN stations st ON st.id = ss.station_id
                            LEFT JOIN stock_vouchers v ON v.id = ss.voucher_id LEFT JOIN users u ON u.id = ss.submitted_by WHERE ss.id = $1`, [id]);
  if (!s) throw new HttpError(404, 'Không tìm thấy phiên kiểm kê');
  const lots = s.status === 'da_nop'
    ? await many(q, `SELECT l.lot_id AS id, sl.lot, sl.expiry, d.name AS drug_name, d.unit, l.book_qty::float AS qty, l.counted_qty::float AS counted
                       FROM stock_voucher_lines l JOIN stock_lots sl ON sl.id = l.lot_id JOIN drugs d ON d.id = sl.drug_id WHERE l.voucher_id = $1 ORDER BY d.name, sl.expiry`, [s.voucher_id])
    : await many(q, `SELECT l.id, l.lot, l.expiry, d.name AS drug_name, d.unit, l.qty::float AS qty
                       FROM stock_lots l JOIN drugs d ON d.id = l.drug_id
                      WHERE l.station_id = $1 AND l.vehicle_id IS NULL AND l.qty > 0 ORDER BY d.name, l.expiry`, [s.station_id]);
  return { ...s, lots: s.blind && s.status !== 'da_nop' ? lots.map(({ qty: _q, ...l }) => l) : lots };
}

/** Nộp kết quả đếm: phải đủ mọi lô đang có trong kho (kiểm toàn bộ) */
export async function submitSession(tx: Tx, actor: Actor, id: string, b: { lines: { lotId: string; counted: number }[]; note?: string | null }) {
  const s = await one(tx, 'SELECT * FROM stocktake_sessions WHERE id = $1 FOR UPDATE', [id]);
  if (!s) throw new HttpError(404, 'Không tìm thấy phiên kiểm kê');
  if (s.status === 'da_nop') throw new HttpError(409, 'Phiên kiểm kê đã nộp');
  const lots = await many(tx, 'SELECT id FROM stock_lots WHERE station_id = $1 AND vehicle_id IS NULL AND qty > 0', [s.station_id]);
  const given = new Set(b.lines.map((l) => l.lotId));
  const missing = lots.filter((l) => !given.has(l.id)).length;
  if (missing) throw new HttpError(400, `Kiểm kê toàn bộ: còn ${missing} lô chưa đếm`);
  if (!b.lines.length) throw new HttpError(400, 'Kho không còn lô nào để đếm');
  const note = [`Kiểm kê theo lịch ngày ${String(s.due_date instanceof Date ? s.due_date.toISOString().slice(0, 10) : s.due_date)}`, s.status === 'qua_han' ? 'nộp trễ' : null, b.note].filter(Boolean).join(' · ');
  const v = await createStocktake(tx, actor, { stationId: s.station_id, lines: b.lines, note });
  await tx.query(`UPDATE stocktake_sessions SET status = 'da_nop', voucher_id = $2, submitted_by = $3, submitted_at = now() WHERE id = $1`, [id, v.id, actor.id]);
  const diffs = Number((await one(tx, 'SELECT count(*)::int AS n FROM stock_voucher_lines WHERE voucher_id = $1 AND qty <> 0', [v.id]))?.n ?? 0);
  if (diffs) {
    const title = `Kiểm kê ${s.scope === 'kho_tong' ? 'kho tổng' : `kho ${s.station_id}`} lệch ${diffs} lô: chờ duyệt ${v.code}`;
    await tx.query(`INSERT INTO notifications(user_id, kind, title, body, link)
                    SELECT id, 'stocktake', $1, $2, '/kho#phieu-kho' FROM users WHERE active AND role IN ('supervisor', 'admin', 'director') AND id IS DISTINCT FROM $3`,
    [title, 'Người thứ hai xem và duyệt chênh lệch', actor.id]);
  }
  const report = await buildStocktakeReport(tx, id);
  return { voucher: v, diffs, report };
}
