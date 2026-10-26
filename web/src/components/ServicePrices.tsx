'use client';
import { useEffect, useState } from 'react';
import { api } from '../api';

interface Row { id: number; code: string; name: string; unit: string; price: number; care_key: string | null; lab_type: string | null; active: boolean; note: string | null; updated_by_name: string | null }
interface Resp { rows: Row[]; care: Record<string, string>; labs: { code: string; name: string }[] }
const money = (n: number) => Number(n).toLocaleString('vi-VN');

/**
 * Bảng giá dịch vụ kỹ thuật: mỗi dòng gắn với một ô can thiệp hoặc một loại cận lâm sàng trên phiếu, ký phiếu thì
 * tự cộng vào khoản thu. Admin, kế toán, giám đốc chỉnh được; khoản thu đã sinh giữ giá cũ.
 */
export function ServicePrices({ canEdit }: { canEdit: boolean }) {
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState('');
  const [f, setF] = useState({ code: '', name: '', unit: 'lần', price: '', link: '' });
  const load = () => api<Resp>('GET', '/api/finance/service-prices').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); await load(); } catch (e) { setErr((e as Error).message); } };
  if (!d) return err ? <div className="error">{err}</div> : null;
  const linkLabel = (r: Row) => (r.care_key ? `Can thiệp: ${d.care[r.care_key] ?? r.care_key}` : r.lab_type ? `Cận lâm sàng: ${d.labs.find((l) => l.code === r.lab_type)?.name ?? r.lab_type} (mỗi kết quả)` : 'Kế toán thêm tay');
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <h3 style={{ marginTop: 0 }}>Bảng giá dịch vụ kỹ thuật</h3>
      <div className="small muted">Ký phiếu thì tự cộng vào khoản thu theo can thiệp đã đánh dấu và số kết quả cận lâm sàng. Thuốc, vật tư tính tiền riêng chỉnh ở Kho thuốc → Danh mục (đánh dấu "tính tiền riêng", giá bán). Giá mẫu là bản nháp.</div>
      {err && <div className="error">{err}</div>}
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>Mã</th><th>Dịch vụ</th><th>Tính khi</th><th>ĐVT</th><th className="right">Đơn giá (đ)</th><th>Dùng</th></tr></thead>
        <tbody>{d.rows.map((r) => (
          <tr key={r.id} style={r.active ? undefined : { opacity: 0.5 }}>
            <td className="mono small">{r.code}</td>
            <td>{canEdit ? <input defaultValue={r.name} onBlur={(e) => e.target.value !== r.name && run(() => api('PATCH', `/api/finance/service-prices/${r.id}`, { name: e.target.value }))} /> : r.name}</td>
            <td className="small">{linkLabel(r)}</td>
            <td className="small">{r.unit}</td>
            <td className="right">{canEdit
              ? <input style={{ width: 110, textAlign: 'right' }} inputMode="numeric" defaultValue={r.price} onBlur={(e) => {
                  const v = Number(e.target.value.replace(/\D/g, ''));
                  if (Number.isFinite(v) && v !== r.price) run(() => api('PATCH', `/api/finance/service-prices/${r.id}`, { price: v }));
                }} />
              : money(r.price)}</td>
            <td>{canEdit ? <input type="checkbox" checked={r.active} onChange={() => run(() => api('PATCH', `/api/finance/service-prices/${r.id}`, { active: !r.active }))} /> : r.active ? 'Có' : 'Không'}</td>
          </tr>
        ))}</tbody>
      </table>
      {canEdit && (
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <input style={{ width: 100 }} placeholder="Mã" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          <input placeholder="Tên dịch vụ" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input style={{ width: 70 }} placeholder="ĐVT" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
          <input style={{ width: 110 }} placeholder="Đơn giá" inputMode="numeric" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/\D/g, '') })} />
          <select value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })}>
            <option value="">Không tự tính (kế toán thêm tay)</option>
            <optgroup label="Khi đánh dấu can thiệp">{Object.entries(d.care).map(([k, v]) => <option key={k} value={`care:${k}`}>{v}</option>)}</optgroup>
            <optgroup label="Theo số kết quả cận lâm sàng">{d.labs.map((l) => <option key={l.code} value={`lab:${l.code}`}>{l.name}</option>)}</optgroup>
          </select>
          <button className="primary" disabled={!/^[A-Z0-9_]{2,30}$/.test(f.code) || f.name.trim().length < 2 || f.price === ''} onClick={() => run(async () => {
            const [k, v] = f.link.split(':');
            await api('POST', '/api/finance/service-prices', { code: f.code, name: f.name, unit: f.unit || 'lần', price: Number(f.price), careKey: k === 'care' ? v : null, labType: k === 'lab' ? v : null });
            setF({ code: '', name: '', unit: 'lần', price: '', link: '' });
          })}>Thêm dịch vụ</button>
        </div>
      )}
    </div>
  );
}
