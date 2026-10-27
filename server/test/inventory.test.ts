import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { runInventoryJobs } from '../src/inventory-jobs.js';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance; let pool: pg.Pool;
let admin: Client, duoc: Client, ddBls: Client, ddVc: Client, dpv06: Client, giamdoc: Client;
let drugA = 0; let drugB = 0;
const qty = async (station: string, drug: number) =>
  Number((await pool.query(`SELECT coalesce(sum(qty), 0) AS q FROM stock_lots WHERE station_id = $1 AND vehicle_id IS NULL AND drug_id = $2`, [station, drug])).rows[0].q);

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [admin, duoc, ddBls, ddVc, dpv06, giamdoc] = await Promise.all(['admin', 'duoc', 'dd.bls', 'dd.vc', 'dpv06', 'giamdoc'].map((u) => login(app, u)));
  await pool.query(`UPDATE users SET station_id = 'TR-01' WHERE username = 'dd.bls'`);
  await pool.query(`UPDATE users SET station_id = 'TR-02' WHERE username = 'dd.vc'`);
  const d = (await pool.query(`SELECT id FROM drugs WHERE active AND NOT controlled AND track_lot ORDER BY id LIMIT 2`)).rows;
  drugA = d[0].id; drugB = d[1].id;
}, 60000);
afterAll(async () => { await app.close(); await pool.end(); });

describe('kho tổng phát cho kho điểm', () => {
  it('kho tổng mặc định là trụ sở khi chưa có điểm loại kho trung tâm; điều phối viên không xem kho tổng', async () => {
    expect((await duoc('GET', '/api/inventory/settings')).central).toBe('TS');
    const rows = (await dpv06('GET', '/api/stock')).data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r: any) => r.station_id === 'TS')).toBe(false);
    expect((await dpv06('GET', '/api/stock?stationId=TS')).http).toBe(403);
    expect((await dpv06('GET', '/api/requisitions')).http).toBe(403);
    expect((await duoc('GET', '/api/stock?stationId=TS')).data.length).toBeGreaterThan(0);
  });

  it('kho điểm lập phiếu lĩnh → kho tổng duyệt (sửa số) → xuất trừ kho tổng → kho điểm xác nhận, nhận thiếu phải ghi lý do', async () => {
    expect((await ddBls('POST', '/api/requisitions', { stationId: 'TR-02', lines: [{ drugId: drugA, qty: 20 }] })).http).toBe(403);
    const r = await ddBls('POST', '/api/requisitions', { stationId: 'TR-01', lines: [{ drugId: drugA, qty: 20 }, { drugId: drugB, qty: 5 }], note: 'Dùng nhiều tuần này' });
    expect(r.http).toBe(200);
    expect(r.code).toMatch(/^PL-\d{4}-00001$/);
    expect((await ddVc('GET', '/api/requisitions')).data).toHaveLength(0);
    expect((await ddBls('POST', `/api/requisitions/${r.id}/decide`, { approve: true })).http).toBe(403);
    const detail = await duoc('GET', `/api/requisitions/${r.id}`);
    expect(detail.lines.find((l: any) => l.drug_id === drugA).central_on_hand).toBe(await qty('TS', drugA));
    expect((await ddBls('GET', `/api/requisitions/${r.id}`)).lines[0].central_on_hand).toBeUndefined();
    const lineA = detail.lines.find((l: any) => l.drug_id === drugA);
    expect((await duoc('POST', `/api/requisitions/${r.id}/decide`, { approve: true, lines: [{ lineId: lineA.id, approvedQty: 15 }] })).http).toBe(200);
    const centralBefore = await qty('TS', drugA);
    const stationA = await qty('TR-01', drugA); const stationB = await qty('TR-01', drugB);
    const iss = await duoc('POST', `/api/requisitions/${r.id}/issue`, {});
    expect(iss.short).toEqual([]);
    expect(await qty('TS', drugA)).toBe(centralBefore - 15);
    expect(await qty('TR-01', drugA)).toBe(stationA); // chưa nhận thì chưa cộng kho điểm
    const issued = (await ddBls('GET', `/api/requisitions/${r.id}`)).lines;
    const issueA = issued.find((l: any) => l.drug_id === drugA).issues[0];
    expect((await duoc('POST', `/api/requisitions/${r.id}/receive`, { lines: [] })).http).toBe(403); // người xuất không tự nhận
    expect((await ddBls('POST', `/api/requisitions/${r.id}/receive`, { lines: [{ issueId: issueA.id, receivedQty: 14 }] })).http).toBe(400);
    const rec = await ddBls('POST', `/api/requisitions/${r.id}/receive`, { lines: [{ issueId: issueA.id, receivedQty: 14 }], note: 'Vỡ 1 ống khi vận chuyển' });
    expect(rec.diffs).toHaveLength(1);
    expect(await qty('TR-01', drugA)).toBe(stationA + 14);
    expect(await qty('TR-01', drugB)).toBe(stationB + 5);
    const done = (await duoc('GET', `/api/requisitions/${r.id}`));
    expect(done).toMatchObject({ status: 'da_nhan', discrepancy: true });
    const n = await admin('GET', '/api/notifications');
    expect(JSON.stringify(n)).toContain('nhận');
  });

  it('kho tổng thiếu hàng thì xuất phần có và ghi số thiếu', async () => {
    const r = await ddBls('POST', '/api/requisitions', { stationId: 'TR-01', lines: [{ drugId: drugB, qty: 500 }] });
    await duoc('POST', `/api/requisitions/${r.id}/decide`, { approve: true });
    const iss = await duoc('POST', `/api/requisitions/${r.id}/issue`, {});
    expect(iss.short[0]).toContain('thiếu');
    expect(await qty('TS', drugB)).toBe(0);
  });

  it('tự phát bù định mức: lập phiếu đã duyệt cho điểm dưới định mức, mỗi ngày một lần theo giờ đã cài', async () => {
    const onHand = await qty('TR-02', drugA);
    await pool.query(`DELETE FROM stock_minimums`);
    await pool.query(`INSERT INTO stock_minimums(station_id, drug_id, min_qty) VALUES ('TR-02', $1, $2)`, [drugA, onHand + 30]);
    const sug = (await ddVc('GET', '/api/requisitions/suggest?stationId=TR-02')).data;
    expect(sug).toEqual([expect.objectContaining({ drug_id: drugA, on_hand: onHand, need: 30 })]);
    expect((await admin('PUT', '/api/inventory/settings', { centralStationId: null, autoIssue: true, autoIssueAt: '06:00' })).http).toBe(200);
    const at = (h: number) => new Date(Date.UTC(2026, 9, 28, h - 7, 5));
    expect(await runInventoryJobs(pool, at(5))).toEqual([]);
    const ran = await runInventoryJobs(pool, at(6));
    expect(ran[0]).toContain('PL-');
    expect(await runInventoryJobs(pool, at(7))).toEqual([]);
    const list = (await ddVc('GET', '/api/requisitions')).data;
    expect(list[0]).toMatchObject({ station_id: 'TR-02', source: 'tu_dong', status: 'da_duyet' });
    // đang có phiếu chưa nhận thì không phát trùng
    expect((await duoc('POST', '/api/requisitions/auto')).created).toEqual([]);
    expect((await giamdoc('GET', '/api/requisitions')).data.length).toBeGreaterThan(0);
  });
});
