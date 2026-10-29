import { get, set } from 'idb-keyval';
import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Danh mục dùng chung (bệnh viện, khoa, kho thuốc của xe) lấy từ máy chủ và lưu lại trên máy,
 * để ứng dụng kíp vẫn chọn được khi mất mạng.
 */
export interface Department { id: number; name: string }
export interface Hospital { id: number; name: string; kcb_code: string | null; tax_code?: string | null; phone?: string | null; kind: string | null; address: string | null; capabilities: string[]; departments: Department[] }
export interface StockLot { id: string; lot: string; expiry: string; qty: number; drug_id: number; drug_name: string; unit: string; default_route: string | null; controlled?: boolean; place?: 'xe' | 'kho'; kind?: string; track_lot?: boolean }
export interface Station { id: string; name: string; kind: string; address: string | null; phone: string | null; lat: number; lng: number; active: boolean; vehicle_count: number; staff_count: number; stock_qty: number; manager_id?: string | null; deputy_id?: string | null; manager_name?: string | null; deputy_name?: string | null }

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
/** Mọi mặt hàng dùng được cho phiếu (thuốc, dịch truyền, vật tư, dụng cụ): trên xe trước, kho điểm sau */
export const useVehicleItems = (vehicleId: string | null | undefined) =>
  useCached<StockLot[]>(`cat:items:${vehicleId ?? '-'}`, vehicleId ? `/api/stock/vehicle/${encodeURIComponent(vehicleId)}?all=1` : null, [])[0];

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

/** Phạm vi thực hiện theo chức danh: danh sách giới hạn, kíp trên xe, bác sĩ để chọn khi ghi y lệnh trao đổi */
export interface ScopeRule { id: number; kind: 'thuoc' | 'can_thiep'; ref: string; label: string; allowed: string[] }
export interface ScopeCrew { id: string; full_name: string; title: string | null; category: string; crew_role: string | null; grants: number[] }
export interface ScopeContext { vehicleId: string | null; rules: ScopeRule[]; crew: ScopeCrew[]; doctors: { full_name: string; license_no: string | null }[]; categories: Record<string, string> }
export const useScope = (transferId: string) =>
  useCached<ScopeContext | null>('cat:scope', `/api/scope/context?transferId=${encodeURIComponent(transferId)}`, null)[0];

export interface LabType { code: string; name: string; unit: string | null; normal_low: number | null; normal_high: number | null }
export const useLabTypes = () => useCached<LabType[]>('cat:lab-types', '/api/lab-types', [])[0];

export const ruleKey = (r: Pick<ScopeRule, 'kind' | 'ref'>) => `${r.kind}:${r.ref}`;

/** Cùng cách tính với máy chủ khi ký: mục giới hạn đã dùng mà kíp không ai đủ phạm vi, chưa ghi bác sĩ trao đổi */
export function scopeCheck(e: any, ctx: ScopeContext | null) {
  if (!ctx) return { used: [] as ScopeRule[], uncovered: [] as ScopeRule[] };
  const care = e.care ?? {};
  const meds: any[] = e.medications ?? [];
  const used = ctx.rules.filter((r) => r.kind === 'can_thiep'
    ? care[r.ref] === true
    : meds.some((m) => (m.drugId != null && String(m.drugId) === r.ref) || (m.name && m.name.trim().toLowerCase() === r.label.toLowerCase())));
  const consulted = new Set((e.consults ?? []).filter((c: any) => c.doctor?.trim()).flatMap((c: any) => c.items ?? []));
  const uncovered = used.filter((r) => !ctx.crew.some((m) => r.allowed.includes(m.category) || m.grants.includes(r.id)) && !consulted.has(ruleKey(r)));
  return { used, uncovered };
}
