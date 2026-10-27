'use client';
import { Fragment, useEffect, useState } from 'react';
import { api, fmtDateTime, session } from '../api';

const BADGE: Record<string, string> = { cho_duyet: 'amber', da_duyet: 'amber', da_xuat: 'amber', da_nhan: 'green', tu_choi: 'red', huy: '' };

/**
 * Phiếu lĩnh kho tổng → kho điểm. Kho điểm lập phiếu (gợi ý theo định mức), kho tổng duyệt và xuất (trừ kho tổng ngay),
 * kho điểm đếm và xác nhận số thực nhận. Kho tổng bấm phát bù định mức cho mọi điểm.
 */
export function Requisitions({ stationId, drugs }: { stationId: string; drugs: { id: number; name: string; unit: string }[] }) {
  const role = session.user?.role ?? '';
  const central = ['pharmacist', 'admin'].includes(role);
  const [settings, setSettings] = useState<any>(null);
  const [list, setList] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  const [draft, setDraft] = useState<{ drugId: string; qty: string }[]>([]);
  const [note, setNote] = useState('');
  const [approve, setApprove] = useState<Record<number, string>>({});
  const [recv, setRecv] = useState<Record<number, string>>({});
  const [witness, setWitness] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const isCentral = settings?.central === stationId;

  const load = () => api<any[]>('GET', `/api/requisitions${isCentral ? '' : `?stationId=${stationId}`}`).then(setList).catch((e) => setError(e.message));
  useEffect(() => { api('GET', '/api/inventory/settings').then(setSettings).catch(() => {}); }, []);
  useEffect(() => { if (settings) load(); setOpen(null); setDraft([]); }, [stationId, settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = async (id: string) => { const r = await api('GET', `/api/requisitions/${id}`); setOpen(r); setApprove({}); setRecv({}); };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(''); setMsg('');
    try { await fn(); setMsg(ok); await load(); if (open) await show(open.id).catch(() => setOpen(null)); } catch (e) { setError((e as Error).message); }
  };
  const suggest = async () => {
    const s = await api<any[]>('GET', `/api/requisitions/suggest?stationId=${stationId}`);
    if (!s.length) { setMsg('Kho điểm không có mặt hàng nào dưới định mức'); return; }
    setDraft(s.map((x) => ({ drugId: String(x.drug_id), qty: String(x.need) })));
  };
  const statuses: Record<string, string> = settings?.statuses ?? {};

  return (
    <div className="col" id="phieu-linh">
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      <div className="panel col">
        <div className="small muted">Kho tổng: <b>{settings?.centralName ?? 'chưa chọn'}</b>
          {settings?.auto_issue ? ` · tự phát bù định mức lúc ${settings.auto_issue_at} hằng ngày` : ' · chưa bật tự phát bù định mức'}
          {role === 'admin' && settings && <InventorySettings settings={settings} onSaved={(s) => { setSettings(s); setMsg('Đã lưu cài đặt kho (nếu đã khóa cấu hình thì thành đề xuất)'); }} onError={setError} />}</div>
        {isCentral ? (
          central && <div className="row"><button onClick={() => run(async () => {
            const r = await api('POST', '/api/requisitions/auto');
            setMsg(r.created.length ? `Đã lập ${r.created.length} phiếu phát: ${r.created.map((c: any) => `${c.code} (${c.stationId})`).join(', ')}` : 'Không điểm nào dưới định mức');
          }, '')}>Phát bù định mức cho các điểm ngay</button></div>
        ) : (
          <>
            <h3 style={{ margin: 0 }}>Lập phiếu lĩnh cho kho {stationId}</h3>
            {draft.map((d, i) => (
              <div className="row" key={i}>
                <select value={d.drugId} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, drugId: e.target.value } : x)))} style={{ minWidth: 260 }}>
                  <option value="">Chọn mặt hàng</option>{drugs.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.unit})</option>)}
                </select>
                <input type="number" min={1} value={d.qty} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} style={{ width: 90 }} />
                <button className="ghost" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>Bỏ</button>
              </div>
            ))}
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="ghost" onClick={() => setDraft([...draft, { drugId: '', qty: '' }])}>Thêm dòng</button>
              <button className="ghost" onClick={() => suggest().catch((e) => setError(e.message))}>Gợi ý theo định mức</button>
              <input placeholder="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 220 }} />
              <button className="primary" disabled={!draft.some((d) => d.drugId && Number(d.qty) > 0)} onClick={() => run(async () => {
                await api('POST', '/api/requisitions', { stationId, note: note || null, lines: draft.filter((d) => d.drugId && Number(d.qty) > 0).map((d) => ({ drugId: Number(d.drugId), qty: Number(d.qty) })) });
                setDraft([]); setNote('');
              }, 'Đã gửi phiếu lĩnh cho kho tổng')}>Gửi phiếu lĩnh</button>
            </div>
          </>
        )}
      </div>

      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Phiếu</th><th>Kho điểm</th><th>Nguồn</th><th>Lập lúc</th><th>Trạng thái</th></tr></thead>
          <tbody>
            {list.map((r) => (
              <Fragment key={r.id}>
                <tr className="click" onClick={() => (open?.id === r.id ? setOpen(null) : show(r.id).catch((e) => setError(e.message)))}>
                  <td className="mono">{r.code}</td><td>{r.station_name}</td>
                  <td className="small">{r.source === 'tu_dong' ? 'Kho tổng tự phát' : r.created_by_name}</td>
                  <td className="small">{fmtDateTime(r.created_at)}</td>
                  <td><span className={`badge ${BADGE[r.status] ?? ''}`}>{statuses[r.status] ?? r.status}</span>{r.discrepancy && <span className="badge red"> Nhận lệch</span>}</td>
                </tr>
                {open?.id === r.id && (
                  <tr><td colSpan={5} style={{ background: 'var(--panel-2)' }}>
                    <div className="col" style={{ gap: 6 }}>
                      {open.note && <div className="small">Ghi chú: {open.note}</div>}
                      {open.decision_note && <div className="small">Kho tổng: {open.decision_note}</div>}
                      {open.receive_note && <div className="small">Kho điểm khi nhận: {open.receive_note}</div>}
                      <table className="small">
                        <thead><tr><th>Mặt hàng</th><th className="right">Xin</th><th className="right">Duyệt</th>{open.lines[0]?.central_on_hand !== undefined && <th className="right">Kho tổng còn</th>}<th>Lô xuất, số nhận</th></tr></thead>
                        <tbody>{open.lines.map((l: any) => (
                          <tr key={l.id}>
                            <td>{l.drug_name} <span className="muted">{l.unit}</span></td>
                            <td className="right">{l.requested_qty}</td>
                            <td className="right">{open.status === 'cho_duyet' && central
                              ? <input type="number" min={0} style={{ width: 80 }} value={approve[l.id] ?? String(l.requested_qty)} onChange={(e) => setApprove({ ...approve, [l.id]: e.target.value })} />
                              : l.approved_qty ?? '—'}</td>
                            {l.central_on_hand !== undefined && <td className="right">{l.central_on_hand}</td>}
                            <td>{l.issues.map((i: any) => (
                              <div key={i.id} className="row" style={{ gap: 6 }}>
                                <span className="mono">{i.lot}</span> <span className="muted">HD {String(i.expiry).slice(0, 10)}</span> xuất {i.qty}
                                {open.status === 'da_xuat' && !central || (open.status === 'da_xuat' && role === 'admin')
                                  ? <label className="row" style={{ gap: 4 }}>nhận<input type="number" min={0} max={i.qty} style={{ width: 70 }} value={recv[i.id] ?? String(i.qty)} onChange={(e) => setRecv({ ...recv, [i.id]: e.target.value })} /></label>
                                  : i.receivedQty != null && <span>, nhận {i.receivedQty}</span>}
                              </div>
                            ))}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                      <div className="row" style={{ flexWrap: 'wrap' }}>
                        {open.status === 'cho_duyet' && central && <>
                          <input placeholder="Ghi chú (bắt buộc khi từ chối)" value={note} onChange={(e) => setNote(e.target.value)} />
                          <button onClick={() => run(() => api('POST', `/api/requisitions/${open.id}/decide`, { approve: true, note: note || null,
                            lines: Object.entries(approve).map(([k, v]) => ({ lineId: Number(k), approvedQty: Number(v) })) }), 'Đã duyệt phiếu lĩnh')}>Duyệt</button>
                          <button className="danger" disabled={!note.trim()} onClick={() => run(() => api('POST', `/api/requisitions/${open.id}/decide`, { approve: false, note }), 'Đã từ chối')}>Từ chối</button>
                        </>}
                        {open.status === 'da_duyet' && central && <>
                          <input placeholder="Người chứng kiến (thuốc kiểm soát)" value={witness} onChange={(e) => setWitness(e.target.value)} />
                          <button className="primary" onClick={() => run(() => api('POST', `/api/requisitions/${open.id}/issue`, { witness: witness || null }), 'Đã xuất kho tổng, chờ kho điểm nhận')}>Xuất kho tổng</button>
                        </>}
                        {open.status === 'da_xuat' && (!central || role === 'admin') && <>
                          <input placeholder="Lý do nếu nhận khác số xuất" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 240 }} />
                          <button className="primary" onClick={() => run(() => api('POST', `/api/requisitions/${open.id}/receive`, { note: note || null,
                            lines: Object.entries(recv).map(([k, v]) => ({ issueId: Number(k), receivedQty: Number(v) })) }), 'Đã xác nhận nhận hàng vào kho điểm')}>Xác nhận đã nhận</button>
                        </>}
                        {['cho_duyet', 'da_duyet'].includes(open.status) && (central || open.created_by === session.user?.id) &&
                          <button className="ghost" onClick={() => confirm(`Hủy phiếu ${open.code}?`) && run(() => api('POST', `/api/requisitions/${open.id}/cancel`), 'Đã hủy phiếu')}>Hủy phiếu</button>}
                      </div>
                    </div>
                  </td></tr>
                )}
              </Fragment>
            ))}
            {list.length === 0 && <tr><td colSpan={5} className="muted">Chưa có phiếu lĩnh.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Quản trị chọn kho tổng, bật tự phát bù định mức (đã khóa cấu hình thì thành đề xuất của trưởng nhóm kho) */
function InventorySettings({ settings, onSaved, onError }: { settings: any; onSaved: (s: any) => void; onError: (m: string) => void }) {
  const [f, setF] = useState({ centralStationId: settings.central_station_id ?? '', autoIssue: !!settings.auto_issue, autoIssueAt: settings.auto_issue_at ?? '06:00' });
  const [stations, setStations] = useState<any[]>([]);
  useEffect(() => { api<any[]>('GET', '/api/stations').then(setStations).catch(() => {}); }, []);
  return (
    <details style={{ marginTop: 6 }}>
      <summary>Cài đặt kho tổng</summary>
      <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
        <select value={f.centralStationId} onChange={(e) => setF({ ...f, centralStationId: e.target.value })}>
          <option value="">Tự chọn (kho trung tâm, không có thì trụ sở)</option>
          {stations.map((s) => <option key={s.id} value={s.id}>{s.id} – {s.name}</option>)}
        </select>
        <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={f.autoIssue} onChange={(e) => setF({ ...f, autoIssue: e.target.checked })} />Tự phát bù định mức hằng ngày lúc</label>
        <input type="time" value={f.autoIssueAt} onChange={(e) => setF({ ...f, autoIssueAt: e.target.value })} />
        <button onClick={async () => {
          try {
            await api('PUT', '/api/inventory/settings', { centralStationId: f.centralStationId || null, autoIssue: f.autoIssue, autoIssueAt: f.autoIssueAt });
            onSaved(await api('GET', '/api/inventory/settings'));
          } catch (e) { onError((e as Error).message); }
        }}>Lưu</button>
      </div>
    </details>
  );
}
