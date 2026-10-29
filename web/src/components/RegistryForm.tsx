import { useEffect, useState } from 'react';
import { api, fmtDateTime, session } from '../api';

export interface RegistryField { key: string; label: string; type: 'bool' | 'number' | 'text' | 'date' | 'datetime' | 'select'; options?: [string, string][]; part: 'truoc_vien' | 'trong_vien' | 'tu_den'; required?: boolean; when?: [string, string] }
export interface RegistryDef { code: string; name: string; criteria: string; fields: RegistryField[]; collecting?: boolean }

export const REGISTRY_STATUS: Record<string, [string, string]> = {
  cho_bo_sung: ['Chờ bổ sung', 'red'], dang_bo_sung: ['Đang bổ sung', 'amber'], du: ['Đã đủ', 'green'],
};

let defsCache: Promise<RegistryDef[]> | null = null;
export function useRegistryDefs() {
  const [defs, setDefs] = useState<RegistryDef[]>([]);
  useEffect(() => {
    defsCache ??= api<RegistryDef[]>('GET', '/api/registry/defs').catch((e) => { defsCache = null; throw e; });
    defsCache.then(setDefs).catch(() => {});
  }, []);
  return defs;
}

export const SOURCE_NAME: Record<string, string> = { xe_115: 'Xe 115', tu_den: 'Tự đến' };
export function SourceBadge({ source }: { source: string }) {
  return <span className={`badge ${source === 'tu_den' ? 'blue' : ''}`}>{SOURCE_NAME[source] ?? source}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const [label, color] = REGISTRY_STATUS[status] ?? [status, ''];
  return <span className={`badge ${color}`}>{label}</span>;
}

const SEX: Record<string, string> = { M: 'Nam', F: 'Nữ', U: 'Chưa rõ' };
const shown = (f: RegistryField, data: Record<string, any>) => !f.when || String(data[f.when[0]] ?? '') === f.when[1];

/** Phần trước viện chụp từ phiếu lúc ký: ai cũng chỉ xem */
function Prehospital({ p }: { p: any }) {
  const v = p.firstVitals ?? {};
  const arrest = p.arrest ?? {};
  const rows: [string, any][] = [
    ['Số phiếu', p.transferNumber], ['Mã ca', p.incidentCode], ['Tuổi, giới', [p.age, SEX[p.sex]].filter(Boolean).join(', ')],
    ['Lý do', p.chiefComplaint], ['Chẩn đoán', [p.diagnosis, p.icd10].filter(Boolean).join(' · ')],
    ['Sinh hiệu đầu', [v.hr && `M ${v.hr}`, v.sbp && `HA ${v.sbp}/${v.dbp ?? ''}`, v.spo2 && `SpO2 ${v.spo2}%`, v.gcs && `GCS ${v.gcs}`].filter(Boolean).join(', ')],
    ['Bàn giao', p.handoverAt ? fmtDateTime(p.handoverAt) : null],
    ...(p.arrest ? [['Ngừng tuần hoàn', [arrest.witnessed && `chứng kiến: ${arrest.witnessed}`, arrest.firstRhythm && `nhịp đầu: ${arrest.firstRhythm}`,
      arrest.roscAny != null && (arrest.roscAny ? 'có ROSC trước viện' : 'không ROSC trước viện')].filter(Boolean).join(', ')] as [string, any]] : []),
    ...(p.fast ? [['FAST', ['F', 'A', 'S'].filter((k) => p.fast[k.toLowerCase()]).join(', ') || 'âm tính'] as [string, any], ['Đường máu', p.glucose]] as [string, any][] : []),
    ...(p.trauma ? [['Chấn thương', (p.trauma.types ?? []).join(', ')] as [string, any], ['GCS', p.gcs]] as [string, any][] : []),
  ];
  return (
    <table className="small"><tbody>
      {rows.filter(([, val]) => val !== null && val !== undefined && val !== '').map(([k, val]) => <tr key={k}><td className="muted" style={{ width: 140 }}>{k}</td><td>{String(val)}</td></tr>)}
    </tbody></table>
  );
}

function Input({ f, value, onChange, disabled }: { f: RegistryField; value: any; onChange: (v: any) => void; disabled: boolean }) {
  if (f.type === 'bool') {
    return (
      <select value={value === true ? 'true' : value === false ? 'false' : ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}>
        <option value="">—</option><option value="true">Có</option><option value="false">Không</option>
      </select>
    );
  }
  if (f.type === 'select') {
    return (
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">—</option>{f.options!.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    );
  }
  const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : 'text';
  return <input type={type} value={value ?? ''} disabled={disabled}
    onChange={(e) => onChange(e.target.value === '' ? null : f.type === 'number' ? Number(e.target.value) : e.target.value)} />;
}

/**
 * Một ca trong biểu mẫu nghiên cứu: phần trước viện (từ phiếu) và phần trong viện. Bệnh viện chỉ sửa phần trong viện;
 * bác sĩ, điều phối của trung tâm sửa cả hai.
 */
export function RegistryForm({ caseId, defs, onSaved }: { caseId: string; defs: RegistryDef[]; onSaved?: (c: any) => void }) {
  const [c, setC] = useState<any>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setC(null); setDraft({}); setMsg('');
    api('GET', `/api/registry/cases/${caseId}`).then(setC).catch((e) => setMsg(e.message));
  }, [caseId]);
  const def = defs.find((d) => d.code === c?.registry);
  if (!c || !def) return <div className="panel">{msg || 'Đang tải…'}</div>;
  const isHospital = session.user?.role === 'hospital';
  const walkIn = c.source === 'tu_den';
  const data = { ...(c.data ?? {}), ...draft };
  const dirty = Object.keys(draft).length > 0;
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const next = await api('PUT', `/api/registry/cases/${caseId}`, draft);
      setC(next); setDraft({}); onSaved?.(next);
      setMsg(next.status === 'du' ? 'Đã lưu: biểu mẫu đã đủ' : 'Đã lưu');
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  const TITLE = { tu_den: 'Thông tin khi tới khoa cấp cứu', truoc_vien: walkIn ? 'Trước khi tới viện' : 'Phần trước viện bổ sung', trong_vien: 'Phần trong viện' };
  const part = (p: 'truoc_vien' | 'trong_vien' | 'tu_den') => {
    const fields = def.fields.filter((f) => f.part === p && shown(f, data));
    if (!fields.length) return null;
    const locked = isHospital && !walkIn && p === 'truoc_vien';
    return (
      <>
        <h4 style={{ margin: '12px 0 4px' }}>{TITLE[p]}{locked && <span className="small muted"> (trung tâm điền)</span>}</h4>
        <div className="grid3">
          {fields.map((f) => (
            <label key={f.key} className="field">{f.label}{f.required && <b style={{ color: 'var(--danger)' }}> *</b>}
              <Input f={f} value={data[f.key]} disabled={locked} onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} />
            </label>
          ))}
        </div>
      </>
    );
  };
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{def.name}</b>
        <span><StatusBadge status={c.status} />{c.updated_by_name && <span className="small muted"> · {c.updated_by_name} {fmtDateTime(c.updated_at)}</span>}</span>
      </div>
      {walkIn ? (
        <div className="small" style={{ marginTop: 6 }}>
          <SourceBadge source="tu_den" /> {c.hospital_name} · Số hồ sơ <b className="mono">{c.hospital_record_no}</b>
          {c.created_by_name && <span className="muted"> · Người tạo: {c.created_by_name}, {fmtDateTime(c.created_at)}</span>}
          {c.paid_at && <span className="badge green" style={{ marginLeft: 6 }}>Đã thanh toán {fmtDateTime(c.paid_at)}</span>}
        </div>
      ) : (
        <>
          <h4 style={{ margin: '8px 0 4px' }}>Trước viện (từ phiếu chuyển viện)</h4>
          <Prehospital p={c.prehospital ?? {}} />
        </>
      )}
      {walkIn && part('tu_den')}
      {part('truoc_vien')}
      {part('trong_vien')}
      {c.missing?.length > 0 && !dirty && <div className="small muted" style={{ marginTop: 6 }}>Còn thiếu: {c.missing.join(', ')}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={!dirty || busy} onClick={save}>Lưu</button>
        {dirty && <button className="ghost" onClick={() => setDraft({})}>Bỏ thay đổi</button>}
        {msg && <span className="small">{msg}</span>}
      </div>
    </div>
  );
}

/**
 * Tạo ca tự đến (người dân tự đưa tới khoa cấp cứu): chọn biểu mẫu đang lấy số liệu, nhập số hồ sơ bệnh viện. Tạo xong
 * thì mở phiếu để điền đủ các phần.
 */
export function WalkInCreate({ defs, hospitals, onCreated }: { defs: RegistryDef[]; hospitals?: { id: number; name: string }[]; onCreated: (c: any) => void }) {
  const open = defs.filter((d) => d.collecting);
  const [f, setF] = useState({ registry: '', hospitalRecordNo: '', hospitalId: '' });
  const [msg, setMsg] = useState('');
  const registry = f.registry || open[0]?.code || '';
  if (!open.length) return <div className="small muted">Chưa có biểu mẫu nào đang lấy số liệu nên chưa tạo được ca tự đến.</div>;
  const create = async () => {
    setMsg('');
    try {
      const c = await api('POST', '/api/registry/walk-in', { registry, hospitalRecordNo: f.hospitalRecordNo.trim(), ...(hospitals ? { hospitalId: Number(f.hospitalId) } : {}) });
      setF({ ...f, hospitalRecordNo: '' }); onCreated(c);
    } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select value={registry} onChange={(e) => setF({ ...f, registry: e.target.value })}>
          {open.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
        </select>
        {hospitals && (
          <select value={f.hospitalId} onChange={(e) => setF({ ...f, hospitalId: e.target.value })}>
            <option value="">Chọn bệnh viện</option>{hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        )}
        <input placeholder="Số hồ sơ / số vào viện" value={f.hospitalRecordNo} onChange={(e) => setF({ ...f, hospitalRecordNo: e.target.value })} />
        <button className="primary" disabled={!f.hospitalRecordNo.trim() || (!!hospitals && !f.hospitalId)} onClick={create}>Tạo ca tự đến</button>
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>Số hồ sơ chỉ dùng để chặn nhập trùng, không đưa vào file xuất nghiên cứu. Không ghi họ tên người bệnh.</div>
      {msg && <div className="error">{msg}</div>}
    </div>
  );
}
