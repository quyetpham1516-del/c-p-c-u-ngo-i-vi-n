import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance; let pool: pg.Pool;
let bsAls: Client, bsMsu: Client, ddVc: Client, dpv: Client, truongca: Client, ysBls: Client, ddBls: Client;
let hid = '';

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [bsAls, bsMsu, ddVc, dpv, truongca, ysBls, ddBls] = await Promise.all(['bs.als', 'bs.msu', 'dd.vc', 'dpv06', 'truongca', 'ys.bls', 'dd.bls'].map((u) => login(app, u)));
}, 60000);
afterAll(async () => { await app.close(); await pool.end(); });

async function confirmedIncident() {
  const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000000' });
  await dpv('PATCH', `/api/incidents/${inc.id}`, { address: 'Hiện trường', lat: 10.78, lng: 106.70, callbackPhone: '0900000000' });
  await dpv('PUT', `/api/incidents/${inc.id}/triage`, { answers: { conscious: 'yes', breathing: 'difficult', age_group: 'adult' }, group: 'kho_tho' });
  await dpv('POST', `/api/incidents/${inc.id}/confirm`, { priority: 'P1', vehicleType: 'ALS', lights: true, overrideReason: 'kiểm thử' });
  return inc.id as string;
}

describe('bàn giao xe mỗi ca', () => {
  it('kíp mới nhận ca trên xe vừa có kíp khác thì mở biên bản; kíp đầu tiên trong ngày thì không', async () => {
    expect((await bsAls('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' })).http).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM vehicle_handovers')).rows[0].n).toBe(0);
    expect((await bsMsu('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' })).http).toBe(200);
    expect((await ddVc('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Điều dưỡng' })).http).toBe(200);
    const mine = (await bsAls('GET', '/api/handovers/mine')).data;
    expect(mine).toHaveLength(1);
    hid = mine[0].id;
    const h = await bsMsu('GET', `/api/handovers/${hid}`);
    expect(h.status).toBe('cho_giao');
    expect(h.incoming_people.map((p: any) => p.name).sort()).toEqual(['BS Kíp đột quỵ', 'ĐD Xe vận chuyển']);
    expect(h.items.length).toBeGreaterThan(0);
  });

  it('người giao (Trưởng kíp kíp cũ) đếm đủ, lệch phải ghi chú, ký; người nhận (Trưởng kíp kíp mới) ký thì khóa', async () => {
    const h = await bsAls('GET', `/api/handovers/${hid}`);
    const items = h.items.map((i: any) => ({ drugId: i.drugId, counted: i.book, condition: 'tot' }));
    const equipment = h.equipment.map((e: any) => ({ id: e.id, condition: 'tot' }));
    expect((await bsMsu('POST', `/api/handovers/${hid}/give`, { items, equipment })).http).toBe(403);
    expect((await bsAls('POST', `/api/handovers/${hid}/give`, { items: items.slice(1), equipment })).http).toBe(400);
    items[0].condition = 'thieu'; items[0].counted = Math.max(0, items[0].counted - 1);
    expect((await bsAls('POST', `/api/handovers/${hid}/give`, { items, equipment })).http).toBe(400);
    const g = await bsAls('POST', `/api/handovers/${hid}/give`, { items, equipment, note: 'Thiếu 1, đã báo kho' });
    expect(g.issues).toBe(1);
    expect((await ddVc('POST', `/api/handovers/${hid}/receive`, { agree: true })).http).toBe(403);
    expect((await bsMsu('POST', `/api/handovers/${hid}/receive`, { agree: false })).http).toBe(400);
    const r = await bsMsu('POST', `/api/handovers/${hid}/receive`, { agree: true });
    expect(r.status).toBe('da_khoa');
    expect((await bsMsu('POST', `/api/handovers/${hid}/receive`, { agree: true })).http).toBe(409);
  });

  it('quá 30 phút chưa ký, không có ca: xe bị khóa; có ca thì vẫn đi, về rồi mới tính tiếp; trưởng ca cho đi kèm lý do', async () => {
    await pool.query(`UPDATE users SET station_id = NULL WHERE username IN ('ys.bls', 'dd.bls')`);
    // người đến muộn của kíp vừa nhận (trong 2 giờ) chỉ được ghi thêm vào kíp nhận
    expect((await ddBls('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Lái xe' })).http).toBe(200);
    expect((await pool.query(`SELECT incoming FROM vehicle_handovers WHERE id = $1`, [hid])).rows[0].incoming).toHaveLength(3);
    expect((await pool.query(`SELECT count(*)::int AS n FROM vehicle_handovers`)).rows[0].n).toBe(1);
    await pool.query(`UPDATE vehicle_handovers SET created_at = now() - interval '3 hours'`);
    expect((await ysBls('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' })).http).toBe(200);
    const open = (await pool.query(`SELECT id FROM vehicle_handovers WHERE status <> 'da_khoa'`)).rows[0];
    expect(open).toBeTruthy();
    let board = await dpv('GET', '/api/board');
    expect(board.vehicles.find((v: any) => v.id === 'MD-ALS-01').locked).toBeNull();
    // có ca ngay khi chưa bàn giao: cứ đi
    await pool.query(`UPDATE vehicles SET status = 'S2' WHERE id = 'MD-ALS-01'`);
    const i1 = await confirmedIncident();
    expect((await dpv('POST', `/api/incidents/${i1}/assign`, { vehicleId: 'MD-ALS-01' })).http).toBe(200);
    await pool.query(`UPDATE vehicle_handovers SET reminded_at = now() - interval '31 minutes' WHERE id = $1`, [open.id]);
    board = await dpv('GET', '/api/board');
    expect(board.vehicles.find((v: any) => v.id === 'MD-ALS-01').locked).toBeNull();
    // đi ca về quá 30 phút vẫn chưa ký: khóa
    await pool.query(`UPDATE assignments SET ended_at = now() - interval '31 minutes' WHERE vehicle_id = 'MD-ALS-01' AND ended_at IS NULL`);
    await pool.query(`UPDATE vehicles SET status = 'S2', current_incident_id = NULL WHERE id = 'MD-ALS-01'`);
    board = await dpv('GET', '/api/board');
    expect(board.vehicles.find((v: any) => v.id === 'MD-ALS-01').locked).toContain('bàn giao');
    const i2 = await confirmedIncident();
    const blocked = await dpv('POST', `/api/incidents/${i2}/assign`, { vehicleId: 'MD-ALS-01' });
    expect(blocked.http).toBe(409);
    expect(blocked.details.code).toBe('HANDOVER');
    expect((await dpv('POST', `/api/incidents/${i2}/assign`, { vehicleId: 'MD-ALS-01', handoverOverride: 'P1 không còn xe' })).http).toBe(403);
    expect((await truongca('POST', `/api/incidents/${i2}/assign`, { vehicleId: 'MD-ALS-01', handoverOverride: 'P1 không còn xe', confirmFar: true })).http).toBe(200);
    expect((await ysBls('GET', '/api/handovers/mine')).data.filter((h: any) => h.status !== 'da_khoa')).toHaveLength(1);
  });
});
