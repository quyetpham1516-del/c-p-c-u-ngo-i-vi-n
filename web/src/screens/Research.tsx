import { useEffect, useState } from 'react';
import { api, download, fmtDateTime, session } from '../api';
import { useHospitals } from '../catalog';
import { RegistryContributors } from '../components/RegistryContributors';
import { REGISTRY_STATUS, RegistryForm, SOURCE_NAME, SourceBadge, StatusBadge, useRegistryDefs, WalkInCreate } from '../components/RegistryForm';

/**
 * Biểu mẫu nghiên cứu: Utstein (ngừng tuần hoàn), PATOS (chấn thương), đột quỵ. Admin, Ban Giám đốc bật, tắt từng biểu mẫu
 * và chọn khoảng thời gian lấy số liệu; bác sĩ, điều phối bổ sung ca; QLCL xuất số liệu.
 */
export function Research() {
  const role = session.user?.role ?? '';
  const canSet = ['admin', 'director'].includes(role);
  const canAdd = ['dispatcher', 'supervisor', 'qa', 'admin', 'director'].includes(role);
  const canExport = ['supervisor', 'qa', 'admin', 'director'].includes(role);
  const canWalkIn = canExport;
  const canSeePay = ['admin', 'director', 'accountant', 'qa'].includes(role);
  const defs = useRegistryDefs();
  const hospitals = useHospitals();
  const [settings, setSettings] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [filter, setFilter] = useState({ registry: '', status: 'chua_du', hospitalId: '', from: '', to: '', source: '' });
  const [rates, setRates] = useState<Record<string, string>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [add, setAdd] = useState({ registry: 'utstein', transferNumber: '' });
  const [msg, setMsg] = useState('');

  const loadSettings = () => api<any[]>('GET', '/api/registry/settings').then(setSettings).catch((e) => setMsg(e.message));
  const loadCases = () => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
    return api<any[]>('GET', `/api/registry/cases?${qs}`).then(setCases).catch((e) => setMsg(e.message));
  };
  const payOnly = role === 'accountant';
  useEffect(() => { if (!payOnly) loadSettings(); }, []);
  useEffect(() => { if (!payOnly) loadCases(); }, [filter]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg('');
    try { await fn(); if (ok) setMsg(ok); await Promise.all([loadSettings(), loadCases()]); } catch (e: any) { setMsg(e.message); }
  };
  const saveSetting = (s: any, patch: any) => run(() => api('PUT', `/api/registry/settings/${s.code}`, {
    enabled: s.enabled, startOn: s.start_on?.slice(0, 10) ?? null, endOn: s.end_on?.slice(0, 10) ?? null, note: s.note ?? null, ...patch,
  }));
  const nameOf = (code: string) => defs.find((d) => d.code === code)?.name ?? code;

  // Kế toán chỉ xem bảng kê người nhập để thanh toán
  if (payOnly) return <RegistryContributors defs={defs} hospitals={hospitals} />;

  return (
    <div>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Biểu mẫu nghiên cứu</h2>
        <div className="small muted">Biểu mẫu đang bật thì ca đúng tiêu chí tự vào khi ký phiếu. Phần trong viện do bệnh viện nhận điền qua tài khoản bệnh viện
          (mã QR trên phiếu in), hoặc bác sĩ, điều phối của trung tâm điền thay.</div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table>
            <thead><tr><th>Biểu mẫu</th><th>Lấy số liệu</th><th>Từ ngày</th><th>Đến ngày</th><th>Số ca</th>
              <th title="Trả cho người nhập mỗi ca đủ; để trống là chưa đặt">Đơn giá ca tự đến</th><th title="Trả cho người điền phần trong viện mỗi ca đủ">Đơn giá ca xe 115</th></tr></thead>
            <tbody>{settings.map((s) => (
              <tr key={s.code}>
                <td><b>{nameOf(s.code)}</b><div className="small muted">{defs.find((d) => d.code === s.code)?.criteria}</div></td>
                <td>
                  <label className="row" style={{ gap: 6 }}>
                    <input type="checkbox" checked={s.enabled} disabled={!canSet} onChange={(e) => saveSetting(s, { enabled: e.target.checked })} />
                    {s.collecting ? <span className="badge green">Đang lấy</span> : s.enabled ? <span className="badge amber">Bật, ngoài khoảng ngày</span> : <span className="badge">Tắt</span>}
                  </label>
                  {s.updated_by_name && <div className="small muted">{s.updated_by_name} · {fmtDateTime(s.updated_at)}</div>}
                </td>
                <td><input type="date" value={s.start_on?.slice(0, 10) ?? ''} disabled={!canSet} onChange={(e) => saveSetting(s, { startOn: e.target.value || null })} /></td>
                <td><input type="date" value={s.end_on?.slice(0, 10) ?? ''} disabled={!canSet} onChange={(e) => saveSetting(s, { endOn: e.target.value || null })} /></td>
                <td>{s.cases}{s.open_cases > 0 && <span className="small muted"> ({s.open_cases} chưa đủ)</span>}</td>
                {(['rate_walk_in', 'rate_ems'] as const).map((k) => {
                  const key = `${s.code}:${k}`;
                  const val = rates[key] ?? (s[k] == null ? '' : String(Number(s[k])));
                  const commit = () => {
                    if (rates[key] === undefined) return;
                    const n = rates[key].trim() === '' ? null : Number(rates[key]);
                    setRates(({ [key]: _, ...rest }) => rest);
                    if (n !== null && (!Number.isInteger(n) || n < 0)) { setMsg('Đơn giá phải là số đồng, không âm'); return; }
                    saveSetting(s, { [k === 'rate_walk_in' ? 'rateWalkIn' : 'rateEms']: n });
                  };
                  return <td key={k}><input type="number" min={0} step={1000} style={{ width: 110 }} placeholder="Chưa đặt" value={val} disabled={!canSet}
                    onChange={(e) => setRates({ ...rates, [key]: e.target.value })} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} /></td>;
                })}
              </tr>))}</tbody>
          </table>
        </div>
        {!canSet && <div className="small muted">Chỉ Quản trị, Ban Giám đốc bật, tắt biểu mẫu.</div>}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Ca trong biểu mẫu</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select value={filter.registry} onChange={(e) => setFilter({ ...filter, registry: e.target.value })}>
            <option value="">Mọi biểu mẫu</option>{defs.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
          </select>
          <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
            <option value="">Mọi trạng thái</option><option value="chua_du">Chưa đủ</option>
            {Object.entries(REGISTRY_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select value={filter.hospitalId} onChange={(e) => setFilter({ ...filter, hospitalId: e.target.value })}>
            <option value="">Mọi bệnh viện</option>{hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
          <select value={filter.source} onChange={(e) => setFilter({ ...filter, source: e.target.value })}>
            <option value="">Mọi nguồn ca</option>{Object.entries(SOURCE_NAME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <label className="row small" style={{ gap: 4 }}>Từ<input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></label>
          <label className="row small" style={{ gap: 4 }}>Đến<input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></label>
          {canExport && filter.registry && (
            <button onClick={() => download(`/api/registry/export?registry=${filter.registry}${filter.from ? `&from=${filter.from}` : ''}${filter.to ? `&to=${filter.to}` : ''}`,
              `${filter.registry}-${filter.from || 'all'}-${filter.to || 'all'}.csv`).catch((e) => setMsg(e.message))}
            title="Không kèm họ tên, số định danh">Xuất CSV</button>
          )}
          {canExport && !filter.registry && <span className="small muted">Chọn một biểu mẫu để xuất CSV</span>}
        </div>
        {canAdd && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="small">Thêm ca bằng tay:</span>
            <select value={add.registry} onChange={(e) => setAdd({ ...add, registry: e.target.value })}>
              {defs.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
            </select>
            <input placeholder="Số phiếu chuyển viện (vd 2026-00012)" value={add.transferNumber} onChange={(e) => setAdd({ ...add, transferNumber: e.target.value })} />
            <button disabled={!add.transferNumber.trim()} onClick={() => run(async () => {
              const r = await api('POST', '/api/registry/cases', add); setSel(r.id); setAdd({ ...add, transferNumber: '' });
            }, 'Đã thêm ca')}>Thêm</button>
          </div>
        )}
        {canWalkIn && (
          <details style={{ marginTop: 8 }}>
            <summary className="small">Tạo ca tự đến thay bệnh viện</summary>
            <div style={{ marginTop: 6 }}><WalkInCreate defs={defs} hospitals={hospitals} onCreated={(c) => { setSel(c.id); loadCases(); }} /></div>
          </details>
        )}
        {msg && <div className="small" style={{ marginTop: 6 }}>{msg}</div>}
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table>
            <thead><tr><th>Số phiếu / hồ sơ</th><th>Biểu mẫu</th><th>Bệnh viện</th><th>Tuổi, chẩn đoán</th><th>Người nhập</th><th>Trạng thái</th><th>Vào biểu mẫu</th></tr></thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} onClick={() => setSel(c.id)} style={{ cursor: 'pointer', background: c.id === sel ? 'var(--panel-2)' : undefined }}>
                  <td><SourceBadge source={c.source} /> <span className="mono">{c.transfer_number ?? c.hospital_record_no}</span><div className="small muted">{c.incident_code}</div></td>
                  <td>{nameOf(c.registry)}</td>
                  <td>{c.hospital_name ?? <span className="muted">Chưa gắn</span>}</td>
                  <td className="small">{[c.age && `${c.age} tuổi`, c.diagnosis].filter(Boolean).join(' · ')}</td>
                  <td className="small">{c.source === 'tu_den' ? c.created_by_name : c.completed_by_name ?? <span className="muted">—</span>}</td>
                  <td><StatusBadge status={c.status} /></td>
                  <td className="small">{fmtDateTime(c.created_at)}</td>
                </tr>
              ))}
              {cases.length === 0 && <tr><td colSpan={7} className="muted">Không có ca nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {sel && <RegistryForm key={sel} caseId={sel} defs={defs} onSaved={loadCases} />}
      {canSeePay && <RegistryContributors defs={defs} hospitals={hospitals} />}
    </div>
  );
}
