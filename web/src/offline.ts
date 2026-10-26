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
  /** Bản trên máy chủ khi bị từ chối (409): chờ người dùng chọn giữ bản nào */
  server?: { version: number; status: string; epcr: any; transfer_number?: string | null } | null;
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
      const srv = e.body?.server;
      // Phiếu đã ký trên máy chủ thì bản trên máy không gửi được nữa: thôi gửi lại, lấy bản đã ký
      const next: Draft = srv?.status === 'signed'
        ? { ...d, epcr: srv.epcr ?? d.epcr, baseVersion: srv.version, number: srv.transfer_number ?? d.number, status: 'signed', dirty: false, conflict: null, server: null }
        : { ...d, conflict: e.message, server: srv ? { version: srv.version, status: srv.status, epcr: srv.epcr, transfer_number: srv.transfer_number } : null };
      await set(PREFIX + id, next);
      return next;
    }
    return d; // mất mạng: giữ nguyên, thử lại sau
  }
}

/** Xử lý xung đột: lấy bản trên máy chủ, hoặc giữ bản trên máy và ghi đè lên bản mới nhất của máy chủ */
export async function resolveConflict(id: string, keep: 'server' | 'local'): Promise<Draft | undefined> {
  const d = await loadDraft(id);
  if (!d?.server) return d;
  const next: Draft = keep === 'server'
    ? { ...d, epcr: d.server.epcr, baseVersion: d.server.version, number: d.server.transfer_number ?? d.number, dirty: false, conflict: null, server: null }
    : { ...d, baseVersion: d.server.version, dirty: true, conflict: null, server: null };
  await set(PREFIX + id, next);
  return keep === 'local' ? syncDraft(id) : next;
}

/** Đồng bộ nền bỏ qua phiếu đang xung đột: chờ người dùng chọn, không gửi lại mãi một bản máy chủ đã từ chối */
export async function syncAll(): Promise<void> {
  for (const d of await allDrafts()) if (d.dirty && !d.conflict) await syncDraft(d.id);
}

let started = false;
export function startBackgroundSync(): void {
  if (started) return;
  started = true;
  window.addEventListener('online', () => { syncAll(); });
  setInterval(() => { if (navigator.onLine) syncAll(); }, 10_000);
}
