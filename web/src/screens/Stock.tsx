import { useEffect, useMemo, useState } from 'react';
import { api, session } from '../api';
import { useStations } from '../catalog';

interface Lot { id: string; station_id: string; station_name: string; lot: string; expiry: string; qty: number; supplier: string | null; received_at: string; drug_id: number; drug_name: string; unit: string }
interface Drug { id: number; name: string; unit: string }

const soon = (d: string) => new Date(d).getTime() - Date.now() < 90 * 86400_000;
const today = () => new Date().toISOString().slice(0, 10);

/** Kho thuốc theo số lô tại từng điểm (QL-13, QLCL-16): nhập lô, xem tồn, điều chỉnh kiểm kê */
export function Stock() {
  const [stations] = useStations();
  const canEdit = ['supervisor', 'admin'].includes(session.user?.role ?? '');
  const [stationId, setStationId] = useState('');
  const [lots, setLots] = useState<Lot[]>([]);
  const [drugs, setDrugs] = useState<Drug[]>([]);
  const [form, setForm] = useState({ drugId: '', drugName: '', unit: 'ống', lot: '', expiry: '', qty: '', supplier: '' });
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  const load = async () => {
    const [l, d] = await Promise.all([
      api<Lot[]>('GET', `/api/stock${stationId ? `?stationId=${encodeURIComponent(stationId)}` : ''}`),
      api<Drug[]>('GET', '/api/drugs'),
    ]);
    setLots(l); setDrugs(d);
  };
  useEffect(() => { load().catch((e) => setError(e.message)); }, [stationId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!stationId && stations.length) setStationId(stations[0].id); }, [stations, stationId]);

  const receive = async () => {
    setError(''); setMsg('');
    try {
      const r = await api('POST', '/api/stock/receive', {
        stationId, drugId: form.drugId ? Number(form.drugId) : null, drugName: form.drugId ? null : form.drugName, unit: form.unit,
        lot: form.lot, expiry: form.expiry, qty: Number(form.qty), supplier: form.supplier || null,
      });
      setMsg(`Đã nhập lô ${r.lot}, tồn ${Number(r.qty)}.`);
      setForm({ ...form, lot: '', expiry: '', qty: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  const adjust = async (l: Lot) => {
    const v = prompt(`Kiểm kê lô ${l.lot} (${l.drug_name}). Số lượng thực tế còn bao nhiêu? Hiện ghi ${Number(l.qty)}.`);
    if (v === null || v.trim() === '' || Number.isNaN(Number(v))) return;
    const delta = Number(v) - Number(l.qty);
    if (!delta) return;
    const note = prompt('Lý do chênh lệch (bắt buộc):');
    if (!note || note.trim().length < 2) return;
    try { await api('POST', '/api/stock/adjust', { lotId: l.id, delta, note }); await load(); } catch (e) { setError((e as Error).message); }
  };

  const shown = useMemo(() => lots.filter((l) => !q || l.drug_name.toLowerCase().includes(q.toLowerCase()) || l.lot.toLowerCase().includes(q.toLowerCase())), [lots, q]);
  const valid = stationId && (form.drugId || form.drugName.trim().length > 2) && form.lot.trim() && /^\d{4}-\d{2}-\d{2}$/.test(form.expiry) && Number(form.qty) > 0;

  return (
    <div className="col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Kho thuốc theo số lô</h2>
        <label className="row small">Điểm
          <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
            {stations.map((s) => <option key={s.id} value={s.id}>{s.id} – {s.name}</option>)}
          </select>
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      {canEdit && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Nhập kho tại điểm {stationId}</h3>
          <div className="grid4">
            <label className="field">Thuốc
              <select value={form.drugId} onChange={(e) => setForm({ ...form, drugId: e.target.value })}>
                <option value="">— Thuốc mới (gõ tên bên cạnh) —</option>
                {drugs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            {!form.drugId && <label className="field">Tên thuốc mới<input value={form.drugName} onChange={(e) => setForm({ ...form, drugName: e.target.value })} placeholder="Tên, hàm lượng, dạng" /></label>}
            {!form.drugId && <label className="field">Đơn vị<input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></label>}
            <label className="field">Số lô<input value={form.lot} onChange={(e) => setForm({ ...form, lot: e.target.value })} /></label>
            <label className="field">Hạn dùng<input type="date" min={today()} value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value })} /></label>
            <label className="field">Số lượng<input inputMode="decimal" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></label>
            <label className="field">Nhà cung cấp / phiếu<input value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} /></label>
          </div>
          <div className="row"><button className="primary" disabled={!valid} onClick={receive}>Nhập kho</button>{msg && <span className="small">{msg}</span>}</div>
          <div className="small muted">Kíp chọn thuốc trong phiếu sẽ tự lấy số lô này; lô hết hạn sớm nhất được dùng trước. Ký phiếu thì kho tự trừ.</div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <input placeholder="Lọc theo tên thuốc hoặc số lô" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
        <table>
          <thead><tr><th>Thuốc</th><th>Số lô</th><th>Hạn dùng</th><th className="right">Tồn</th><th>Nhập từ</th>{canEdit && <th />}</tr></thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id}>
                <td>{l.drug_name}</td>
                <td className="mono">{l.lot}</td>
                <td className="mono" style={soon(l.expiry) ? { color: 'var(--p1)', fontWeight: 600 } : undefined}>{l.expiry}{soon(l.expiry) ? ' (dưới 90 ngày)' : ''}</td>
                <td className="right mono">{Number(l.qty)} {l.unit}</td>
                <td className="small muted">{l.supplier ?? '—'}</td>
                {canEdit && <td className="right"><button className="ghost small" onClick={() => adjust(l)}>Kiểm kê</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <div className="muted small">Chưa có lô nào.</div>}
      </div>
    </div>
  );
}
