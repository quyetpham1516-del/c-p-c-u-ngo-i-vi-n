'use client';
import { useEffect, useRef, useState } from 'react';
import { api, session, useLive } from '../api';
import { startAlarm, unlockAudio } from '../alarm';

const HOLD_MS = 2000;
const SOS_VIEW = ['calltaker', 'dispatcher', 'supervisor', 'admin', 'qa', 'director'];
const SOS_ACK = ['calltaker', 'dispatcher', 'supervisor', 'admin'];
const SOS_RESOLVE = ['dispatcher', 'supervisor', 'admin'];
const at = (s?: string | null) => (s ? new Date(s).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '');
const mapUrl = (s: any) => `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`;

function position(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
    () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 },
  ));
}

/** Nút báo khẩn của kíp: giữ 2 giây để gửi (tránh chạm nhầm); đang báo khẩn thì gửi lại vị trí mỗi 15 giây */
export function CrewSos() {
  const [sos, setSos] = useState<any>(null);
  const [holding, setHolding] = useState(0);
  const [error, setError] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const load = () => api<any>('GET', '/api/crew/sos').then(setSos).catch(() => {});
  useLive((e) => { if (e.type === 'sos' && (!sos || e.id === sos.id)) load(); });
  useEffect(() => { load(); }, []);
  const send = async () => {
    setError('');
    const p = await position();
    try { setSos(await api('POST', '/api/crew/sos', { ...(p ?? {}) })); }
    catch (e) { setError(`${(e as Error).message}. Gọi bộ đàm hoặc điện thoại cho EOC ngay.`); }
  };
  useEffect(() => {
    if (!sos?.id) return;
    const t = window.setInterval(send, 15000);
    return () => clearInterval(t);
  }, [sos?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = () => {
    unlockAudio();
    const t0 = Date.now();
    timer.current = window.setInterval(() => {
      const ms = Date.now() - t0;
      setHolding(Math.min(1, ms / HOLD_MS));
      if (ms >= HOLD_MS) { stop(); try { navigator.vibrate?.(300); } catch { /* bỏ qua */ } send(); }
    }, 50);
  };
  const stop = () => { clearInterval(timer.current); setHolding(0); };
  if (sos) {
    return (
      <div className="panel red col sos-active">
        <b>ĐANG BÁO KHẨN {sos.code} · gửi lúc {at(sos.created_at)}</b>
        {sos.acked_at ? <div>EOC đã nhận lúc {at(sos.acked_at)}{sos.acked_by_name ? ` (${sos.acked_by_name})` : ''}: {sos.ack_note}</div> : <div>Đang chờ EOC xác nhận… Vị trí tự gửi lại mỗi 15 giây.</div>}
        {sos.lat == null && <div className="small">Chưa lấy được vị trí: báo địa điểm qua bộ đàm.</div>}
        {error && <div className="small">{error}</div>}
        <button className="ghost small" onClick={() => {
          const reason = prompt('Lý do hủy báo khẩn (ví dụ: bấm nhầm, đã an toàn):');
          if (reason && reason.trim().length >= 2) api('POST', `/api/crew/sos/${sos.id}/cancel`, { reason }).then(() => setSos(null)).catch((e) => setError(e.message));
        }}>Hủy (bấm nhầm, đã an toàn)</button>
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 4 }}>
      <button className="danger sos-btn" style={{ ['--hold' as any]: `${holding * 100}%` }}
        onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop} onContextMenu={(e) => e.preventDefault()}>
        {holding ? 'Giữ tiếp…' : 'GIỮ 2 GIÂY ĐỂ BÁO KHẨN'}
      </button>
      {error && <div className="alert red small">{error}</div>}
    </div>
  );
}

/** Báo động báo khẩn trên mọi màn của EOC: kêu cho tới khi có người xác nhận */
export function SosBanner() {
  const role = session.user?.role ?? '';
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState<{ id: string; mode: 'ack' | 'resolve'; note: string; falseAlarm: boolean } | null>(null);
  const [error, setError] = useState('');
  const enabled = SOS_VIEW.includes(role);
  const load = () => { if (enabled) api<any[]>('GET', '/api/sos').then(setRows).catch(() => {}); };
  useLive((e) => { if (e.type === 'sos' || e.type === 'reconnected') load(); });
  useEffect(() => { load(); const t = window.setInterval(load, 30000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const unacked = rows.filter((r) => !r.acked_at);
  useEffect(() => {
    if (!unacked.length) return;
    return startAlarm(`BÁO KHẨN ${unacked[0].code}`, `${unacked[0].user_name} · xe ${unacked[0].vehicle_id ?? '?'}`);
  }, [unacked.map((r) => r.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!enabled || !rows.length) return null;
  const submit = async () => {
    if (!form) return;
    setError('');
    try {
      await api('POST', `/api/sos/${form.id}/${form.mode}`, form.mode === 'ack' ? { note: form.note } : { resolution: form.note, falseAlarm: form.falseAlarm });
      setForm(null); load();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="sos-banner no-print">
      {rows.map((s) => (
        <div key={s.id} className={`sos-row ${s.acked_at ? 'acked' : ''}`}>
          <b>BÁO KHẨN {s.code}</b>
          <span>{s.user_name}{s.user_phone ? ` · ${s.user_phone}` : ''} · xe {s.vehicle_id ?? '?'}{s.incident_code ? ` · ca ${s.incident_code}` : ''} · {at(s.created_at)}</span>
          {s.note && <span>“{s.note}”</span>}
          {s.lat != null ? <a href={mapUrl(s)} target="_blank" rel="noreferrer">Bản đồ (±{Math.round(s.accuracy_m ?? 0)} m, {at(s.located_at)})</a> : <span>chưa có vị trí</span>}
          {s.acked_at && <span>Đã nhận: {s.acked_by_name} {at(s.acked_at)}: {s.ack_note}</span>}
          {SOS_ACK.includes(role) && <button className="small" onClick={() => setForm({ id: s.id, mode: 'ack', note: '', falseAlarm: false })}>{s.acked_at ? 'Ghi thêm' : 'Xác nhận đã nhận'}</button>}
          {SOS_RESOLVE.includes(role) && s.acked_at && <button className="small ghost" onClick={() => setForm({ id: s.id, mode: 'resolve', note: '', falseAlarm: false })}>Kết thúc</button>}
        </div>
      ))}
      {form && (
        <div className="row sos-form">
          <input className="grow" autoFocus value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
            placeholder={form.mode === 'ack' ? 'Đã làm gì: gọi công an 113, điều xe hỗ trợ, gọi lại kíp...' : 'Kết quả: kíp đã an toàn...'} />
          {form.mode === 'resolve' && <label className="row small"><input type="checkbox" checked={form.falseAlarm} onChange={(e) => setForm({ ...form, falseAlarm: e.target.checked })} /> Báo nhầm</label>}
          <button className="primary small" disabled={form.note.trim().length < (form.mode === 'ack' ? 2 : 3)} onClick={submit}>Lưu</button>
          <button className="ghost small" onClick={() => setForm(null)}>Bỏ</button>
        </div>
      )}
      {error && <div className="small">{error}</div>}
    </div>
  );
}
