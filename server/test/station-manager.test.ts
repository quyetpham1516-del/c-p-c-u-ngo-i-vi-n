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
