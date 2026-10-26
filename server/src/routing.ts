import { AVAILABLE, suggestVehicles, vehiclePos, type RoadTimes, type VehicleRow } from './fleet.js';
import type { Priority, VehicleType } from './triage/protocol.js';

/**
 * Chỉ đường theo đường bộ bằng OSRM (miễn phí, dữ liệu OpenStreetMap). Bật bằng MEDONE_OSRM_URL, ví dụ http://127.0.0.1:5001.
 * OSRM không có giao thông thời gian thực: MEDONE_OSRM_FACTOR nhân thêm thời gian cho giờ cao điểm nội đô (mặc định 1).
 * Máy chủ chỉ đường không trả lời trong 2,5 giây thì quay về ước tính theo khoảng cách, điều phối không bị chặn.
 */
type Pt = { lat: number; lng: number };

export function osrmConfig() {
  const url = process.env.MEDONE_OSRM_URL?.trim().replace(/\/+$/, '');
  if (!url) return null;
  const factor = Number(process.env.MEDONE_OSRM_FACTOR ?? '1');
  return { url, profile: process.env.MEDONE_OSRM_PROFILE?.trim() || 'driving', factor: Number.isFinite(factor) && factor > 0 ? factor : 1 };
}

const TIMEOUT_MS = 2500;
let lastError = 0;
const coord = (p: Pt) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

async function osrmGet(path: string): Promise<any | null> {
  const c = osrmConfig();
  if (!c) return null;
  try {
    const r = await fetch(`${c.url}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j: any = await r.json();
    if (!r.ok || j.code !== 'Ok') throw new Error(j.message ?? j.code ?? `HTTP ${r.status}`);
    return j;
  } catch (e) {
    // Ghi lỗi tối đa mỗi phút một lần để không làm đầy nhật ký khi máy chủ chỉ đường tắt
    if (Date.now() - lastError > 60_000) { lastError = Date.now(); console.warn(`[osrm] không gọi được máy chủ chỉ đường: ${(e as Error).message}`); }
    return null;
  }
}

const minutes = (sec: number, factor: number) => Math.round((sec / 60) * factor * 10) / 10;
const km = (m: number) => Math.round((m / 1000) * 10) / 10;

/** Thời gian và quãng đường đường bộ từ nhiều điểm tới một đích (một lần gọi bảng OSRM). null: không có máy chủ hoặc lỗi */
export async function roadTable(origins: Pt[], dest: Pt): Promise<({ km: number; min: number } | null)[] | null> {
  const c = osrmConfig();
  if (!c || origins.length === 0) return null;
  const pts = [...origins, dest].map(coord).join(';');
  const sources = origins.map((_, i) => i).join(';');
  const j = await osrmGet(`/table/v1/${c.profile}/${pts}?sources=${sources}&destinations=${origins.length}&annotations=duration,distance`);
  if (!j) return null;
  return origins.map((_, i) => {
    const d = j.durations?.[i]?.[0]; const m = j.distances?.[i]?.[0];
    return typeof d === 'number' ? { min: minutes(d, c.factor), km: typeof m === 'number' ? km(m) : 0 } : null;
  });
}

/** Một tuyến đường (trang theo dõi cho gia đình, báo trước bệnh viện) */
export async function roadRoute(from: Pt, to: Pt): Promise<{ km: number; min: number } | null> {
  const c = osrmConfig();
  if (!c) return null;
  const j = await osrmGet(`/route/v1/${c.profile}/${coord(from)};${coord(to)}?overview=false`);
  const r = j?.routes?.[0];
  return r ? { km: km(r.distance), min: minutes(r.duration, c.factor) } : null;
}

export const roadBasis = () => {
  const c = osrmConfig();
  return `Thời gian theo đường bộ (OSRM, bản đồ OpenStreetMap)${c && c.factor !== 1 ? ` × ${c.factor} cho giao thông` : ''}; chưa có giao thông thời gian thực`;
};

/** Gợi ý xe có tính đường bộ khi bật OSRM; không bật hoặc lỗi thì như cũ */
export async function suggestWithRoads(vehicles: VehicleRow[], scene: Pt | null, requested: VehicleType | null, priority: Priority | null) {
  if (!scene || !osrmConfig()) return suggestVehicles(vehicles, scene, requested, priority);
  const candidates = vehicles.filter((v) => AVAILABLE.has(v.status)).map((v) => ({ v, p: vehiclePos(v) })).filter((x): x is { v: VehicleRow; p: Pt } => !!x.p);
  const table = await roadTable(candidates.map((x) => x.p), scene);
  if (!table) return suggestVehicles(vehicles, scene, requested, priority);
  const times: RoadTimes = {};
  candidates.forEach((x, i) => { const t = table[i]; if (t) times[x.v.id] = t; });
  return suggestVehicles(vehicles, scene, requested, priority, new Date(), { times, basis: roadBasis() });
}
