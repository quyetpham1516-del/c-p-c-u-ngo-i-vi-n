'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { lookupIcd, searchIcd } from '../catalog';

/**
 * Ô mã ICD-10: gõ mã (ví dụ I21.9 hoặc I219) thì tên bệnh tự hiện; gõ chữ thì gợi ý mã theo tên bệnh.
 * onResolved trả về mã chuẩn và tên bệnh để điền vào chẩn đoán.
 */
export function IcdInput({ value, onChange, onResolved, disabled }: {
  value: string; disabled?: boolean;
  onChange: (code: string) => void;
  onResolved: (code: string, name: string) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'missing'>('idle');
  const [options, setOptions] = useState<{ code: string; name: string }[]>([]);
  const listId = useId();
  const resolved = useRef(onResolved);
  resolved.current = onResolved;

  useEffect(() => {
    const v = value.trim();
    if (!v) { setName(null); setState('idle'); setOptions([]); return; }
    const t = setTimeout(async () => {
      if (/^[A-Za-z]\d{2}/.test(v)) {
        setState('loading');
        const r = await lookupIcd(v);
        if (r) {
          setName(r.name); setState('idle');
          if (r.code !== v) onChange(r.code);
          resolved.current(r.code, r.name);
        } else { setName(null); setState('missing'); }
        setOptions(v.length < 5 ? await searchIcd(v) : []);
      } else {
        setName(null); setState('idle');
        setOptions(await searchIcd(v));
      }
    }, 300);
    return () => clearTimeout(t);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ width: '100%' }}>
      <input list={listId} value={value} disabled={disabled} placeholder="Gõ mã (I21.9) hoặc tên bệnh"
        onChange={(e) => {
          const raw = e.target.value;
          const hit = options.find((o) => `${o.code} – ${o.name}` === raw);
          onChange(hit ? hit.code : raw);
        }} />
      <datalist id={listId}>
        {options.map((o) => <option key={o.code} value={`${o.code} – ${o.name}`} />)}
      </datalist>
      <div className="small" style={{ marginTop: 2, minHeight: 16 }}>
        {state === 'loading' && <span className="muted">Đang tra mã…</span>}
        {state === 'missing' && <span style={{ color: 'var(--p1, #b91c1c)' }}>Không có mã này trong danh mục ICD-10 Bộ Y tế</span>}
        {name && <span><b>{value.toUpperCase()}</b> {name}</span>}
      </div>
    </div>
  );
}
