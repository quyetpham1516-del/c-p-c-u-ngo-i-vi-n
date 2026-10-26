import { Fragment, useEffect, useState } from 'react';
import { api, session } from '../api';
import { useStations } from '../catalog';

const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('vi-VN'));
const at = (s?: string | null) => (s ? new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—');

const PO_STATUS: Record<string, string> = {
  cho_duyet: 'Chờ duyệt', da_duyet: 'Đã duyệt, chờ hàng', dang_nhan: 'Đang nhận (thiếu)', da_nhan: 'Đã nhận đủ', tu_choi: 'Từ chối', huy: 'Đã hủy',
};
const O2_STATUS: Record<string, string> = { day: 'Đầy', dang_dung: 'Đang dùng', rong: 'Rỗng', gui_nap: 'Gửi nạp', hong: 'Hỏng' };
const O2_ACTION: Record<string, string> = {
  do_ap: 'Đo áp', gan_xe: 'Gắn lên xe', ve_kho: 'Về kho', gui_nap: 'Gửi nạp', nhan_nap: 'Nhận nạp', kiem_dinh: 'Kiểm định', hong: 'Báo hỏng', thanh_ly: 'Thanh lý',
};
const POINT_KIND: Record<string, string> = { kho: 'Kho thuốc', tu_thuoc: 'Tủ thuốc', tu_lanh: 'Tủ lạnh', xe: 'Khoang thuốc trên xe' };
const ASSET_CAT: Record<string, string> = { xe: 'Xe cứu thương', thiet_bi_y_te: 'Thiết bị y tế', cntt: 'Máy tính, mạng', nha_cua: 'Nhà cửa', noi_that: 'Nội thất', khac: 'Khác' };

type Tab = 'Tổng quan' | 'Mua hàng' | 'Sổ thuốc kiểm soát' | 'Bình oxy' | 'Nhiệt độ bảo quản' | 'Tài sản cố định' | 'Đồng phục, bảo hộ';
const TAB_ROLES: Record<Tab, string[]> = {
  'Tổng quan': ['crew', 'dispatcher', 'supervisor', 'qa', 'admin', 'pharmacist', 'director', 'accountant', 'technician', 'hr'],
  'Mua hàng': ['dispatcher', 'supervisor', 'qa', 'admin', 'pharmacist', 'director', 'accountant'],
  'Sổ thuốc kiểm soát': ['pharmacist', 'supervisor', 'qa', 'admin', 'director'],
  'Bình oxy': ['crew', 'technician', 'pharmacist', 'supervisor', 'admin', 'qa', 'dispatcher', 'director'],
  'Nhiệt độ bảo quản': ['crew', 'dispatcher', 'supervisor', 'qa', 'admin', 'pharmacist', 'director', 'accountant', 'ipc'],
  'Tài sản cố định': ['accountant', 'director', 'admin', 'technician'],
  'Đồng phục, bảo hộ': ['hr', 'admin', 'director'],
};

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
type Ctx = { stationId: string; stations: { id: string; name: string }[]; role: string; run: Run };
const has = (role: string, ...roles: string[]) => roles.includes(role);

/** Hậu cần: mua hàng, sổ thuốc kiểm soát đặc biệt, bình oxy, nhiệt độ bảo quản, tài sản cố định, đồng phục và bảo hộ */
export function Logistics() {
  const [stations] = useStations();
  const role = session.user?.role ?? '';
  const tabs = (Object.keys(TAB_ROLES) as Tab[]).filter((t) => TAB_ROLES[t].includes(role));
  const [tab, setTab] = useState<Tab>(tabs[0] ?? 'Tổng quan');
  const [stationId, setStationId] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { if (!stationId && stations.length) setStationId(stations[0].id); }, [stations, stationId]);
  const run: Run = async (fn, ok) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  const ctx = { stationId, stations, role, run };
  return (
    <div className="col">
      <div className="row no-print" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Hậu cần <span className="small muted">QL-13, QLCL-15, QLCL-16</span></h2>
        <label className="row small">Điểm
          <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
            {stations.map((s) => <option key={s.id} value={s.id}>{s.id} – {s.name}</option>)}
          </select>
        </label>
      </div>
      <div className="tabs no-print">{tabs.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setMsg(''); setError(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {stationId && tab === 'Tổng quan' && <Overview {...ctx} go={setTab} tabs={tabs} />}
      {stationId && tab === 'Mua hàng' && <Purchasing {...ctx} />}
      {stationId && tab === 'Sổ thuốc kiểm soát' && <Ledger {...ctx} />}
      {stationId && tab === 'Bình oxy' && <Oxygen {...ctx} />}
      {stationId && tab === 'Nhiệt độ bảo quản' && <Storage {...ctx} />}
      {tab === 'Tài sản cố định' && <Assets {...ctx} />}
      {tab === 'Đồng phục, bảo hộ' && <Ppe {...ctx} />}
    </div>
  );
}

/* ---------------- Tổng quan ---------------- */

function Overview({ stationId, go, tabs }: Ctx & { go: (t: Tab) => void; tabs: Tab[] }) {
  const [a, setA] = useState<any>(null);
  useEffect(() => { api('GET', `/api/logistics/alerts?stationId=${encodeURIComponent(stationId)}`).then(setA).catch(() => setA(null)); }, [stationId]);
  if (!a) return <div className="muted small">Đang tải…</div>;
  const items: { n: number; label: string; tab: Tab; red?: boolean }[] = [
    { n: a.purchase.pending, label: 'đơn đặt hàng chờ duyệt', tab: 'Mua hàng' },
    { n: a.purchase.late, label: 'đơn quá ngày giao chưa nhận đủ', tab: 'Mua hàng', red: true },
    { n: a.o2.low.length, label: `bình oxy trên xe dưới 50 bar`, tab: 'Bình oxy', red: true },
    { n: a.o2.vehiclesWithoutFull.length, label: 'xe chưa có bình oxy đầy', tab: 'Bình oxy' },
    { n: a.o2.testDue.length, label: 'bình sắp/quá hạn kiểm định', tab: 'Bình oxy' },
    { n: a.o2.atSupplierLong.length, label: 'bình gửi nạp quá 7 ngày', tab: 'Bình oxy' },
    { n: a.temp.outOfRange.length, label: 'lần đo nhiệt độ ngoài ngưỡng chưa xem xét', tab: 'Nhiệt độ bảo quản', red: true },
    { n: a.temp.noRecentReading.length, label: 'nơi bảo quản quá 12 giờ chưa ghi nhiệt độ', tab: 'Nhiệt độ bảo quản' },
    { n: a.ppeDueSoon, label: 'đồ đồng phục/bảo hộ đến hạn cấp lại trong 30 ngày (toàn đơn vị)', tab: 'Đồng phục, bảo hộ' },
  ];
  const shown = items.filter((i) => i.n > 0);
  return (
    <div className="panel col">
      {!shown.length && <div className="alert green">Không có việc hậu cần nào cần xử lý ở điểm {stationId}.</div>}
      {shown.map((i) => (
        <div key={i.label} className={`alert ${i.red ? 'red' : 'amber'} row`} style={{ justifyContent: 'space-between' }}>
          <span><b>{i.n}</b> {i.label}</span>
          {tabs.includes(i.tab) && <button onClick={() => go(i.tab)}>Mở</button>}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Mua hàng ---------------- */

function Purchasing({ stationId, role, run }: Ctx) {
  const canManage = has(role, 'pharmacist', 'supervisor', 'admin');
  const canApprove = has(role, 'supervisor', 'admin', 'director');
  const [orders, setOrders] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  const [drugs, setDrugs] = useState<{ id: number; name: string; unit: string }[]>([]);
  const [opts, setOpts] = useState<{ suppliers: any[]; proposals: any[] }>({ suppliers: [], proposals: [] });
  const [draft, setDraft] = useState<{ supplierId: string; expectedOn: string; proposalId: string; note: string; lines: { drugId: string; qty: string; unitPrice: string }[] } | null>(null);
  const [recv, setRecv] = useState<Record<number, { lot: string; expiry: string; qty: string }>>({});
  const [invoiceNo, setInvoiceNo] = useState('');
  const load = () => api<any[]>('GET', `/api/logistics/po?stationId=${encodeURIComponent(stationId)}`).then(setOrders);
  useEffect(() => { load().catch(() => {}); setOpen(null); }, [stationId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api('GET', '/api/drugs').then(setDrugs).catch(() => {});
    if (canManage) api('GET', '/api/logistics/po/options').then(setOpts).catch(() => {});
  }, [canManage]);
  const show = async (id: string) => { setOpen(await api('GET', `/api/logistics/po/${id}`)); setRecv({}); setInvoiceNo(''); };

  const fromSuggestion = () => run(async () => {
    const rows = await api<any[]>('GET', `/api/logistics/po/suggest?stationId=${encodeURIComponent(stationId)}`);
    if (!rows.length) throw new Error('Không có thuốc nào cần đặt theo lượng dùng 7 ngày và định mức tối thiểu');
    setDraft({
      supplierId: rows.find((r) => r.last_supplier_id)?.last_supplier_id ?? '', expectedOn: '', proposalId: '', note: 'Lập từ đề xuất đặt hàng tuần',
      lines: rows.map((r) => ({ drugId: String(r.drug_id), qty: String(r.order), unitPrice: r.last_price != null ? String(r.last_price) : '' })),
    });
  });
  const total = draft ? draft.lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.unitPrice || 0), 0) : 0;
  const submit = () => run(async () => {
    if (!draft) return;
    const lines = draft.lines.filter((l) => l.drugId && Number(l.qty) > 0).map((l) => ({ drugId: Number(l.drugId), qty: Number(l.qty), unitPrice: Number(l.unitPrice || 0) }));
    const po = await api<any>('POST', '/api/logistics/po', {
      stationId, supplierId: draft.supplierId, expectedOn: draft.expectedOn || null, proposalId: draft.proposalId || null, note: draft.note || null, lines,
    });
    setDraft(null); await load(); await show(po.id);
  }, 'Đã lập đơn đặt hàng, chờ người thứ hai duyệt.');
  const decide = (approve: boolean) => run(async () => {
    const note = approve ? null : prompt('Lý do từ chối');
    if (!approve && !note) return;
    await api('POST', `/api/logistics/po/${open.id}/decide`, { approve, note });
    await load(); await show(open.id);
  }, approve ? 'Đã duyệt đơn.' : 'Đã từ chối đơn.');
  const cancel = () => run(async () => {
    const note = prompt('Lý do hủy đơn');
    if (!note) return;
    await api('POST', `/api/logistics/po/${open.id}/cancel`, { note });
    await load(); await show(open.id);
  }, 'Đã hủy đơn.');
  const receive = () => run(async () => {
    const lines = Object.entries(recv).filter(([, v]) => Number(v.qty) > 0).map(([lineId, v]) => ({ lineId: Number(lineId), lot: v.lot, expiry: v.expiry, qty: Number(v.qty) }));
    if (!lines.length) throw new Error('Nhập số lô, hạn dùng, số lượng nhận cho ít nhất một dòng');
    await api('POST', `/api/logistics/po/${open.id}/receive`, { invoiceNo: invoiceNo || null, lines });
    await load(); await show(open.id);
  }, 'Đã nhập kho theo đơn. Các lô đã có trong Kho thuốc của điểm.');

  return (
    <>
      {canManage && !draft && (
        <div className="row">
          <button className="primary" onClick={fromSuggestion}>Lập đơn từ đề xuất đặt hàng tuần</button>
          <button onClick={() => setDraft({ supplierId: '', expectedOn: '', proposalId: '', note: '', lines: [{ drugId: '', qty: '', unitPrice: '' }] })}>Lập đơn trống</button>
          <span className="small muted">Nhà cung cấp lấy từ danh sách đã duyệt (Hệ thống CL → Nhà cung cấp).</span>
        </div>
      )}
      {draft && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Đơn đặt hàng mới cho điểm {stationId}</h3>
          <div className="grid4">
            <label className="field">Nhà cung cấp
              <select value={draft.supplierId} onChange={(e) => setDraft({ ...draft, supplierId: e.target.value })}>
                <option value="">— Chọn —</option>
                {opts.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'theo_doi' ? ' (đang theo dõi)' : ''}</option>)}
              </select>
            </label>
            <label className="field">Ngày giao dự kiến<input type="date" min={today()} value={draft.expectedOn} onChange={(e) => setDraft({ ...draft, expectedOn: e.target.value })} /></label>
            <label className="field">Đề xuất chi mua sắm (khi từ ngưỡng duyệt chi)
              <select value={draft.proposalId} onChange={(e) => setDraft({ ...draft, proposalId: e.target.value })}>
                <option value="">— Không —</option>
                {opts.proposals.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.title} · {fmt(p.amount)} đ</option>)}
              </select>
            </label>
            <label className="field">Ghi chú<input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label>
          </div>
          <table>
            <thead><tr><th>Thuốc, vật tư</th><th className="right">Số lượng</th><th className="right">Đơn giá (đ)</th><th className="right">Thành tiền</th><th /></tr></thead>
            <tbody>
              {draft.lines.map((l, i) => {
                const set = (p: Partial<typeof l>) => setDraft({ ...draft, lines: draft.lines.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                return (
                  <tr key={i}>
                    <td><select value={l.drugId} onChange={(e) => set({ drugId: e.target.value })}>
                      <option value="">— Chọn —</option>{drugs.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.unit})</option>)}</select></td>
                    <td className="right"><input inputMode="decimal" style={{ width: 90 }} value={l.qty} onChange={(e) => set({ qty: e.target.value })} /></td>
                    <td className="right"><input inputMode="numeric" style={{ width: 110 }} value={l.unitPrice} onChange={(e) => set({ unitPrice: e.target.value })} /></td>
                    <td className="right mono">{fmt(Number(l.qty || 0) * Number(l.unitPrice || 0))}</td>
                    <td><button className="ghost" onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}>Bỏ</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row">
            <button onClick={() => setDraft({ ...draft, lines: [...draft.lines, { drugId: '', qty: '', unitPrice: '' }] })}>Thêm dòng</button>
            <b>Tổng: {fmt(total)} đ</b>
            <button className="primary" disabled={!draft.supplierId} onClick={submit}>Gửi duyệt</button>
            <button className="ghost" onClick={() => setDraft(null)}>Thôi</button>
          </div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Mã đơn</th><th>Nhà cung cấp</th><th className="right">Tổng (đ)</th><th>Trạng thái</th><th>Người lập</th><th>Ngày giao</th></tr></thead>
          <tbody>{orders.map((o) => (
            <tr key={o.id} onClick={() => show(o.id)} style={{ cursor: 'pointer', background: open?.id === o.id ? 'var(--panel-2)' : undefined }}>
              <td className="mono">{o.code}</td><td>{o.supplier_name}</td><td className="right mono">{fmt(o.total)}</td>
              <td><span className="badge">{PO_STATUS[o.status]}</span></td><td className="small">{o.created_by_name} · {at(o.created_at)}</td>
              <td className={o.expected_on && o.expected_on < today() && ['da_duyet', 'dang_nhan'].includes(o.status) ? 'red mono' : 'mono'}>{o.expected_on ?? '—'}</td>
            </tr>))}</tbody>
        </table>
        {!orders.length && <div className="muted small">Chưa có đơn đặt hàng nào.</div>}
      </div>
      {open && (
        <div className="panel col">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>{open.code} · {open.supplier_name} · {PO_STATUS[open.status]}</h3>
            <div className="row">
              {canApprove && open.status === 'cho_duyet' && open.created_by !== session.user?.id && <>
                <button className="primary" onClick={() => decide(true)}>Duyệt</button><button className="danger" onClick={() => decide(false)}>Từ chối</button></>}
              {['cho_duyet', 'da_duyet'].includes(open.status) && (canApprove || open.created_by === session.user?.id) && <button className="ghost" onClick={cancel}>Hủy đơn</button>}
            </div>
          </div>
          <div className="small muted">Lập: {open.created_by_name} · {at(open.created_at)}{open.decided_by_name && ` · Quyết định: ${open.decided_by_name} ${at(open.decided_at)}`}{open.decision_note && ` · ${open.decision_note}`}</div>
          <table>
            <thead><tr><th>Thuốc</th><th className="right">Đặt</th><th className="right">Đã nhận</th><th className="right">Đơn giá</th>
              {canManage && ['da_duyet', 'dang_nhan'].includes(open.status) && <><th>Số lô</th><th>Hạn dùng</th><th className="right">Nhận lần này</th></>}</tr></thead>
            <tbody>{open.lines.map((l: any) => {
              const v = recv[l.id] ?? { lot: '', expiry: '', qty: '' };
              const set = (p: Partial<typeof v>) => setRecv({ ...recv, [l.id]: { ...v, ...p } });
              const left = l.qty - l.received_qty;
              return (
                <tr key={l.id}>
                  <td>{l.drug_name}</td><td className="right mono">{fmt(l.qty)} {l.unit}</td>
                  <td className={`right mono ${left > 0 ? '' : 'green'}`}>{fmt(l.received_qty)}</td><td className="right mono">{fmt(l.unit_price)}</td>
                  {canManage && ['da_duyet', 'dang_nhan'].includes(open.status) && (left > 0 ? <>
                    <td><input style={{ width: 110 }} value={v.lot} onChange={(e) => set({ lot: e.target.value })} /></td>
                    <td><input type="date" min={today()} value={v.expiry} onChange={(e) => set({ expiry: e.target.value })} /></td>
                    <td className="right"><input inputMode="decimal" style={{ width: 80 }} placeholder={`≤ ${left}`} value={v.qty} onChange={(e) => set({ qty: e.target.value })} /></td>
                  </> : <td colSpan={3} className="small muted">Đã nhận đủ</td>)}
                </tr>
              );
            })}</tbody>
          </table>
          {canManage && ['da_duyet', 'dang_nhan'].includes(open.status) && (
            <div className="row">
              <label className="row small">Số hóa đơn<input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} /></label>
              <button className="primary" onClick={receive}>Nhập kho</button>
              <span className="small muted">Mỗi dòng nhận thành một lô trong kho điểm {open.station_id}. Giao nhiều lô cùng thuốc thì nhập từng lần.</span>
            </div>
          )}
          {open.receipts.length > 0 && <div className="col">
            <b>Phiếu nhập kho</b>
            {open.receipts.map((r: any) => (
              <div key={r.id} className="small">{r.code} · {at(r.received_at)} · {r.received_by_name}{r.invoice_no && ` · HĐ ${r.invoice_no}`}: {' '}
                {(r.items ?? []).map((i: any) => `${i.drug} lô ${i.lot} (HD ${i.expiry}) × ${fmt(i.qty)}`).join('; ')}</div>
            ))}
          </div>}
        </div>
      )}
    </>
  );
}

/* ---------------- Sổ thuốc kiểm soát đặc biệt ---------------- */

function Ledger({ stationId, stations, run }: Ctx) {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    run(async () => setData(await api('GET', `/api/logistics/controlled-ledger?stationId=${encodeURIComponent(stationId)}&month=${month}`)));
  }, [stationId, month]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = stations.find((s) => s.id === stationId)?.name ?? stationId;
  return (
    <div className="panel col print-page">
      <div className="row no-print">
        <label className="row small">Tháng<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
        <button onClick={() => window.print()}>In sổ</button>
        <span className="small muted">Gồm kho điểm và cơ số trên các xe của điểm; cấp xe, xe trả kho là chuyển nội bộ nên không ghi. Mẫu tham khảo TT 20/2017/TT-BYT, dược sĩ phụ trách đối chiếu trước khi dùng chính thức.</span>
      </div>
      <h3 style={{ margin: 0, textAlign: 'center' }}>SỔ THEO DÕI XUẤT, NHẬP, TỒN THUỐC GÂY NGHIỆN, HƯỚNG THẦN</h3>
      <div style={{ textAlign: 'center' }}>{name} · Tháng {month.slice(5)}/{month.slice(0, 4)}</div>
      {data && !data.drugs.length && <div className="muted small">Không có thuốc kiểm soát nào tồn hoặc biến động trong tháng.</div>}
      {data?.drugs.map((d: any) => (
        <Fragment key={d.drugId}>
          <h4 style={{ margin: '12px 0 4px' }}>{d.drug} ({d.unit}) · <span className="badge far">{d.classLabel}</span>
            <span className="small muted"> Tồn đầu {fmt(d.opening)} · Nhập {fmt(d.totalIn)} · Xuất {fmt(d.totalOut)} · Tồn cuối {fmt(d.closing)}</span></h4>
          <table>
            <thead><tr><th>Ngày giờ</th><th>Nội dung</th><th>Chứng từ</th><th>Số lô / HD</th><th>Nơi</th><th className="right">Nhập</th><th className="right">Xuất</th><th className="right">Tồn</th><th>Người thực hiện</th><th>Chứng kiến</th></tr></thead>
            <tbody>
              <tr><td colSpan={7}><i>Tồn đầu kỳ</i></td><td className="right mono">{fmt(d.opening)}</td><td colSpan={2} /></tr>
              {d.rows.map((r: any, i: number) => (
                <tr key={i}>
                  <td className="mono small">{at(r.at)}</td><td>{r.kind}{r.note && <span className="small muted"> · {r.note}</span>}</td>
                  <td className="mono small">{r.document ?? '—'}{r.invoice && ` · HĐ ${r.invoice}`}</td><td className="mono small">{r.lot} · {r.expiry}</td><td className="small">{r.place}</td>
                  <td className="right mono">{r.in ? fmt(r.in) : ''}</td><td className="right mono">{r.out ? fmt(r.out) : ''}</td><td className="right mono">{fmt(r.balance)}</td>
                  <td className="small">{r.user ?? '—'}</td><td className="small">{r.witness ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Fragment>
      ))}
      {data && data.drugs.length > 0 && <div className="row" style={{ justifyContent: 'space-around', marginTop: 24 }}>
        <div style={{ textAlign: 'center' }}><b>Người lập sổ</b><br /><span className="small muted">(ký, ghi rõ họ tên)</span></div>
        <div style={{ textAlign: 'center' }}><b>Dược sĩ phụ trách</b><br /><span className="small muted">(ký, ghi rõ họ tên)</span></div>
        <div style={{ textAlign: 'center' }}><b>Thủ trưởng đơn vị</b><br /><span className="small muted">(ký, đóng dấu)</span></div>
      </div>}
    </div>
  );
}

/* ---------------- Bình oxy ---------------- */

function Oxygen({ stationId, role, run }: Ctx) {
  const tech = has(role, 'technician', 'pharmacist', 'supervisor', 'admin');
  const canWork = tech || role === 'crew';
  const [data, setData] = useState<any>(null);
  const [vehicles, setVehicles] = useState<{ id: string; station_id: string }[]>([]);
  const [form, setForm] = useState({ code: '', sizeL: '10', fullBar: '150', nextTestOn: '' });
  const [act, setAct] = useState<{ id: string; kind: string; pressureBar: string; vehicleId: string; nextTestOn: string; note: string } | null>(null);
  const load = () => api('GET', `/api/logistics/o2?stationId=${encodeURIComponent(stationId)}`).then(setData);
  useEffect(() => { load().catch(() => {}); }, [stationId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api<any[]>('GET', '/api/equipment/readiness').then(setVehicles).catch(() => {}); }, []);
  const add = () => run(async () => {
    await api('POST', '/api/logistics/o2', { code: form.code, sizeL: Number(form.sizeL), fullBar: Number(form.fullBar), stationId, nextTestOn: form.nextTestOn || null });
    setForm({ ...form, code: '' }); await load();
  }, `Đã nhập bình ${form.code}.`);
  const doAct = () => run(async () => {
    if (!act) return;
    await api('POST', `/api/logistics/o2/${act.id}/event`, {
      kind: act.kind, pressureBar: act.pressureBar === '' ? null : Number(act.pressureBar), vehicleId: act.vehicleId || null, nextTestOn: act.nextTestOn || null, note: act.note || null,
    });
    setAct(null); await load();
  }, 'Đã ghi.');
  const kinds = role === 'crew' ? ['do_ap', 'gan_xe', 've_kho', 'hong'] : Object.keys(O2_ACTION);
  if (!data) return <div className="muted small">Đang tải…</div>;
  const al = data.alerts;
  return (
    <>
      {(al.low.length > 0 || al.vehiclesWithoutFull.length > 0 || al.testDue.length > 0 || al.atSupplierLong.length > 0) && (
        <div className="col">
          {al.low.length > 0 && <div className="alert red">Sắp cạn (dưới 50 bar) trên xe: {al.low.map((c: any) => `${c.code} (${c.vehicle_id}, ${c.pressure_bar} bar)`).join(', ')}</div>}
          {al.vehiclesWithoutFull.length > 0 && <div className="alert amber">Xe chưa có bình đầy: {al.vehiclesWithoutFull.join(', ')}</div>}
          {al.testDue.length > 0 && <div className="alert amber">Sắp/quá hạn kiểm định: {al.testDue.map((c: any) => `${c.code} (${c.next_test_on})`).join(', ')}</div>}
          {al.atSupplierLong.length > 0 && <div className="alert amber">Gửi nạp quá 7 ngày: {al.atSupplierLong.map((c: any) => c.code).join(', ')}</div>}
        </div>
      )}
      {tech && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Nhập bình mới vào điểm {stationId}</h3>
          <div className="grid4">
            <label className="field">Số bình<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
            <label className="field">Dung tích (lít nước)<input inputMode="decimal" value={form.sizeL} onChange={(e) => setForm({ ...form, sizeL: e.target.value })} /></label>
            <label className="field">Áp suất khi đầy (bar)<input inputMode="numeric" value={form.fullBar} onChange={(e) => setForm({ ...form, fullBar: e.target.value })} /></label>
            <label className="field">Hạn kiểm định<input type="date" value={form.nextTestOn} onChange={(e) => setForm({ ...form, nextTestOn: e.target.value })} /></label>
          </div>
          <div className="row"><button className="primary" disabled={!form.code.trim()} onClick={add}>Nhập bình</button>
            <span className="small muted">Oxy còn lại ≈ dung tích × áp suất; số phút tính ở 15 lít/phút (mask có túi).</span></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Bình</th><th>Ở đâu</th><th>Trạng thái</th><th className="right">Áp suất</th><th className="right">Còn lại</th><th>Nạp gần nhất</th><th>Hạn kiểm định</th>{canWork && <th />}</tr></thead>
          <tbody>{data.cylinders.map((c: any) => (
            <tr key={c.id}>
              <td className="mono">{c.code} <span className="small muted">{c.size_l} L</span></td>
              <td>{c.vehicle_id ?? (c.status === 'gui_nap' ? (c.supplier_name ?? 'Đơn vị nạp') : 'Kho điểm')}</td>
              <td><span className="badge">{O2_STATUS[c.status] ?? c.status}</span></td>
              <td className={`right mono ${c.pressure_bar != null && c.pressure_bar < 50 ? 'red' : ''}`}>{c.pressure_bar ?? '—'} / {c.full_bar} bar</td>
              <td className="right mono">{c.liters != null ? `${fmt(c.liters)} L · ${c.minutes} phút` : '—'}</td>
              <td className="mono">{c.last_filled_on ?? '—'}</td>
              <td className={`mono ${c.next_test_on && c.next_test_on < today() ? 'red' : ''}`}>{c.next_test_on ?? '—'}</td>
              {canWork && <td><button onClick={() => setAct({ id: c.id, kind: 'do_ap', pressureBar: '', vehicleId: '', nextTestOn: '', note: '' })}>Ghi việc</button></td>}
            </tr>))}</tbody>
        </table>
        {!data.cylinders.length && <div className="muted small">Chưa có bình nào ở điểm này.</div>}
      </div>
      {act && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Bình {data.cylinders.find((c: any) => c.id === act.id)?.code}</h3>
          <div className="grid4">
            <label className="field">Việc
              <select value={act.kind} onChange={(e) => setAct({ ...act, kind: e.target.value })}>{kinds.map((k) => <option key={k} value={k}>{O2_ACTION[k]}</option>)}</select>
            </label>
            {['do_ap', 'gan_xe', 've_kho', 'nhan_nap'].includes(act.kind) && <label className="field">Áp suất (bar)<input inputMode="numeric" value={act.pressureBar} onChange={(e) => setAct({ ...act, pressureBar: e.target.value })} /></label>}
            {act.kind === 'gan_xe' && <label className="field">Xe
              <select value={act.vehicleId} onChange={(e) => setAct({ ...act, vehicleId: e.target.value })}><option value="">— Chọn —</option>
                {vehicles.filter((v) => v.station_id === stationId).map((v) => <option key={v.id} value={v.id}>{v.id}</option>)}</select></label>}
            {act.kind === 'kiem_dinh' && <label className="field">Hạn kiểm định tiếp theo<input type="date" value={act.nextTestOn} onChange={(e) => setAct({ ...act, nextTestOn: e.target.value })} /></label>}
            <label className="field">Ghi chú{['hong', 'thanh_ly'].includes(act.kind) ? ' (bắt buộc)' : ''}<input value={act.note} onChange={(e) => setAct({ ...act, note: e.target.value })} /></label>
          </div>
          <div className="row"><button className="primary" onClick={doAct}>Ghi</button><button className="ghost" onClick={() => setAct(null)}>Thôi</button></div>
        </div>
      )}
    </>
  );
}

/* ---------------- Nhiệt độ bảo quản ---------------- */

function Storage({ stationId, role, run }: Ctx) {
  const canManage = has(role, 'pharmacist', 'supervisor', 'admin');
  const canRecord = canManage || role === 'crew';
  const [data, setData] = useState<any>(null);
  const [vals, setVals] = useState<Record<string, { t: string; h: string; action: string }>>({});
  const [form, setForm] = useState({ name: '', kind: 'tu_thuoc', minC: '', maxC: '' });
  const [hist, setHist] = useState<{ id: string; name: string; rows: any[] } | null>(null);
  const load = () => api('GET', `/api/logistics/storage?stationId=${encodeURIComponent(stationId)}`).then(setData);
  useEffect(() => { load().catch(() => {}); setHist(null); }, [stationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const record = (p: any) => run(async () => {
    const v = vals[p.id] ?? { t: '', h: '', action: '' };
    await api('POST', `/api/logistics/storage/${p.id}/readings`, { tempC: Number(v.t), humidity: v.h === '' ? null : Number(v.h), action: v.action || null });
    setVals({ ...vals, [p.id]: { t: '', h: '', action: '' } }); await load();
  }, `Đã ghi nhiệt độ ${p.name}.`);
  const addPoint = () => run(async () => {
    await api('POST', '/api/logistics/storage', { name: form.name, kind: form.kind, stationId, minC: form.minC === '' ? null : Number(form.minC), maxC: form.maxC === '' ? null : Number(form.maxC) });
    setForm({ ...form, name: '', minC: '', maxC: '' }); await load();
  }, 'Đã thêm nơi bảo quản.');
  const ack = (r: any) => run(async () => {
    const note = prompt('Kết quả xem xét (thuốc còn dùng được, đã chuyển, đã hủy...)');
    if (!note) return;
    await api('POST', `/api/logistics/readings/${r.id}/ack`, { note }); await load();
  }, 'Đã ghi kết quả xem xét.');
  const showHist = async (p: any) => setHist({ id: p.id, name: p.name, rows: await api('GET', `/api/logistics/storage/${p.id}/readings?days=31`) });
  if (!data) return <div className="muted small">Đang tải…</div>;
  const d = data.defaults[form.kind];
  return (
    <>
      {data.alerts.outOfRange.length > 0 && (
        <div className="panel red col">
          <b>Ngoài ngưỡng, chờ dược sĩ/trưởng ca xem xét</b>
          {data.alerts.outOfRange.map((r: any) => (
            <div key={r.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{r.name}: <b>{r.temp_c} °C</b>{r.humidity != null && `, ${r.humidity}%`} (ngưỡng {r.min_c}–{r.max_c}) · {at(r.at)} · {r.user_name} · Xử trí: {r.action}</span>
              {canManage && <button onClick={() => ack(r)}>Xem xét</button>}
            </div>
          ))}
        </div>
      )}
      {data.alerts.noRecentReading.length > 0 && <div className="alert amber">Quá 12 giờ chưa ghi: {data.alerts.noRecentReading.map((p: any) => p.name).join(', ')}</div>}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Nơi bảo quản</th><th>Ngưỡng</th><th>Lần đo gần nhất</th>{canRecord && <><th>Nhiệt độ °C</th><th>Độ ẩm %</th><th>Xử trí nếu ngoài ngưỡng</th><th /></>}<th /></tr></thead>
          <tbody>{data.points.map((p: any) => {
            const v = vals[p.id] ?? { t: '', h: '', action: '' };
            const set = (x: Partial<typeof v>) => setVals({ ...vals, [p.id]: { ...v, ...x } });
            return (
              <tr key={p.id}>
                <td>{p.name}<div className="small muted">{POINT_KIND[p.kind]}{p.vehicle_id && ` · ${p.vehicle_id}`}</div></td>
                <td className="mono small">{p.min_c}–{p.max_c} °C{p.max_humidity != null && ` · ≤ ${p.max_humidity}%`}</td>
                <td className={`small ${p.last_out ? 'red' : ''}`}>{p.last_at ? `${p.last_temp} °C${p.last_humidity != null ? `, ${p.last_humidity}%` : ''} · ${at(p.last_at)}` : 'Chưa đo'}</td>
                {canRecord && <>
                  <td><input inputMode="decimal" style={{ width: 70 }} value={v.t} onChange={(e) => set({ t: e.target.value })} /></td>
                  <td><input inputMode="decimal" style={{ width: 70 }} value={v.h} onChange={(e) => set({ h: e.target.value })} /></td>
                  <td><input value={v.action} onChange={(e) => set({ action: e.target.value })} /></td>
                  <td><button className="primary" disabled={v.t === '' || Number.isNaN(Number(v.t))} onClick={() => record(p)}>Ghi</button></td>
                </>}
                <td><button className="ghost" onClick={() => showHist(p)}>31 ngày</button></td>
              </tr>
            );
          })}</tbody>
        </table>
        {!data.points.length && <div className="muted small">Chưa khai báo nơi bảo quản nào ở điểm này.</div>}
      </div>
      {hist && (
        <div className="panel col">
          <div className="row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>{hist.name}: 31 ngày</h3><button className="ghost" onClick={() => setHist(null)}>Đóng</button></div>
          <table>
            <thead><tr><th>Lúc</th><th className="right">°C</th><th className="right">%</th><th>Người ghi</th><th>Xử trí</th><th>Xem xét</th></tr></thead>
            <tbody>{hist.rows.map((r) => (
              <tr key={r.id}><td className="mono small">{at(r.at)}</td><td className={`right mono ${r.out_of_range ? 'red' : ''}`}>{r.temp_c}</td><td className="right mono">{r.humidity ?? ''}</td>
                <td className="small">{r.user_name}</td><td className="small">{r.action ?? ''}</td><td className="small">{r.ack_at ? `${r.ack_by_name}: ${r.ack_note}` : ''}</td></tr>))}</tbody>
          </table>
        </div>
      )}
      {canManage && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Thêm nơi bảo quản</h3>
          <div className="grid4">
            <label className="field">Tên<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Tủ thuốc trực, tủ lạnh insulin…" /></label>
            <label className="field">Loại<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{Object.entries(POINT_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Thấp nhất °C<input inputMode="decimal" placeholder={String(d.min)} value={form.minC} onChange={(e) => setForm({ ...form, minC: e.target.value })} /></label>
            <label className="field">Cao nhất °C<input inputMode="decimal" placeholder={String(d.max)} value={form.maxC} onChange={(e) => setForm({ ...form, maxC: e.target.value })} /></label>
          </div>
          <div className="row"><button className="primary" disabled={form.name.trim().length < 2} onClick={addPoint}>Thêm</button>
            <span className="small muted">Mặc định: kho, tủ thường 15–30 °C, độ ẩm ≤ 75%; tủ lạnh 2–8 °C. Ghi ít nhất sáng và chiều.</span></div>
        </div>
      )}
    </>
  );
}

/* ---------------- Tài sản cố định ---------------- */

function Assets({ role, stations, run }: Ctx) {
  const canManage = has(role, 'accountant', 'admin');
  const [asOf, setAsOf] = useState(today());
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState({ name: '', category: 'thiet_bi_y_te', stationId: '', acquiredOn: '', cost: '', lifeMonths: '60', salvage: '' });
  const load = () => api('GET', `/api/logistics/assets?asOf=${asOf}`).then(setData);
  useEffect(() => { load().catch(() => {}); }, [asOf]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = () => run(async () => {
    await api('POST', '/api/logistics/assets', {
      name: form.name, category: form.category, stationId: form.stationId || null, acquiredOn: form.acquiredOn, cost: Number(form.cost),
      lifeMonths: Number(form.lifeMonths), salvage: form.salvage ? Number(form.salvage) : null,
    });
    setForm({ ...form, name: '', cost: '', salvage: '' }); await load();
  }, 'Đã ghi tăng tài sản.');
  const dispose = (a: any) => run(async () => {
    const note = prompt(`Lý do thanh lý ${a.name}`);
    if (!note) return;
    await api('POST', `/api/logistics/assets/${a.id}/dispose`, { disposedOn: today(), note }); await load();
  }, 'Đã ghi giảm (thanh lý).');
  return (
    <>
      {canManage && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Ghi tăng tài sản cố định</h3>
          <div className="grid4">
            <label className="field">Tên tài sản<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field">Nhóm<select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{Object.entries(ASSET_CAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Điểm<select value={form.stationId} onChange={(e) => setForm({ ...form, stationId: e.target.value })}><option value="">— Toàn đơn vị —</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
            <label className="field">Ngày ghi tăng<input type="date" max={today()} value={form.acquiredOn} onChange={(e) => setForm({ ...form, acquiredOn: e.target.value })} /></label>
            <label className="field">Nguyên giá (đ)<input inputMode="numeric" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></label>
            <label className="field">Thời gian khấu hao (tháng)<input inputMode="numeric" value={form.lifeMonths} onChange={(e) => setForm({ ...form, lifeMonths: e.target.value })} /></label>
            <label className="field">Giá trị thu hồi (đ)<input inputMode="numeric" value={form.salvage} onChange={(e) => setForm({ ...form, salvage: e.target.value })} placeholder="0" /></label>
          </div>
          <div className="row"><button className="primary" disabled={!form.name || !form.acquiredOn || !(Number(form.cost) > 0)} onClick={add}>Ghi tăng</button>
            <span className="small muted">Khấu hao đường thẳng theo tháng. Khung thời gian theo quy định hiện hành về khấu hao tài sản cố định: kế toán đối chiếu (bản nháp).</span></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <div className="row" style={{ marginBottom: 8 }}><label className="row small">Tính đến ngày<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
          {data && <span className="small">Đang dùng: nguyên giá <b>{fmt(data.totals.cost)}</b> · hao mòn lũy kế <b>{fmt(data.totals.accumulated)}</b> · còn lại <b>{fmt(data.totals.netBook)}</b> · khấu hao mỗi tháng <b>{fmt(data.totals.monthly)}</b> đ</span>}</div>
        <table>
          <thead><tr><th>Mã</th><th>Tài sản</th><th>Nhóm</th><th>Ghi tăng</th><th className="right">Nguyên giá</th><th className="right">Tháng đã dùng</th><th className="right">KH/tháng</th><th className="right">Lũy kế</th><th className="right">Còn lại</th><th /></tr></thead>
          <tbody>{data?.items.map((a: any) => (
            <tr key={a.id} className={a.status === 'thanh_ly' ? 'muted' : ''}>
              <td className="mono">{a.code}</td><td>{a.name}{a.station_id && <span className="small muted"> · {a.station_id}</span>}{a.status === 'thanh_ly' && <span className="badge" style={{ marginLeft: 6 }}>Thanh lý {a.disposed_on}</span>}</td>
              <td className="small">{ASSET_CAT[a.category]}</td><td className="mono">{a.acquired_on}</td><td className="right mono">{fmt(a.cost)}</td>
              <td className="right mono">{a.monthsUsed}/{a.life_months}</td><td className="right mono">{fmt(a.monthly)}</td><td className="right mono">{fmt(a.accumulated)}</td><td className="right mono">{fmt(a.netBook)}</td>
              <td>{canManage && a.status === 'dang_dung' && <button className="ghost" onClick={() => dispose(a)}>Thanh lý</button>}</td>
            </tr>))}</tbody>
        </table>
        {data && !data.items.length && <div className="muted small">Chưa ghi tăng tài sản nào.</div>}
      </div>
    </>
  );
}

/* ---------------- Đồng phục, bảo hộ ---------------- */

function Ppe({ role, run }: Ctx) {
  const canManage = has(role, 'hr', 'admin');
  const [items, setItems] = useState<any[]>([]);
  const [people, setPeople] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [dueOnly, setDueOnly] = useState(false);
  const [form, setForm] = useState({ userId: '', itemId: '', qty: '1', size: '', issuedOn: today() });
  const load = () => api<any[]>('GET', `/api/logistics/ppe${dueOnly ? '?due=true' : ''}`).then(setRows);
  useEffect(() => { load().catch(() => {}); }, [dueOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api<any[]>('GET', '/api/logistics/ppe/items').then(setItems).catch(() => {});
    if (canManage) api<any[]>('GET', '/api/logistics/ppe/people').then(setPeople).catch(() => {});
  }, [canManage]);
  const issue = () => run(async () => {
    await api('POST', '/api/logistics/ppe', { userId: form.userId, itemId: Number(form.itemId), qty: Number(form.qty), size: form.size || null, issuedOn: form.issuedOn });
    setForm({ ...form, size: '' }); await load();
  }, 'Đã ghi cấp phát. Nhân viên xác nhận đã nhận ở trang Cá nhân → Đồ được cấp.');
  const ret = (r: any) => run(async () => { await api('POST', `/api/logistics/ppe/${r.id}/return`, { returnedOn: today() }); await load(); }, 'Đã ghi trả lại.');
  return (
    <>
      {canManage && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Cấp đồng phục, bảo hộ lao động</h3>
          <div className="grid4">
            <label className="field">Nhân viên<select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}><option value="">— Chọn —</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.title ? ` · ${p.title}` : ''}</option>)}</select></label>
            <label className="field">Loại<select value={form.itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value })}><option value="">— Chọn —</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.name}{i.replace_months ? ` (cấp lại sau ${i.replace_months} tháng)` : ''}</option>)}</select></label>
            <label className="field">Số lượng<input inputMode="numeric" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></label>
            <label className="field">Cỡ<input value={form.size} onChange={(e) => setForm({ ...form, size: e.target.value })} placeholder="S, M, L, 42…" /></label>
            <label className="field">Ngày cấp<input type="date" max={today()} value={form.issuedOn} onChange={(e) => setForm({ ...form, issuedOn: e.target.value })} /></label>
          </div>
          <div className="row"><button className="primary" disabled={!form.userId || !form.itemId} onClick={issue}>Ghi cấp phát</button></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <label className="row small" style={{ marginBottom: 8 }}><input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} /> Chỉ hiện đồ đến hạn cấp lại trong 30 ngày</label>
        <table>
          <thead><tr><th>Nhân viên</th><th>Đồ</th><th className="right">SL</th><th>Cỡ</th><th>Ngày cấp</th><th>Hạn cấp lại</th><th>Nhân viên xác nhận</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td>{r.user_name}</td><td>{r.item_name}</td><td className="right mono">{r.qty}</td><td>{r.size ?? ''}</td><td className="mono">{r.issued_on}</td>
              <td className={`mono ${r.due_soon ? 'red' : ''}`}>{r.returned_on ? `Đã trả ${r.returned_on}` : (r.due_on ?? 'Khi hỏng')}</td>
              <td className="small">{r.received_at ? at(r.received_at) : <span className="muted">Chưa</span>}</td>
              <td>{canManage && !r.returned_on && <button className="ghost" onClick={() => ret(r)}>Ghi trả</button>}</td>
            </tr>))}</tbody>
        </table>
        {!rows.length && <div className="muted small">Chưa có lần cấp nào.</div>}
      </div>
    </>
  );
}

/** Đồ đồng phục, bảo hộ được cấp cho chính mình (trang Cá nhân) */
export function MyPpe() {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => api<any[]>('GET', '/api/logistics/ppe/me').then(setRows).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!rows.length) return null;
  return (
    <div className="panel col">
      <h3 style={{ margin: 0 }}>Đồ được cấp</h3>
      <table>
        <thead><tr><th>Đồ</th><th className="right">SL</th><th>Cỡ</th><th>Ngày cấp</th><th>Hạn cấp lại</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td>{r.item_name}</td><td className="right mono">{r.qty}</td><td>{r.size ?? ''}</td><td className="mono">{r.issued_on}</td>
            <td className={`mono ${r.due_soon ? 'red' : ''}`}>{r.returned_on ? `Đã trả ${r.returned_on}` : (r.due_on ?? 'Khi hỏng')}</td>
            <td>{r.received_at ? <span className="small muted">Đã xác nhận</span>
              : <button onClick={async () => { await api('POST', `/api/logistics/ppe/${r.id}/confirm`); await load(); }}>Xác nhận đã nhận</button>}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}
