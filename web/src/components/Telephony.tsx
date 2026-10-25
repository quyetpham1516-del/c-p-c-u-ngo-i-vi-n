import { useEffect, useState } from 'react';
import { api, API_BASE, fmtTime, ROLE_LABEL, session, type Role } from '../api';

/** Nghe lại ghi âm: trưởng ca, QLCL, quản trị, Ban Giám đốc (khớp quyền phía máy chủ) */
const LISTEN: string[] = ['supervisor', 'qa', 'admin', 'director'];
const DIRECTION: Record<string, string> = { in: 'Gọi vào', out: 'Gọi ra' };
const STATE: Record<string, string> = { ringing: 'Đang chờ', answered: 'Đang nói', ended: 'Đã kết thúc', abandoned: 'Bỏ dở' };

/** Máy lẻ của người đang đăng nhập và có gọi ra được không */
export function useTelephony() {
  const [me, setMe] = useState<{ ext: string | null; canDial: boolean }>({ ext: null, canDial: false });
  useEffect(() => { api('GET', '/api/telephony/me').then(setMe).catch(() => {}); }, []);
  return me;
}

/** Nút gọi lại: máy lẻ của mình đổ chuông trước, nhấc máy thì tổng đài quay số */
export function DialButton({ phone, incidentId, callbackOf, onDone, className }: {
  phone: string | null | undefined; incidentId?: string; callbackOf?: string; onDone?: () => void; className?: string;
}) {
  const [state, setState] = useState<'' | 'busy' | 'ok'>('');
  const [error, setError] = useState('');
  if (!phone) return null;
  const dial = async () => {
    setState('busy'); setError('');
    try {
      const r = await api('POST', '/api/telephony/call', { phone, incidentId, callbackOf });
      setState('ok');
      setTimeout(() => setState(''), 8000);
      onDone?.();
      return r;
    } catch (e) {
      setState(''); setError((e as Error).message);
    }
  };
  return (
    <span className="row" style={{ gap: 4 }}>
      <button type="button" className={className ?? 'ok'} disabled={state === 'busy'} onClick={dial} title={`Gọi ${phone} qua máy lẻ của bạn`}>
        {state === 'ok' ? 'Nhấc máy lẻ để nói' : state === 'busy' ? 'Đang gọi…' : 'Gọi lại'}
      </button>
      {error && <span className="error small">{error}</span>}
    </span>
  );
}

/** Danh sách cuộc gọi của một ca; ai có quyền thì nghe lại ghi âm ngay tại đây */
export function IncidentCalls({ incidentId, version }: { incidentId: string; version?: number }) {
  const [calls, setCalls] = useState<any[] | null>(null);
  const [audio, setAudio] = useState<Record<string, { url?: string; intact?: boolean; error?: string }>>({});
  const canListen = LISTEN.includes(session.user?.role ?? '');
  useEffect(() => { api<any[]>('GET', `/api/incidents/${incidentId}/calls`).then(setCalls).catch(() => setCalls([])); }, [incidentId, version]);
  useEffect(() => () => Object.values(audio).forEach((a) => a.url && URL.revokeObjectURL(a.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Thẻ <audio> không gửi được mã đăng nhập: tải về bằng fetch rồi phát từ bộ nhớ
  const play = async (id: string) => {
    setAudio((a) => ({ ...a, [id]: {} }));
    try {
      const res = await fetch(`${API_BASE}/api/calls/${id}/recording`, { headers: { authorization: `Bearer ${session.token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Lỗi ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      setAudio((a) => ({ ...a, [id]: { url, intact: res.headers.get('x-recording-intact') !== '0' } }));
    } catch (e) {
      setAudio((a) => ({ ...a, [id]: { error: (e as Error).message } }));
    }
  };

  if (!calls?.length) return null;
  return (
    <div className="panel">
      <h3>Cuộc gọi của ca <span className="badge">{calls.length}</span></h3>
      <table className="small">
        <thead><tr><th>Giờ</th><th>Chiều</th><th>Số</th><th>Máy lẻ</th><th>Người nghe</th><th>Thời lượng</th><th>Ghi âm</th></tr></thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id}>
              <td className="mono">{fmtTime(c.ringing_at)}</td>
              <td>{DIRECTION[c.direction] ?? c.direction}{c.state !== 'ended' ? ` · ${STATE[c.state] ?? c.state}` : ''}</td>
              <td className="mono">{c.phone}</td>
              <td className="mono">{c.extension ?? '—'}</td>
              <td>{c.operator_name ?? '—'}</td>
              <td className="mono">{c.duration_s != null ? `${Math.floor(c.duration_s / 60)}:${String(c.duration_s % 60).padStart(2, '0')}` : '—'}</td>
              <td>
                {!c.has_recording ? <span className="muted">Không có</span>
                  : !canListen ? <span className="muted">Có (trưởng ca, QLCL nghe lại)</span>
                    : audio[c.id]?.url ? (
                      <span className="col" style={{ gap: 2 }}>
                        <audio controls src={audio[c.id].url} style={{ height: 32 }} />
                        {!audio[c.id].intact && <span className="badge red">Tệp đã bị thay đổi sau khi ghi</span>}
                      </span>
                    ) : audio[c.id]?.error ? <span className="error">{audio[c.id].error}</span>
                      : <button type="button" className="small" disabled={!!audio[c.id]} onClick={() => play(c.id)}>{audio[c.id] ? 'Đang tải…' : 'Nghe lại'}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canListen && <div className="small muted">Mỗi lượt nghe được ghi vào nhật ký ca.</div>}
    </div>
  );
}

/** Quản trị tổng đài: gán máy lẻ cho người trực, xem tình trạng kết nối */
export function TelephonyAdmin() {
  const [d, setD] = useState<any>(null);
  const [form, setForm] = useState({ ext: '', userId: '', label: '' });
  const [error, setError] = useState('');
  const load = () => api('GET', '/api/telephony/extensions').then(setD).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };
  if (!d) return error ? <div className="panel error">{error}</div> : null;
  const s = d.status;
  return (
    <div className="panel col">
      <h3 style={{ margin: 0 }}>Tổng đài và máy lẻ</h3>
      <div className="row small" style={{ flexWrap: 'wrap' }}>
        {!s.configured ? <span className="badge amber">Chưa nối tổng đài để gọi ra (thiếu MEDONE_ARI_URL)</span>
          : s.reachable ? <span className="badge green">Tổng đài trực tuyến{s.version ? ` · Asterisk ${String(s.version).split('~')[0]}` : ''}</span>
            : <span className="badge red">Không kết nối được tổng đài</span>}
        <span className={`badge ${s.recordingsDir ? 'green' : 'amber'}`}>{s.recordingsDir ? 'Đã cấu hình thư mục ghi âm' : 'Chưa cấu hình thư mục ghi âm (MEDONE_RECORDINGS_DIR)'}</span>
      </div>
      {error && <div className="error">{error}</div>}
      <table className="small">
        <thead><tr><th>Máy lẻ</th><th>Nhãn</th><th>Người dùng máy</th><th></th></tr></thead>
        <tbody>
          {d.extensions.map((e: any) => (
            <tr key={e.ext}>
              <td className="mono">{e.ext}</td>
              <td>{e.label ?? ''}</td>
              <td>
                <select value={e.user_id ?? ''} onChange={(ev) => run(() => api('PUT', `/api/telephony/extensions/${e.ext}`, { userId: ev.target.value || null, label: e.label }))}>
                  <option value="">— Chưa gán —</option>
                  {d.users.map((u: any) => <option key={u.id} value={u.id}>{u.full_name} ({ROLE_LABEL[u.role as Role] ?? u.role})</option>)}
                </select>
              </td>
              <td><button className="ghost small" onClick={() => confirm(`Xóa máy lẻ ${e.ext}?`) && run(() => api('DELETE', `/api/telephony/extensions/${e.ext}`))}>Xóa</button></td>
            </tr>
          ))}
          <tr>
            <td><input className="mono" style={{ width: 80 }} placeholder="101" value={form.ext} onChange={(e) => setForm({ ...form, ext: e.target.value.trim() })} /></td>
            <td><input placeholder="Bàn 1" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></td>
            <td>
              <select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                <option value="">— Chưa gán —</option>
                {d.users.map((u: any) => <option key={u.id} value={u.id}>{u.full_name} ({ROLE_LABEL[u.role as Role] ?? u.role})</option>)}
              </select>
            </td>
            <td><button disabled={!/^[0-9]{2,6}$/.test(form.ext)} onClick={() => run(async () => {
              await api('PUT', `/api/telephony/extensions/${form.ext}`, { userId: form.userId || null, label: form.label || null });
              setForm({ ext: '', userId: '', label: '' });
            })}>Thêm máy lẻ</button></td>
          </tr>
        </tbody>
      </table>
      <div className="small muted">
        Người được gán máy lẻ nhấc máy cuộc gọi trong hàng chờ thì màn hình EOC của họ tự mở ca. Mỗi người chỉ dùng một máy lẻ;
        mật khẩu điện thoại nằm trong tệp may-le.txt do lệnh <span className="mono">npm run asterisk:config</span> tạo, không hiện ở đây.
      </div>
    </div>
  );
}
