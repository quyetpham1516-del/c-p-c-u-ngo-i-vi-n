import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many } from '../db.js';
import { computeCoverage, defaultArea, demandPoints, FLEET_GROUP, pickSources, SCENARIO } from '../coverage.js';
import { guard, type Ctx, type Role } from '../http.js';
import { loadVehicles } from './fleet.js';

const VIEW: Role[] = ['calltaker', 'dispatcher', 'supervisor', 'qa', 'admin', 'director'];
const PRIORITY_SET: Record<string, string[] | null> = { tat_ca: null, p1: ['P1'], p1p2: ['P1', 'P2'] };

const Query = z.object({
  scenario: z.enum(Object.keys(SCENARIO) as [string, ...string[]]).default('hien_tai'),
  group: z.enum(Object.keys(FLEET_GROUP) as [string, ...string[]]).default('cap_cuu'),
  target: z.coerce.number().int().min(5).max(60).default(15),
  days: z.coerce.number().int().min(7).max(365).default(90),
  priorities: z.enum(Object.keys(PRIORITY_SET) as [string, ...string[]]).default('tat_ca'),
  exclude: z.string().max(400).optional(),
  cellKm: z.coerce.number().min(0.3).max(5).default(1),
  suggest: z.coerce.number().int().min(0).max(5).default(3),
});

export function registerCoverage(app: FastifyInstance, { pool }: Ctx) {
  app.get('/api/coverage/meta', { preHandler: guard(...VIEW) }, async () => ({
    scenarios: SCENARIO, groups: Object.fromEntries(Object.entries(FLEET_GROUP).map(([k, v]) => [k, v.label])),
    priorities: { tat_ca: 'Mọi ca', p1: 'Ca P1', p1p2: 'Ca P1, P2' },
  }));

  /** Bản đồ vùng phủ theo kịch bản; exclude = các xe giả định đi làm nhiệm vụ (ví dụ "nếu xe ALS-01 đi thì hở chỗ nào") */
  app.get('/api/coverage', { preHandler: guard(...VIEW) }, async (req) => {
    const q = Query.parse(req.query);
    const exclude = (q.exclude ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const [vehicles, stations, demand] = await Promise.all([
      loadVehicles(pool), many(pool, 'SELECT id, name, lat, lng FROM stations WHERE active ORDER BY id'), demandPoints(pool, q.days, PRIORITY_SET[q.priorities]),
    ]);
    const sources = pickSources(vehicles, q.scenario, q.group, exclude);
    const area = defaultArea([...stations, ...demand]);
    if (!area) return { area: null, stations, sources, cells: [], summary: null, suggestions: [] };
    const r = computeCoverage({ area, cellKm: q.cellKm, sources, demand: demand.slice(0, 5000), target: q.target, suggest: q.suggest });
    const typeOf = Object.fromEntries(vehicles.map((v) => [v.id, v.type]));
    return {
      area, stations, sources, target: q.target, ...r,
      excluded: exclude,
      vehicles: vehicles.filter((v) => (FLEET_GROUP[q.group].types).includes(v.type)).map((v) => ({ id: v.id, type: v.type, status: v.status, duty: v.duty, used: sources.some((s) => s.id === v.id) })),
      types: typeOf,
    };
  });

  /** Tóm tắt nhanh cho bảng đội xe: tỉ lệ ca 90 ngày qua nằm trong vùng xe sẵn sàng tới kịp */
  app.get('/api/coverage/summary', { preHandler: guard(...VIEW) }, async () => {
    const [vehicles, stations, demand] = await Promise.all([
      loadVehicles(pool), many(pool, 'SELECT id, name, lat, lng FROM stations WHERE active ORDER BY id'), demandPoints(pool, 90, null),
    ]);
    const area = defaultArea([...stations, ...demand]);
    const sources = pickSources(vehicles, 'hien_tai', 'cap_cuu');
    if (!area) return { sources: sources.length, demandCoveredPct: null, areaCoveredPct: null };
    const r = computeCoverage({ area, cellKm: 1.5, sources, demand: demand.slice(0, 5000), target: 15, suggest: 0 });
    return { target: 15, ...r.summary };
  });
}
