import { useEffect, useState } from 'react';
import { api, fmtDateTime, money, session } from '../api';
import { useStations } from '../catalog';
import { DutyTasksAdmin } from '../components/DutyTasks';

type Member = { userId: string; position: string };
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const blank = () => {
  const start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1);
  return { vehicleId: '', where: 'station', stationId: '', place: '', lat: '', lng: '', startsAt: localInput(start), endsAt: localInput(new Date(start.getTime() + 12 * 3600_000)),
    note: '', equipment: '', members: [] as Member[] };
};

/**
 * Ca trực: điều phối viên lập ca cho xe trực ở điểm có sẵn hoặc vị trí tạm (sân vận động, ngã tư), xếp người theo vị trí trong kíp,
 * ghi thiết bị mang thêm, xem bảng giá áp cho ca. Không có số liệu tài chính, không có kho tổng.
 */
export function Duty() {
  const role = session.user?.role ?? '';
  const canEdit = ['dispatcher', 'supervisor'].includes(role);
  const canPrice = ['calltaker', 'dispatcher', 'supervisor', 'admin', 'director'].includes(role);
  const [stations] = useStations();
  const [posts, setPosts] = useState<any[]>([]);
  const [opts, setOpts] = useState<{ crew: any[]; vehicles: any[]; positions: string[] }>({ crew: [], vehicles: [], positions: [] });
  const [prices, setPrices] = useState<{ priceLists: any[]; services: any[] } | null>(null);
  const [form, setForm] = useState(blank());
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => api<any[]>('GET', '/api/duty-posts').then(setPosts).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api('GET', '/api/duty/options').then(setOpts).catch(() => {});
    if (canPrice) api('GET', '/api/duty/prices').then(setPrices).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(''); setMsg('');
    try { await fn(); setMsg(ok); await load(); } catch (e) { setError((e as Error).message); }
  };
  const body = () => ({
    vehicleId: form.vehicleId,
    stationId: form.where === 'station' ? form.stationId || null : null,
    place: form.where === 'place' ? form.place.trim() || null : null,
    lat: form.where === 'place' && form.lat !== '' ? Number(form.lat) : null,
    lng: form.where === 'place' && form.lng !== '' ? Number(form.lng) : null,
    startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString(),
    note: form.note.trim() || null,
    equipment: form.equipment.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
    members: form.members.filter((m) => m.userId && m.position),
  });
  const save = () => run(async () => {
    if (editing) await api('PUT', `/api/duty-posts/${editing}`, body()); else await api('POST', '/api/duty-posts', body());
    setForm(blank()); setEditing(null);
  }, editing ? 'Đã sửa ca trực' : 'Đã lập ca trực, đã báo cho người trong ca');
  const edit = (p: any) => {
    setEditing(p.id);
    setForm({ vehicleId: p.vehicle_id, where: p.station_id ? 'station' : 'place', stationId: p.station_id ?? '', place: p.place ?? '',
      lat: p.lat ?? '', lng: p.lng ?? '', startsAt: localInput(new Date(p.starts_at)), endsAt: localInput(new Date(p.ends_at)),
      note: p.note ?? '', equipment: (p.equipment ?? []).join(', '), members: p.members.map((m: any) => ({ userId: m.userId, position: m.position })) });
  };
  const setMember = (i: number, patch: Partial<Member>) => setForm({ ...form, members: form.members.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const leader = (p: any) => p.members.find((m: any) => m.position === 'Trưởng kíp') ?? p.members[0];
  const valid = form.vehicleId && (form.where === 'station' ? form.stationId : form.place.trim()) && form.startsAt < form.endsAt;

  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Ca trực</h2>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Xe</th><th>Trực ở</th><th>Thời gian</th><th>Kíp</th><th>Thiết bị mang thêm</th>{canEdit && <th />}</tr></thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.id}>
                <td><b>{p.vehicle_id}</b> <span className="small muted">{p.vehicle_type}</span>
                  {leader(p) && <div className="small">{leader(p).title ?? ''} {leader(p).name}</div>}</td>
                <td>{p.place ?? p.station_name}{p.note && <div className="small muted">{p.note}</div>}</td>
                <td className="small">{fmtDateTime(p.starts_at)}<br />đến {fmtDateTime(p.ends_at)}</td>
                <td className="small">{p.members.map((m: any) => <div key={m.userId}>{m.position}: {m.name}</div>)}
                  {p.members.length === 0 && <span className="muted">Chưa xếp người</span>}</td>
                <td className="small">{(p.equipment ?? []).join(', ') || '—'}</td>
                {canEdit && <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  <button className="ghost" onClick={() => edit(p)}>Sửa</button>
                  <button className="ghost" onClick={() => confirm(`Hủy ca trực của xe ${p.vehicle_id}?`) && run(() => api('POST', `/api/duty-posts/${p.id}/cancel`), 'Đã hủy ca trực')}>Hủy</button>
                </td>}
              </tr>
            ))}
            {posts.length === 0 && <tr><td colSpan={6} className="muted">Chưa có ca trực nào trong 7 ngày tới.</td></tr>}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>{editing ? 'Sửa ca trực' : 'Lập ca trực'}</h3>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <select value={form.vehicleId} onChange={(e) => setForm({ ...form, vehicleId: e.target.value })}>
              <option value="">Chọn xe</option>
              {opts.vehicles.map((v) => <option key={v.id} value={v.id}>{v.id} · {v.type}{v.plate ? ` · ${v.plate}` : ''}</option>)}
            </select>
            <select value={form.where} onChange={(e) => setForm({ ...form, where: e.target.value })}>
              <option value="station">Trực ở điểm có sẵn</option><option value="place">Trực ở vị trí tạm</option>
            </select>
            {form.where === 'station'
              ? <select value={form.stationId} onChange={(e) => setForm({ ...form, stationId: e.target.value })}>
                <option value="">Chọn điểm</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              : <>
                <input placeholder="Vị trí, vd Sân vận động Thống Nhất" value={form.place} onChange={(e) => setForm({ ...form, place: e.target.value })} style={{ minWidth: 240 }} />
                <input placeholder="Vĩ độ" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} style={{ width: 100 }} />
                <input placeholder="Kinh độ" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} style={{ width: 100 }} />
              </>}
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="row small" style={{ gap: 4 }}>Từ<input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></label>
            <label className="row small" style={{ gap: 4 }}>Đến<input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></label>
          </div>
          <div className="col" style={{ gap: 4 }}>
            <b className="small">Người trong ca</b>
            {form.members.map((m, i) => (
              <div className="row" key={i}>
                <select value={m.position} onChange={(e) => setMember(i, { position: e.target.value })}>
                  <option value="">Vị trí</option>{opts.positions.map((p) => <option key={p}>{p}</option>)}
                </select>
                <select value={m.userId} onChange={(e) => setMember(i, { userId: e.target.value })}>
                  <option value="">Chọn người</option>
                  {opts.crew.map((c) => <option key={c.id} value={c.id}>{c.title ? `${c.title} ` : ''}{c.full_name}{c.station_id ? ` · ${c.station_id}` : ''}</option>)}
                </select>
                <button className="ghost" onClick={() => setForm({ ...form, members: form.members.filter((_, j) => j !== i) })}>Bỏ</button>
              </div>
            ))}
            <div><button className="ghost" onClick={() => setForm({ ...form, members: [...form.members, { userId: '', position: form.members.length ? '' : 'Trưởng kíp' }] })}>Thêm người</button></div>
          </div>
          <textarea placeholder="Thiết bị mang thêm, cách nhau dấu phẩy" value={form.equipment} onChange={(e) => setForm({ ...form, equipment: e.target.value })} rows={2} />
          <input placeholder="Ghi chú" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <div className="row">
            <button disabled={!valid} onClick={save}>{editing ? 'Lưu' : 'Lập ca trực'}</button>
            {editing && <button className="ghost" onClick={() => { setEditing(null); setForm(blank()); }}>Thôi</button>}
          </div>
          <div className="small muted">Người trong ca đăng nhập ca trên xe này không bị giới hạn theo điểm được phân, từ 1 giờ trước giờ bắt đầu tới hết ca.</div>
        </div>
      )}

      <DutyTasksAdmin />

      {prices && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Bảng giá áp cho ca trực</h3>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Bảng giá</th><th>Loại xe</th><th className="right">Giá mở cửa</th><th className="right">Km đầu</th><th className="right">Mỗi km</th><th className="right">Chờ mỗi giờ</th><th className="right">Phụ thu đêm</th></tr></thead>
              <tbody>{prices.priceLists.map((p) => (
                <tr key={p.id}><td>{p.name}</td><td>{p.vehicle_type}</td><td className="right">{money(p.base_fee)}</td><td className="right">{p.base_km}</td>
                  <td className="right">{money(p.per_km)}</td><td className="right">{money(p.wait_per_hour)}</td><td className="right">{p.night_surcharge_pct}%</td></tr>
              ))}</tbody>
            </table>
          </div>
          {prices.services.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary>Giá dịch vụ ({prices.services.length})</summary>
              <table className="small">
                <tbody>{prices.services.map((s) => <tr key={s.id}><td className="mono">{s.code}</td><td>{s.name}</td><td>{s.unit}</td><td className="right">{money(s.price)}</td></tr>)}</tbody>
              </table>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
