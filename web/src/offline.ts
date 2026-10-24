import { del, get, keys, set } from 'idb-keyval';
import { api, ApiError } from './api';

/**
 * Lưu ePCR trên máy trước, đồng bộ sau (mục 12.4: chạy không mạng tối thiểu 12 giờ).
 * Mỗi phiếu có UUID do máy sinh, nên gửi lại nhiều lần không tạo bản trùng trên máy chủ.
 */
export interface Draft {
  id: string;
  incidentId: string | null;
  vehicleId: string | null;
  patientId: string | null;
  patientLabel?: string | null;
  epcr: any;
  baseVersion: number;
  dirty: boolean;
  status: 'draft' | 'signed';
  number?: string | null;
  conflict?: string | null;
  updatedAt: string;
  syncedAt?: string | null;
}

const PREFIX = 'epcr:';
const deviceId = (() => {
  try {
    let d = localStorage.getItem('medone.device');
    if (!d) { d = `web-${crypto.randomUUID().slice(0, 8)}`; localStorage.setItem('medone.device', d); }
    return d;
  } catch { return 'web-unknown'; }
})();

export async function saveDraft(d: Draft): Promise<void> {
  await set(PREFIX + d.id, { ...d, updatedAt: new Date().toISOString() });
}

export async function loadDraft(id: string): Promise<Draft | undefined> {
  return get(PREFIX + id);
}

export async function allDrafts(): Promise<Draft[]> {
  const ks = (await keys()).filter((k) => String(k).startsWith(PREFIX));
  const out: Draft[] = [];
  for (const k of ks) { const d = await get(k); if (d) out.push(d); }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function removeDraft(id: string): Promise<void> {
  await del(PREFIX + id);
}

export async function syncDraft(id: string): Promise<Draft | undefined> {
  const d = await loadDraft(id);
  if (!d || !d.dirty || d.status === 'signed') return d;
  try {
    const row = await api('PUT', `/api/transfers/${d.id}`, {
      incidentId: d.incidentId, patientId: d.patientId, vehicleId: d.vehicleId, baseVersion: d.baseVersion, deviceId, epcr: d.epcr,
    });
    const latest = (await loadDraft(id)) ?? d;
    // Nếu người dùng sửa tiếp trong lúc đang gửi thì vẫn để dirty
    const changedMeanwhile = latest.updatedAt !== d.updatedAt;
    const next: Draft = { ...latest, baseVersion: row.version, number: row.transfer_number, dirty: changedMeanwhile, conflict: null, syncedAt: new Date().toISOString() };
    await set(PREFIX + id, next);
    return next;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const next: Draft = { ...d, conflict: e.message, status: e.body?.server?.status === 'signed' ? 'signed' : d.status };
      await set(PREFIX + id, next);
      return next;
    }
    return d; // mất mạng: giữ nguyên, thử lại sau
  }
}

export async function syncAll(): Promise<void> {
  for (const d of await allDrafts()) if (d.dirty) await syncDraft(d.id);
}

let started = false;
export function startBackgroundSync(): void {
  if (started) return;
  started = true;
  window.addEventListener('online', () => { syncAll(); });
  setInterval(() => { if (navigator.onLine) syncAll(); }, 10_000);
}
