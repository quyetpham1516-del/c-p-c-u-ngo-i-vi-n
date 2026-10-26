import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, download, session } from '../api';
import { useStations } from '../catalog';
import { ParSheet, type ParItem } from '../components/ParSheet';

interface Lot {
  id: string; station_id: string; station_name: string; vehicle_id: string | null; lot: string; expiry: string; qty: number;
  supplier: string | null; received_at: string; drug_id: number; drug_name: string; unit: string; controlled: boolean; days_left: number;
}
interface Drug { id: number; name: string; unit: string; controlled: boolean; track_lot?: boolean; group_name?: string }
interface Voucher {
  id: string; code: string; kind: string; status: string; station_id: string; vehicle_id: string | null; to_station_id: string | null;
  note: string | null; witness: string | null; created_by: string; created_by_name: string; created_at: string;
  decided_by_name: string | null; decided_at: string | null; decision_note: string | null; line_count: number;
  items?: { id: number; lot: string; expiry: string; drug_name: string; unit: string; qty: number; counted_qty: number | null; book_qty: number | null }[];
}

const KIND: Record<string, string> = { cap_xe: 'Cấp cơ số xe', tra_kho: 'Xe trả kho', dieu_chuyen: 'Điều chuyển', kiem_ke: 'Kiểm kê', huy: 'Hủy thuốc' };
const VSTATUS: Record<string, string> = { cho_duyet: 'Chờ duyệt', da_duyet: 'Đã duyệt', tu_choi: 'Từ chối' };
const TABS = ['Tồn kho điểm', 'Cơ số xe', 'Phiếu kho', 'Cảnh báo, đặt hàng', 'Định mức, cơ số chuẩn'] as const;
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (n: number) => Number(n).toLocaleString('vi-VN');
const at = (s: string) => new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

/** Kho thuốc (QL-13, QLCL-16): kho điểm → cơ số xe → người bệnh; phiếu kho duyệt hai cấp; cảnh báo hạn dùng, định mức */
export function Stock() {
  const [stations] = useStations();
  const role = session.user?.role ?? '';
  const canManage = ['pharmacist', 'supervisor', 'admin'].includes(role);
  const canApprove = ['supervisor', 'admin', 'director'].includes(role);
  const [stationId, setStationId] = useState('');
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  const [drugs, setDrugs] = useState<Drug[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { if (!stationId && stations.length) setStationId(stations[0].id); }, [stations, stationId]);
  useEffect(() => { api<Drug[]>('GET', '/api/drugs').then(setDrugs).catch((e) => setError(e.message)); }, []);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  const ctx = { stationId, stations, drugs, canManage, canApprove, run };

  return (
    <div className="col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Kho thuốc, vật tư <span className="small muted">QL-13, QLCL-16</span></h2>
        <label className="row small">Điểm
          <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
            {stations.map((s) => <option key={s.id} value={s.id}>{s.id} – {s.name}</option>)}
          </select>
        </label>
      </div>
      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setMsg(''); setError(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {stationId && tab === 'Tồn kho điểm' && <LotsTab {...ctx} />}
      {stationId && tab === 'Cơ số xe' && <VehiclesTab {...ctx} />}
      {stationId && tab === 'Phiếu kho' && <VouchersTab {...ctx} />}
      {stationId && tab === 'Cảnh báo, đặt hàng' && <AlertsTab {...ctx} />}
      {stationId && tab === 'Định mức, cơ số chuẩn' && <SettingsTab {...ctx} />}
    </div>
  );
}

type Ctx = {
  stationId: string; stations: { id: string; name: string }[]; drugs: Drug[]; canManage: boolean; canApprove: boolean;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
};

function LotsTab({ stationId, stations, drugs, canManage, run }: Ctx) {
  const [lots, setLots] = useState<Lot[]>([]);
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ drugId: '', drugName: '', unit: 'ống', lot: '', expiry: '', qty: '', supplier: '' });
  const [counting, setCounting] = useState<Record<string, string> | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [move, setMove] = useState({ to: '', witness: '', note: '' });
  const load = () => api<Lot[]>('GET', `/api/stock?stationId=${encodeURIComponent(stationId)}&place=kho`).then(setLots);
  useEffect(() => { load().catch(() => {}); }, [stationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => lots.filter((l) => !q || `${l.drug_name} ${l.lot}`.toLowerCase().includes(q.toLowerCase())), [lots, q]);
  const noLot = !!form.drugId && drugs.find((d) => String(d.id) === form.drugId)?.track_lot === false;
  const valid = (form.drugId || form.drugName.trim().length > 2) && (noLot || (form.lot.trim() && /^\d{4}-\d{2}-\d{2}$/.test(form.expiry))) && Number(form.qty) > 0;
  const picked = Object.entries(pick).filter(([, v]) => Number(v) > 0).map(([lotId, v]) => ({ lotId, qty: Number(v) }));
  const pickedControlled = picked.some((p) => lots.find((l) => l.id === p.lotId)?.controlled);

  const receive = () => run(async () => {
    await api('POST', '/api/stock/receive', {
      stationId, drugId: form.drugId ? Number(form.drugId) : null, drugName: form.drugId ? null : form.drugName, unit: form.unit,
      lot: form.lot || null, expiry: form.expiry || null, qty: Number(form.qty), supplier: form.supplier || null,
    });
    setForm({ ...form, lot: '', expiry: '', qty: '' });
    await load();
  }, `Đã nhập lô ${form.lot}.`);

  const submitCount = () => run(async () => {
    const lines = Object.entries(counting ?? {}).filter(([, v]) => v.trim() !== '').map(([lotId, v]) => ({ lotId, counted: Number(v) }));
    if (!lines.length) throw new Error('Chưa nhập số đếm nào');
    const v = await api<Voucher>('POST', '/api/stock/stocktake', { stationId, lines });
    setCounting(null);
    await load();
    return v;
  }, 'Đã lập phiếu kiểm kê. Nếu có chênh lệch, phiếu chờ người thứ hai duyệt rồi mới điều chỉnh tồn.');

  const transfer = () => run(async () => {
    await api('POST', '/api/stock/transfer', { fromStation: stationId, toStation: move.to, lines: picked, witness: move.witness || null, note: move.note || null });
    setPick({}); await load();
  }, `Đã điều chuyển ${picked.length} lô sang ${move.to}.`);

  const dispose = () => run(async () => {
    if (move.note.trim().length < 3) throw new Error('Ghi lý do hủy (hết hạn, vỡ, hỏng...)');
    await api('POST', '/api/stock/disposal', { stationId, lines: picked, note: move.note, witness: move.witness || null });
    setPick({}); await load();
  }, 'Đã lập phiếu hủy, chờ duyệt rồi mới trừ kho.');

  return (
    <>
      {canManage && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Nhập kho tại điểm {stationId}</h3>
          <div className="grid4">
            <label className="field">Thuốc
              <select value={form.drugId} onChange={(e) => setForm({ ...form, drugId: e.target.value })}>
                <option value="">— Thuốc mới (gõ tên bên cạnh) —</option>
                {drugs.map((d) => <option key={d.id} value={d.id}>{d.group_name ? `${d.group_name} · ` : ''}{d.name}</option>)}
              </select>
            </label>
            {!form.drugId && <label className="field">Tên thuốc mới<input value={form.drugName} onChange={(e) => setForm({ ...form, drugName: e.target.value })} placeholder="Tên, hàm lượng, dạng" /></label>}
            {!form.drugId && <label className="field">Đơn vị<input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></label>}
            <label className="field">Số lô{noLot ? ' (không bắt buộc)' : ''}<input value={form.lot} onChange={(e) => setForm({ ...form, lot: e.target.value })} /></label>
            <label className="field">Hạn dùng{noLot ? ' (không bắt buộc)' : ''}<input type="date" min={today()} value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value })} /></label>
            <label className="field">Số lượng<input inputMode="decimal" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></label>
            <label className="field">Nhà cung cấp / số phiếu<input value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} /></label>
          </div>
          <div className="row"><button className="primary" disabled={!valid} onClick={receive}>Nhập kho</button>
            <span className="small muted">Kíp chọn thuốc trong phiếu sẽ tự lấy số lô; lô hết hạn sớm nhất dùng trước.</span></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <input placeholder="Lọc theo tên thuốc hoặc số lô" value={q} onChange={(e) => setQ(e.target.value)} />
          {canManage && !counting && <button onClick={() => setCounting({})}>Kiểm kê kho này</button>}
          {counting && <><button className="primary" onClick={submitCount}>Lập phiếu kiểm kê</button><button className="ghost" onClick={() => setCounting(null)}>Thôi</button>
            <span className="small muted">Nhập số đếm thực tế; ô để trống là không kiểm.</span></>}
        </div>
        <table>
          <thead><tr><th>Thuốc</th><th>Số lô</th><th>Hạn dùng</th><th className="right">Tồn</th><th>Nhập từ</th>
            {counting && <th className="right">Đếm thực tế</th>}{canManage && !counting && <th className="right">Chọn để chuyển/hủy</th>}</tr></thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id}>
                <td>{l.drug_name}{l.controlled && <span className="badge far" style={{ marginLeft: 6 }}>Kiểm soát đặc biệt</span>}</td>
                <td className="mono">{l.lot === 'KHONG-LO' ? '—' : l.lot}</td>
                <td className="mono" style={l.days_left < 90 ? { color: 'var(--p1)', fontWeight: 600 } : undefined}>
                  {l.expiry.startsWith('9999') ? 'Không hạn' : l.expiry}{l.days_left < 0 ? ' (đã hết hạn)' : l.days_left < 90 ? ` (còn ${l.days_left} ngày)` : ''}</td>
                <td className="right mono">{fmt(l.qty)} {l.unit}</td>
                <td className="small muted">{l.supplier ?? '—'}</td>
                {counting && <td className="right"><input inputMode="decimal" style={{ width: 90 }} value={counting[l.id] ?? ''}
                  onChange={(e) => setCounting({ ...counting, [l.id]: e.target.value })} /></td>}
                {canManage && !counting && <td className="right"><input inputMode="decimal" style={{ width: 80 }} placeholder="SL" value={pick[l.id] ?? ''}
                  onChange={(e) => setPick({ ...pick, [l.id]: e.target.value })} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <div className="muted small">Chưa có lô nào.</div>}
      </div>
      {canManage && picked.length > 0 && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Đã chọn {picked.length} lô</h3>
          <div className="grid4">
            <label className="field">Điều chuyển sang điểm
              <select value={move.to} onChange={(e) => setMove({ ...move, to: e.target.value })}>
                <option value="">— Chọn điểm nhận —</option>
                {stations.filter((s) => s.id !== stationId).map((s) => <option key={s.id} value={s.id}>{s.id} – {s.name}</option>)}
              </select>
            </label>
            <label className="field">Người chứng kiến{pickedControlled ? ' (bắt buộc)' : ''}<input value={move.witness} onChange={(e) => setMove({ ...move, witness: e.target.value })} /></label>
            <label className="field">Ghi chú / lý do hủy<input value={move.note} onChange={(e) => setMove({ ...move, note: e.target.value })} /></label>
          </div>
          <div className="row">
            <button className="primary" disabled={!move.to} onClick={transfer}>Điều chuyển</button>
            <button className="danger" onClick={dispose}>Lập phiếu hủy (chờ duyệt)</button>
          </div>
        </div>
      )}
    </>
  );
}

function VehiclesTab({ stationId, run }: Ctx) {
  const [vehicles, setVehicles] = useState<{ id: string; type: string; station_id: string }[]>([]);
  const [par, setPar] = useState<Record<string, { items: ParItem[]; short: number }>>({});
  const load = async () => {
    const vs = (await api<{ id: string; type: string; station_id: string }[]>('GET', '/api/equipment/readiness')).filter((v) => v.station_id === stationId);
    setVehicles(vs);
    const out: typeof par = {};
    for (const v of vs) out[v.id] = await api('GET', `/api/stock/vehicle/${encodeURIComponent(v.id)}/par`);
    setPar(out);
  };
  useEffect(() => { load().catch(() => {}); }, [stationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const restock = (vehicleId: string) => {
    const needWitness = par[vehicleId]?.items.some((i) => i.missing > 0 && i.controlled);
    const witness = needWitness ? prompt('Có thuốc kiểm soát đặc biệt cần bù. Người chứng kiến:') : null;
    if (needWitness && !witness?.trim()) return;
    run(async () => {
      const r = await api<{ voucher: Voucher | null; lines: number; unfilled: { drug: string; missing: number }[] }>('POST', `/api/stock/vehicle/${encodeURIComponent(vehicleId)}/restock`, { witness });
      await load();
      if (r.unfilled.length) throw new Error(`Đã bù ${r.lines} dòng${r.voucher ? ` (phiếu ${r.voucher.code})` : ''}. Kho điểm không đủ: ${r.unfilled.map((u) => `${u.drug} thiếu ${u.missing}`).join('; ')}`);
    }, `Đã bù đủ cơ số xe ${vehicleId}.`);
  };

  return (
    <>
      {!vehicles.length && <div className="panel muted">Điểm này chưa có xe.</div>}
      {vehicles.map((v) => (
        <div key={v.id} className="panel" style={{ overflowX: 'auto' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>{v.id} <span className="small muted">{v.type}</span>{' '}
              {par[v.id] && (par[v.id].short ? <span className="badge far">Thiếu {par[v.id].short} loại</span> : <span className="badge">Đủ cơ số</span>)}</h3>
            <button className="primary" disabled={!par[v.id]?.short} onClick={() => restock(v.id)}>Bù cơ số từ kho điểm</button>
          </div>
          <ParSheet items={par[v.id]?.items ?? []} />
        </div>
      ))}
    </>
  );
}

function VouchersTab({ stationId, canApprove, run }: Ctx) {
  const [list, setList] = useState<Voucher[]>([]);
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<Voucher | null>(null);
  const me = session.user?.id;
  const load = () => api<Voucher[]>('GET', `/api/stock/vouchers?stationId=${encodeURIComponent(stationId)}${status ? `&status=${status}` : ''}`).then(setList);
  useEffect(() => { load().catch(() => {}); }, [stationId, status]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = async (v: Voucher) => setOpen(open?.id === v.id ? null : await api<Voucher>('GET', `/api/stock/vouchers/${v.id}`));
  const decide = (v: Voucher, approve: boolean) => {
    const note = approve ? null : prompt('Lý do từ chối:');
    if (!approve && !note?.trim()) return;
    run(async () => { await api('POST', `/api/stock/vouchers/${v.id}/decide`, { approve, note }); setOpen(null); await load(); },
      approve ? `Đã duyệt phiếu ${v.code}.` : `Đã từ chối phiếu ${v.code}.`);
  };
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Mọi trạng thái</option>
          {Object.entries(VSTATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="small muted">Kiểm kê có chênh lệch và hủy thuốc phải người khác người lập duyệt.</span>
      </div>
      <table>
        <thead><tr><th>Số phiếu</th><th>Loại</th><th>Nơi</th><th>Người lập</th><th>Lúc</th><th>Trạng thái</th><th /></tr></thead>
        <tbody>
          {list.map((v) => (
            <Fragment key={v.id}>
              <tr onClick={() => show(v)} style={{ cursor: 'pointer' }}>
                <td className="mono">{v.code}</td><td>{KIND[v.kind]}</td>
                <td className="small">{v.station_id}{v.vehicle_id ? ` ↔ ${v.vehicle_id}` : ''}{v.to_station_id ? ` → ${v.to_station_id}` : ''}</td>
                <td className="small">{v.created_by_name}</td><td className="small mono">{at(v.created_at)}</td>
                <td><span className={`badge ${v.status === 'cho_duyet' ? 'far' : ''}`}>{VSTATUS[v.status]}</span></td>
                <td className="right" onClick={(e) => e.stopPropagation()}>
                  {canApprove && v.status === 'cho_duyet' && v.created_by !== me && <>
                    <button className="primary small" onClick={() => decide(v, true)}>Duyệt</button>{' '}
                    <button className="ghost small" onClick={() => decide(v, false)}>Từ chối</button></>}
                </td>
              </tr>
              {open?.id === v.id && (
                <tr><td colSpan={7}>
                  <div className="small">{v.note && <>Ghi chú: {v.note}. </>}{v.witness && <>Người chứng kiến: {v.witness}. </>}
                    {v.decided_by_name && <>Quyết định: {v.decided_by_name} lúc {at(v.decided_at!)}{v.decision_note ? ` (${v.decision_note})` : ''}.</>}</div>
                  <table>
                    <thead><tr><th>Thuốc</th><th>Số lô</th><th>Hạn dùng</th>{v.kind === 'kiem_ke' ? <><th className="right">Sổ sách</th><th className="right">Đếm</th><th className="right">Chênh</th></> : <th className="right">Số lượng</th>}</tr></thead>
                    <tbody>{open.items?.map((i) => (
                      <tr key={i.id}><td>{i.drug_name}</td><td className="mono">{i.lot}</td><td className="mono">{i.expiry}</td>
                        {v.kind === 'kiem_ke'
                          ? <><td className="right mono">{fmt(i.book_qty ?? 0)}</td><td className="right mono">{fmt(i.counted_qty ?? 0)}</td>
                            <td className="right mono" style={Number(i.qty) ? { color: 'var(--p1)', fontWeight: 700 } : undefined}>{Number(i.qty) > 0 ? '+' : ''}{fmt(i.qty)}</td></>
                          : <td className="right mono">{fmt(i.qty)} {i.unit}</td>}
                      </tr>))}</tbody>
                  </table>
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {!list.length && <div className="muted small">Chưa có phiếu.</div>}
    </div>
  );
}

function AlertsTab({ stationId }: Ctx) {
  const [a, setA] = useState<any>(null);
  const [order, setOrder] = useState<any[]>([]);
  useEffect(() => {
    api('GET', `/api/stock/alerts?stationId=${encodeURIComponent(stationId)}`).then(setA).catch(() => {});
    api<any[]>('GET', `/api/stock/order-suggestion?stationId=${encodeURIComponent(stationId)}`).then(setOrder).catch(() => {});
  }, [stationId]);
  if (!a) return <div className="panel muted">Đang tải…</div>;
  const where = (l: any) => l.vehicle_id ? `xe ${l.vehicle_id}` : `kho ${l.station_id}`;
  return (
    <>
      {a.pendingVouchers > 0 && <div className="alert amber">{a.pendingVouchers} phiếu kho đang chờ duyệt.</div>}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Đã hết hạn, còn tồn ({a.expired.length})</h3>
        {a.expired.length ? <ul>{a.expired.map((l: any) => <li key={l.id}><b>{l.drug_name}</b> lô {l.lot}, hạn {l.expiry}, còn {fmt(l.qty)} {l.unit} ở {where(l)}: lập phiếu hủy.</li>)}</ul> : <div className="small muted">Không có.</div>}
        <h3>Sắp hết hạn trong 90 ngày ({a.expiring.length})</h3>
        {a.expiring.length ? <ul>{a.expiring.map((l: any) => <li key={l.id}>{l.drug_name} lô {l.lot}, hạn {l.expiry} (còn {l.days_left} ngày), {fmt(l.qty)} {l.unit} ở {where(l)}</li>)}</ul> : <div className="small muted">Không có.</div>}
        <h3>Kho điểm dưới định mức ({a.belowMin.length})</h3>
        {a.belowMin.length ? <ul>{a.belowMin.map((x: any) => <li key={x.drug_id}>{x.drug_name}: còn {fmt(x.on_hand)}, định mức {fmt(x.min_qty)} {x.unit}</li>)}</ul> : <div className="small muted">Không có (hoặc chưa đặt định mức).</div>}
        <h3>Xe thiếu cơ số ({a.vehicleShort.length})</h3>
        {a.vehicleShort.length ? <ul>{a.vehicleShort.map((v: any) => <li key={v.vehicleId}><b>{v.vehicleId}</b>: {v.items.map((i: any) => `${i.drug} thiếu ${i.missing}`).join(', ')}</li>)}</ul> : <div className="small muted">Không có.</div>}
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Đề xuất đặt hàng tuần cho {stationId}</h3>
        <div className="small muted">Số đặt = đã dùng 7 ngày qua + định mức tối thiểu − tồn kho điểm còn hạn.</div>
        <table>
          <thead><tr><th>Thuốc</th><th className="right">Dùng 7 ngày</th><th className="right">Định mức</th><th className="right">Tồn</th><th className="right">Đặt</th></tr></thead>
          <tbody>{order.map((r) => <tr key={r.drug_id}><td>{r.drug_name}</td><td className="right mono">{fmt(r.used_7d)}</td><td className="right mono">{fmt(r.min_qty)}</td>
            <td className="right mono">{fmt(r.on_hand)}</td><td className="right mono"><b>{fmt(r.order)}</b> {r.unit}</td></tr>)}</tbody>
        </table>
        {!order.length && <div className="small muted">Chưa cần đặt thêm.</div>}
      </div>
    </>
  );
}

function SettingsTab({ stationId, drugs, canManage, run }: Ctx) {
  const role = session.user?.role ?? '';
  const canPar = ['pharmacist', 'admin'].includes(role);
  const [mins, setMins] = useState<{ drug_id: number; drug_name: string; unit: string; min_qty: number }[]>([]);
  const [par, setPar] = useState<{ vehicle_type: string; drug_id: number; drug_name: string; unit: string; qty: number }[]>([]);
  const [minForm, setMinForm] = useState({ drugId: '', qty: '' });
  const [parForm, setParForm] = useState({ vehicleType: 'ALS', drugId: '', qty: '' });
  const [drugList, setDrugList] = useState(drugs);
  const load = () => Promise.all([
    api<typeof mins>('GET', `/api/stock/minimums?stationId=${encodeURIComponent(stationId)}`).then(setMins),
    api<typeof par>('GET', '/api/par-levels').then(setPar),
    api<Drug[]>('GET', '/api/drugs').then(setDrugList),
  ]);
  useEffect(() => { load().catch(() => {}); }, [stationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const types = [...new Set(par.map((p) => p.vehicle_type))];

  return (
    <>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Định mức tối thiểu tại kho {stationId}</h3>
        <table><tbody>{mins.map((m) => <tr key={m.drug_id}><td>{m.drug_name}</td><td className="right mono">{fmt(m.min_qty)} {m.unit}</td></tr>)}</tbody></table>
        {!mins.length && <div className="small muted">Chưa đặt định mức.</div>}
        {canManage && (
          <div className="row" style={{ marginTop: 8 }}>
            <select value={minForm.drugId} onChange={(e) => setMinForm({ ...minForm, drugId: e.target.value })}>
              <option value="">— Thuốc —</option>{drugList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <input inputMode="decimal" placeholder="Định mức (0 = bỏ)" style={{ width: 150 }} value={minForm.qty} onChange={(e) => setMinForm({ ...minForm, qty: e.target.value })} />
            <button disabled={!minForm.drugId || minForm.qty === ''} onClick={() => run(async () => {
              await api('PUT', '/api/stock/minimums', { stationId, drugId: Number(minForm.drugId), minQty: Number(minForm.qty) }); setMinForm({ drugId: '', qty: '' }); await load();
            }, 'Đã lưu định mức.')}>Lưu</button>
          </div>
        )}
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Cơ số chuẩn theo loại xe</h3>
        <div className="small muted">Bản nháp; Hội đồng Chuyên môn duyệt danh mục cơ số trước khi dùng thật.</div>
        <div className="row" style={{ margin: '8px 0' }}>
          <button onClick={() => run(() => download('/api/par-levels/excel', 'co-so-xe.xlsx'), 'Đã tải bảng cơ số Excel (mỗi loại xe một trang).')}>Tải Excel cơ số</button>
          {canPar && <label className="btn">Nạp từ Excel
            <input type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => {
              const f = e.target.files?.[0]; e.target.value = '';
              if (!f) return;
              run(async () => {
                const buf = new Uint8Array(await f.arrayBuffer());
                let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
                const r = await api<any>('POST', '/api/par-levels/import', { file: btoa(bin) });
                await load();
                const msg = `Đã nạp ${r.sheets.join(', ')}: đổi ${r.set}, bỏ ${r.removed}, mặt hàng mới ${r.created.length}.`;
                if (r.errors.length) throw new Error(`${msg} Có ${r.errors.length} dòng lỗi: ${r.errors.slice(0, 5).join('; ')}`);
                alert(msg);
              });
            }} /></label>}
          <span className="small muted">Mở trong Excel, sửa cột "Cơ số chuẩn" (0 là bỏ), thêm dòng hàng mới, rồi nạp lại.</span>
        </div>
        <div className="grid2">
          {types.map((t) => (
            <div key={t}><b>{t}</b>
              <table><tbody>{par.filter((p) => p.vehicle_type === t).map((p) => <tr key={p.drug_id}><td>{p.drug_name}</td><td className="right mono">{fmt(p.qty)} {p.unit}</td></tr>)}</tbody></table>
            </div>
          ))}
        </div>
        {canPar && (
          <div className="row" style={{ marginTop: 8 }}>
            <select value={parForm.vehicleType} onChange={(e) => setParForm({ ...parForm, vehicleType: e.target.value })}>
              {['ALS', 'BLS', 'MSU', 'ECMO', 'VC', 'DP'].map((t) => <option key={t}>{t}</option>)}
            </select>
            <select value={parForm.drugId} onChange={(e) => setParForm({ ...parForm, drugId: e.target.value })}>
              <option value="">— Thuốc —</option>{drugList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <input inputMode="decimal" placeholder="Số lượng (0 = bỏ)" style={{ width: 150 }} value={parForm.qty} onChange={(e) => setParForm({ ...parForm, qty: e.target.value })} />
            <button disabled={!parForm.drugId || parForm.qty === ''} onClick={() => run(async () => {
              await api('PUT', '/api/par-levels', { vehicleType: parForm.vehicleType, drugId: Number(parForm.drugId), qty: Number(parForm.qty) }); setParForm({ ...parForm, drugId: '', qty: '' }); await load();
            }, 'Đã lưu cơ số chuẩn.')}>Lưu</button>
          </div>
        )}
      </div>
      <ItemCatalog canEdit={canPar} run={run} onChange={load} />
    </>
  );
}

const KIND_LABEL: Record<string, string> = { thuoc: 'Thuốc', dich_truyen: 'Dịch truyền', vat_tu: 'Vật tư tiêu hao', dung_cu: 'Dụng cụ dùng lại', van_phong_pham: 'Văn phòng phẩm' };

/** Danh mục hàng hóa chia nhóm: thuốc, dịch truyền, vật tư, dụng cụ, văn phòng phẩm */
function ItemCatalog({ canEdit, run, onChange }: { canEdit: boolean; run: Ctx['run']; onChange: () => Promise<unknown> }) {
  const [items, setItems] = useState<any[]>([]);
  const [groups, setGroups] = useState<{ code: string; name: string }[]>([]);
  const [group, setGroup] = useState('');
  const [form, setForm] = useState({ name: '', unit: 'cái', kind: 'vat_tu', groupCode: '' });
  const load = () => Promise.all([api<any[]>('GET', '/api/items?all=1').then(setItems), api<any[]>('GET', '/api/item-groups').then(setGroups)]);
  useEffect(() => { load().catch(() => {}); }, []);
  const patch = (id: number, body: object) => run(async () => { await api('PATCH', `/api/items/${id}`, body); await load(); await onChange(); });
  const shown = items.filter((i) => !group || i.group_code === group);
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Danh mục hàng hóa</h3>
        <select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">Tất cả nhóm</option>{groups.map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}</select>
      </div>
      <div className="small muted">Thuốc, dịch truyền quản lý theo số lô và hạn dùng. Vật tư không có hạn, văn phòng phẩm thì nhập kho không cần lô. Thuốc kiểm soát đặc biệt phải ghi người chứng kiến.</div>
      <table className="sheet">
        <thead><tr><th>Tên</th><th>Nhóm</th><th>Loại</th><th>ĐVT</th><th>Theo lô</th><th>KSĐB</th><th>Tính tiền</th><th className="right">Giá bán</th><th>Đang dùng</th></tr></thead>
        <tbody>{shown.map((i) => (
          <tr key={i.id} className={i.active ? '' : 'muted'}>
            <td>{i.name}</td>
            <td>{canEdit ? <select value={i.group_code} onChange={(e) => patch(i.id, { groupCode: e.target.value })}>{groups.map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}</select> : i.group_name}</td>
            <td className="small">{KIND_LABEL[i.kind]}</td><td className="small">{i.unit}</td>
            <td><input type="checkbox" disabled={!canEdit} checked={i.track_lot} onChange={(e) => patch(i.id, { trackLot: e.target.checked })} /></td>
            <td><input type="checkbox" disabled={!canEdit} checked={i.controlled} onChange={(e) => patch(i.id, { controlled: e.target.checked })} /></td>
            <td><input type="checkbox" disabled={!canEdit} checked={i.billable} onChange={(e) => patch(i.id, { billable: e.target.checked })} /></td>
            <td className="right">{canEdit ? <input inputMode="numeric" style={{ width: 90 }} defaultValue={i.sell_price ?? ''} onBlur={(e) => {
              const v = e.target.value.trim(); if (v === String(i.sell_price ?? '')) return; patch(i.id, { sellPrice: v === '' ? null : Number(v) });
            }} /> : (i.sell_price != null ? fmt(i.sell_price) : '—')}</td>
            <td><input type="checkbox" disabled={!canEdit} checked={i.active} onChange={(e) => patch(i.id, { active: e.target.checked })} /></td>
          </tr>))}</tbody>
      </table>
      {canEdit && (
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <input placeholder="Tên hàng mới (vd. Bơm tiêm 3 ml, Bút bi)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="ĐVT" style={{ width: 80 }} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select value={form.groupCode} onChange={(e) => setForm({ ...form, groupCode: e.target.value })}><option value="">— Nhóm —</option>{groups.map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}</select>
          <button disabled={form.name.trim().length < 2 || !form.groupCode} onClick={() => run(async () => {
            await api('POST', '/api/items', form); setForm({ ...form, name: '' }); await load(); await onChange();
          }, 'Đã thêm mặt hàng.')}>Thêm</button>
          <button className="ghost" onClick={() => { const name = prompt('Tên nhóm mới'); if (name?.trim()) run(async () => { await api('POST', '/api/item-groups', { name }); await load(); }, 'Đã thêm nhóm.'); }}>Thêm nhóm</button>
        </div>
      )}
    </div>
  );
}
