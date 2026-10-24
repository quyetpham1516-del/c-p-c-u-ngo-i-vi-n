import { useEffect, useRef, useState } from 'react';

export type Role = 'calltaker' | 'dispatcher' | 'supervisor' | 'crew' | 'qa' | 'admin'
  | 'pharmacist' | 'technician' | 'ipc' | 'hr' | 'accountant' | 'director';
export interface User { id: string; username: string; name: string; role: Role }

/** Địa chỉ backend Fastify, đặt qua NEXT_PUBLIC_API_URL trong .env (để trống = cùng địa chỉ với frontend) */
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');

function wsUrl(): string {
  const base = API_BASE ? new URL(API_BASE) : new URL(location.href);
  const proto = base.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${base.host}/ws`;
}

const TOKEN_KEY = 'medone.token';
const USER_KEY = 'medone.user';

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string | null) {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* bộ nhớ trình duyệt bị chặn */ }
}

export const session = {
  get token() { return safeGet(TOKEN_KEY); },
  get user(): User | null { const u = safeGet(USER_KEY); return u ? JSON.parse(u) : null; },
  set(token: string, user: User) { safeSet(TOKEN_KEY, token); safeSet(USER_KEY, JSON.stringify(user)); },
  clear() { safeSet(TOKEN_KEY, null); safeSet(USER_KEY, null); },
};

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, message: string, body: any) { super(message); this.status = status; this.body = body; }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (res.status === 401 && !url.endsWith('/login')) {
    session.clear();
    location.href = '/dang-nhap';
  }
  if (!res.ok) {
    const details = Array.isArray(json?.details) && typeof json.details[0] === 'string' ? `: ${json.details.join('; ')}` : '';
    throw new ApiError(res.status, (json?.error ?? `Lỗi ${res.status}`) + details, json);
  }
  return json as T;
}

export type LiveEvent = { type: string; id?: string; [k: string]: any };

/** Kết nối thời gian thực, tự nối lại khi rớt mạng */
export function useLive(onEvent: (e: LiveEvent) => void): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let retry = 500;
    let timer: number | undefined;
    const connect = () => {
      ws = new WebSocket(`${wsUrl()}?token=${encodeURIComponent(session.token ?? '')}`);
      ws.onopen = () => { setConnected(true); retry = 500; handler.current({ type: 'reconnected' }); };
      ws.onmessage = (m) => { try { handler.current(JSON.parse(m.data)); } catch { /* bỏ qua */ } };
      ws.onclose = () => {
        setConnected(false);
        if (!stop) timer = window.setTimeout(connect, (retry = Math.min(retry * 2, 10_000)));
      };
    };
    connect();
    return () => { stop = true; clearTimeout(timer); ws?.close(); };
  }, []);
  return connected;
}

/** Đồng hồ cập nhật mỗi giây để hiển thị thời gian chờ */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

export function fmtTime(iso?: string | null, seconds = true): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false });
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('vi-VN', { hour12: false });
}

export const PRIORITY_LABEL: Record<string, string> = {
  P1: 'P1 – Đe dọa tính mạng', P2: 'P2 – Nguy kịch', P3: 'P3 – Khẩn cấp', P4: 'P4 – Tư vấn', HEN: 'Vận chuyển theo hẹn',
};
export const VEHICLE_LABEL: Record<string, string> = {
  ALS: 'ALS – Cấp cứu nâng cao', BLS: 'BLS – Cấp cứu cơ bản', MSU: 'Xe đột quỵ có CT', ECMO: 'Xe ECMO',
  VC: 'Xe vận chuyển', DP: 'Xe dự phòng', NONE: 'Không cần xe',
};
export const STATUS_LABEL: Record<string, string> = {
  S1: 'Sẵn sàng tại trạm', S2: 'Sẵn sàng ngoài trạm', S3: 'Đã nhận lệnh', S4: 'Đang đến hiện trường', S5: 'Tại hiện trường',
  S6: 'Đang vận chuyển', S7: 'Tại BV, chờ bàn giao', S8: 'Bổ sung, khử khuẩn', S9: 'Ngoài hoạt động',
};
export const INCIDENT_STATUS: Record<string, string> = {
  intake: 'Đang hỏi', awaiting_confirm: 'Chờ xác nhận', confirmed: 'Đã xác nhận, chờ xe', dispatched: 'Đã giao xe',
  on_scene: 'Tại hiện trường', transporting: 'Đang vận chuyển', at_hospital: 'Tại bệnh viện', closed: 'Đã đóng',
  cancelled: 'Đã hủy', transferred_115: 'Đã chuyển 115', advice_only: 'Tư vấn qua điện thoại',
};
export const TIME_LABEL: Record<string, string> = {
  T0: 'Chuông reo', T1: 'Nhấc máy', T2: 'Có địa điểm', T3: 'Chốt mã', T4: 'Giao xe', T5: 'Kíp xác nhận',
  T6: 'Lăn bánh', T7: 'Tới hiện trường', T8: 'Tới người bệnh', T9: 'Can thiệp đầu', T10: 'Rời hiện trường',
  T11: 'Báo trước BV', T12: 'Tới BV', T13: 'Bàn giao xong', T14: 'Sẵn sàng lại', T15: 'Ký ePCR',
};
export const ROLE_LABEL: Record<Role, string> = {
  calltaker: 'Tiếp nhận cuộc gọi', dispatcher: 'Điều phối viên', supervisor: 'Trưởng ca', crew: 'Kíp cấp cứu', qa: 'QLCL', admin: 'Quản trị',
  pharmacist: 'Kho – dược', technician: 'Kỹ thuật thiết bị', ipc: 'Kiểm soát nhiễm khuẩn', hr: 'Hành chính – nhân sự',
  accountant: 'Kế toán – thu ngân', director: 'Ban Giám đốc',
};

export function homeFor(role: Role | undefined): string {
  if (role === 'crew') return '/kip';
  if (role === 'qa') return '/chat-luong';
  if (role === 'pharmacist') return '/kho';
  if (role === 'technician') return '/thiet-bi';
  if (role === 'ipc') return '/chat-luong';
  if (role === 'hr') return '/nhan-su';
  if (role === 'accountant') return '/tai-chinh';
  if (role === 'director') return '/bao-cao';
  return '/eoc';
}

export const INFECTION_RISK: Record<string, string> = { tiep_xuc: 'Lây qua tiếp xúc', giot_ban: 'Lây qua giọt bắn', khong_khi: 'Lây qua không khí (lao, sởi...)' };
