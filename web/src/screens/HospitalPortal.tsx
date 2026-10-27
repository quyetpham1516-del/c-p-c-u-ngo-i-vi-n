import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, fmtDateTime } from '../api';
import { RegistryForm, StatusBadge, useRegistryDefs } from '../components/RegistryForm';

const SEX: Record<string, string> = { M: 'Nam', F: 'Nữ', U: '' };

/** Cổng bệnh viện nhận bệnh: phiếu chuyển viện ca chuyển tới bệnh viện mình, điền phần trong viện của biểu mẫu nghiên cứu */
export function HospitalPortal() {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get('phieu');
  const defs = useRegistryDefs();
  const [me, setMe] = useState<any>(null);
  const [rows, setRows] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');

  const load = () => api<any[]>('GET', `/api/hospital/transfers?days=${days}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { api('GET', '/api/hospital/me').then(setMe).catch(() => {}); }, []);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [q, days]);

  const open = (id: string | null) => router.replace(id ? `/benh-vien?phieu=${id}` : '/benh-vien');
  const cur = rows?.find((r) => r.id === selected);
  const waiting = rows?.filter((r) => r.registries.some((c: any) => c.status !== 'du')).length ?? 0;

  return (
    <div>
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Ca chuyển tới {me?.name ?? 'bệnh viện'}</h2>
          {waiting > 0 && <span className="badge amber">{waiting} ca chờ điền phần trong viện</span>}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input placeholder="Tìm số phiếu, mã ca, họ tên" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d} ngày gần đây</option>)}
          </select>
        </div>
        {error && <div className="error">{error}</div>}
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table>
            <thead><tr><th>Số phiếu</th><th>Người bệnh</th><th>Chẩn đoán trước viện</th><th>Bàn giao</th><th>Biểu mẫu</th></tr></thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id} onClick={() => open(r.id)} style={{ cursor: 'pointer', background: r.id === selected ? 'var(--panel-2)' : undefined }}>
                  <td className="mono">{r.transfer_number}<div className="small muted">{r.incident_code}</div></td>
                  <td>{r.full_name ?? 'Chưa rõ tên'}<div className="small muted">{[r.birth_year, SEX[r.sex]].filter(Boolean).join(' · ')}</div></td>
                  <td>{r.diagnosis ?? '—'}</td>
                  <td className="small">{fmtDateTime(r.handover_at ?? r.signed_at)}</td>
                  <td>{r.registries.map((c: any) => <div key={c.id}><span className="small">{defs.find((d) => d.code === c.registry)?.name ?? c.registry}</span> <StatusBadge status={c.status} /></div>)}</td>
                </tr>
              ))}
              {rows?.length === 0 && <tr><td colSpan={5} className="muted">Chưa có ca nào chuyển tới trong khoảng này.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>Phiếu {cur?.transfer_number ?? ''}</b>
            <span className="row">
              <button onClick={() => window.open(`/phieu/${selected}`, '_blank')}>Xem, in phiếu chuyển viện</button>
              <button className="ghost" onClick={() => open(null)}>Đóng</button>
            </span>
          </div>
          {rows && !cur && <div className="alert amber" style={{ marginTop: 8 }}>Không thấy phiếu này trong danh sách ca chuyển tới bệnh viện của bạn (có thể quá {days} ngày: chọn khoảng dài hơn).</div>}
          {cur?.registries.length === 0 && <div className="small muted" style={{ marginTop: 8 }}>Ca này không thuộc biểu mẫu nghiên cứu nào đang bật.</div>}
        </div>
      )}
      {cur?.registries.map((c: any) => <RegistryForm key={c.id} caseId={c.id} defs={defs} onSaved={load} />)}
      <FormPreview defs={defs} />
    </div>
  );
}

/**
 * Xem trước các biểu mẫu (Utstein, PATOS, đột quỵ): phần bệnh viện sẽ điền. Ca chỉ hiện ở bảng trên sau khi kíp ký phiếu
 * có đúng tiêu chí và ghi đúng tên bệnh viện này, nên khi chưa có ca, bệnh viện vẫn xem được mẫu.
 */
function FormPreview({ defs }: { defs: { code: string; name: string; criteria: string; fields: any[] }[] }) {
  if (!defs.length) return null;
  return (
    <details className="panel">
      <summary><b>Xem mẫu biểu mẫu bệnh viện cần điền</b></summary>
      <div className="small muted" style={{ margin: '6px 0' }}>
        Ca vào biểu mẫu khi kíp ký phiếu chuyển viện có đúng tiêu chí và chọn bệnh viện nhận là bệnh viện này. Khi đó ca hiện ở bảng trên để điền phần trong viện.
      </div>
      {defs.map((d) => (
        <div key={d.code} style={{ marginTop: 8 }}>
          <b>{d.name}</b>
          <div className="small muted">Tiêu chí: {d.criteria}</div>
          <ul className="small" style={{ margin: '4px 0 0 18px' }}>
            {d.fields.filter((f) => f.part === 'trong_vien').map((f) => (
              <li key={f.key}>{f.label}{f.required ? ' *' : ''}{f.options ? `: ${f.options.map((o: [string, string]) => o[1]).join(', ')}` : ''}</li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}
