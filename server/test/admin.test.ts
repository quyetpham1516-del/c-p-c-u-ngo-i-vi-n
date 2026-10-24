import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;
let admin: Awaited<ReturnType<typeof login>>;
let dpv: Awaited<ReturnType<typeof login>>;
let crew: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  admin = await login(app, 'admin');
  dpv = await login(app, 'dpv06');
  crew = await login(app, 'ys.bls');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('điểm/trạm do quản trị quyết định', () => {
  it('chỉ admin tạo được điểm mới', async () => {
    const body = { id: 'tr-03', name: 'Trạm 3 – Thủ Đức', kind: 'tram', address: 'Thủ Đức', lat: 10.85, lng: 106.77 };
    expect((await dpv('POST', '/api/stations', body)).http).toBe(403);
    const s = await admin('POST', '/api/stations', body);
    expect(s.http).toBe(200);
    expect(s.id).toBe('TR-03');
    expect((await admin('POST', '/api/stations', body)).http).toBe(409);
    const list = await dpv('GET', '/api/stations');
    expect(list.data.map((x: any) => x.id)).toContain('TR-03');
  });

  it('chuyển xe sang điểm mới; điểm còn xe thì không tạm ngưng được', async () => {
    expect((await admin('PATCH', '/api/vehicles/MD-BLS-01/station', { stationId: 'TR-03' })).http).toBe(200);
    const r = await admin('PATCH', '/api/stations/TR-03', { active: false });
    expect(r.http).toBe(409);
    expect((await admin('PATCH', '/api/vehicles/MD-BLS-01/station', { stationId: 'TR-01' })).http).toBe(200);
    expect((await admin('PATCH', '/api/stations/TR-03', { active: false })).http).toBe(200);
    expect((await dpv('GET', '/api/stations')).data.map((x: any) => x.id)).not.toContain('TR-03');
    expect((await admin('GET', '/api/stations?all=1')).data.map((x: any) => x.id)).toContain('TR-03');
    const d = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
    const stock = await admin('POST', '/api/stock/receive', { stationId: 'TR-03', drugName: 'Thuốc thử', lot: 'X1', expiry: d, qty: 1 });
    expect(stock.http).toBe(409);
  });

  it('kíp được phân điểm chỉ thấy và nhận xe của điểm đó', async () => {
    const users = await admin('GET', '/api/users');
    const u = users.data.find((x: any) => x.username === 'ys.bls');
    expect((await admin('PATCH', `/api/users/${u.id}/station`, { stationId: 'TR-01' })).http).toBe(200);
    const vs = await crew('GET', '/api/crew/vehicles');
    expect(vs.data.every((v: any) => v.station_id === 'TR-01')).toBe(true);
    expect((await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' })).http).toBe(403);
    expect((await crew('POST', '/api/crew/shift', { vehicleId: 'MD-BLS-01', crewRole: 'Trưởng kíp' })).http).toBe(200);
  });
});
