import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, fmtDateTime, session, STATUS_LABEL } from '../api';
import { useStations } from '../catalog';
import { Requisitions } from '../components/Requisitions';
import { Stocktakes } from '../components/Stocktakes';
import { StockHistory } from '../components/StockHistory';

const ALL_STATIONS = ['admin', 'director', 'supervisor', 'pharmacist'];
const EQ_STATUS: Record<string, string> = { hong: 'Hỏng', bao_tri: 'Đang bảo trì', hoat_dong: 'Sắp đến hạn bảo trì, kiểm định' };
const TABS = ['Tổng quan', 'Phiếu đề xuất, phiếu lĩnh', 'Kiểm kê kho điểm', 'Lịch sử xuất nhập'] as const;

/**
 * Trang quản lý điểm: quản lý điểm (và người thay) xem và làm việc của điểm mình: nhân sự, xe, ca trực, thuốc, vật tư,
 * dụng cụ, báo thiếu của kíp (gộp vào phiếu đề xuất), ký nhận phiếu lĩnh, kiểm kê kho điểm, lịch sử xuất nhập.
 */
export function StationManager() {
  const role = session.user?.role ?? '';
  const params = useSearchParams();
  const router = useRouter();
  const [mine, setMine] = useState<any[] | null>(null);
  const [allStations] = useStations();
  const [ov, setOv] = useState<any>(null);
  const [drugs, setDrugs] = useState<any[]>([]);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Tổng quan');
  const [picked, setPicked] = useState<string[]>([]);
  const [prefill, setPrefill] = useState<any>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { api<any[]>('GET', '/api/station-manager/mine').then(setMine).catch(() => setMine([])); api<any[]>('GET', '/api/drugs').then(setDrugs).catch(() => {}); }, []);
  const choices = ALL_STATIONS.includes(role) ? allStations.map((s) => ({ id: s.id, name: s.name })) : mine ?? [];
  const stationId = params.get('diem') ?? choices[0]?.id ?? '';
  const load = () => { if (stationId) api('GET', `/api/station-manager/overview?stationId=${encodeURIComponent(stationId)}`).then((o) => { setOv(o); setError(''); }).catch((e) => { setOv(null); setError(e.message); }); };
  useEffect(() => { setPicked([]); load(); }, [stationId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (mine && !choices.length) return <div className="panel">Bạn chưa được giao quản lý điểm nào. Quản trị gán quản lý điểm ở trang Quản trị.</div>;
  const s = ov?.station;
  const toProposal = () => {
    const rows = ov.shortages.filter((x: any) => picked.includes(x.id));
    const byDrug = new Map<number, number>();
    for (const x of rows) if (x.drug_id) byDrug.set(x.drug_id, (byDrug.get(x.drug_id) ?? 0) + (x.qty ?? 1));
    setPrefill({ lines: [...byDrug].map(([drugId, qty]) => ({ drugId, qty })), shortageIds: rows.map((x: any) => x.id) });
    setTab('Phiếu đề xuất, phiếu lĩnh');
  };

  return (
    <div className="col">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Quản lý điểm</h2>
        <select value={stationId} onChange={(e) => router.replace(`/quan-ly-diem?diem=${encodeURIComponent(e.target.value)}`)}>
          {choices.map((c) => <option key={c.id} value={c.id}>{c.id} – {c.name}</option>)}
        </select>
      </div>
      {s && <div className="small muted">Quản lý: <b>{s.manager_name ?? 'chưa gán'}</b> · Người thay: <b>{s.deputy_name ?? 'chưa gán'}</b></div>}
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>

      {ov && tab === 'Tổng quan' && (
        <>
          <div className="grid2">
            <div className="panel" id="bao-thieu">
              <h3 style={{ marginTop: 0 }}>Kíp báo thiếu {ov.shortages.length > 0 && <span className="badge amber">{ov.shortages.length}</span>}</h3>
              {!ov.shortages.length && <div className="small muted">Không có báo thiếu nào đang mở.</div>}
              {ov.shortages.map((x: any) => (
                <div key={x.id} className="row small" style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--line)', padding: '4px 0' }}>
                  <label className="row"><input type="checkbox" checked={picked.includes(x.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, x.id] : picked.filter((p) => p !== x.id))} />
                    <span><b>{x.item}</b>{x.qty ? ` · ${x.qty} ${x.unit ?? ''}` : ''}{x.note ? ` · ${x.note}` : ''}<div className="muted">{x.reported_by_name} · {fmtDateTime(x.reported_at)}</div></span></label>
                  <button className="ghost small" onClick={async () => {
                    const note = prompt('Lý do đóng (đã có hàng, không cần...)');
                    if (!note) return;
                    try { await api('POST', `/api/stations/${encodeURIComponent(stationId)}/shortages/${x.id}/close`, { note }); load(); } catch (e) { setError((e as Error).message); }
                  }}>Đóng</button>
                </div>
              ))}
              {ov.shortages.length > 0 && <button style={{ marginTop: 6 }} disabled={!picked.length} onClick={toProposal}>Đưa {picked.length || ''} mục vào phiếu đề xuất</button>}
            </div>
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Phiếu đang chạy</h3>
              {!ov.slips.length && <div className="small muted">Không có phiếu nào đang chờ.</div>}
              {ov.slips.map((r: any) => (
                <div key={r.id} className="small"><a href={`/kho#phieu-linh-${r.id}`} onClick={(e) => { e.preventDefault(); setTab('Phiếu đề xuất, phiếu lĩnh'); router.replace(`/quan-ly-diem?diem=${encodeURIComponent(stationId)}#phieu-linh-${r.id}`); }}>
                  <b className="mono">{r.code}</b></a> {r.source === 'tu_dong' ? 'Phiếu lĩnh' : 'Phiếu đề xuất'} · {({ cho_duyet: 'chờ kho tổng duyệt', da_duyet: 'đã duyệt, chờ xuất', da_xuat: 'đã xuất: cần ký nhận' } as Record<string, string>)[r.status]}
                  {r.urgent && <span className="badge red" style={{ marginLeft: 4 }}>Khẩn</span>}</div>
              ))}
              <h3>Kiểm kê</h3>
              <div className="small">{ov.stocktake ? `Phiên gần nhất ${ov.stocktake.due_date}: ${({ mo: 'đang mở, chưa nộp', da_nop: 'đã nộp', qua_han: 'quá hạn' } as Record<string, string>)[ov.stocktake.status] ?? ov.stocktake.status}` : 'Chưa có phiên kiểm kê.'}</div>
            </div>
          </div>
          <div className="grid2">
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Thuốc, vật tư dưới định mức</h3>
              {!ov.belowMin.length && <div className="small muted">Không có mặt hàng nào dưới định mức.</div>}
              <table className="small"><tbody>{ov.belowMin.map((x: any) => (
                <tr key={x.drug_id}><td>{x.drug_name ?? x.name}</td><td className="right">còn {x.on_hand}</td><td className="right">định mức {x.min_qty}</td><td className="right"><b>cần {x.need}</b></td></tr>
              ))}</tbody></table>
              <h3>Sắp hết hạn (30 ngày)</h3>
              {!ov.expiring.length && <div className="small muted">Không có lô nào sắp hết hạn.</div>}
              <table className="small"><tbody>{ov.expiring.map((x: any, i: number) => (
                <tr key={i}><td>{x.drug_name}</td><td className="mono">{x.lot}</td><td>HD {x.expiry}</td><td className="right">{x.qty} {x.unit}</td><td>{x.vehicle_id ? `xe ${x.vehicle_id}` : 'kho điểm'}</td></tr>
              ))}</tbody></table>
            </div>
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Xe của điểm</h3>
              <table className="small"><tbody>{ov.vehicles.map((v: any) => (
                <tr key={v.id}><td><b>{v.id}</b> {v.type}</td><td>{STATUS_LABEL[v.status] ?? v.status}</td><td>{v.crew_on} người trên xe</td>
                  <td>{v.handover && <span className="badge amber">Bàn giao {v.handover === 'cho_giao' ? 'chờ giao' : 'chờ nhận'}</span>}</td></tr>
              ))}</tbody></table>
              <h3>Dụng cụ, thiết bị cần xử lý</h3>
              {!ov.equipment.length && <div className="small muted">Không có thiết bị hỏng hoặc sắp đến hạn.</div>}
              <table className="small"><tbody>{ov.equipment.map((e: any) => (
                <tr key={e.id}><td>{e.name}</td><td className="mono">{e.asset_code ?? e.serial}</td><td>{EQ_STATUS[e.status]}{e.next_due ? ` · hạn ${e.next_due}` : ''}</td><td>{e.vehicle_id ? `xe ${e.vehicle_id}` : 'kho điểm'}</td></tr>
              ))}</tbody></table>
            </div>
          </div>
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Nhân sự của điểm</h3>
            <table className="small">
              <thead><tr><th>Họ tên</th><th>Chức danh</th><th>Đang trực</th></tr></thead>
              <tbody>{ov.staff.map((u: any) => (
                <tr key={u.id}><td>{u.full_name}</td><td>{u.title ?? '—'}</td><td>{u.on_shift_vehicle ? `${u.crew_role} xe ${u.on_shift_vehicle} từ ${fmtDateTime(u.started_at)}` : '—'}</td></tr>
              ))}</tbody>
            </table>
            {ov.duty.length > 0 && <>
              <h3>Ca trực sắp tới</h3>
              {ov.duty.map((d: any) => <div key={d.id} className="small">Xe {d.vehicle_id}{d.place ? ` tại ${d.place}` : ''}: {fmtDateTime(d.starts_at)} – {fmtDateTime(d.ends_at)}</div>)}
            </>}
          </div>
        </>
      )}
      {stationId && tab === 'Phiếu đề xuất, phiếu lĩnh' && <Requisitions stationId={stationId} drugs={drugs} prefill={prefill} />}
      {stationId && tab === 'Kiểm kê kho điểm' && <Stocktakes stationId={stationId} />}
      {stationId && tab === 'Lịch sử xuất nhập' && <StockHistory stationId={stationId} drugs={drugs} />}
    </div>
  );
}
