import { useEffect, useState } from 'react';
import { api, download, fmtDateTime, session } from '../api';
import { useHospitals } from '../catalog';
import { REGISTRY_STATUS, RegistryForm, StatusBadge, useRegistryDefs } from '../components/RegistryForm';

/**
 * Biểu mẫu nghiên cứu: Utstein (ngừng tuần hoàn), PATOS (chấn thương), đột quỵ. Admin, Ban Giám đốc bật, tắt từng biểu mẫu
 * và chọn khoảng thời gian lấy số liệu; bác sĩ, điều phối bổ sung ca; QLCL xuất số liệu.
 */
export function Research() {
  const role = session.user?.role ?? '';
  const canSet = ['admin', 'director'].includes(role);
  const canAdd = ['dispatcher', 'supervisor', 'qa', 'admin', 'director'].includes(role);
  const canExport = ['supervisor', 'qa', 'admin', 'director'].includes(role);
  const defs = useRegistryDefs();
  const hospitals = useHospitals();
  const [settings, setSettings] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [filter, setFilter] = useState({ registry: '', status: 'chua_du', hospitalId: '', from: '', to: '' });
  const [sel, setSel] = useState<string | null>(null);
  const [add, setAdd] = useState({ registry: 'utstein', transferNumber: '' });
  const [msg, setMsg] = useState('');

  const loadSettings = () => api<any[]>('GET', '/api/registry/settings').then(setSettings).catch((e) => setMsg(e.message));
  const loadCases = () => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
    return api<any[]>('GET', `/api/registry/cases?${qs}`).then(setCases).catch((e) => setMsg(e.message));
  };
  useEffect(() => { loadSettings(); }, []);
  useEffect(() => { loadCases(); }, [filter]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg('');
    try { await fn(); if (ok) setMsg(ok); await Promise.all([loadSettings(), loadCases()]); } catch (e: any) { setMsg(e.message); }
  };
  const saveSetting = (s: any, patch: any) => run(() => api('PUT', `/api/registry/settings/${s.code}`, {
    enabled: s.enabled, startOn: s.start_on?.slice(0, 10) ?? null, endOn: s.end_on?.slice(0, 10) ?? null, note: s.note ?? null, ...patch,
  }));
  const nameOf = (code: string) => defs.find((d) => d.code === code)?.name ?? code;

  return (
    <div>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Biểu mẫu nghiên cứu</h2>
        <div className="small muted">Biểu mẫu đang bật thì ca đúng tiêu chí tự vào khi ký phiếu. Phần trong viện do bệnh viện nhận điền qua tài khoản bệnh viện
          (mã QR trên phiếu in), hoặc bác sĩ, điều phối của trung tâm điền thay.</div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table>
            <thead><tr><th>Biểu mẫu</th><th>Lấy số liệu</th><th>Từ ngày</th><th>Đến ngày</th><th>Số ca</th></tr></thead>
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
        {msg && <div className="small" style={{ marginTop: 6 }}>{msg}</div>}
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table>
            <thead><tr><th>Số phiếu</th><th>Biểu mẫu</th><th>Bệnh viện nhận</th><th>Tuổi, chẩn đoán</th><th>Trạng thái</th><th>Vào biểu mẫu</th></tr></thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} onClick={() => setSel(c.id)} style={{ cursor: 'pointer', background: c.id === sel ? 'var(--panel-2)' : undefined }}>
                  <td className="mono">{c.transfer_number}<div className="small muted">{c.incident_code}</div></td>
                  <td>{nameOf(c.registry)}</td>
                  <td>{c.hospital_name ?? <span className="muted">Chưa gắn</span>}</td>
                  <td className="small">{[c.age && `${c.age} tuổi`, c.diagnosis].filter(Boolean).join(' · ')}</td>
                  <td><StatusBadge status={c.status} /></td>
                  <td className="small">{fmtDateTime(c.created_at)}</td>
                </tr>
              ))}
              {cases.length === 0 && <tr><td colSpan={6} className="muted">Không có ca nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {sel && <RegistryForm key={sel} caseId={sel} defs={defs} onSaved={loadCases} />}
    </div>
  );
}
