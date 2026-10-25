import { useEffect, useState } from 'react';
import { api, download, money, session } from '../api';
import { Stat } from './Hr';

interface Meta {
  payer: Record<string, string>; chargeStatus: Record<string, string>; payMethod: Record<string, string>;
  proposalKind: Record<string, string>; expenseCategory: Record<string, string>;
  settings: { approvalThreshold: number; accounts: Record<string, string>; company: { name: string; taxCode: string; address: string } };
}
const PSTATUS: Record<string, string> = { cho_duyet_1: 'Chờ kế toán duyệt', cho_duyet_2: 'Chờ Ban Giám đốc duyệt', da_duyet: 'Đã duyệt', tu_choi: 'Từ chối', da_chi: 'Đã chi', huy: 'Hủy' };
const ISTATUS: Record<string, string> = { nhap: 'Nháp, chờ ghi số', da_phat_hanh: 'Đã phát hành', huy: 'Hủy' };
const WAIVER: Record<string, string> = { mien: 'Miễn', giam: 'Giảm', that_thu: 'Thất thu' };
const CU_KIND: Record<string, string> = { benh_vien: 'Bệnh viện', bao_hiem: 'Bảo hiểm', doanh_nghiep: 'Doanh nghiệp', su_kien: 'Sự kiện', ca_nhan: 'Cá nhân', khac: 'Khác' };
const TABS = ['Tổng quan', 'Khoản thu', 'Chờ duyệt', 'Hóa đơn', 'Đề xuất chi', 'Phiếu chi', 'Công nợ', 'Bảng giá, khách hàng', 'BHYT', 'Kế toán'] as const;
const vnDate = (d = 0) => new Date(Date.now() + 7 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);

/** Tài chính: khoản thu từ phiếu chuyển viện, thu tiền, miễn giảm có duyệt, hóa đơn, đề xuất chi 2 cấp, phiếu chi, công nợ, bút toán */
export function Finance() {
  const role = session.user?.role ?? '';
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Tổng quan');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const loadMeta = () => api<Meta>('GET', '/api/finance/meta').then(setMeta).catch((e) => setError(e.message));
  useEffect(() => { loadMeta(); }, []);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  if (!meta) return <div className="panel">{error || 'Đang tải…'}</div>;
  const ctx = { meta, role, run, isAcc: role === 'accountant', isDir: role === 'director', reloadMeta: loadMeta, go: setTab };
  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Tài chính, kế toán</h2>
      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); setMsg(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {tab === 'Tổng quan' && <Overview {...ctx} />}
      {tab === 'Khoản thu' && <Charges {...ctx} />}
      {tab === 'Chờ duyệt' && <Approvals {...ctx} />}
      {tab === 'Hóa đơn' && <Invoices {...ctx} />}
      {tab === 'Đề xuất chi' && <Proposals {...ctx} />}
      {tab === 'Phiếu chi' && <Expenses {...ctx} />}
      {tab === 'Công nợ' && <Receivables {...ctx} />}
      {tab === 'Bảng giá, khách hàng' && <PricesCustomers {...ctx} />}
      {tab === 'BHYT' && <Bhyt {...ctx} />}
      {tab === 'Kế toán' && <Accounting {...ctx} />}
    </div>
  );
}

type Ctx = {
  meta: Meta; role: string; isAcc: boolean; isDir: boolean; run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
  reloadMeta: () => void; go: (t: (typeof TABS)[number]) => void;
};

function Overview({ go }: Ctx) {
  const [month, setMonth] = useState(vnDate().slice(0, 7));
  const [s, setS] = useState<any>(null);
  useEffect(() => { api('GET', `/api/finance/summary?month=${month}`).then(setS).catch(() => {}); }, [month]);
  if (!s) return null;
  return (
    <div className="col">
      <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 200 }} />
      <div className="grid4">
        <Stat label="Doanh thu tháng (sau miễn giảm)" value={money(s.revenue)} />
        <Stat label="Đã thu trong tháng" value={money(s.collected)} />
        <Stat label="Chi phí tháng" value={money(s.expenses)} />
        <Stat label="Chênh lệch thu – chi" value={money(s.revenue - s.expenses)} />
      </div>
      <div className="grid4">
        <Stat label="Còn phải thu (mọi kỳ)" value={money(s.outstanding)} />
        <div onClick={() => go('Khoản thu')} style={{ cursor: 'pointer' }}><Stat label="Khoản thu thiếu số km/bảng giá" value={s.missing_info} tone={s.missing_info ? 'warn' : ''} /></div>
        <div onClick={() => go('Chờ duyệt')} style={{ cursor: 'pointer' }}><Stat label="Miễn giảm / đề xuất chờ duyệt" value={`${s.waivers_pending} / ${s.proposals_pending}`} /></div>
        <div onClick={() => go('Hóa đơn')} style={{ cursor: 'pointer' }}><Stat label="Hóa đơn nháp chờ ghi số" value={s.invoices_draft} /></div>
      </div>
    </div>
  );
}

function Charges({ meta, isAcc, run }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState('thieu_thong_tin,cho_thu,thu_mot_phan');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const load = () => api<any[]>('GET', `/api/finance/charges?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setRows);
  useEffect(() => { load().catch(() => {}); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => { const n = new Set(pick); if (n.has(id)) n.delete(id); else n.add(id); setPick(n); };
  return (
    <div className="col">
      <div className="row">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPick(new Set()); }}>
          <option value="thieu_thong_tin,cho_thu,thu_mot_phan">Chưa thu xong</option>
          <option value="">Tất cả</option>
          {Object.entries(meta.chargeStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input placeholder="Mã khoản thu, mã ca, số phiếu, tên" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
        <button onClick={() => load()}>Tìm</button>
        {isAcc && pick.size > 0 && <button className="primary" onClick={() => run(async () => {
          const inv = await api<any>('POST', '/api/finance/invoices', { chargeIds: [...pick] });
          setPick(new Set()); await load();
          return inv;
        }, 'Đã lập hóa đơn nháp. Phát hành ở hệ thống hóa đơn điện tử rồi ghi số ở thẻ Hóa đơn.')}>Lập hóa đơn cho {pick.size} khoản</button>}
      </div>
      <div className="small muted">Khoản thu tự sinh khi kíp ký phiếu chuyển viện, tính theo bảng giá loại xe và số km kíp ghi trên phiếu.</div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr>{isAcc && <th />}<th>Mã</th><th>Ngày</th><th>Ca / phiếu</th><th>Người trả</th><th>Đối tượng</th><th className="right">Phải thu</th><th className="right">Còn lại</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id}>
              {isAcc && <td><input type="checkbox" checked={pick.has(c.id)} disabled={!!c.invoice_code || ['huy', 'thieu_thong_tin', 'that_thu'].includes(c.status)} onChange={() => toggle(c.id)} /></td>}
              <td className="mono">{c.code}</td><td className="small">{c.service_date}</td>
              <td className="small mono">{c.incident_code}<div>{c.transfer_number}</div></td>
              <td>{c.customer_name ?? c.payer_name ?? '—'}</td><td className="small">{meta.payer[c.payer_kind]}</td>
              <td className="right">{money(c.total)}</td><td className="right"><b>{money(c.outstanding)}</b></td>
              <td><span className={`badge ${c.status === 'thieu_thong_tin' ? 'far' : ''}`}>{meta.chargeStatus[c.status]}</span>
                {c.waiver_status === 'cho_duyet' && <div className="small">miễn/giảm chờ duyệt</div>}{c.invoice_code && <div className="small muted">{c.invoice_code}</div>}</td>
              <td className="right"><button className="ghost small" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Đóng' : 'Chi tiết'}</button></td>
            </tr>
          ))}</tbody>
        </table>
        {!rows.length && <div className="small muted">Không có khoản thu.</div>}
      </div>
      {open && <ChargeDetail key={open} id={open} meta={meta} isAcc={isAcc} run={run} onChange={load} />}
    </div>
  );
}

function ChargeDetail({ id, meta, isAcc, run, onChange }: { id: string; meta: Meta; isAcc: boolean; run: Ctx['run']; onChange: () => void }) {
  const [c, setC] = useState<any>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [pay, setPay] = useState({ amount: '', method: 'tien_mat', reference: '' });
  const [w, setW] = useState({ kind: 'giam', amount: '', reason: '' });
  const load = () => api('GET', `/api/finance/charges/${id}`).then((x: any) => { setC(x); setPay((p) => ({ ...p, amount: String(Math.max(0, x.outstanding - (x.waiver_status === 'cho_duyet' ? Number(x.waiver_amount ?? 0) : 0))) })); });
  useEffect(() => { load().catch(() => {}); api<any[]>('GET', '/api/customers/active').then(setCustomers).catch(() => {}); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return null;
  const done = async (fn: () => Promise<unknown>, ok: string) => { if (await run(fn, ok)) { await load(); onChange(); } };
  const patch = (b: Record<string, unknown>) => done(() => api('PATCH', `/api/finance/charges/${id}`, b), 'Đã tính lại.');
  return (
    <div className="panel col">
      <h3 style={{ margin: 0 }}>{c.code} · {meta.chargeStatus[c.status]} <span className="small muted">{c.price_list_name}</span></h3>
      <div className="grid4">
        <label className="field">Số km (cả đi và về theo quy định giá)<input type="number" min={0} defaultValue={c.km ?? ''} disabled={!isAcc} onBlur={(e) => e.target.value !== String(c.km ?? '') && patch({ km: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        <label className="field">Giờ chờ<input type="number" min={0} step={0.5} defaultValue={c.wait_hours} disabled={!isAcc} onBlur={(e) => Number(e.target.value) !== Number(c.wait_hours) && patch({ waitHours: Number(e.target.value) })} /></label>
        <label className="field">Khách hàng hợp đồng<select value={c.customer_id ?? ''} disabled={!isAcc} onChange={(e) => patch({ customerId: e.target.value || null })}>
          <option value="">— Khách lẻ —</option>{customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label className="row small" style={{ alignSelf: 'end' }}><input type="checkbox" checked={c.night} disabled={!isAcc} onChange={(e) => patch({ night: e.target.checked })} /> Phụ thu ban đêm</label>
      </div>
      <table><tbody>
        {c.lines.map((l: any, i: number) => <tr key={i}><td>{l.label}</td><td className="right small">{l.qty} × {money(l.unit_price)}</td><td className="right">{money(l.amount)}</td></tr>)}
        {Number(c.discount) > 0 && <tr><td>Giảm theo hợp đồng</td><td /><td className="right">−{money(c.discount)}</td></tr>}
        {Number(c.vat) > 0 && <tr><td>Thuế GTGT</td><td /><td className="right">{money(c.vat)}</td></tr>}
        <tr><td><b>Tổng phải thu</b></td><td /><td className="right"><b>{money(c.total)}</b></td></tr>
        {Number(c.waived) > 0 && <tr><td>{WAIVER[c.waiver_kind]} đã duyệt</td><td /><td className="right">−{money(c.waived)}</td></tr>}
        <tr><td>Đã thu</td><td /><td className="right">{money(c.paid)}</td></tr>
        <tr><td><b>Còn lại</b></td><td /><td className="right"><b>{money(c.outstanding)}</b></td></tr>
      </tbody></table>
      {c.waiver_status && (
        <div className={`alert ${c.waiver_status === 'cho_duyet' ? 'amber' : c.waiver_status === 'da_duyet' ? 'green' : 'red'} small`}>
          {WAIVER[c.waiver_kind]} {c.waiver_amount != null ? money(c.waiver_amount) : '(kế toán chưa nhập số tiền)'}: {c.waiver_reason}.
          {' '}{c.waiver_status === 'cho_duyet' ? 'Chờ Ban Giám đốc duyệt.' : c.waiver_status === 'da_duyet' ? `Đã duyệt bởi ${c.waiver_decided_by_name}.` : 'Bị từ chối.'}
        </div>
      )}
      {c.payments.length > 0 && (
        <table><tbody>{c.payments.map((p: any) => (
          <tr key={p.id} style={p.voided ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>
            <td className="mono">{p.code}</td><td>{money(p.amount)}</td><td className="small">{meta.payMethod[p.method]}{p.reference ? ` · ${p.reference}` : ''}</td>
            <td className="small">{new Date(p.received_at).toLocaleString('vi-VN')} · {p.received_by_name}</td>
            <td className="right">{isAcc && !p.voided && <button className="ghost small" onClick={() => {
              const r = prompt('Lý do hủy phiếu thu:');
              if (r && r.trim().length >= 5) done(() => api('POST', `/api/finance/payments/${p.id}/void`, { reason: r }), 'Đã hủy phiếu thu.');
            }}>Hủy</button>}</td>
          </tr>))}</tbody></table>
      )}
      {isAcc && ['cho_thu', 'thu_mot_phan'].includes(c.status) && (
        <div className="grid4">
          <label className="field">Thu tiền<input type="number" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></label>
          <label className="field">Hình thức<select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{Object.entries(meta.payMethod).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Mã giao dịch / số chứng từ<input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></label>
          <div className="row" style={{ alignSelf: 'end' }}><button className="primary" disabled={!Number(pay.amount)} onClick={() => done(() => api('POST', `/api/finance/charges/${id}/payments`, { amount: Number(pay.amount), method: pay.method, reference: pay.reference || null }), 'Đã lập phiếu thu.')}>Lập phiếu thu</button></div>
        </div>
      )}
      {isAcc && ['cho_thu', 'thu_mot_phan'].includes(c.status) && c.waiver_status !== 'cho_duyet' && (
        <div className="grid4">
          <label className="field">Đề nghị<select value={w.kind} onChange={(e) => setW({ ...w, kind: e.target.value })}>{Object.entries(WAIVER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Số tiền<input type="number" value={w.amount} onChange={(e) => setW({ ...w, amount: e.target.value })} /></label>
          <label className="field">Lý do<input value={w.reason} onChange={(e) => setW({ ...w, reason: e.target.value })} placeholder="Hộ nghèo, người có công, không liên lạc được..." /></label>
          <div className="row" style={{ alignSelf: 'end' }}><button disabled={!Number(w.amount) || w.reason.trim().length < 5} onClick={() => done(() => api('POST', `/api/finance/charges/${id}/waiver`, { kind: w.kind, amount: Number(w.amount), reason: w.reason }), 'Đã gửi đề nghị, chờ Ban Giám đốc duyệt.')}>Gửi đề nghị</button></div>
        </div>
      )}
      {isAcc && c.waiver_status === 'cho_duyet' && c.waiver_amount == null && (
        <div className="row"><span className="small">Phiếu ghi đối tượng "Giảm": nhập số tiền giảm</span>
          <input type="number" value={w.amount} onChange={(e) => setW({ ...w, amount: e.target.value })} />
          <button disabled={!Number(w.amount)} onClick={() => done(() => api('POST', `/api/finance/charges/${id}/waiver`, { kind: 'giam', amount: Number(w.amount), reason: c.waiver_reason }), 'Đã nhập số tiền giảm.')}>Lưu</button></div>
      )}
      {isAcc && Number(c.paid) === 0 && c.status !== 'huy' && <div><button className="ghost small" onClick={() => {
        const r = prompt('Lý do hủy khoản thu (ví dụ phiếu lập trùng):');
        if (r && r.trim().length >= 5) done(() => api('POST', `/api/finance/charges/${id}/cancel`, { reason: r }), 'Đã hủy khoản thu.');
      }}>Hủy khoản thu</button></div>}
    </div>
  );
}

function Approvals({ meta, isAcc, isDir, run, role }: Ctx) {
  const [waivers, setWaivers] = useState<any[]>([]);
  const [props, setProps] = useState<any[]>([]);
  const load = () => Promise.all([
    api<any[]>('GET', '/api/finance/charges?waiver=cho_duyet').then(setWaivers),
    api<any[]>('GET', '/api/finance/proposals?status=cho_duyet_1,cho_duyet_2').then(setProps),
  ]);
  useEffect(() => { load().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const decideW = (id: string, approve: boolean) => {
    const note = approve ? null : prompt('Lý do từ chối:');
    if (!approve && !note) return;
    run(async () => { await api('POST', `/api/finance/charges/${id}/waiver/decide`, { approve, note }); await load(); }, approve ? 'Đã duyệt miễn/giảm.' : 'Đã từ chối.');
  };
  const decideP = (id: string, approve: boolean) => {
    const note = approve ? prompt('Ý kiến (không bắt buộc):') ?? '' : prompt('Lý do từ chối:');
    if (!approve && !note) return;
    run(async () => { await api('POST', `/api/finance/proposals/${id}/decide`, { approve, note: note || null }); await load(); }, approve ? 'Đã duyệt.' : 'Đã từ chối.');
  };
  const me = session.user?.id;
  return (
    <div className="col">
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Miễn, giảm, thất thu <span className="small muted">Ban Giám đốc duyệt; người đề nghị không tự duyệt</span></h3>
        <table><tbody>{waivers.map((c) => (
          <tr key={c.id}><td className="mono">{c.code}</td><td>{c.payer_name ?? c.customer_name}</td><td>{WAIVER[c.waiver_kind]}</td>
            <td className="right">{c.waiver_amount != null ? money(c.waiver_amount) : <span className="muted">chưa nhập</span>} / {money(c.total)}</td><td className="small">{c.waiver_reason}</td>
            <td className="right">{isDir && c.waiver_by !== me && <><button className="primary small" disabled={c.waiver_amount == null} onClick={() => decideW(c.id, true)}>Duyệt</button> <button className="ghost small" onClick={() => decideW(c.id, false)}>Từ chối</button></>}</td></tr>
        ))}</tbody></table>
        {!waivers.length && <div className="small muted">Không có.</div>}
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Đề xuất chi <span className="small muted">cấp 1 kế toán; từ {money(meta.settings.approvalThreshold)} thêm cấp 2 Ban Giám đốc</span></h3>
        <table><tbody>{props.map((p) => {
          const can = p.created_by !== me && ((p.status === 'cho_duyet_1' && (isAcc || isDir)) || (p.status === 'cho_duyet_2' && isDir && p.l1_by !== me));
          return (
            <tr key={p.id}><td className="mono">{p.code}</td><td><b>{p.title}</b><div className="small muted">{meta.proposalKind[p.kind]} · {p.created_by_name}{p.vehicle_id ? ` · ${p.vehicle_id}` : ''}</div>{p.description && <div className="small">{p.description}</div>}</td>
              <td className="right">{money(p.amount)}</td><td className="small">{PSTATUS[p.status]}{p.l1_name && <div className="muted">Cấp 1: {p.l1_name}</div>}</td>
              <td className="right">{can && <><button className="primary small" onClick={() => decideP(p.id, true)}>Duyệt</button> <button className="ghost small" onClick={() => decideP(p.id, false)}>Từ chối</button></>}</td></tr>
          );
        })}</tbody></table>
        {!props.length && <div className="small muted">Không có.</div>}
        {role === 'admin' && <div className="small muted">Quản trị hệ thống chỉ xem, không duyệt chi.</div>}
      </div>
    </div>
  );
}

function Invoices({ isAcc, run }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => api<any[]>('GET', '/api/finance/invoices').then(setRows);
  useEffect(() => { load().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="panel col" style={{ overflowX: 'auto' }}>
      <div className="small muted">Lập hóa đơn từ thẻ Khoản thu (chọn các khoản cùng khách hàng). Hệ thống chưa nối nhà cung cấp hóa đơn điện tử: kế toán phát hành ở đó rồi ghi ký hiệu và số hóa đơn ở đây.</div>
      <table>
        <thead><tr><th>Số nội bộ</th><th>Người mua</th><th>Khoản thu</th><th className="right">Tổng</th><th>Trạng thái</th><th /></tr></thead>
        <tbody>{rows.map((i) => (
          <tr key={i.id}><td className="mono">{i.code}</td><td>{i.buyer_name}<div className="small muted">{i.buyer_tax_code}</div></td>
            <td className="small mono">{(i.charge_codes ?? []).join(', ')}</td><td className="right">{money(i.total)}</td>
            <td>{ISTATUS[i.status]}{i.einvoice_no && <div className="small mono">{i.einvoice_symbol} · {i.einvoice_no}</div>}</td>
            <td className="right">{isAcc && i.status === 'nhap' && <button className="primary small" onClick={() => {
              const symbol = prompt('Ký hiệu hóa đơn (ví dụ 1C26TMD):'); if (!symbol) return;
              const no = prompt('Số hóa đơn:'); if (!no) return;
              run(async () => { await api('POST', `/api/finance/invoices/${i.id}/issue`, { einvoiceSymbol: symbol, einvoiceNo: no }); await load(); }, 'Đã ghi số hóa đơn.');
            }}>Ghi số HĐĐT</button>} {isAcc && i.status !== 'huy' && <button className="ghost small" onClick={() => {
              const r = prompt('Lý do hủy hóa đơn:'); if (r && r.trim().length >= 5) run(async () => { await api('POST', `/api/finance/invoices/${i.id}/cancel`, { reason: r }); await load(); }, 'Đã hủy hóa đơn.');
            }}>Hủy</button>}</td></tr>
        ))}</tbody>
      </table>
      {!rows.length && <div className="small muted">Chưa có hóa đơn.</div>}
    </div>
  );
}

export function ProposalForm({ meta, run, onDone }: { meta: { proposalKind: Record<string, string> }; run: Ctx['run']; onDone: () => void }) {
  const [f, setF] = useState({ kind: 'chi_phi', title: '', amount: '', vehicleId: '', description: '' });
  return (
    <div className="grid4">
      <label className="field">Loại<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(meta.proposalKind).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">Nội dung<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Thay lốp xe BLS" /></label>
      <label className="field">Số tiền (đ)<input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
      <label className="field">Xe (nếu có)<input value={f.vehicleId} onChange={(e) => setF({ ...f, vehicleId: e.target.value.toUpperCase() })} /></label>
      <label className="field" style={{ gridColumn: '1 / -1' }}>Lý do, báo giá<textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <div><button className="primary" disabled={f.title.trim().length < 5 || !Number(f.amount)} onClick={async () => {
        if (await run(() => api('POST', '/api/finance/proposals', { ...f, amount: Number(f.amount), vehicleId: f.vehicleId || null, description: f.description || null }), 'Đã gửi đề xuất.')) {
          setF({ kind: 'chi_phi', title: '', amount: '', vehicleId: '', description: '' }); onDone();
        }
      }}>Gửi đề xuất</button></div>
    </div>
  );
}

function Proposals({ meta, run }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => api<any[]>('GET', '/api/finance/proposals').then(setRows);
  useEffect(() => { load().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col">
      <div className="panel"><ProposalForm meta={meta} run={run} onDone={load} /></div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Mã</th><th>Nội dung</th><th className="right">Số tiền</th><th className="right">Đã chi</th><th>Trạng thái</th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id}><td className="mono">{p.code}</td><td>{p.title}<div className="small muted">{meta.proposalKind[p.kind]} · {p.created_by_name}</div></td>
              <td className="right">{money(p.amount)}</td><td className="right">{money(p.spent)}</td>
              <td className="small">{PSTATUS[p.status]}{p.l1_name && <div className="muted">Cấp 1: {p.l1_name}{p.l1_note ? ` – ${p.l1_note}` : ''}</div>}{p.l2_name && <div className="muted">Cấp 2: {p.l2_name}{p.l2_note ? ` – ${p.l2_note}` : ''}</div>}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function Expenses({ meta, isAcc, run }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const [approved, setApproved] = useState<any[]>([]);
  const [f, setF] = useState({ category: 'nhien_lieu', amount: '', spentOn: vnDate(), method: 'tien_mat', payee: '', docNo: '', vehicleId: '', proposalId: '', note: '' });
  const load = () => Promise.all([
    api<any[]>('GET', '/api/finance/expenses').then(setRows),
    api<any[]>('GET', '/api/finance/proposals?status=da_duyet').then(setApproved),
  ]);
  useEffect(() => { load().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const needProposal = Number(f.amount) >= meta.settings.approvalThreshold;
  return (
    <div className="col">
      {isAcc && (
        <div className="panel grid4">
          <label className="field">Khoản mục<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(meta.expenseCategory).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Số tiền<input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
          <label className="field">Ngày chi<input type="date" value={f.spentOn} onChange={(e) => setF({ ...f, spentOn: e.target.value })} /></label>
          <label className="field">Hình thức<select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="tien_mat">Tiền mặt</option><option value="chuyen_khoan">Chuyển khoản</option><option value="cong_no">Ghi nợ nhà cung cấp</option></select></label>
          <label className="field">Người nhận / nhà cung cấp<input value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} /></label>
          <label className="field">Số hóa đơn bên bán<input value={f.docNo} onChange={(e) => setF({ ...f, docNo: e.target.value })} /></label>
          <label className="field">Xe (để tính chi phí theo xe)<input value={f.vehicleId} onChange={(e) => setF({ ...f, vehicleId: e.target.value.toUpperCase() })} /></label>
          <label className="field">Theo đề xuất{needProposal && <b> (bắt buộc)</b>}<select value={f.proposalId} onChange={(e) => setF({ ...f, proposalId: e.target.value })}>
            <option value="">—</option>{approved.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.title} · còn {money(p.amount - p.spent)}</option>)}</select></label>
          <div><button className="primary" disabled={!Number(f.amount) || (needProposal && !f.proposalId)} onClick={async () => {
            if (await run(() => api('POST', '/api/finance/expenses', { ...f, amount: Number(f.amount), payee: f.payee || null, docNo: f.docNo || null, vehicleId: f.vehicleId || null, proposalId: f.proposalId || null, note: f.note || null }), 'Đã lập phiếu chi.')) {
              setF({ ...f, amount: '', payee: '', docNo: '', proposalId: '' }); load();
            }
          }}>Lập phiếu chi</button></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Mã</th><th>Ngày</th><th>Khoản mục</th><th>Người nhận</th><th>Xe</th><th>Đề xuất</th><th className="right">Số tiền</th></tr></thead>
          <tbody>{rows.map((e) => (
            <tr key={e.id}><td className="mono">{e.code}</td><td className="small">{e.spent_on}</td><td>{meta.expenseCategory[e.category]}</td><td className="small">{e.payee}{e.doc_no ? ` · HĐ ${e.doc_no}` : ''}</td>
              <td className="small">{e.vehicle_id}</td><td className="small mono">{e.proposal_code}</td><td className="right">{money(e.amount)}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function Receivables(_: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api<any[]>('GET', '/api/finance/receivables').then(setRows).catch(() => {}); }, []);
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <h3 style={{ marginTop: 0 }}>Công nợ phải thu theo tuổi nợ</h3>
      <table>
        <thead><tr><th>Người trả</th><th>Số khoản</th><th className="right">Chưa đến hạn</th><th className="right">1–30 ngày</th><th className="right">31–60</th><th className="right">61–90</th><th className="right">Trên 90</th><th className="right">Tổng</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.payer}><td><b>{r.payer}</b></td><td>{r.count}</td><td className="right">{money(r.not_due)}</td><td className="right">{money(r.d30)}</td>
            <td className="right">{money(r.d60)}</td><td className="right">{money(r.d90)}</td><td className="right" style={r.over90 ? { color: 'var(--red)' } : undefined}>{money(r.over90)}</td>
            <td className="right"><b>{money(r.outstanding)}</b></td></tr>
        ))}</tbody>
      </table>
      {!rows.length && <div className="small muted">Không còn công nợ.</div>}
    </div>
  );
}

function PricesCustomers({ isAcc, isDir, run }: Ctx) {
  const [prices, setPrices] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [p, setP] = useState({ vehicleType: 'ALS', name: '', baseFee: '', baseKm: '10', perKm: '', waitPerHour: '', nightSurchargePct: '20', vatRate: '0' });
  const [c, setC] = useState({ code: '', name: '', kind: 'benh_vien', taxCode: '', contractNo: '', contractTo: '', discountPct: '0', paymentDays: '30' });
  const load = () => Promise.all([api<any[]>('GET', '/api/finance/price-lists').then(setPrices), api<any[]>('GET', '/api/finance/customers').then(setCustomers)]);
  useEffect(() => { load().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const can = isAcc || isDir;
  return (
    <div className="col">
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Bảng giá theo loại xe</h3>
        <table>
          <thead><tr><th>Loại xe</th><th>Tên</th><th className="right">Mở cửa</th><th>Km gồm</th><th className="right">Km tiếp</th><th className="right">Giờ chờ</th><th>Đêm</th><th>VAT</th><th>Hiệu lực</th></tr></thead>
          <tbody>{prices.map((x) => (
            <tr key={x.id} style={x.active ? undefined : { opacity: 0.5 }}><td><b>{x.vehicle_type}</b></td><td className="small">{x.name}</td><td className="right">{money(x.base_fee)}</td><td>{Number(x.base_km)}</td>
              <td className="right">{money(x.per_km)}</td><td className="right">{money(x.wait_per_hour)}</td><td>{Number(x.night_surcharge_pct)}%</td><td>{Number(x.vat_rate)}%</td>
              <td className="small">{x.active ? `từ ${x.effective_from}` : 'đã thay'}</td></tr>
          ))}</tbody>
        </table>
        {can && (
          <div className="grid4" style={{ marginTop: 8 }}>
            <label className="field">Loại xe<select value={p.vehicleType} onChange={(e) => setP({ ...p, vehicleType: e.target.value })}>{['ALS', 'BLS', 'MSU', 'ECMO', 'VC', 'DP'].map((v) => <option key={v}>{v}</option>)}</select></label>
            <label className="field">Tên bảng giá<input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} placeholder="Theo QĐ số .../2026" /></label>
            <label className="field">Giá mở cửa<input type="number" value={p.baseFee} onChange={(e) => setP({ ...p, baseFee: e.target.value })} /></label>
            <label className="field">Số km gồm trong giá mở cửa<input type="number" value={p.baseKm} onChange={(e) => setP({ ...p, baseKm: e.target.value })} /></label>
            <label className="field">Đ/km tiếp theo<input type="number" value={p.perKm} onChange={(e) => setP({ ...p, perKm: e.target.value })} /></label>
            <label className="field">Đ/giờ chờ<input type="number" value={p.waitPerHour} onChange={(e) => setP({ ...p, waitPerHour: e.target.value })} /></label>
            <label className="field">Phụ thu đêm (%)<input type="number" value={p.nightSurchargePct} onChange={(e) => setP({ ...p, nightSurchargePct: e.target.value })} /></label>
            <label className="field">Thuế GTGT (%)<input type="number" value={p.vatRate} onChange={(e) => setP({ ...p, vatRate: e.target.value })} /></label>
            <div><button className="primary" disabled={p.name.trim().length < 2 || p.baseFee === ''} onClick={async () => {
              const n = (s: string) => Number(s || 0);
              if (await run(() => api('POST', '/api/finance/price-lists', { name: p.name, vehicleType: p.vehicleType, baseFee: n(p.baseFee), baseKm: n(p.baseKm), perKm: n(p.perKm), waitPerHour: n(p.waitPerHour), nightSurchargePct: n(p.nightSurchargePct), vatRate: n(p.vatRate) }), `Đã áp dụng bảng giá mới cho xe ${p.vehicleType}. Khoản thu đã sinh giữ giá cũ.`)) load();
            }}>Áp dụng bảng giá mới</button></div>
          </div>
        )}
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Khách hàng hợp đồng</h3>
        <div className="small muted">Điều phối chọn khách hàng hợp đồng trên ca; khoản thu áp chiết khấu và hạn thanh toán theo hợp đồng.</div>
        <table>
          <thead><tr><th>Mã</th><th>Tên</th><th>Loại</th><th>Hợp đồng</th><th>Chiết khấu</th><th>Hạn TT</th><th className="right">Còn nợ</th><th /></tr></thead>
          <tbody>{customers.map((x) => (
            <tr key={x.id} style={x.active ? undefined : { opacity: 0.5 }}><td className="mono">{x.code}</td><td>{x.name}<div className="small muted">{x.tax_code}</div></td><td>{CU_KIND[x.kind]}</td>
              <td className="small">{x.contract_no}{x.contract_to ? ` · đến ${x.contract_to}` : ''}</td><td>{Number(x.discount_pct)}%</td><td>{x.payment_days} ngày</td>
              <td className="right">{money(x.outstanding)}</td>
              <td className="right">{can && <button className="ghost small" onClick={() => run(async () => { await api('PATCH', `/api/finance/customers/${x.id}`, { active: !x.active }); await load(); })}>{x.active ? 'Ngưng' : 'Mở lại'}</button>}</td></tr>
          ))}</tbody>
        </table>
        {can && (
          <div className="grid4" style={{ marginTop: 8 }}>
            <label className="field">Mã<input value={c.code} onChange={(e) => setC({ ...c, code: e.target.value.toUpperCase() })} placeholder="BV-CR" /></label>
            <label className="field">Tên<input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
            <label className="field">Loại<select value={c.kind} onChange={(e) => setC({ ...c, kind: e.target.value })}>{Object.entries(CU_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Mã số thuế<input value={c.taxCode} onChange={(e) => setC({ ...c, taxCode: e.target.value })} /></label>
            <label className="field">Số hợp đồng<input value={c.contractNo} onChange={(e) => setC({ ...c, contractNo: e.target.value })} /></label>
            <label className="field">Hợp đồng đến<input type="date" value={c.contractTo} onChange={(e) => setC({ ...c, contractTo: e.target.value })} /></label>
            <label className="field">Chiết khấu (%)<input type="number" value={c.discountPct} onChange={(e) => setC({ ...c, discountPct: e.target.value })} /></label>
            <label className="field">Hạn thanh toán (ngày)<input type="number" value={c.paymentDays} onChange={(e) => setC({ ...c, paymentDays: e.target.value })} /></label>
            <div><button className="primary" disabled={c.code.length < 2 || c.name.trim().length < 2} onClick={async () => {
              if (await run(() => api('POST', '/api/finance/customers', { ...c, taxCode: c.taxCode || null, contractNo: c.contractNo || null, contractTo: c.contractTo || null, discountPct: Number(c.discountPct), paymentDays: Number(c.paymentDays) }), 'Đã thêm khách hàng.')) {
                setC({ ...c, code: '', name: '', taxCode: '', contractNo: '', contractTo: '' }); load();
              }
            }}>Thêm khách hàng</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

const ACCOUNT_LABEL: Record<string, string> = {
  receivable: 'Phải thu khách hàng', revenue: 'Doanh thu dịch vụ', vatOut: 'Thuế GTGT đầu ra', cash: 'Tiền mặt', bank: 'Tiền gửi ngân hàng',
  payable: 'Phải trả người bán', waiver: 'Giảm trừ doanh thu (miễn, giảm)', badDebt: 'Chi phí xóa nợ thất thu',
};

/* ======================= BHYT ======================= */

const BHYT_SETTING_LABEL: [string, string, string?][] = [
  ['maCskcb', 'Mã cơ sở KBCB của công ty (5 ký tự)'], ['maKhoa', 'Mã khoa (PL5 QĐ 5937)'], ['maNhomVc', 'Mã nhóm chi phí vận chuyển (PL3 QĐ 5937)'],
  ['maLoaiKcb', 'Mã hình thức KBCB'], ['maXangDau', 'Mã loại xăng dầu'], ['fuelPrice', 'Giá xăng dầu (đ/lít)', 'number'],
  ['litrePerKm', 'Định mức quỹ trả (lít/km)', 'number'], ['maTtdv', 'Mã định danh y tế người ký (MA_TTDV)'], ['maBacSi', 'Mã định danh y tế người chỉ định mặc định'],
];

function Bhyt({ isAcc, run }: Ctx) {
  const [from, setFrom] = useState(vnDate().slice(0, 8) + '01');
  const [to, setTo] = useState(vnDate());
  const [d, setD] = useState<any>(null);
  const [st, setSt] = useState<Record<string, any>>({});
  const [card, setCard] = useState<any>(null);
  const load = () => run(async () => { const x = await api<any>('GET', `/api/finance/bhyt?from=${from}&to=${to}`); setD(x); setSt(x.settings); });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  const ready = d.rows.filter((r: any) => !r.missing.length);
  const fresh = ready.filter((r: any) => !r.exportedAt);
  const sum = (k: string, rows: any[]) => rows.reduce((t: number, r: any) => t + (r.amounts?.[k] ?? 0), 0);
  const openCard = (r: any) => setCard({ id: r.id, code: r.code, cardNo: r.card?.cardNo ?? '', dkbd: r.card?.dkbd ?? '', validFrom: r.card?.validFrom ?? '', validTo: r.card?.validTo ?? '',
    mucHuong: r.card?.mucHuong ?? 80, khuVuc: r.card?.khuVuc ?? '', doiTuongKcb: r.card?.doiTuongKcb ?? '', noiDi: r.card?.noiDi ?? '' });
  return (
    <div className="col">
      <div className="alert amber small">
        Bảng kê chi phí <b>vận chuyển người bệnh</b> xuất XML theo QĐ 130/QĐ-BYT (sửa đổi QĐ 4750/QĐ-BYT): Bảng 1 tổng hợp và Bảng 3 dịch vụ (mã <span className="mono">VC.&lt;mã nơi đến&gt;</span>).
        Quỹ trả theo định mức nhiên liệu × số km; phần chênh lệch người bệnh trả. Chưa kê thuốc dùng trên xe (Bảng 2) và chưa ký số: tải tệp lên Cổng giám định bằng công cụ ký số của đơn vị.
        Mã mặc định và cách tính là bản nháp, kế toán đối chiếu với BHXH và gửi thử trước khi gửi thật.
      </div>
      <div className="panel col" style={{ overflowX: 'auto' }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="row small">Từ<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="row small">Đến<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <button onClick={load}>Xem</button>
          {isAcc && <button className="primary" disabled={!fresh.length} onClick={() => run(async () => { await download(`/api/finance/bhyt/xml?from=${from}&to=${to}`, `GIAMDINHHS_${st.maCskcb}_${from}_${to}.xml`); await load(); }, 'Đã xuất XML.')}>
            Xuất XML {fresh.length} lượt chưa gửi</button>}
          <span className="small muted grow">{d.rows.length} lượt BHYT · {ready.length} đủ thông tin · đề nghị quỹ trả {money(sum('bhtt', ready))} · người bệnh trả {money(sum('bntt', ready) + sum('bncct', ready))}</span>
        </div>
        <table className="table">
          <thead><tr><th>Ngày</th><th>Khoản thu</th><th>Người bệnh</th><th>Thẻ BHYT</th><th>Nơi đến</th><th className="right">Km</th><th className="right">Chi phí</th><th className="right">Quỹ trả</th><th className="right">Người bệnh trả</th><th>Tình trạng</th><th /></tr></thead>
          <tbody>{d.rows.map((r: any) => (
            <tr key={r.id} className={r.missing.length ? 'amber' : undefined}>
              <td className="small">{r.serviceDate}</td>
              <td className="mono small">{r.code}<div className="muted">{r.transferNumber}</div></td>
              <td>{r.patient ?? '—'}</td>
              <td className="mono small">{r.card ? <>{r.card.cardNo}<div className="muted">{r.card.mucHuong}% · {r.card.dkbd}</div></> : '—'}</td>
              <td className="small">{r.hospital ?? '—'}{r.hospitalCode && <div className="mono muted">{r.hospitalCode}</div>}</td>
              <td className="right">{r.km ?? '—'}</td>
              <td className="right">{money(r.total)}</td>
              <td className="right">{r.amounts ? money(r.amounts.bhtt) : '—'}</td>
              <td className="right">{r.amounts ? money(r.amounts.bntt + r.amounts.bncct) : '—'}</td>
              <td className="small">{r.missing.length ? <span className="red">Thiếu: {r.missing.join(', ')}</span> : r.exportedAt ? `Đã xuất ${new Date(r.exportedAt).toLocaleDateString('vi-VN')}` : 'Sẵn sàng'}</td>
              <td>{isAcc && <button className="ghost small" onClick={() => openCard(r)}>Thẻ BHYT</button>}</td>
            </tr>
          ))}</tbody>
        </table>
        {!d.rows.length && <div className="small muted">Không có khoản thu đối tượng BHYT trong kỳ.</div>}
        {card && (
          <div className="col panel">
            <b>Thẻ BHYT cho {card.code}</b>
            <div className="grid4">
              <label className="field">Mã thẻ (15 ký tự)<input className="mono" value={card.cardNo} onChange={(e) => setCard({ ...card, cardNo: e.target.value.toUpperCase() })} /></label>
              <label className="field">Nơi đăng ký ban đầu<input className="mono" value={card.dkbd} onChange={(e) => setCard({ ...card, dkbd: e.target.value.toUpperCase() })} /></label>
              <label className="field">Giá trị từ<input type="date" value={card.validFrom} onChange={(e) => setCard({ ...card, validFrom: e.target.value })} /></label>
              <label className="field">Đến<input type="date" value={card.validTo} onChange={(e) => setCard({ ...card, validTo: e.target.value })} /></label>
              <label className="field">Mức hưởng (%)<input type="number" min={1} max={100} value={card.mucHuong} onChange={(e) => setCard({ ...card, mucHuong: Number(e.target.value) })} /></label>
              <label className="field">Khu vực<select value={card.khuVuc} onChange={(e) => setCard({ ...card, khuVuc: e.target.value })}><option value="">—</option><option>K1</option><option>K2</option><option>K3</option></select></label>
              <label className="field">Mã đối tượng KCB (trống: cấp cứu 2, hẹn 1)<input value={card.doiTuongKcb} onChange={(e) => setCard({ ...card, doiTuongKcb: e.target.value })} /></label>
              <label className="field">Mã nơi chuyển đi (nếu có)<input className="mono" value={card.noiDi} onChange={(e) => setCard({ ...card, noiDi: e.target.value.toUpperCase() })} /></label>
            </div>
            <div className="row">
              <button className="primary" onClick={() => run(async () => {
                await api('PUT', `/api/finance/charges/${card.id}/bhyt`, { ...card, id: undefined, code: undefined, khuVuc: card.khuVuc || null, doiTuongKcb: card.doiTuongKcb || null, noiDi: card.noiDi || null });
                setCard(null); await load();
              }, 'Đã lưu thẻ BHYT.')}>Lưu</button>
              <button className="ghost" onClick={() => setCard(null)}>Bỏ</button>
            </div>
          </div>
        )}
      </div>
      <div className="panel col">
        <h3 style={{ margin: 0 }}>Cài đặt BHYT</h3>
        <fieldset disabled={!isAcc} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="grid4">{BHYT_SETTING_LABEL.map(([k, label, type]) => (
            <label key={k} className="field">{label}<input className={type ? undefined : 'mono'} type={type ?? 'text'} step="any" value={st[k] ?? ''}
              onChange={(e) => setSt({ ...st, [k]: type === 'number' ? Number(e.target.value) : e.target.value })} /></label>
          ))}</div>
          <button className="primary" onClick={() => run(async () => { setSt(await api('PUT', '/api/finance/bhyt/settings', st)); await load(); }, 'Đã lưu cài đặt BHYT.')}>Lưu cài đặt BHYT</button>
        </fieldset>
        <div className="small muted">Mã KCB bệnh viện nhận lấy từ danh mục bệnh viện (Quản trị). Bệnh viện chưa có mã thì bổ sung ở đó.</div>
      </div>
      {d.exports.length > 0 && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Các lần xuất</h3>
          <table className="table">
            <thead><tr><th>Lúc</th><th>Kỳ</th><th className="right">Số lượt</th><th className="right">Chi phí</th><th className="right">Đề nghị quỹ trả</th><th>Người xuất</th><th>Mã băm</th></tr></thead>
            <tbody>{d.exports.map((x: any) => (
              <tr key={x.id}><td className="small">{new Date(x.created_at).toLocaleString('vi-VN')}</td><td className="small">{x.from_date} → {x.to_date}</td><td className="right">{x.n}</td>
                <td className="right">{money(x.total_bv)}</td><td className="right">{money(x.total_bhtt)}</td><td className="small">{x.created_by_name}</td><td className="mono small">{x.sha256.slice(0, 12)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Accounting({ meta, isAcc, isDir, run, reloadMeta }: Ctx) {
  const [from, setFrom] = useState(vnDate().slice(0, 8) + '01');
  const [to, setTo] = useState(vnDate());
  const [rows, setRows] = useState<any[]>([]);
  const [acc, setAcc] = useState<Record<string, string>>(meta.settings.accounts);
  const [threshold, setThreshold] = useState(String(meta.settings.approvalThreshold));
  const load = () => run(async () => setRows(await api<any[]>('GET', `/api/finance/journal?from=${from}&to=${to}`)));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const label = (k: string) => ACCOUNT_LABEL[k] ?? `Chi phí: ${meta.expenseCategory[k] ?? k}`;
  return (
    <div className="col">
      <div className="panel col" style={{ overflowX: 'auto' }}>
        <div className="row">
          <label className="row small">Từ<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="row small">Đến<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <button onClick={load}>Xem bút toán</button>
          <button className="primary" onClick={() => run(() => download(`/api/finance/misa?from=${from}&to=${to}`, `misa-${from}-${to}.xlsx`), 'Đã tải tệp Excel cho MISA.')}>Tải Excel nhập MISA</button>
          <button onClick={() => run(() => download(`/api/finance/journal?from=${from}&to=${to}&format=csv`, `but-toan-${from}-${to}.csv`))}>Tải CSV bút toán</button>
        </div>
        <div className="small muted">
          <b>Excel nhập MISA</b>: mỗi loại chứng từ một trang (phiếu thu, thu tiền gửi, phiếu chi, chi tiền gửi, nghiệp vụ khác), cột theo mẫu nhập khẩu của MISA SME;
          trong MISA chọn Nhập khẩu từ Excel, chọn trang tương ứng rồi ghép cột (hướng dẫn ở trang cuối tệp). <b>CSV bút toán</b> dùng cho Fast, Bravo hoặc phần mềm khác.
          Cột mã xe dùng làm mã thống kê để tính lãi lỗ theo xe.
        </div>
        <table>
          <thead><tr><th>Ngày</th><th>Chứng từ</th><th>Diễn giải</th><th>Nợ</th><th>Có</th><th className="right">Số tiền</th><th>Đối tượng</th><th>Xe</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><td className="small">{r.date}</td><td className="mono small">{r.docNo}</td><td className="small">{r.description}</td><td className="mono">{r.debit}</td><td className="mono">{r.credit}</td><td className="right">{money(r.amount)}</td><td className="small">{r.object}</td><td className="small">{r.vehicle}</td></tr>)}</tbody>
        </table>
        {!rows.length && <div className="small muted">Không có bút toán trong kỳ.</div>}
      </div>
      <div className="panel col">
        <h3 style={{ margin: 0 }}>Cài đặt</h3>
        <div className="small muted">Số hiệu tài khoản mặc định theo hệ thống tài khoản doanh nghiệp thông dụng; kế toán trưởng rà soát theo chế độ kế toán đơn vị áp dụng.</div>
        <fieldset disabled={!(isAcc || isDir)} style={{ border: 0, padding: 0, margin: 0 }}>
          <label className="field" style={{ maxWidth: 320 }}>Ngưỡng phải Ban Giám đốc duyệt cấp 2 (đ)<input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
          <div className="grid4">{Object.keys(acc).map((k) => (
            <label key={k} className="field">{label(k)}<input className="mono" value={acc[k]} onChange={(e) => setAcc({ ...acc, [k]: e.target.value })} /></label>
          ))}</div>
          <button className="primary" onClick={() => run(async () => { await api('PUT', '/api/finance/settings', { approvalThreshold: Number(threshold), accounts: acc }); reloadMeta(); }, 'Đã lưu cài đặt.')}>Lưu cài đặt</button>
        </fieldset>
      </div>
    </div>
  );
}
