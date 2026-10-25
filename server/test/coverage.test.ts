import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { computeCoverage, defaultArea, grid, pickSources } from '../src/coverage.js';
import type { VehicleRow } from '../src/fleet.js';
import { freshApp, login } from './helpers.js';

const v = (id: string, o: Partial<VehicleRow>): VehicleRow => ({
  id, type: 'ALS', plate: null, station_id: 'TS', station_lat: 10.77, station_lng: 106.70, duty: '24/7', status: 'S1', status_since: '',
  lat: null, lng: null, current_incident_id: null, free_hint_at: null, supplies_ok: true, supplies_note: null, ...o,
});

describe('tính vùng phủ', () => {
  it('chọn xe theo kịch bản: hiện tại chỉ xe sẵn sàng; bỏ xe bị khóa, xe hành chính ngoài giờ, xe giả định đi', () => {
    const night = new Date('2026-10-25T15:00:00Z'); // 22h Chủ nhật giờ Việt Nam
    const list = [
      v('A', {}), v('B', { status: 'S4', lat: 10.8, lng: 106.6 }), v('C', { equipment_gaps: 'thiếu máy sốc điện' }),
      v('D', { type: 'BLS', status: 'S2', lat: 10.9, lng: 106.8 }), v('E', { type: 'VC' }), v('F', { duty: 'office', type: 'BLS' }), v('G', { type: 'DP', duty: 'reserve', status: 'S9' }),
    ];
    expect(pickSources(list, 'hien_tai', 'cap_cuu', [], night).map((s) => s.id)).toEqual(['A', 'D']);
    expect(pickSources(list, 'hien_tai', 'cap_cuu', [], night).find((s) => s.id === 'D')).toMatchObject({ lat: 10.9, lng: 106.8 });
    expect(pickSources(list, 'du_kien', 'cap_cuu', [], night).map((s) => s.id)).toEqual(['A', 'B', 'D', 'G']);
    expect(pickSources(list, 'du_kien', 'cap_cuu', [], night).find((s) => s.id === 'B')).toMatchObject({ lat: 10.77, lng: 106.70 });
    expect(pickSources(list, 'du_kien', 'als', ['A'], night).map((s) => s.id)).toEqual(['B', 'G']);
  });

  it('ô gần xe tới kịp, ô xa bị hở; tỉ lệ ca được phủ; gợi ý chỗ đặt xe phủ thêm nhiều ca nhất', () => {
    const src = [{ id: 'A', type: 'ALS', lat: 10.77, lng: 106.70 }];
    const near = Array.from({ length: 6 }, () => ({ lat: 10.775, lng: 106.705 }));
    const far = Array.from({ length: 4 }, () => ({ lat: 10.95, lng: 106.85 }));
    const area = defaultArea([...src, ...near, ...far], 2)!;
    const r = computeCoverage({ area, cellKm: 1, sources: src, demand: [...near, ...far], target: 15 });
    expect(r.summary.demand).toBe(10);
    expect(r.summary.demandCovered).toBe(6);
    expect(r.summary.demandCoveredPct).toBe(60);
    expect(r.summary.areaCoveredPct).toBeLessThan(50);
    expect(r.cells.reduce((t, c) => t + c.demand, 0)).toBe(10);
    expect(r.suggestions[0].gain).toBe(4);
    expect(Math.abs(r.suggestions[0].lat - 10.95)).toBeLessThan(0.05);
    const none = computeCoverage({ area, cellKm: 1, sources: [], demand: near, target: 15 });
    expect(none.summary.demandCovered).toBe(0);
    expect(none.cells.every((c) => c.minutes === null)).toBe(true);
  });

  it('lưới tự nới ô khi địa bàn quá rộng', () => {
    const g = grid({ south: 10, north: 11.5, west: 106, east: 107.5 }, 0.5);
    expect(g.centers.length).toBeLessThanOrEqual(3600);
    expect(g.cellKm).toBeGreaterThan(0.5);
  });
});

describe('API vùng phủ', () => {
  let app: FastifyInstance; let pool: pg.Pool;
  beforeAll(async () => { ({ app, pool } = await freshApp()); });
  afterAll(async () => { await app.close(); await pool.end(); });

  it('điều phối xem bản đồ, giả định một xe đi; kíp không xem được', async () => {
    await pool.query(`UPDATE vehicles SET status = 'S1' WHERE duty = '24/7'`);
    await pool.query(`INSERT INTO incidents(code, source, status, lat, lng, final_priority) VALUES ('T-1', '1800', 'closed', 10.78, 106.70, 'P1'), ('T-2', '1800', 'closed', 11.2, 107.2, 'P2')`);
    const dpv = await login(app, 'dpv06');
    const r = await dpv('GET', '/api/coverage?scenario=hien_tai&target=15');
    expect(r.http).toBe(200);
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.summary.demand).toBe(2);
    expect(r.summary.demandCovered).toBe(1);
    expect(r.suggestions[0].gain).toBe(1);
    const ids = r.sources.map((s: any) => s.id).join(',');
    const all = await dpv('GET', `/api/coverage?exclude=${ids}`);
    expect(all.sources).toHaveLength(0);
    expect(all.summary.demandCovered).toBe(0);
    expect((await dpv('GET', '/api/coverage/summary')).demandCoveredPct).toBe(50);
    expect((await dpv('GET', '/api/coverage?target=2')).http).toBe(400);
    const crew = await login(app, 'bs.als');
    expect((await crew('GET', '/api/coverage')).http).toBe(403);
  });
});
