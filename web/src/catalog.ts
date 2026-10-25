import { get, set } from 'idb-keyval';
import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Danh mục dùng chung (bệnh viện, khoa, kho thuốc của xe) lấy từ máy chủ và lưu lại trên máy,
 * để ứng dụng kíp vẫn chọn được khi mất mạng.
 */
export interface Department { id: number; name: string }
export interface Hospital { id: number; name: string; kcb_code: string | null; phone?: string | null; kind: string | null; address: string | null; capabilities: string[]; departments: Department[] }
export interface StockLot { id: string; lot: string; expiry: string; qty: number; drug_id: number; drug_name: string; unit: string; default_route: string | null; controlled?: boolean; place?: 'xe' | 'kho' }
export interface Station { id: string; name: string; kind: string; address: string | null; phone: string | null; lat: number; lng: number; active: boolean; vehicle_count: number; staff_count: number; stock_qty: number }

function useCached<T>(key: string, url: string | null, initial: T): [T, () => void] {
  const [data, setData] = useState<T>(initial);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    get(key).then((v) => { if (alive && v !== undefined) setData(v as T); }).catch(() => {});
    api<T>('GET', url).then((v) => {
      if (!alive) return;
      setData(v);
      set(key, v).catch(() => {});
    }).catch(() => { /* mất mạng: dùng bản đã lưu */ });
    return () => { alive = false; };
  }, [key, url, tick]);
  return [data, () => setTick((t) => t + 1)];
}

export const useHospitals = () => useCached<Hospital[]>('cat:hospitals', '/api/hospitals', [])[0];
export const useStations = (all = false) => useCached<Station[]>(`cat:stations:${all ? 'all' : 'active'}`, `/api/stations${all ? '?all=1' : ''}`, []);
export const useVehicleStock = (vehicleId: string | null | undefined) =>
  useCached<StockLot[]>(`cat:stock:${vehicleId ?? '-'}`, vehicleId ? `/api/stock/vehicle/${encodeURIComponent(vehicleId)}` : null, [])[0];

export const STATION_KIND: Record<string, string> = {
  tru_so: 'Trụ sở', tram: 'Trạm xe', kho_trung_tam: 'Kho trung tâm', diem_su_kien: 'Điểm trực sự kiện',
};

/** Tra tên bệnh theo mã ICD-10; lưu lại các mã đã tra để dùng khi mất mạng */
export async function lookupIcd(code: string): Promise<{ code: string; name: string } | null> {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]\d{2}/.test(c)) return null;
  const key = `icd:${c}`;
  try {
    const r = await api<{ code: string; name: string }>('GET', `/api/icd10/${encodeURIComponent(c)}`);
    set(key, r).catch(() => {});
    return r;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    return ((await get(key).catch(() => undefined)) as { code: string; name: string } | undefined) ?? null;
  }
}

export async function searchIcd(q: string): Promise<{ code: string; name: string }[]> {
  if (q.trim().length < 2) return [];
  try { return await api('GET', `/api/icd10?q=${encodeURIComponent(q.trim())}`); } catch { return []; }
}
