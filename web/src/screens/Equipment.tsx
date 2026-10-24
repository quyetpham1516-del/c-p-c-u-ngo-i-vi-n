import { Fragment, useEffect, useState } from 'react';
import { api, session } from '../api';
import { QrLookup } from './Scan';
import { useStations } from '../catalog';

interface EqType { id: number; name: string; maintenance_days: number | null; inspection_days: number | null; calibration_days: number | null; active: boolean; required: Record<string, number> }
interface Eq {
  id: string; asset_code: string; qr_code: string; type_id: number; type_name: string; serial: string; model: string | null; station_id: string; vehicle_id: string | null; status: string;
  next_maintenance: string | null; next_inspection: string | null; next_calibration: string | null; note: string | null; overdue: boolean; maintenance_overdue: boolean;
}
interface Readiness { id: string; type: string; station_id: string; status: string; ok: boolean; gaps: { type: string; need: number; have: number; issues: string[] }[] }
interface ISet { id: string; code: string; name: string; station_id: string; vehicle_id: string | null; status: string; sterile_until: string | null; cycles: number; last_used_at: string | null; last_incident_code: string | null; sterile_expired: boolean }
interface Batch { id: string; code: string; method: string; station_id: string; status: string; started_at: string; finished_at: string | null; started_by_name: string; finished_by_name: string | null; indicator_ok: boolean | null; bi_ok: boolean | null; shelf_days: number; sets: string[] }

const STATUS: Record<string, string> = { hoat_dong: 'Hoạt động', hong: 'Hỏng', bao_tri: 'Đang bảo trì', thanh_ly: 'Thanh lý' };
const EVENT: Record<string, string> = { nhap: 'Nhập', kiem_tra: 'Kiểm tra đầu ca', ve_sinh: 'Vệ sinh', bao_duong: 'Bảo dưỡng', kiem_dinh: 'Kiểm định', hieu_chuan: 'Hiệu chuẩn', bao_hong: 'Báo hỏng', sua_xong: 'Sửa xong', dieu_chuyen: 'Điều chuyển', thanh_ly: 'Thanh lý' };
const SET_STATUS: Record<string, string> = { san_sang: 'Sẵn sàng', da_dung: 'Đã dùng, chờ tiệt khuẩn', dang_tiet_khuan: 'Đang tiệt khuẩn', hong: 'Hỏng' };
const METHOD: Record<string, string> = { hap_uot: 'Hấp ướt', eo: 'EO', plasma: 'Plasma' };
const TABS = ['Xe sẵn sàng', 'Thiết bị', 'Đến hạn', 'Dụng cụ, tiệt khuẩn', 'Danh mục'] as const;
const VTYPES = ['ALS', 'BLS', 'MSU', 'ECMO', 'VC', 'DP'];
const todayStr = () => new Date().toISOString().slice(0, 10);
const at = (s: string) => new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

/** Trang thiết bị và dụng cụ (QLCL-15): xe thiếu thiết bị bắt buộc không được giao */
export function Equipment() {
  const role = session.user?.role ?? '';
  const canManage = ['technician', 'supervisor', 'admin'].includes(role);
  const canSterile = ['ipc', 'technician', 'supervisor', 'admin'].includes(role);
  const canCatalog = ['technician', 'admin'].includes(role);
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  return (
    <div className="col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Trang thiết bị và dụng cụ <span className="small muted">QLCL-15</span></h2>
        <QrLookup />
      </div>
      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); setMsg(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {tab === 'Xe sẵn sàng' && <ReadinessTab />}
      {tab === 'Thiết bị' && <EquipmentTab canManage={canManage} run={run} />}
      {tab === 'Đến hạn' && <DueTab />}
      {tab === 'Dụng cụ, tiệt khuẩn' && <SterileTab canManage={canSterile} run={run} />}
      {tab === 'Danh mục' && <CatalogTab canManage={canCatalog} run={run} />}
    </div>
  );
}

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;

function ReadinessTab() {
  const [rows, setRows] = useState<Readiness[]>([]);
  useEffect(() => { api<Readiness[]>('GET', '/api/equipment/readiness').then(setRows).catch(() => {}); }, []);
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <div className="small muted" style={{ marginBottom: 8 }}>Thiết bị bắt buộc thiếu, hỏng hoặc quá hạn kiểm định/hiệu chuẩn thì xe báo đỏ và không được gợi ý giao.</div>
      <table>
        <thead><tr><th>Xe</th><th>Loại</th><th>Điểm</th><th>Thiết bị bắt buộc</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td><b>{r.id}</b></td><td>{r.type}</td><td>{r.station_id}</td>
            <td>{r.ok ? <span className="badge">Đủ</span> : <div className="col" style={{ gap: 2 }}>
              <span className="badge far" style={{ alignSelf: 'flex-start' }}>Không được giao</span>
              {r.gaps.map((g) => <span key={g.type} className="small error">{g.type}: có {g.have}/{g.need}{g.issues.length ? ` (${g.issues.join(', ')})` : ''}</span>)}
            </div>}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

function EquipmentTab({ canManage, run }: { canManage: boolean; run: Run }) {
  const [stations] = useStations();
  const [types, setTypes] = useState<EqType[]>([]);
  const [vehicles, setVehicles] = useState<{ id: string; station_id: string }[]>([]);
  const [list, setList] = useState<Eq[]>([]);
  const [filter, setFilter] = useState({ stationId: '', vehicleId: '', status: '' });
  const [form, setForm] = useState({ typeId: '', serial: '', model: '', stationId: '', vehicleId: '', nextInspection: '', nextCalibration: '' });
  const [open, setOpen] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [ev, setEv] = useState({ kind: 'bao_duong', note: '', certNo: '', nextDue: '', stationId: '', vehicleId: '' });
  const load = () => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    return api<Eq[]>('GET', `/api/equipment${qs ? `?${qs}` : ''}`).then(setList);
  };
  useEffect(() => {
    api<EqType[]>('GET', '/api/equipment-types').then(setTypes).catch(() => {});
    api<{ id: string; station_id: string }[]>('GET', '/api/equipment/readiness').then(setVehicles).catch(() => {});
  }, []);
  useEffect(() => { load().catch(() => {}); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id); setEvents(await api('GET', `/api/equipment/${id}/events`));
    setEv({ kind: 'bao_duong', note: '', certNo: '', nextDue: '', stationId: '', vehicleId: '' });
  };
  const create = () => run(async () => {
    await api('POST', '/api/equipment', {
      typeId: Number(form.typeId), serial: form.serial, model: form.model || null, stationId: form.stationId, vehicleId: form.vehicleId || null,
      nextInspection: form.nextInspection || null, nextCalibration: form.nextCalibration || null,
    });
    setForm({ ...form, serial: '', model: '' }); await load();
  }, `Đã thêm thiết bị ${form.serial}.`);
  const record = (e: Eq) => run(async () => {
    await api('POST', `/api/equipment/${e.id}/events`, {
      kind: ev.kind, note: ev.note || null, certNo: ev.certNo || null, nextDue: ev.nextDue || null,
      stationId: ev.kind === 'dieu_chuyen' ? (ev.stationId || e.station_id) : undefined, vehicleId: ev.kind === 'dieu_chuyen' ? (ev.vehicleId || null) : undefined,
    });
    await load(); setEvents(await api('GET', `/api/equipment/${e.id}/events`));
  }, `Đã ghi ${EVENT[ev.kind].toLowerCase()} cho ${e.serial}.`);
  const vehiclesOf = (sid: string) => vehicles.filter((v) => v.station_id === sid);

  return (
    <>
      {canManage && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Thêm thiết bị</h3>
          <div className="grid4">
            <label className="field">Loại<select value={form.typeId} onChange={(e) => setForm({ ...form, typeId: e.target.value })}>
              <option value="">— Chọn —</option>{types.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <label className="field">Số seri<input value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value })} /></label>
            <label className="field">Hãng, model<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
            <label className="field">Điểm<select value={form.stationId} onChange={(e) => setForm({ ...form, stationId: e.target.value, vehicleId: '' })}>
              <option value="">— Chọn —</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.id} – {s.name}</option>)}</select></label>
            <label className="field">Lắp trên xe<select value={form.vehicleId} onChange={(e) => setForm({ ...form, vehicleId: e.target.value })}>
              <option value="">— Để ở kho điểm —</option>{vehiclesOf(form.stationId).map((v) => <option key={v.id}>{v.id}</option>)}</select></label>
            <label className="field">Hạn kiểm định<input type="date" value={form.nextInspection} onChange={(e) => setForm({ ...form, nextInspection: e.target.value })} /></label>
            <label className="field">Hạn hiệu chuẩn<input type="date" value={form.nextCalibration} onChange={(e) => setForm({ ...form, nextCalibration: e.target.value })} /></label>
          </div>
          <div><button className="primary" disabled={!form.typeId || form.serial.trim().length < 2 || !form.stationId} onClick={create}>Thêm</button></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <select value={filter.stationId} onChange={(e) => setFilter({ ...filter, stationId: e.target.value, vehicleId: '' })}>
            <option value="">Mọi điểm</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select>
          <select value={filter.vehicleId} onChange={(e) => setFilter({ ...filter, vehicleId: e.target.value })}>
            <option value="">Mọi xe</option>{(filter.stationId ? vehiclesOf(filter.stationId) : vehicles).map((v) => <option key={v.id}>{v.id}</option>)}</select>
          <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
            <option value="">Mọi trạng thái</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <a className="btn" href={`/tem-qr?${new URLSearchParams({ loai: 'tb', ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v)) })}`} target="_blank" rel="noreferrer">In tem QR ({list.length} thiết bị đang lọc)</a>
        </div>
        <table>
          <thead><tr><th>Mã TB</th><th>Thiết bị</th><th>Số seri</th><th>Nơi</th><th>Trạng thái</th><th>Bảo dưỡng</th><th>Kiểm định</th><th>Hiệu chuẩn</th></tr></thead>
          <tbody>{list.map((e) => (
            <Fragment key={e.id}>
              <tr style={{ cursor: 'pointer' }} onClick={() => toggle(e.id)}>
                <td className="mono small">{e.asset_code}</td>
                <td>{e.type_name}<div className="small muted">{e.model}</div></td>
                <td className="mono">{e.serial}</td>
                <td className="small">{e.vehicle_id ?? `kho ${e.station_id}`}</td>
                <td><span className={`badge ${e.status !== 'hoat_dong' || e.overdue ? 'far' : ''}`}>{STATUS[e.status]}{e.overdue ? ', quá hạn' : ''}</span></td>
                <td className="mono small" style={e.maintenance_overdue ? { color: 'var(--p2)' } : undefined}>{e.next_maintenance ?? '—'}</td>
                <td className="mono small" style={e.next_inspection && e.next_inspection < todayStr() ? { color: 'var(--p1)', fontWeight: 700 } : undefined}>{e.next_inspection ?? '—'}</td>
                <td className="mono small" style={e.next_calibration && e.next_calibration < todayStr() ? { color: 'var(--p1)', fontWeight: 700 } : undefined}>{e.next_calibration ?? '—'}</td>
              </tr>
              {open === e.id && (
                <tr><td colSpan={8}>
                  <div className="row small" style={{ marginBottom: 6 }}>
                    <a href={`/tb/${e.qr_code}`}>Mở trang quét QR</a>
                    <a href={`/tem-qr?loai=tb&ids=${e.id}`} target="_blank" rel="noreferrer">In tem thiết bị này</a>
                  </div>
                  {canManage && e.status !== 'thanh_ly' && (
                    <div className="grid4" style={{ marginBottom: 8 }}>
                      <label className="field">Ghi nhận<select value={ev.kind} onChange={(x) => setEv({ ...ev, kind: x.target.value })}>
                        {Object.entries(EVENT).filter(([k]) => k !== 'nhap').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                      {['kiem_dinh', 'hieu_chuan'].includes(ev.kind) && <label className="field">Số giấy chứng nhận<input value={ev.certNo} onChange={(x) => setEv({ ...ev, certNo: x.target.value })} /></label>}
                      {['bao_duong', 'kiem_dinh', 'hieu_chuan'].includes(ev.kind) && <label className="field">Hạn kế tiếp (để trống = theo chu kỳ)<input type="date" value={ev.nextDue} onChange={(x) => setEv({ ...ev, nextDue: x.target.value })} /></label>}
                      {ev.kind === 'dieu_chuyen' && <>
                        <label className="field">Điểm<select value={ev.stationId || e.station_id} onChange={(x) => setEv({ ...ev, stationId: x.target.value, vehicleId: '' })}>
                          {stations.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
                        <label className="field">Xe<select value={ev.vehicleId} onChange={(x) => setEv({ ...ev, vehicleId: x.target.value })}>
                          <option value="">— Kho điểm —</option>{vehiclesOf(ev.stationId || e.station_id).map((v) => <option key={v.id}>{v.id}</option>)}</select></label></>}
                      <label className="field">Ghi chú{['bao_hong', 'thanh_ly'].includes(ev.kind) ? ' (bắt buộc)' : ''}<input value={ev.note} onChange={(x) => setEv({ ...ev, note: x.target.value })} /></label>
                      <div className="row" style={{ alignItems: 'flex-end' }}><button className="primary" onClick={() => record(e)}>Lưu</button></div>
                    </div>
                  )}
                  <table><tbody>{events.map((x) => (
                    <tr key={x.id}><td className="small mono">{at(x.at)}</td><td>{EVENT[x.kind]}</td><td className="small">{x.note}{x.cert_no ? ` · GCN ${x.cert_no}` : ''}{x.next_due ? ` · hạn kế tiếp ${x.next_due}` : ''}</td><td className="small muted">{x.user_name}</td></tr>
                  ))}</tbody></table>
                </td></tr>
              )}
            </Fragment>
          ))}</tbody>
        </table>
        {!list.length && <div className="small muted">Chưa có thiết bị.</div>}
      </div>
    </>
  );
}

function DueTab() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api<any[]>('GET', `/api/equipment/due?days=${days}`).then(setRows).catch(() => {}); }, [days]);
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <label className="row small" style={{ marginBottom: 8 }}>Đến hạn trong
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 60, 90].map((d) => <option key={d} value={d}>{d} ngày</option>)}</select>(kể cả đã quá hạn)</label>
      <table>
        <thead><tr><th>Việc</th><th>Thiết bị</th><th>Số seri</th><th>Nơi</th><th>Hạn</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={`${r.id}-${r.kind}`}><td>{EVENT[r.kind]}</td><td>{r.type_name}</td><td className="mono">{r.serial}</td><td className="small">{r.vehicle_id ?? `kho ${r.station_id}`}</td>
            <td className="mono" style={r.days_left < 0 ? { color: 'var(--p1)', fontWeight: 700 } : undefined}>{r.due}{r.days_left < 0 ? ` (quá ${-r.days_left} ngày)` : ` (còn ${r.days_left} ngày)`}</td></tr>
        ))}</tbody>
      </table>
      {!rows.length && <div className="small muted">Không có việc đến hạn.</div>}
    </div>
  );
}

function SterileTab({ canManage, run }: { canManage: boolean; run: Run }) {
  const [stations] = useStations();
  const [vehicles, setVehicles] = useState<{ id: string; station_id: string }[]>([]);
  const [sets, setSets] = useState<ISet[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [batch, setBatch] = useState({ method: 'hap_uot', stationId: '', shelfDays: '30' });
  const [form, setForm] = useState({ code: '', name: '', stationId: '', vehicleId: '' });
  const load = () => Promise.all([api<ISet[]>('GET', '/api/instrument-sets').then(setSets), api<Batch[]>('GET', '/api/sterilization-batches').then(setBatches)]);
  useEffect(() => { load().catch(() => {}); api<any[]>('GET', '/api/equipment/readiness').then(setVehicles).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = Object.keys(chosen).filter((k) => chosen[k]);
  const start = () => run(async () => {
    await api('POST', '/api/sterilization-batches', { method: batch.method, stationId: batch.stationId, setIds: ids, shelfDays: Number(batch.shelfDays) || 30 });
    setChosen({}); await load();
  }, `Đã đưa ${ids.length} bộ vào lô tiệt khuẩn.`);
  const finish = (b: Batch, ok: boolean) => run(async () => {
    const r = await api<{ passed: boolean }>('POST', `/api/sterilization-batches/${b.id}/finish`, { indicatorOk: ok, biOk: ok ? true : null });
    await load();
    if (!r.passed) throw new Error(`Lô ${b.code} không đạt: các bộ trở lại chờ tiệt khuẩn.`);
  }, `Lô ${b.code} đạt: các bộ đã sẵn sàng.`);

  return (
    <>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ marginTop: 0 }}>Bộ dụng cụ dùng lại</h3>
          <a className="btn" href="/tem-qr?loai=dc" target="_blank" rel="noreferrer">In tem QR bộ dụng cụ</a>
        </div>
        <table>
          <thead><tr>{canManage && <th />}<th>Mã</th><th>Tên bộ</th><th>Nơi</th><th>Trạng thái</th><th>Hạn vô khuẩn</th><th className="right">Số lần</th><th>Dùng gần nhất</th></tr></thead>
          <tbody>{sets.map((s) => (
            <tr key={s.id}>
              {canManage && <td>{s.status === 'da_dung' && <input type="checkbox" checked={!!chosen[s.id]} onChange={(e) => setChosen({ ...chosen, [s.id]: e.target.checked })} />}</td>}
              <td className="mono">{s.code}</td><td>{s.name}</td><td className="small">{s.vehicle_id ?? `kho ${s.station_id}`}</td>
              <td><span className={`badge ${s.status !== 'san_sang' || s.sterile_expired ? 'far' : ''}`}>{s.sterile_expired ? 'Hết hạn vô khuẩn' : SET_STATUS[s.status]}</span></td>
              <td className="mono small">{s.sterile_until ?? '—'}</td><td className="right mono">{s.cycles}</td>
              <td className="small">{s.last_used_at ? at(s.last_used_at) : '—'}{s.last_incident_code ? ` · ${s.last_incident_code}` : ''}</td>
            </tr>))}</tbody>
        </table>
        {canManage && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="small">Đã chọn {ids.length} bộ</span>
            <select value={batch.method} onChange={(e) => setBatch({ ...batch, method: e.target.value })}>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <select value={batch.stationId} onChange={(e) => setBatch({ ...batch, stationId: e.target.value })}>
              <option value="">— Nơi tiệt khuẩn —</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select>
            <label className="row small">Bảo quản<input style={{ width: 60 }} value={batch.shelfDays} onChange={(e) => setBatch({ ...batch, shelfDays: e.target.value })} />ngày</label>
            <button className="primary" disabled={!ids.length || !batch.stationId} onClick={start}>Bắt đầu lô tiệt khuẩn</button>
          </div>
        )}
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Lô tiệt khuẩn</h3>
        <table>
          <thead><tr><th>Số lô</th><th>Cách</th><th>Bắt đầu</th><th>Các bộ</th><th>Kết quả</th><th /></tr></thead>
          <tbody>{batches.map((b) => (
            <tr key={b.id}><td className="mono">{b.code}</td><td>{METHOD[b.method]}</td><td className="small">{at(b.started_at)} · {b.started_by_name}</td>
              <td className="small">{b.sets?.join(', ')}</td>
              <td>{b.status === 'dang_chay' ? <span className="badge">Đang chạy</span> : b.status === 'dat' ? <span className="badge">Đạt</span> : <span className="badge far">Không đạt</span>}</td>
              <td className="right">{canManage && b.status === 'dang_chay' && <>
                <button className="primary small" onClick={() => finish(b, true)}>Chỉ thị đạt</button>{' '}
                <button className="danger small" onClick={() => finish(b, false)}>Không đạt</button></>}</td></tr>))}</tbody>
        </table>
        {!batches.length && <div className="small muted">Chưa có lô.</div>}
      </div>
      {canManage && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Thêm bộ dụng cụ</h3>
          <div className="grid4">
            <label className="field">Mã bộ<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
            <label className="field">Tên bộ<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Bộ đặt nội khí quản..." /></label>
            <label className="field">Điểm<select value={form.stationId} onChange={(e) => setForm({ ...form, stationId: e.target.value, vehicleId: '' })}>
              <option value="">— Chọn —</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
            <label className="field">Xe<select value={form.vehicleId} onChange={(e) => setForm({ ...form, vehicleId: e.target.value })}>
              <option value="">— Kho điểm —</option>{vehicles.filter((v) => v.station_id === form.stationId).map((v) => <option key={v.id}>{v.id}</option>)}</select></label>
          </div>
          <div><button disabled={form.code.trim().length < 2 || form.name.trim().length < 2 || !form.stationId} onClick={() => run(async () => {
            await api('POST', '/api/instrument-sets', { ...form, vehicleId: form.vehicleId || null }); setForm({ code: '', name: '', stationId: form.stationId, vehicleId: '' }); await load();
          }, 'Đã thêm bộ dụng cụ; bộ mới phải qua tiệt khuẩn trước khi dùng.')}>Thêm</button></div>
        </div>
      )}
    </>
  );
}

function CatalogTab({ canManage, run }: { canManage: boolean; run: Run }) {
  const [types, setTypes] = useState<EqType[]>([]);
  const [form, setForm] = useState({ name: '', maintenanceDays: '', inspectionDays: '', calibrationDays: '' });
  const load = () => api<EqType[]>('GET', '/api/equipment-types').then(setTypes);
  useEffect(() => { load().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (s: string) => (s.trim() ? Number(s) : null);
  const setReq = (t: EqType, vt: string) => {
    const v = prompt(`Số ${t.name} bắt buộc trên xe ${vt} (0 = không bắt buộc):`, String(t.required[vt] ?? 0));
    if (v === null || Number.isNaN(Number(v))) return;
    run(async () => { await api('PUT', '/api/vehicle-required-equipment', { vehicleType: vt, typeId: t.id, qty: Number(v) }); await load(); }, 'Đã lưu danh mục bắt buộc.');
  };
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <div className="small muted" style={{ marginBottom: 8 }}>Chu kỳ tính bằng ngày. Bấm vào ô số theo loại xe để đổi số thiết bị bắt buộc.</div>
      <table>
        <thead><tr><th>Loại thiết bị</th><th className="right">Bảo dưỡng</th><th className="right">Kiểm định</th><th className="right">Hiệu chuẩn</th>{VTYPES.map((v) => <th key={v} className="right">{v}</th>)}</tr></thead>
        <tbody>{types.map((t) => (
          <tr key={t.id}><td>{t.name}</td><td className="right mono">{t.maintenance_days ?? '—'}</td><td className="right mono">{t.inspection_days ?? '—'}</td><td className="right mono">{t.calibration_days ?? '—'}</td>
            {VTYPES.map((v) => <td key={v} className="right mono" style={canManage ? { cursor: 'pointer' } : undefined} onClick={canManage ? () => setReq(t, v) : undefined}>{t.required[v] ?? '·'}</td>)}</tr>
        ))}</tbody>
      </table>
      {canManage && (
        <div className="row" style={{ marginTop: 8 }}>
          <input placeholder="Loại thiết bị mới" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Bảo dưỡng (ngày)" style={{ width: 130 }} value={form.maintenanceDays} onChange={(e) => setForm({ ...form, maintenanceDays: e.target.value })} />
          <input placeholder="Kiểm định (ngày)" style={{ width: 130 }} value={form.inspectionDays} onChange={(e) => setForm({ ...form, inspectionDays: e.target.value })} />
          <input placeholder="Hiệu chuẩn (ngày)" style={{ width: 130 }} value={form.calibrationDays} onChange={(e) => setForm({ ...form, calibrationDays: e.target.value })} />
          <button disabled={form.name.trim().length < 2} onClick={() => run(async () => {
            await api('POST', '/api/equipment-types', { name: form.name, maintenanceDays: num(form.maintenanceDays), inspectionDays: num(form.inspectionDays), calibrationDays: num(form.calibrationDays) });
            setForm({ name: '', maintenanceDays: '', inspectionDays: '', calibrationDays: '' }); await load();
          }, 'Đã thêm loại thiết bị.')}>Thêm loại</button>
        </div>
      )}
    </div>
  );
}
