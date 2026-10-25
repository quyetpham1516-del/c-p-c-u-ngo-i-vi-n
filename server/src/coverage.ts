import { many, type Queryable } from './db.js';
import { AVAILABLE, haversineKm, isOfficeHours, travelMinutes, type VehicleRow } from './fleet.js';

/**
 * Vùng phủ: chia địa bàn thành ô lưới, mỗi ô tính thời gian xe gần nhất tới được (ước tính theo khoảng cách như phần gợi ý xe,
 * chưa có giao thông). Ô quá chỉ tiêu là vùng bị hở. Đối chiếu nhu cầu thật (ca đã xảy ra) để biết bao nhiêu phần trăm ca
 * nằm trong vùng tới kịp, và gợi ý chỗ đặt xe tạm trú phủ thêm được nhiều ca nhất.
 */

export const SCENARIO: Record<string, string> = {
  hien_tai: 'Hiện tại: chỉ xe đang sẵn sàng (S1, S2) ở vị trí hiện tại',
  du_kien: 'Đủ xe: mọi xe trực (cả xe dự phòng) đứng tại trạm, kể cả xe đang làm hoặc ngoài ca',
};
/** Nhóm xe tính phủ: cấp cứu (ALS, BLS, MSU, dự phòng) hoặc chỉ ALS cho ca P1 */
export const FLEET_GROUP: Record<string, { label: string; types: string[] }> = {
  cap_cuu: { label: 'Xe cấp cứu (ALS, BLS, đột quỵ, dự phòng)', types: ['ALS', 'BLS', 'MSU', 'DP'] },
  als: { label: 'Chỉ xe ALS và dự phòng (ca P1)', types: ['ALS', 'DP'] },
};

export interface Source { id: string; type: string; lat: number; lng: number }
export interface Cell { lat: number; lng: number; minutes: number | null; by: string | null; demand: number }

const MAX_CELLS = 3600;

/** Chọn xe làm nguồn phủ theo kịch bản; bỏ xe đang khóa (thiếu thiết bị bắt buộc, hết hạn đăng kiểm) và xe trực giờ hành chính lúc ngoài giờ */
export function pickSources(vehicles: VehicleRow[], scenario: string, group: string, exclude: string[] = [], now = new Date()): Source[] {
  const types = FLEET_GROUP[group]?.types ?? FLEET_GROUP.cap_cuu.types;
  const office = isOfficeHours(now);
  return vehicles
    .filter((v) => types.includes(v.type) && !exclude.includes(v.id) && !v.locked && !v.equipment_gaps)
    .filter((v) => v.duty !== 'office' || office)
    .filter((v) => scenario === 'du_kien' || AVAILABLE.has(v.status))
    .map((v) => {
      const atStation = scenario === 'du_kien' || v.lat == null || v.lng == null;
      return { id: v.id, type: v.type, lat: atStation ? Number(v.station_lat) : Number(v.lat), lng: atStation ? Number(v.station_lng) : Number(v.lng) };
    })
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

export interface Area { south: number; west: number; north: number; east: number }

/** Địa bàn mặc định: khung chứa các trạm và các ca đã có tọa độ, nới thêm biên */
export function defaultArea(points: { lat: number; lng: number }[], padKm = 8): Area | null {
  if (!points.length) return null;
  const lats = points.map((p) => p.lat); const lngs = points.map((p) => p.lng);
  const dLat = padKm / 111; const mid = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLng = padKm / (111 * Math.cos((mid * Math.PI) / 180));
  return { south: Math.min(...lats) - dLat, north: Math.max(...lats) + dLat, west: Math.min(...lngs) - dLng, east: Math.max(...lngs) + dLng };
}

/** Lưới ô vuông cạnh cellKm (tự nới to nếu quá nhiều ô) */
export function grid(area: Area, cellKm: number) {
  const mid = (area.south + area.north) / 2;
  const kmLng = 111 * Math.cos((mid * Math.PI) / 180);
  let size = cellKm;
  const count = (s: number) => Math.ceil(((area.north - area.south) * 111) / s) * Math.ceil(((area.east - area.west) * kmLng) / s);
  while (count(size) > MAX_CELLS) size *= 1.25;
  const dLat = size / 111; const dLng = size / kmLng;
  const centers: { lat: number; lng: number }[] = [];
  for (let lat = area.south + dLat / 2; lat < area.north; lat += dLat) {
    for (let lng = area.west + dLng / 2; lng < area.east; lng += dLng) centers.push({ lat, lng });
  }
  return { cellKm: Math.round(size * 100) / 100, dLat, dLng, centers };
}

function nearest(p: { lat: number; lng: number }, sources: Source[]) {
  let best: { minutes: number; by: string } | null = null;
  for (const s of sources) {
    const m = travelMinutes(haversineKm(p, s));
    if (!best || m < best.minutes) best = { minutes: m, by: s.id };
  }
  return best;
}

export function computeCoverage(opts: {
  area: Area; cellKm: number; sources: Source[]; demand: { lat: number; lng: number }[]; target: number; suggest?: number;
}) {
  const g = grid(opts.area, opts.cellKm);
  const key = (lat: number, lng: number) => `${Math.floor((lat - opts.area.south) / g.dLat)}:${Math.floor((lng - opts.area.west) / g.dLng)}`;
  const demandAt = new Map<string, number>();
  for (const d of opts.demand) {
    if (d.lat < opts.area.south || d.lat > opts.area.north || d.lng < opts.area.west || d.lng > opts.area.east) continue;
    const k = key(d.lat, d.lng); demandAt.set(k, (demandAt.get(k) ?? 0) + 1);
  }
  const cells: Cell[] = g.centers.map((c) => {
    const n = nearest(c, opts.sources);
    return { lat: c.lat, lng: c.lng, minutes: n?.minutes ?? null, by: n?.by ?? null, demand: demandAt.get(key(c.lat, c.lng)) ?? 0 };
  });
  const within = (m: number | null) => m != null && m <= opts.target;
  // Nhu cầu tính theo đúng vị trí ca, không theo tâm ô
  const demandIn = opts.demand.filter((d) => within(nearest(d, opts.sources)?.minutes ?? null)).length;
  const covered = cells.filter((c) => within(c.minutes)).length;

  // Gợi ý chỗ đặt xe tạm trú: chọn lần lượt ô có nhu cầu, mỗi lần chọn ô phủ thêm được nhiều ca nhất
  const suggestions: { lat: number; lng: number; gain: number; gainPct: number }[] = [];
  const uncovered = opts.demand.filter((d) => !within(nearest(d, opts.sources)?.minutes ?? null));
  let left = uncovered;
  const candidates = cells.filter((c) => c.demand > 0 || !within(c.minutes));
  for (let i = 0; i < (opts.suggest ?? 3) && left.length; i++) {
    let best: { c: Cell; hit: typeof left } | null = null;
    for (const c of candidates) {
      const hit = left.filter((d) => travelMinutes(haversineKm(c, d)) <= opts.target);
      if (hit.length && (!best || hit.length > best.hit.length)) best = { c, hit };
    }
    if (!best) break;
    suggestions.push({ lat: best.c.lat, lng: best.c.lng, gain: best.hit.length, gainPct: Math.round((1000 * best.hit.length) / Math.max(1, opts.demand.length)) / 10 });
    left = left.filter((d) => !best!.hit.includes(d));
  }

  return {
    cellKm: g.cellKm, dLat: g.dLat, dLng: g.dLng, cells,
    summary: {
      sources: opts.sources.length,
      cells: cells.length,
      areaCoveredPct: cells.length ? Math.round((1000 * covered) / cells.length) / 10 : 0,
      demand: opts.demand.length,
      demandCovered: demandIn,
      demandCoveredPct: opts.demand.length ? Math.round((1000 * demandIn) / opts.demand.length) / 10 : null,
    },
    suggestions,
  };
}

/** Vị trí các ca thật trong N ngày gần đây (bỏ ca hủy, chỉ tư vấn) làm nhu cầu */
export async function demandPoints(q: Queryable, days: number, priorities: string[] | null) {
  return many<{ lat: number; lng: number }>(q, `
    SELECT lat, lng FROM incidents
     WHERE lat IS NOT NULL AND lng IS NOT NULL AND created_at >= now() - make_interval(days => $1)
       AND status NOT IN ('cancelled', 'advice_only') AND ($2::text[] IS NULL OR final_priority = ANY($2::text[]))`, [days, priorities]);
}
