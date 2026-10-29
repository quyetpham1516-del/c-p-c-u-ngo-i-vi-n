import { useEffect, useState } from 'react';
import { api, download, session } from '../api';
import { SOURCE_NAME, type RegistryDef } from './RegistryForm';

const money = (n: number | null) => (n == null ? '—' : `${Math.round(n).toLocaleString('vi-VN')} đ`);

/**
 * Số ca theo bệnh viện và người nhập, tách theo biểu mẫu và nguồn ca (xe 115, tự đến): căn cứ thanh toán cho người nhập.
 * Ca tự đến tính cho người tạo; ca xe 115 tính cho người điền làm biểu mẫu đủ. Chỉ ca đủ của tài khoản bệnh viện mới có tiền.
 */
export function RegistryContributors({ defs, hospitals }: { defs: RegistryDef[]; hospitals?: { id: number; name: string }[] }) {
  const role = session.user?.role ?? '';
  const canPay = ['admin', 'director', 'accountant'].includes(role);
  const isHospital = role === 'hospital';
  const month = new Date().toISOString().slice(0, 7);
  const [f, setF] = useState({ from: `${month}-01`, to: '', registry: '', source: '', hospitalId: '' });
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  const load = () => api<any[]>('GET', `/api/registry/contributors?${qs}`).then(setRows).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, [qs]);
  const nameOf = (code: string) => defs.find((d) => d.code === code)?.name ?? code;
  const sum = (k: string) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);

  const pay = async (r?: any) => {
    const scope = r ? `${r.full_name} (${nameOf(r.registry)}, ${SOURCE_NAME[r.source]})` : 'mọi người trong bộ lọc';
    if (!confirm(`Đánh dấu đã trả cho ${scope}? Mỗi ca chỉ trả một lần.`)) return;
    setMsg('');
    try {
      const body = { from: f.from || undefined, to: f.to || undefined, registry: r?.registry ?? (f.registry || undefined), source: r?.source ?? (f.source || undefined),
        hospitalId: f.hospitalId ? Number(f.hospitalId) : undefined, userId: r?.user_id ?? undefined };
      const res = await api('POST', '/api/registry/payouts', body);
      setMsg(`Đã đánh dấu trả ${res.cases} ca, tổng ${money(res.total)}`); load();
    } catch (e: any) { setMsg(e.message); }
  };

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>{isHospital ? 'Số ca bệnh viện đã nhập' : 'Người nhập và thanh toán'}</h3>
      <div className="small muted">Ca tự đến tính cho người tạo phiếu; ca xe 115 tính cho người điền làm biểu mẫu đủ. Chỉ ca đã đủ của tài khoản bệnh viện mới tính tiền,
        theo đơn giá từng biểu mẫu. Lọc theo ngày ca đủ (ca chưa đủ theo ngày tạo).</div>
      <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        <label className="row small" style={{ gap: 4 }}>Từ<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="row small" style={{ gap: 4 }}>Đến<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <select value={f.registry} onChange={(e) => setF({ ...f, registry: e.target.value })}>
          <option value="">Mọi biểu mẫu</option>{defs.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
        </select>
        <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
          <option value="">Mọi nguồn ca</option>{Object.entries(SOURCE_NAME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {hospitals && (
          <select value={f.hospitalId} onChange={(e) => setF({ ...f, hospitalId: e.target.value })}>
            <option value="">Mọi bệnh viện</option>{hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        )}
        {!isHospital && <button onClick={() => download(`/api/registry/contributors?${qs}&format=csv`, `bang-ke-nhap-lieu-${f.from || 'all'}-${f.to || 'all'}.csv`).catch((e) => setMsg(e.message))}>Xuất bảng kê</button>}
        {canPay && sum('due') > 0 && <button onClick={() => pay()}>Đánh dấu đã trả tất cả ({money(sum('due'))})</button>}
      </div>
      {msg && <div className="small" style={{ marginTop: 6 }}>{msg}</div>}
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table>
          <thead><tr><th>Bệnh viện</th><th>Người nhập</th><th>Biểu mẫu</th><th>Nguồn</th><th>Số ca</th><th>Đủ</th><th>Đã trả</th><th>Đơn giá</th><th>Còn phải trả</th>{canPay && <th />}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.hospital_name ?? '—'}</td>
                <td>{r.full_name ?? <span className="muted">Chưa có (ca chưa đủ)</span>}{r.role && r.role !== 'hospital' && <div className="small muted">Nhân viên trung tâm, không tính tiền</div>}</td>
                <td className="small">{nameOf(r.registry)}</td>
                <td>{SOURCE_NAME[r.source]}</td>
                <td>{r.total}</td>
                <td>{r.complete}</td>
                <td>{r.paid}{r.paid > 0 && <div className="small muted">{money(r.paid_amount)}</div>}</td>
                <td className="small">{r.rate == null ? <span className="muted">Chưa đặt</span> : money(r.rate)}</td>
                <td><b>{r.due ? money(r.due) : '—'}</b>{r.due ? <div className="small muted">{r.unpaid} ca</div> : null}</td>
                {canPay && <td>{r.due > 0 && <button className="ghost" onClick={() => pay(r)}>Đã trả</button>}</td>}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={canPay ? 10 : 9} className="muted">Không có ca nào trong khoảng này.</td></tr>}
            {rows.length > 1 && (
              <tr><td colSpan={4}><b>Tổng</b></td><td><b>{sum('total')}</b></td><td><b>{sum('complete')}</b></td><td><b>{sum('paid')}</b></td><td /><td><b>{money(sum('due'))}</b></td>{canPay && <td />}</tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
