import { useState } from 'react';
import { api, ApiError } from '../api';

export interface PatientRow { id: string; ba_number: string; full_name: string | null; sex: string | null; birth_year: number | null; id_masked: string | null; id_type: string; is_temporary: boolean; phone: string | null; transfer_count?: number }

/** Tìm bệnh án theo CCCD (hoặc tên, SĐT, Số BA); không có thì tạo mới — một người bệnh chỉ một bệnh án */
export function PatientPicker({ value, label, onPick }: { value: string | null; label: string | null; onPick: (p: PatientRow) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PatientRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<any>({ idType: 'CCCD', sex: 'U' });
  const [msg, setMsg] = useState('');
  const [candidates, setCandidates] = useState<PatientRow[]>([]);

  const search = async () => {
    setMsg('');
    try { setRows(await api('GET', `/api/patients/search?q=${encodeURIComponent(q)}`)); }
    catch (e) { setMsg(navigator.onLine ? (e as Error).message : 'Mất mạng: gắn bệnh án sau khi có mạng, phiếu vẫn được lưu trên máy.'); }
  };

  const create = async (force = false) => {
    setMsg('');
    try {
      const p = await api<PatientRow>('POST', '/api/patients', { ...form, birthYear: form.birthYear ? Number(form.birthYear) : undefined, force });
      onPick(p);
      setCreating(false);
      setCandidates([]);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (e.body?.existing) { setMsg('Người bệnh đã có bệnh án: dùng bệnh án cũ.'); setCandidates([e.body.existing]); }
        else if (e.body?.candidates) { setMsg(e.body.error); setCandidates(e.body.candidates); }
      } else setMsg((e as Error).message);
    }
  };

  const List = ({ items }: { items: PatientRow[] }) => (
    <div className="list">
      {items.map((p) => (
        <div key={p.id} className="item row" style={{ justifyContent: 'space-between' }} onClick={() => onPick(p)}>
          <div>
            <b>{p.ba_number}</b> · {p.full_name ?? 'Chưa rõ tên'} {p.is_temporary && <span className="badge">Bệnh án tạm</span>}
            <div className="small muted">{p.id_type} {p.id_masked ?? ''} · {p.birth_year ?? '—'} · {p.phone ?? ''}{p.transfer_count != null ? ` · ${p.transfer_count} phiếu` : ''}</div>
          </div>
          <button className="primary">Chọn</button>
        </div>
      ))}
    </div>
  );

  return (
    <div className="panel" style={{ background: 'var(--panel-2)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Bệnh án</b>
        {value ? <span className="badge">{label ?? 'Đã gắn'}</span> : <span className="small muted">Chưa gắn</span>}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input className="grow" placeholder="Số CCCD 12 số, họ tên, SĐT hoặc Số BA" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <button onClick={search} disabled={q.trim().length < 2}>Tìm</button>
        <button onClick={() => setCreating((c) => !c)}>{creating ? 'Thôi' : 'Tạo bệnh án mới'}</button>
      </div>
      {rows && <div style={{ marginTop: 8 }}>{rows.length ? <List items={rows} /> : <div className="small muted">Không tìm thấy.</div>}</div>}
      {creating && (
        <div className="col" style={{ marginTop: 8 }}>
          <div className="grid3">
            <label className="field">Loại giấy tờ
              <select value={form.idType} onChange={(e) => setForm({ ...form, idType: e.target.value })}>
                <option value="CCCD">CCCD (12 số)</option>
                <option value="DDCN">Số định danh (trẻ em chưa có thẻ)</option>
                <option value="PASSPORT">Hộ chiếu (người nước ngoài)</option>
                <option value="UNKNOWN">Chưa rõ danh tính (bệnh án tạm)</option>
              </select>
            </label>
            {form.idType !== 'UNKNOWN' && <label className="field">Số<input inputMode={form.idType === 'PASSPORT' ? 'text' : 'numeric'} value={form.idNumber ?? ''} onChange={(e) => setForm({ ...form, idNumber: e.target.value })} /></label>}
            {form.idType === 'PASSPORT' && <label className="field">Quốc tịch<input value={form.nationality ?? ''} onChange={(e) => setForm({ ...form, nationality: e.target.value })} /></label>}
            <label className="field">Họ tên<input placeholder={form.idType === 'UNKNOWN' ? 'VD: Chưa rõ – Nam – khoảng 40 tuổi' : ''} value={form.fullName ?? ''} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></label>
            <label className="field">Năm sinh<input inputMode="numeric" value={form.birthYear ?? ''} onChange={(e) => setForm({ ...form, birthYear: e.target.value })} /></label>
            <label className="field">Giới
              <select value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}><option value="M">Nam</option><option value="F">Nữ</option><option value="U">Chưa rõ</option></select>
            </label>
            <label className="field">Số điện thoại<input value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          </div>
          <button className="primary" onClick={() => create(form.idType === 'UNKNOWN')}>Tạo và gắn vào phiếu</button>
        </div>
      )}
      {msg && <div className="alert amber small" style={{ marginTop: 8 }}>{msg}</div>}
      {candidates.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <List items={candidates} />
          {!candidates.some((c) => c.id_masked && form.idNumber?.endsWith(c.id_masked.slice(-4))) && (
            <button style={{ marginTop: 6 }} onClick={() => create(true)}>Không phải các người này, vẫn tạo mới</button>
          )}
        </div>
      )}
    </div>
  );
}
