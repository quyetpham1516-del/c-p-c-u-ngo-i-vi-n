'use client';
import { useId, useMemo } from 'react';
import { useHospitals } from '../catalog';

/**
 * Chọn bệnh viện nhận (gõ để lọc trong danh mục do quản trị quản lý) và khoa nhận.
 * Gõ tên ngoài danh mục vẫn được, nhưng hiện cảnh báo để điều phối kiểm tra lại.
 */
export function HospitalPicker({ hospital, department, onChange, disabled }: {
  hospital: string; department: string; disabled?: boolean;
  onChange: (hospital: string, department: string) => void;
}) {
  const list = useHospitals();
  const listId = useId();
  const match = useMemo(() => list.find((h) => h.name.toLowerCase() === hospital.trim().toLowerCase()), [list, hospital]);
  const depts = match?.departments ?? [];
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
      <input
        className="grow" list={listId} placeholder="Gõ tên bệnh viện để chọn" value={hospital} disabled={disabled}
        onChange={(e) => {
          const name = e.target.value;
          const h = list.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
          const keep = h?.departments.some((d) => d.name === department);
          onChange(name, keep ? department : (h?.departments.find((d) => /c[aấ]p c[uứ]u/i.test(d.name))?.name ?? ''));
        }}
      />
      <datalist id={listId}>
        {list.map((h) => <option key={h.id} value={h.name}>{[h.kcb_code, h.address].filter(Boolean).join(' · ')}</option>)}
      </datalist>
      <select value={department} disabled={disabled || !depts.length} onChange={(e) => onChange(hospital, e.target.value)} style={{ minWidth: 180 }}>
        <option value="">{depts.length ? '— Khoa nhận —' : 'Chọn bệnh viện trước'}</option>
        {depts.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
        {department && !depts.some((d) => d.name === department) && <option value={department}>{department}</option>}
      </select>
      {hospital.trim().length > 2 && list.length > 0 && !match && (
        <div className="small" style={{ color: 'var(--amber, #b45309)', width: '100%' }}>Bệnh viện này chưa có trong danh mục. Kiểm tra lại tên hoặc báo quản trị bổ sung.</div>
      )}
      {match?.capabilities?.length ? <div className="small muted" style={{ width: '100%' }}>{match.capabilities.join(' · ')}</div> : null}
    </div>
  );
}
