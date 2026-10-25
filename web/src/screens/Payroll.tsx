import { Fragment, useEffect, useState } from 'react';
import { api, download, money, session } from '../api';

const STATUS: Record<string, string> = { nhap: 'Nháp', da_duyet: 'Đã duyệt', da_chi: 'Đã chi' };
const CONTRACT: Record<string, string> = { thu_viec: 'Thử việc', xac_dinh: 'Xác định thời hạn', khong_xac_dinh: 'Không xác định thời hạn', cong_tac_vien: 'Cộng tác viên' };
const TABS = ['Bảng lương tháng', 'Hồ sơ lương', 'Tham số'] as const;
const vnMonth = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
const n = (v: string) => Number(String(v).replace(/[^\d-]/g, '')) || 0;

/** Bảng lương: hồ sơ lương, tính lương tháng từ lịch trực/chuyến/nghỉ không lương, điều chỉnh, duyệt, xuất Excel */
export function Payroll() {
  const role = session.user?.role ?? '';
  const [tab, setTab] = useState<(typeof TABS)[number]>('Bảng lương tháng');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  const ctx = { role, run };
  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Bảng lương</h2>
      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); setMsg(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {tab === 'Bảng lương tháng' && <Periods {...ctx} />}
      {tab === 'Hồ sơ lương' && <Salaries {...ctx} />}
      {tab === 'Tham số' && <Settings {...ctx} />}
    </div>
  );
}
type Ctx = { role: string; run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean> };

function Periods({ role, run }: Ctx) {
  const prepare = ['hr', 'accountant'].includes(role);
  const [list, setList] = useState<any[]>([]);
  const [month, setMonth] = useState(vnMonth());
  const [d, setD] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api<any[]>('GET', '/api/payroll/periods').then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  const show = (id: string) => api('GET', `/api/payroll/periods/${id}`).then(setD);
  const t = d?.totals;
  return (
    <div className="col">
      <div className="panel row">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        {prepare && <button className="primary" onClick={() => run(async () => { const r = await api('POST', '/api/payroll/periods', { month }); setD(r); await load(); }, 'Đã tính bảng lương. Kiểm tra, điều chỉnh rồi trình Ban Giám đốc duyệt.')}>Tính bảng lương tháng</button>}
        <span className="small muted">Số ca đêm, trực 24 giờ lấy từ lịch trực; số chuyến từ phiếu kíp đã ký trong ca; ngày nghỉ không lương từ đơn đã duyệt. Tính lại được khi còn nháp, giữ các khoản điều chỉnh.</span>
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>Tháng</th><th>Trạng thái</th><th>Số người</th><th>Tổng thu nhập</th><th>Thực lĩnh</th><th></th></tr></thead>
          <tbody>{list.map((p) => (
            <tr key={p.id}><td>{p.month}</td><td>{STATUS[p.status]}</td><td>{p.lines}</td><td>{money(p.gross)}</td><td>{money(p.net)}</td>
              <td className="right"><button onClick={() => show(p.id)}>Xem</button></td></tr>
          ))}</tbody>
        </table>
        {!list.length && <div className="muted">Chưa có bảng lương. Nhập hồ sơ lương trước (tab Hồ sơ lương).</div>}
      </div>
      {d && (
        <div className="panel col" style={{ overflowX: 'auto' }}>
          <div className="row">
            <h3 style={{ margin: 0 }}>Tháng {d.month} · {STATUS[d.status]}</h3>
            <span className="small muted">Lập: {d.created_by_name}{d.approved_by_name && ` · Duyệt: ${d.approved_by_name}`}</span>
            <span className="grow" />
            <button onClick={() => run(() => download(`/api/payroll/periods/${d.id}/xlsx`, `bang-luong-${d.month}.xlsx`))}>Tải Excel</button>
            {role === 'director' && d.status === 'nhap' && <button className="primary" onClick={() => run(async () => { setD(await api('POST', `/api/payroll/periods/${d.id}/approve`)); await load(); }, 'Đã duyệt bảng lương. Nhân viên xem được phiếu lương ở trang Cá nhân.')}>Duyệt</button>}
            {role === 'accountant' && d.status === 'da_duyet' && <button className="primary" onClick={() => run(async () => { setD(await api('POST', `/api/payroll/periods/${d.id}/paid`)); await load(); }, 'Đã ghi đã chi lương.')}>Ghi đã chi</button>}
          </div>
          <div className="grid4">
            <div className="small">Tổng thu nhập<br /><b>{money(t.gross)}</b></div>
            <div className="small">BH người lao động<br /><b>{money(t.insEmp)}</b></div>
            <div className="small">Thuế TNCN<br /><b>{money(t.pit)}</b></div>
            <div className="small">Thực lĩnh<br /><b>{money(t.net)}</b> <span className="muted">· BH đơn vị đóng {money(t.insEr)}</span></div>
          </div>
          <table>
            <thead><tr><th>Nhân viên</th><th>Ca / đêm / 24h / chuyến</th><th>Tổng thu nhập</th><th>BH</th><th>Thuế</th><th>Thực lĩnh</th><th></th></tr></thead>
            <tbody>{d.lines.map((l: any) => (
              <Fragment key={l.id}>
                <tr>
                  <td>{l.full_name}<div className="small muted">{l.code} · {l.title}</div></td>
                  <td className="small">{l.input.shifts} / {l.input.nightShifts} / {l.input.duty24} / {l.input.trips}{l.input.unpaidDays > 0 && ` · nghỉ KL ${l.input.unpaidDays}`}</td>
                  <td>{money(l.gross)}</td><td>{money(l.ins_emp)}</td><td>{money(l.pit)}</td><td><b>{money(l.net)}</b></td>
                  <td className="right"><button className="ghost" onClick={() => setOpen(open === l.id ? null : l.id)}>{open === l.id ? 'Ẩn' : 'Chi tiết'}</button></td>
                </tr>
                {open === l.id && <tr><td colSpan={7}><LineDetail l={l} editable={prepare && d.status === 'nhap'} run={run} onSaved={() => show(d.id)} /></td></tr>}
              </Fragment>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LineDetail({ l, editable, run, onSaved }: { l: any; editable: boolean; run: Ctx['run']; onSaved: () => void }) {
  const [items, setItems] = useState<any[]>(l.adjustments ?? []);
  return (
    <div className="grid2">
      <Payslip r={l.result} />
      <div className="col">
        <b>Điều chỉnh (thưởng, truy thu, trừ tạm ứng…)</b>
        {items.map((it, k) => (
          <div key={k} className="row">
            <input value={it.name} disabled={!editable} placeholder="Nội dung" onChange={(e) => setItems(items.map((x, j) => j === k ? { ...x, name: e.target.value } : x))} />
            <input value={it.amount} disabled={!editable} style={{ width: 120 }} onChange={(e) => setItems(items.map((x, j) => j === k ? { ...x, amount: n(e.target.value) } : x))} />
            <label className="row small"><input type="checkbox" checked={it.taxable} disabled={!editable} onChange={(e) => setItems(items.map((x, j) => j === k ? { ...x, taxable: e.target.checked } : x))} /> tính thuế</label>
            {editable && <button className="ghost" onClick={() => setItems(items.filter((_, j) => j !== k))}>Xóa</button>}
          </div>
        ))}
        {editable && <div className="row">
          <button onClick={() => setItems([...items, { name: '', amount: 0, taxable: true }])}>Thêm khoản</button>
          <button className="primary" onClick={() => run(async () => { await api('PUT', `/api/payroll/lines/${l.id}/adjustments`, { items }); onSaved(); }, 'Đã lưu điều chỉnh.')}>Lưu điều chỉnh</button>
        </div>}
        <div className="small muted">Số âm là khoản trừ. Bỏ "tính thuế" với khoản không chịu thuế (trừ tạm ứng, hoàn ứng...).</div>
      </div>
    </div>
  );
}

/** Phiếu lương: dùng cho cả màn hình nhân sự và trang Cá nhân */
export function Payslip({ r }: { r: any }) {
  return (
    <table className="small">
      <tbody>
        {r.items.map((x: any, k: number) => <tr key={k}><td>{x.name}{!x.taxable && <span className="muted"> (không tính thuế)</span>}</td><td className="right">{money(x.amount)}</td></tr>)}
        <tr><td><b>Tổng thu nhập</b></td><td className="right"><b>{money(r.gross)}</b></td></tr>
        {r.insured && <>
          <tr><td>BHXH ({money(r.insBase)} × 8%)</td><td className="right">−{money(r.emp.bhxh)}</td></tr>
          <tr><td>BHYT</td><td className="right">−{money(r.emp.bhyt)}</td></tr>
          <tr><td>BHTN</td><td className="right">−{money(r.emp.bhtn)}</td></tr>
        </>}
        <tr><td>Thuế TNCN{r.pitMethod === 'khau_tru_10' ? ' (khấu trừ 10%)' : r.pitMethod === 'luy_tien' ? ` (thu nhập tính thuế ${money(r.assessable)})` : ''}</td><td className="right">−{money(r.pit)}</td></tr>
        <tr><td><b>Thực lĩnh</b></td><td className="right"><b>{money(r.net)}</b></td></tr>
      </tbody>
    </table>
  );
}

function Salaries({ role, run }: Ctx) {
  const edit = ['hr', 'accountant'].includes(role);
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState<any>(null);
  const load = () => api<any[]>('GET', '/api/payroll/salaries').then(setRows).catch(() => {});
  useEffect(() => { load(); }, []);
  const start = (r: any) => setF({
    staffId: r.staff_id, name: r.full_name, payType: r.pay_type ?? (r.contract_type === 'cong_tac_vien' ? 'ca' : 'thang'),
    baseSalary: r.base_salary ?? 0, insuranceSalary: r.insurance_salary ?? '', shiftRate: r.shift_rate ?? 0, dependents: r.dependents ?? 0, allowances: r.allowances ?? [],
  });
  const save = () => run(async () => {
    await api('PUT', `/api/payroll/salaries/${f.staffId}`, {
      payType: f.payType, baseSalary: n(f.baseSalary), insuranceSalary: f.insuranceSalary === '' ? null : n(f.insuranceSalary), shiftRate: n(f.shiftRate),
      dependents: Number(f.dependents) || 0, allowances: f.allowances.map((a: any) => ({ ...a, amount: n(a.amount) })),
    });
    setF(null); await load();
  }, 'Đã lưu hồ sơ lương.');
  return (
    <div className="col">
      {f && (
        <div className="panel col">
          <h3 style={{ margin: 0 }}>Hồ sơ lương: {f.name}</h3>
          <div className="grid4">
            <label className="field">Cách trả<select value={f.payType} onChange={(e) => setF({ ...f, payType: e.target.value })}><option value="thang">Lương tháng</option><option value="ca">Theo ca</option></select></label>
            {f.payType === 'thang'
              ? <label className="field">Lương theo hợp đồng / tháng<input value={f.baseSalary} onChange={(e) => setF({ ...f, baseSalary: e.target.value })} /></label>
              : <label className="field">Tiền mỗi ca<input value={f.shiftRate} onChange={(e) => setF({ ...f, shiftRate: e.target.value })} /></label>}
            <label className="field">Lương đóng BHXH (trống = lương HĐ + phụ cấp đóng BH)<input value={f.insuranceSalary} onChange={(e) => setF({ ...f, insuranceSalary: e.target.value })} /></label>
            <label className="field">Người phụ thuộc<input type="number" min={0} max={20} value={f.dependents} onChange={(e) => setF({ ...f, dependents: e.target.value })} /></label>
          </div>
          <b className="small">Phụ cấp cố định hằng tháng</b>
          {f.allowances.map((a: any, k: number) => (
            <div key={k} className="row">
              <input placeholder="Tên phụ cấp" value={a.name} onChange={(e) => setF({ ...f, allowances: f.allowances.map((x: any, j: number) => j === k ? { ...x, name: e.target.value } : x) })} />
              <input style={{ width: 120 }} value={a.amount} onChange={(e) => setF({ ...f, allowances: f.allowances.map((x: any, j: number) => j === k ? { ...x, amount: e.target.value } : x) })} />
              <label className="row small"><input type="checkbox" checked={a.taxable} onChange={(e) => setF({ ...f, allowances: f.allowances.map((x: any, j: number) => j === k ? { ...x, taxable: e.target.checked } : x) })} /> tính thuế</label>
              <label className="row small"><input type="checkbox" checked={a.insurable} onChange={(e) => setF({ ...f, allowances: f.allowances.map((x: any, j: number) => j === k ? { ...x, insurable: e.target.checked } : x) })} /> đóng BH</label>
              <button className="ghost" onClick={() => setF({ ...f, allowances: f.allowances.filter((_: any, j: number) => j !== k) })}>Xóa</button>
            </div>
          ))}
          <div className="row"><button onClick={() => setF({ ...f, allowances: [...f.allowances, { name: '', amount: 0, taxable: true, insurable: false }] })}>Thêm phụ cấp</button>
            <span className="grow" /><button onClick={() => setF(null)}>Hủy</button><button className="primary" onClick={save}>Lưu</button></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Nhân viên</th><th>Hợp đồng</th><th>Cách trả</th><th>Lương / tiền ca</th><th>Phụ cấp cố định</th><th>NPT</th><th></th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.staff_id}>
              <td>{r.full_name}<div className="small muted">{r.code} · {r.title}</div></td>
              <td className="small">{CONTRACT[r.contract_type] ?? <span className="badge far">chưa ghi</span>}</td>
              <td>{r.pay_type ? (r.pay_type === 'ca' ? 'Theo ca' : 'Tháng') : <span className="badge">chưa có hồ sơ</span>}</td>
              <td>{r.pay_type === 'ca' ? money(r.shift_rate) : r.pay_type ? money(r.base_salary) : ''}</td>
              <td className="small">{(r.allowances ?? []).map((a: any) => `${a.name} ${money(a.amount)}`).join(' · ')}</td>
              <td>{r.dependents ?? ''}</td>
              <td className="right">{edit && <button onClick={() => start(r)}>{r.pay_type ? 'Sửa' : 'Nhập'}</button>}</td>
            </tr>
          ))}</tbody>
        </table>
        <div className="small muted">Loại hợp đồng sửa ở Nhân sự → Nhân viên. Hợp đồng xác định và không xác định thời hạn trả lương tháng thì đóng BHXH; thử việc, cộng tác viên khấu trừ thuế 10% từ 2 triệu.</div>
      </div>
    </div>
  );
}

function Settings({ role, run }: Ctx) {
  const edit = ['accountant', 'director'].includes(role);
  const [s, setS] = useState<any>(null);
  useEffect(() => { api<any>('GET', '/api/payroll/settings').then((r) => setS(r.settings)).catch(() => {}); }, []);
  if (!s) return <div className="panel">Đang tải…</div>;
  const num = (k: string, label: string) => (
    <label className="field">{label}<input value={s[k]} disabled={!edit} onChange={(e) => setS({ ...s, [k]: n(e.target.value) })} /></label>
  );
  const rate = (g: 'empRates' | 'erRates', k: string, label: string) => (
    <label className="field">{label} (%)<input value={s[g][k]} disabled={!edit} onChange={(e) => setS({ ...s, [g]: { ...s[g], [k]: Number(e.target.value.replace(',', '.')) || 0 } })} /></label>
  );
  return (
    <div className="panel col">
      <div className="alert amber small">Các số mặc định là bản nháp theo hiểu biết hiện có (lương cơ sở, lương tối thiểu vùng I, mức giảm trừ gia cảnh, biểu thuế 5 bậc). Kế toán đối chiếu văn bản đang hiệu lực và quy chế lương của đơn vị rồi sửa trước khi tính lương thật.</div>
      <h3 style={{ margin: 0 }}>Công và phụ cấp</h3>
      <div className="grid4">{num('standardDays', 'Ngày công chuẩn')}{num('nightAllowance', 'Phụ cấp mỗi ca đêm')}{num('duty24Allowance', 'Phụ cấp mỗi ca trực 24h')}{num('tripAllowance', 'Phụ cấp mỗi chuyến')}</div>
      <h3 style={{ margin: 0 }}>Bảo hiểm</h3>
      <div className="grid4">{num('baseWage', 'Lương cơ sở (trần BHXH, BHYT ×20)')}{num('regionMinWage', 'Lương tối thiểu vùng (trần BHTN ×20)')}</div>
      <div className="grid4">{rate('empRates', 'bhxh', 'NLĐ BHXH')}{rate('empRates', 'bhyt', 'NLĐ BHYT')}{rate('empRates', 'bhtn', 'NLĐ BHTN')}</div>
      <div className="grid4">{rate('erRates', 'bhxh', 'Đơn vị BHXH')}{rate('erRates', 'bhyt', 'Đơn vị BHYT')}{rate('erRates', 'bhtn', 'Đơn vị BHTN')}{rate('erRates', 'kpcd', 'Kinh phí công đoàn')}</div>
      <h3 style={{ margin: 0 }}>Thuế thu nhập cá nhân</h3>
      <div className="grid4">{num('selfDeduction', 'Giảm trừ bản thân / tháng')}{num('dependentDeduction', 'Giảm trừ mỗi người phụ thuộc')}{num('flatThreshold', 'Khấu trừ 10% từ mức')}</div>
      <table className="small" style={{ maxWidth: 420 }}>
        <thead><tr><th>Đến (đ/tháng)</th><th>Thuế suất %</th></tr></thead>
        <tbody>{s.brackets.map((b: any, k: number) => (
          <tr key={k}>
            <td><input value={b.upTo ?? ''} placeholder="trở lên" disabled={!edit || k === s.brackets.length - 1} onChange={(e) => setS({ ...s, brackets: s.brackets.map((x: any, j: number) => j === k ? { ...x, upTo: n(e.target.value) } : x) })} /></td>
            <td><input value={b.rate} disabled={!edit} style={{ width: 70 }} onChange={(e) => setS({ ...s, brackets: s.brackets.map((x: any, j: number) => j === k ? { ...x, rate: Number(e.target.value) || 0 } : x) })} /></td>
          </tr>
        ))}</tbody>
      </table>
      {edit && <div><button className="primary" onClick={() => run(async () => setS(await api('PUT', '/api/payroll/settings', s)), 'Đã lưu tham số. Bảng lương nháp cần tính lại để áp dụng.')}>Lưu tham số</button></div>}
    </div>
  );
}
