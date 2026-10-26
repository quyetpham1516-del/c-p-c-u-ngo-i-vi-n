'use client';
import { Fragment, useMemo, useState } from 'react';

export interface ParItem {
  drug_id: number; drug_name: string; unit: string; controlled: boolean; kind: string; code: string | null; group_code: string; group_name: string;
  par: number; on_vehicle: number; in_station: number; missing: number; nearest_expiry: string | null;
}

const fmt = (n: number) => Number(n).toLocaleString('vi-VN');
const soon = (d: string | null) => !!d && new Date(d).getTime() - Date.now() < 90 * 86400_000;

/**
 * Cơ số xe dạng bảng tính chia theo nhóm (thuốc, vật tư, văn phòng phẩm...): thu gọn từng nhóm, chỉ hiện dòng thiếu,
 * đánh dấu từng dòng khi kiểm đầu ca, in ra giấy
 */
export function ParSheet({ items, title }: { items: ParItem[]; title?: string }) {
  const [q, setQ] = useState('');
  const [onlyShort, setOnlyShort] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const groups = useMemo(() => {
    const out: { code: string; name: string; rows: ParItem[]; short: number }[] = [];
    for (const it of items) {
      if (q && !`${it.drug_name} ${it.code ?? ''}`.toLowerCase().includes(q.toLowerCase())) continue;
      if (onlyShort && !it.missing) continue;
      let g = out.find((x) => x.code === it.group_code);
      if (!g) { g = { code: it.group_code, name: it.group_name, rows: [], short: 0 }; out.push(g); }
      g.rows.push(it);
      if (it.missing) g.short++;
    }
    return out;
  }, [items, q, onlyShort]);
  const done = Object.values(checked).filter(Boolean).length;
  let n = 0;
  return (
    <div className="col print-page">
      {title && <h3 style={{ margin: 0 }}>{title}</h3>}
      <div className="row no-print" style={{ flexWrap: 'wrap' }}>
        <input placeholder="Tìm tên hoặc mã hàng" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="row small"><input type="checkbox" checked={onlyShort} onChange={(e) => setOnlyShort(e.target.checked)} /> Chỉ hiện dòng thiếu</label>
        <button className="ghost small" onClick={() => setClosed(Object.fromEntries(groups.map((g) => [g.code, true])))}>Thu gọn hết</button>
        <button className="ghost small" onClick={() => setClosed({})}>Mở hết</button>
        <button className="ghost small" onClick={() => window.print()}>In bảng kiểm</button>
        <span className="small muted">Đã kiểm {done}/{items.length} dòng</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="sheet">
          <thead><tr><th className="no-print">✓</th><th>STT</th><th>Tên hàng</th><th>ĐVT</th><th className="right">Cơ số chuẩn</th><th className="right">Trên xe</th>
            <th className="right">Thiếu</th><th>Hạn gần nhất</th><th className="right">Kho điểm còn</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.code}>
                <tr className="group-row" onClick={() => setClosed({ ...closed, [g.code]: !closed[g.code] })} style={{ cursor: 'pointer' }}>
                  <td colSpan={9}><b>{closed[g.code] ? '▸' : '▾'} {g.name}</b> <span className="small muted">({g.rows.length} mặt hàng)</span>
                    {g.short > 0 && <span className="badge far" style={{ marginLeft: 8 }}>Thiếu {g.short}</span>}</td>
                </tr>
                {!closed[g.code] && g.rows.map((it) => {
                  n++;
                  return (
                    <tr key={it.drug_id} style={checked[it.drug_id] ? { opacity: 0.55 } : undefined}>
                      <td className="no-print"><input type="checkbox" checked={!!checked[it.drug_id]} onChange={(e) => setChecked({ ...checked, [it.drug_id]: e.target.checked })} /></td>
                      <td className="mono small">{n}</td>
                      <td>{it.drug_name}{it.controlled && <span className="badge far" style={{ marginLeft: 6 }}>KSĐB</span>}{it.code && <span className="small muted mono"> · {it.code}</span>}</td>
                      <td className="small">{it.unit}</td>
                      <td className="right mono">{fmt(it.par)}</td>
                      <td className="right mono">{fmt(it.on_vehicle)}</td>
                      <td className={`right mono ${it.missing ? 'red' : ''}`} style={it.missing ? { fontWeight: 700 } : undefined}>{it.missing ? fmt(it.missing) : '—'}</td>
                      <td className={`mono small ${soon(it.nearest_expiry) ? 'red' : ''}`}>{it.nearest_expiry ?? '—'}</td>
                      <td className="right mono small">{fmt(it.in_station)}</td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {!items.length && <div className="small muted">Loại xe này chưa có cơ số chuẩn (Kho thuốc → Định mức, cơ số chuẩn).</div>}
    </div>
  );
}
