import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { VehicleRow } from '../src/fleet.js';
import { roadRoute, suggestWithRoads } from '../src/routing.js';

/** Máy chủ OSRM giả: xe A gần theo chim bay nhưng phải vòng qua sông (lâu), xe B xa hơn nhưng đường thẳng */
let srv: Server; let base = ''; let calls: string[] = []; let down = false;
beforeAll(async () => {
  srv = createServer((req, res) => {
    calls.push(req.url!);
    if (down) { res.writeHead(500); return res.end('{}'); }
    res.setHeader('content-type', 'application/json');
    if (req.url!.startsWith('/table/v1/driving/')) {
      const n = req.url!.split('?')[0].split('/').pop()!.split(';').length - 1;
      const durations = [[1500], [480], [600]].slice(0, n); // giây
      const distances = [[9000], [5200], [6100]].slice(0, n); // mét
      return res.end(JSON.stringify({ code: 'Ok', durations, distances }));
    }
    if (req.url!.startsWith('/route/v1/driving/')) return res.end(JSON.stringify({ code: 'Ok', routes: [{ duration: 720, distance: 7300 }] }));
    res.writeHead(404); res.end(JSON.stringify({ code: 'InvalidUrl' }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => { srv.close(); delete process.env.MEDONE_OSRM_URL; delete process.env.MEDONE_OSRM_FACTOR; });
beforeEach(() => { calls = []; down = false; process.env.MEDONE_OSRM_URL = base; delete process.env.MEDONE_OSRM_FACTOR; });

const v = (id: string, type: string, lat: number, lng: number, status = 'S1'): VehicleRow => ({
  id, type, plate: null, station_id: 'T', duty: '24h', status, status_since: new Date().toISOString(), lat, lng, current_incident_id: null, free_hint_at: null, supplies_ok: true, supplies_note: null,
});
const scene = { lat: 10.78, lng: 106.70 };
const fleet = [v('A', 'ALS', 10.775, 106.69), v('B', 'ALS', 10.82, 106.72), v('C', 'ALS', 10.80, 106.66), v('X', 'ALS', 10.78, 106.70, 'S4')];

describe('chỉ đường OSRM', () => {
  it('xếp xe theo thời gian đường bộ, không theo chim bay; giữ khoảng cách chim bay cho ngưỡng tự giao xe', async () => {
    const r = await suggestWithRoads(fleet, scene, 'ALS', 'P2');
    expect(r.suggestions.map((s) => s.vehicleId)).toEqual(['B', 'C', 'A']);
    expect(r.suggestions[0]).toMatchObject({ etaMin: 8, roadKm: 5.2 });
    expect(r.suggestions[2].distanceKm).toBeLessThan(2);
    expect(r.basis).toContain('OSRM');
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('106.700000,10.780000;106.700000'); // xe đang bận (X) không gửi đi tính
  });

  it('hệ số giao thông nhân vào thời gian', async () => {
    process.env.MEDONE_OSRM_FACTOR = '1.5';
    const r = await suggestWithRoads(fleet, scene, 'ALS', 'P2');
    expect(r.suggestions[0].etaMin).toBe(12);
    expect(r.basis).toContain('× 1.5');
  });

  it('máy chủ chỉ đường lỗi hoặc chưa cấu hình: quay về ước tính theo khoảng cách', async () => {
    down = true;
    const r = await suggestWithRoads(fleet, scene, 'ALS', 'P2');
    expect(r.suggestions[0].vehicleId).toBe('A');
    expect(r.suggestions[0].roadKm).toBeUndefined();
    expect(r.basis).toContain('chim bay');
    delete process.env.MEDONE_OSRM_URL; calls = [];
    expect((await suggestWithRoads(fleet, scene, 'ALS', 'P2')).basis).toContain('chim bay');
    expect(calls).toHaveLength(0);
  });

  it('tuyến đường cho trang theo dõi', async () => {
    expect(await roadRoute({ lat: 10.8, lng: 106.7 }, scene)).toEqual({ km: 7.3, min: 12 });
  });
});
