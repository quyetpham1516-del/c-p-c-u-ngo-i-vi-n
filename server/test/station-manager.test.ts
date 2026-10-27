import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance; let pool: pg.Pool;
let admin: Client, duoc: Client, ddBls: Client;
const uid = async (username: string) => (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id as string;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [admin, duoc, ddBls] = await Promise.all(['admin', 'duoc', 'dd.bls'].map((u) => login(app, u)));
  await pool.query(`UPDATE users SET station_id = 'TR-01' WHERE username IN ('dd.bls', 'bs.als')`);
  await pool.query(`UPDATE users SET station_id = 'TR-02' WHERE username = 'dd.vc'`);
}, 60000);
afterAll(async () => { await app.close(); await pool.end(); });

describe('quản lý điểm', () => {
  it('chỉ quản trị chọn, phải là người làm ở điểm đó, quản lý và người thay khác nhau', async () => {
    const bls = await uid('dd.bls'); const als = await uid('bs.als'); const vc = await uid('dd.vc');
    expect((await duoc('PUT', '/api/stations/TR-01/managers', { managerId: bls, deputyId: null })).http).toBe(403);
    expect((await admin('PUT', '/api/stations/TR-01/managers', { managerId: vc, deputyId: null })).http).toBe(400);
    expect((await admin('PUT', '/api/stations/TR-01/managers', { managerId: bls, deputyId: bls })).http).toBe(400);
    expect((await admin('PUT', '/api/stations/TR-01/managers', { managerId: bls, deputyId: als })).http).toBe(200);
    const st = (await admin('GET', '/api/stations')).data.find((s: any) => s.id === 'TR-01');
    expect(st.manager_id).toBe(bls);
    expect(st.deputy_name).toBeTruthy();
  });

  it('quản lý điểm nhận thông báo phiếu lĩnh của điểm mình, bấm vào mở đúng phiếu', async () => {
    const drug = (await pool.query(`SELECT id FROM drugs WHERE active AND NOT controlled AND track_lot ORDER BY id LIMIT 1`)).rows[0].id;
    const r = await ddBls('POST', '/api/requisitions', { stationId: 'TR-01', lines: [{ drugId: drug, qty: 3 }] });
    expect(r.http).toBe(200);
    expect((await duoc('POST', `/api/requisitions/${r.id}/decide`, { approve: true })).http).toBe(200);
    const n = await pool.query(`SELECT link FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.username = 'bs.als' AND n.kind = 'requisition'`);
    expect(n.rows.map((x) => x.link)).toContain(`/kho#phieu-linh-${r.id}`);
  });
});

describe('phiếu đề xuất và phiếu lĩnh khi điểm đã có quản lý', () => {
  it('kíp không lập phiếu đề xuất, chỉ báo thiếu hoặc lập phiếu khẩn có lý do; quản lý điểm lập và ký nhận', async () => {
    const drug = (await pool.query(`SELECT id FROM drugs WHERE active AND NOT controlled AND track_lot ORDER BY id LIMIT 1`)).rows[0].id;
    const als = await login(app, 'bs.als');
    await admin('PUT', '/api/stations/TR-01/managers', { managerId: await uid('bs.als'), deputyId: null });
    expect((await ddBls('GET', '/api/requisitions/rights?stationId=TR-01'))).toMatchObject({ manager: false, canPropose: false, canUrgent: true });
    expect((await ddBls('POST', '/api/requisitions', { stationId: 'TR-01', lines: [{ drugId: drug, qty: 2 }] })).http).toBe(403);
    expect((await ddBls('POST', '/api/requisitions', { stationId: 'TR-01', urgent: true, lines: [{ drugId: drug, qty: 2 }] })).http).toBe(400);
    const urgent = await ddBls('POST', '/api/requisitions', { stationId: 'TR-01', urgent: true, note: 'Đêm, gọi quản lý không được', lines: [{ drugId: drug, qty: 2 }] });
    expect(urgent.http).toBe(200);
    expect(urgent.code).toMatch(/^PDX-/);
    const sh = await ddBls('POST', '/api/stations/TR-01/shortages', { drugId: drug, qty: 4, note: 'Hết ở tủ' });
    expect(sh.http).toBe(200);
    const ov = await als('GET', '/api/station-manager/overview?stationId=TR-01');
    expect(ov.http ?? 200, JSON.stringify(ov)).toBe(200);
    expect(ov.shortages.map((x: any) => x.id)).toContain(sh.id);
    expect((await ddBls('GET', '/api/station-manager/overview?stationId=TR-01')).http).toBe(403);
    const p = await als('POST', '/api/requisitions', { stationId: 'TR-01', shortageIds: [sh.id], lines: [{ drugId: drug, qty: 4 }] });
    expect(p.code).toMatch(/^PDX-/);
    expect((await als('GET', '/api/station-manager/overview?stationId=TR-01')).shortages).toHaveLength(0);
    // Kho tổng phát phiếu lĩnh định kỳ; quản lý điểm ký nhận, kíp không ký được
    expect((await als('POST', '/api/requisitions', { stationId: 'TR-01', kind: 'linh', lines: [{ drugId: drug, qty: 1 }] })).http).toBe(403);
    const l = await duoc('POST', '/api/requisitions', { stationId: 'TR-01', kind: 'linh', lines: [{ drugId: drug, qty: 1 }] });
    expect(l.code).toMatch(/^PL-/);
    expect((await duoc('POST', `/api/requisitions/${l.id}/issue`, {})).http).toBe(200);
    expect((await ddBls('POST', `/api/requisitions/${l.id}/receive`, { lines: [] })).http).toBe(403);
    expect((await als('POST', `/api/requisitions/${l.id}/receive`, { lines: [] })).http).toBe(200);
    // Ký số từng bước, lịch sử xuất nhập ghi đúng lô, ai nhận
    const d = await als('GET', `/api/requisitions/${l.id}`);
    expect(d.signatures.map((x: any) => x.purpose)).toEqual(['lap_phieu', 'xuat_kho', 'nhan_hang']);
    const h = await als('GET', `/api/stock/history?stationId=TR-01&drugId=${drug}`);
    const rec = h.data.find((m: any) => m.requisition_id === l.id);
    expect(rec).toMatchObject({ reason: 'nhan_kho_tong', delta: 1, requisition_code: l.code });
    expect(rec.user_name).toBeTruthy();
    expect(rec.issued_by_name).toBeTruthy();
  });
});
