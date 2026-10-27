'use client';
import { useEffect, useState } from 'react';
import { api, fmtDateTime, session } from '../api';

const STATUS: Record<string, [string, string]> = { mo: ['Đang mở', 'amber'], qua_han: ['Quá hạn', 'red'], da_nop: ['Đã nộp', 'green'] };

/** Phiên kiểm kê theo lịch của một kho: đếm toàn bộ lô rồi nộp; lệch thì phiếu kiểm kê chờ người thứ hai duyệt */
export function Stocktakes({ stationId }: { stationId: string }) {
  const role = session.user?.role ?? '';
  const [list, setList] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<any[]>('GET', `/api/stocktakes?stationId=${stationId}`).then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); setOpen(null); }, [stationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = async (id: string) => { setOpen(await api('GET', `/api/stocktakes/${id}`)); setCounts({}); setNote(''); };
  const filled = open && open.lots.every((l: any) => counts[l.id] !== undefined && counts[l.id] !== '');
  const submit = async () => {
    setError(''); setMsg('');
    try {
      const r = await api('POST', `/api/stocktakes/${open.id}/submit`, { note: note || null, lines: open.lots.map((l: any) => ({ lotId: l.id, counted: Number(counts[l.id]) })) });
      setMsg(r.diffs ? `Đã nộp ${r.voucher.code}: lệch ${r.diffs} lô, chờ người thứ hai duyệt ở Phiếu kho` : `Đã nộp ${r.voucher.code}: khớp sổ sách`);
      setOpen(null); await load();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="col" id="kiem-ke">
      {role === 'admin' && <Schedules />}
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Ngày kiểm kê</th><th>Kho</th><th>Trạng thái</th><th>Người nộp</th><th>Phiếu kiểm kê</th></tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} className="click" onClick={() => show(s.id).catch((e) => setError(e.message))}>
                <td>{s.due_date}{s.blind && <span className="badge" style={{ marginLeft: 6 }}>Kiểm mù</span>}</td>
                <td>{s.station_name} <span className="small muted">{s.scope === 'kho_tong' ? 'kho tổng' : 'kho điểm'}</span></td>
                <td><span className={`badge ${STATUS[s.status]?.[1]}`}>{STATUS[s.status]?.[0]}</span></td>
                <td className="small">{s.submitted_by_name ? `${s.submitted_by_name} · ${fmtDateTime(s.submitted_at)}` : '—'}</td>
                <td className="small">{s.voucher_code ? `${s.voucher_code} (${s.voucher_status === 'cho_duyet' ? 'lệch, chờ duyệt' : s.voucher_status === 'da_duyet' ? 'đã duyệt' : 'từ chối'})` : '—'}</td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={5} className="muted">Chưa có phiên kiểm kê nào cho kho này.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Kiểm kê {open.station_name} ngày {open.due_date} {open.blind && <span className="small muted">(kiểm mù: không hiện số sổ sách)</span>}</h3>
          <div style={{ overflowX: 'auto', maxHeight: 520 }}>
            <table className="small">
              <thead><tr><th>Mặt hàng</th><th>Lô</th><th>Hạn dùng</th>{!open.blind && <th className="right">Sổ sách</th>}<th className="right">Đếm thực tế</th></tr></thead>
              <tbody>{open.lots.map((l: any) => (
                <tr key={l.id}>
                  <td>{l.drug_name} <span className="muted">{l.unit}</span></td><td className="mono">{l.lot}</td><td>{String(l.expiry).slice(0, 10)}</td>
                  {!open.blind && <td className="right">{l.qty}</td>}
                  <td className="right">{open.status === 'da_nop' ? l.counted
                    : <input type="number" min={0} style={{ width: 80 }} value={counts[l.id] ?? ''} onChange={(e) => setCounts({ ...counts, [l.id]: e.target.value })} />}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {open.status !== 'da_nop' && (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <input placeholder="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 240 }} />
              <button className="primary" disabled={!filled} onClick={submit}>Nộp kết quả kiểm kê</button>
              {!filled && <span className="small muted">Đếm đủ {open.lots.length} lô mới nộp được.</span>}
              <button className="ghost" onClick={() => setOpen(null)}>Đóng</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Quản trị sửa lịch kiểm kê (đã khóa cấu hình thì thành đề xuất) */
function Schedules() {
  const [d, setD] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const load = () => api('GET', '/api/stocktake-schedules').then(setD).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!d) return null;
  const save = async (s: any) => {
    try {
      const r = await api('PUT', `/api/stocktake-schedules/${s.scope}`, { frequency: s.frequency, at: s.at, blind: s.blind, active: s.active });
      setMsg(r?.proposal ? `Đã gửi đề xuất ${r.code}` : 'Đã lưu lịch kiểm kê'); await load();
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <details className="panel">
      <summary><b>Lịch kiểm kê</b> <span className="small muted">{d.schedules.map((s: any) => `${s.scope === 'kho_tong' ? 'Kho tổng' : 'Kho điểm'}: ${d.frequencies[s.frequency]} ${s.at}`).join(' · ')}</span></summary>
      {d.schedules.map((s: any) => <ScheduleRow key={s.scope} s={s} frequencies={d.frequencies} onSave={save} />)}
      {msg && <div className="small">{msg}</div>}
    </details>
  );
}

function ScheduleRow({ s, frequencies, onSave }: { s: any; frequencies: Record<string, string>; onSave: (s: any) => void }) {
  const [f, setF] = useState({ scope: s.scope, frequency: s.frequency, at: s.at, blind: s.blind, active: s.active });
  return (
    <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
      <b style={{ width: 80 }}>{s.scope === 'kho_tong' ? 'Kho tổng' : 'Kho điểm'}</b>
      <select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>
        {Object.entries(frequencies).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <input type="time" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} />
      <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={f.blind} onChange={(e) => setF({ ...f, blind: e.target.checked })} />Kiểm mù</label>
      <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Đang dùng</label>
      <button className="ghost" onClick={() => onSave(f)}>Lưu</button>
    </div>
  );
}
