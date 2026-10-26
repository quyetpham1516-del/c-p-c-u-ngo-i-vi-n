import type { Queryable } from './db.js';
import type { Priority, VehicleType } from './triage/protocol.js';

export const STATUS_LABEL: Record<string, string> = {
  S1: 'Sẵn sàng tại trạm',
  S2: 'Sẵn sàng ngoài trạm',
  S3: 'Đã nhận lệnh',
  S4: 'Đang đến hiện trường',
  S5: 'Tại hiện trường',
  S6: 'Đang vận chuyển',
  S7: 'Tại bệnh viện, chờ bàn giao',
  S8: 'Bổ sung, khử khuẩn',
  S9: 'Ngoài hoạt động',
};

export const VEHICLE_LABEL: Record<string, string> = {
  ALS: 'Cấp cứu nâng cao (ALS)',
  BLS: 'Cấp cứu cơ bản (BLS)',
  MSU: 'Đột quỵ có CT (MSU)',
  ECMO: 'ECMO',
  VC: 'Vận chuyển người bệnh',
  DP: 'Dự phòng',
  NONE: 'Không cần xe',
};

export const AVAILABLE = new Set(['S1', 'S2']);

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Ước tính thời gian di chuyển theo khoảng cách (MVP, mục 12.5: "gợi ý khoảng cách").
 * Hệ số đường 1,4 và 30 km/h nội đô; sẽ thay bằng dịch vụ bản đồ có giao thông sau go-live.
 */
export function travelMinutes(km: number): number {
  return Math.round((1 + (km * 1.4) / 30 * 60) * 10) / 10;
}

/** Giờ hành chính của xe ECMO và xe vận chuyển: thứ 2–6, 7:00–17:00 giờ Việt Nam (cấu hình được) */
export function isOfficeHours(d = new Date()): boolean {
  const vn = new Date(d.getTime() + 7 * 3600_000);
  const day = vn.getUTCDay();
  const h = vn.getUTCHours();
  return day >= 1 && day <= 5 && h >= 7 && h < 17;
}

/** Xe nào phục vụ được yêu cầu nào; thứ tự = ưu tiên (rank nhỏ hơn tốt hơn) */
const SERVES: Record<Exclude<VehicleType, 'NONE'>, { type: string; rank: number; note?: string }[]> = {
  ALS: [
    { type: 'ALS', rank: 0 },
    { type: 'DP', rank: 1, note: 'Xe dự phòng trang bị mức ALS' },
    { type: 'MSU', rank: 2, note: 'Xe đột quỵ: chỉ dùng khi là xe gần nhất; ưu tiên giữ cho ca đột quỵ' },
    { type: 'BLS', rank: 3, note: 'BLS hỗ trợ khi ALS xa' },
  ],
  BLS: [
    { type: 'BLS', rank: 0 },
    { type: 'DP', rank: 1 },
    { type: 'ALS', rank: 2, note: 'Dùng ALS cho ca P3 làm giảm sẵn sàng cho ca P1' },
  ],
  MSU: [
    { type: 'MSU', rank: 0 },
    { type: 'ALS', rank: 1, note: 'MSU không sẵn sàng: dùng ALS, chọn viện có tiêu sợi huyết/lấy huyết khối' },
  ],
  ECMO: [{ type: 'ECMO', rank: 0 }],
  VC: [
    { type: 'VC', rank: 0 },
    { type: 'BLS', rank: 1, note: 'Không dùng xe đang trực cấp cứu nếu không có dự phòng' },
  ],
};

export interface VehicleRow {
  id: string;
  type: string;
  plate: string | null;
  station_id: string;
  station_name?: string;
  station_lat?: number;
  station_lng?: number;
  duty: string;
  status: string;
  status_since: string;
  lat: number | null;
  lng: number | null;
  current_incident_id: string | null;
  free_hint_at: string | null;
  supplies_ok: boolean;
  supplies_note: string | null;
  /** Thiết bị bắt buộc còn thiếu/hỏng/quá hạn kiểm định (rỗng = đủ) */
  equipment_gaps?: string | null;
  locked?: string | null;
  fleet_warnings?: string | null;
}

export interface Suggestion {
  vehicleId: string;
  type: string;
  status: string;
  distanceKm: number | null;
  /** Quãng đường theo đường bộ khi có máy chủ chỉ đường (OSRM) */
  roadKm?: number | null;
  etaMin: number | null;
  rank: number;
  note?: string;
}

export interface SuggestResult {
  suggestions: Suggestion[];
  advice: string[];
  basis: string;
}

/** Vị trí dùng để tính đường: GPS của xe, chưa có thì vị trí điểm trực */
export const vehiclePos = (v: VehicleRow) => (v.lat != null && v.lng != null ? { lat: v.lat, lng: v.lng }
  : v.station_lat != null && v.station_lng != null ? { lat: v.station_lat, lng: v.station_lng } : null);

export type RoadTimes = Record<string, { km: number; min: number }>;
const DISTANCE_BASIS = 'Ước tính theo khoảng cách đường chim bay × 1,4, 30 km/h; chưa tính giao thông';

export function suggestVehicles(
  vehicles: VehicleRow[],
  scene: { lat: number; lng: number } | null,
  requested: VehicleType | null,
  priority: Priority | null,
  now = new Date(),
  road?: { times: RoadTimes; basis: string },
): SuggestResult {
  const advice: string[] = [];
  if (!requested || requested === 'NONE') {
    return { suggestions: [], advice: ['Ca không cần xe: chuyển điều dưỡng tư vấn.'], basis: 'none' };
  }
  const office = isOfficeHours(now);
  if ((requested === 'ECMO' || requested === 'VC') && !office) {
    advice.push(requested === 'ECMO'
      ? 'Ngoài giờ hành chính: chuyển ngay ca ECMO sang đội ECMO của bệnh viện đối tác.'
      : 'Ngoài giờ hành chính: xe vận chuyển không trực, hẹn lại hoặc trưởng ca quyết định.');
  }
  const rules = SERVES[requested];
  const out: Suggestion[] = [];
  for (const v of vehicles) {
    if (!AVAILABLE.has(v.status)) continue;
    if (v.duty === 'office' && !office) continue;
    const rule = rules.find((r) => r.type === v.type);
    if (!rule) continue;
    if (v.locked) {
      advice.push(`${v.id} rảnh nhưng bị khóa: ${v.locked}.`);
      continue;
    }
    if (v.equipment_gaps) {
      advice.push(`${v.id} rảnh nhưng không được gợi ý: thiếu thiết bị bắt buộc (${v.equipment_gaps}).`);
      continue;
    }
    // BLS chỉ là phương án hỗ trợ cho P1/P2 khi ALS xa, xét ở dưới
    const pos = vehiclePos(v);
    const km = scene && pos ? haversineKm(pos, scene) : null;
    const r = road?.times[v.id];
    out.push({
      vehicleId: v.id, type: v.type, status: v.status,
      distanceKm: km == null ? null : Math.round(km * 10) / 10,
      ...(r ? { roadKm: r.km } : {}),
      etaMin: r ? r.min : km == null ? null : travelMinutes(km),
      rank: rule.rank, note: rule.note,
    });
  }
  out.sort((a, b) => a.rank - b.rank || (a.etaMin ?? 999) - (b.etaMin ?? 999));

  if (requested === 'ALS' && (priority === 'P1' || priority === 'P2')) {
    const limit = priority === 'P1' ? 12 : 15;
    const bestAls = out.find((s) => s.type === 'ALS' || s.type === 'DP');
    const bestBls = out.filter((s) => s.type === 'BLS').sort((a, b) => (a.etaMin ?? 999) - (b.etaMin ?? 999))[0];
    if ((!bestAls || (bestAls.etaMin ?? 999) > limit) && bestBls) {
      advice.push(`ALS gần nhất ${bestAls ? `cần ~${bestAls.etaMin} phút` : 'không có'} (> ${limit} phút): gửi đồng thời ${bestBls.vehicleId} (BLS).`);
    }
    if (!bestAls && !bestBls) {
      advice.push(priority === 'P1'
        ? 'Không còn xe phù hợp: rút xe từ ca P3–P4, đồng thời gửi yêu cầu hỗ trợ tới 115 tỉnh.'
        : 'Không còn xe phù hợp: đưa vào hàng chờ, gọi lại người gọi 10 phút/lần.');
    }
  } else if (out.length === 0) {
    advice.push('Không có xe sẵn sàng phù hợp: đưa vào hàng chờ hoặc chuyển 115.');
  }
  const usedRoad = road && out.some((o) => road.times[o.vehicleId]);
  return { suggestions: out, advice, basis: usedRoad ? road.basis : DISTANCE_BASIS };
}

/* ---------- Dự kiến rảnh lúc mấy (mục 5.12) ---------- */

/** Trung vị mặc định (phút) khi chưa đủ dữ liệu 90 ngày */
export const DEFAULT_MEDIAN_MIN: Record<string, number> = { S3: 1.5, S4: 10, S5: 20, S6: 18, S7: 15, S8: 15 };
const CHAIN = ['S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

let medianCache: { at: number; data: Record<string, number> } | null = null;

export async function statusMedians(q: Queryable): Promise<Record<string, number>> {
  if (medianCache && Date.now() - medianCache.at < 5 * 60_000) return medianCache.data;
  const rows = (await q.query(
    `SELECT status, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ended_at - started_at)) / 60 AS med
       FROM vehicle_status_log
      WHERE ended_at IS NOT NULL AND started_at > now() - interval '90 days' AND status = ANY($1)
      GROUP BY status HAVING count(*) >= 20`,
    [CHAIN],
  )).rows;
  const data = { ...DEFAULT_MEDIAN_MIN };
  for (const r of rows) data[r.status] = Math.round(Number(r.med) * 10) / 10;
  medianCache = { at: Date.now(), data };
  return data;
}

export function resetMedianCache(): void {
  medianCache = null;
}

export interface FreeEstimate {
  freeAt: string | null;
  lowAt: string | null;
  highAt: string | null;
  basis: string;
}

export function estimateFree(
  v: Pick<VehicleRow, 'status' | 'status_since' | 'free_hint_at'>,
  medians: Record<string, number>,
  now = new Date(),
  travelToSceneMin?: number | null,
): FreeEstimate {
  if (AVAILABLE.has(v.status)) return { freeAt: now.toISOString(), lowAt: null, highAt: null, basis: 'Đang rảnh' };
  if (v.status === 'S9') return { freeAt: null, lowAt: null, highAt: null, basis: 'Ngoài hoạt động' };
  if (v.free_hint_at && new Date(v.free_hint_at) > now) {
    return { freeAt: v.free_hint_at, lowAt: null, highAt: null, basis: 'Kíp báo' };
  }
  const elapsed = (now.getTime() - new Date(v.status_since).getTime()) / 60_000;
  const idx = CHAIN.indexOf(v.status);
  let minutes = 0;
  for (let i = idx; i < CHAIN.length; i++) {
    const s = CHAIN[i];
    let dur = medians[s] ?? DEFAULT_MEDIAN_MIN[s];
    if (s === 'S4' && travelToSceneMin != null) dur = travelToSceneMin;
    minutes += i === idx ? Math.max(1, dur - elapsed) : dur;
  }
  const at = (m: number) => new Date(now.getTime() + m * 60_000).toISOString();
  return {
    freeAt: at(minutes),
    lowAt: at(minutes * 0.7),
    highAt: at(minutes * 1.4),
    basis: 'Trung vị 90 ngày theo trạng thái (mặc định khi chưa đủ dữ liệu)',
  };
}
