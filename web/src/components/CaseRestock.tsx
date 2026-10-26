'use client';
import { Fragment, useEffect, useState } from 'react';
import { api, fmtTime } from '../api';

interface Pending { id: string; transfer_number: string | null; signed_at: string; incident_code: string | null; items: number }
interface Line { drug_id: number; drug_name: string; unit: string; kind: string; controlled: boolean; group_name: string; used: number; missing: number; in_station: number }

/**
 * Danh sách bù sau ca: mỗi ca đã ký có dùng cơ số trên xe hiện thành một danh sách, chi tiết tới từng bơm kim tiêm,
 * băng cá nhân. Điều dưỡng lấy từ kho điểm, đánh dấu từng dòng rồi xác nhận; máy trừ kho điểm, cộng lên xe.
 */
export function CaseRestock({ vehicleId }: { vehicleId: string }) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [witness, setWitness] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<Pending[]>('GET', `/api/stock/vehicle/${encodeURIComponent(vehicleId)}/pending-restock`).then(setPending).catch(() => {});
  useEffect(() => { load(); }, [vehicleId]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setMsg(''); setChecked({});
    const r = await api<{ items: Line[] }>('GET', `/api/transfers/${id}/restock`);
    setLines(r.items); setOpen(id);
  };
  const confirm = async () => {
    setMsg('');
    try {
      const items = lines.filter((l) => checked[l.drug_id]).map((l) => ({ drugId: l.drug_id, qty: l.used }));
      const r = await api<{ unfilled: { drug: string; missing: number }[] }>('POST', `/api/transfers/${open}/restock`, { witness: witness || null, items });
      setMsg(r.unfilled.length ? `Đã bù. Kho điểm không đủ: ${r.unfilled.map((u) => `${u.drug} (${u.missing})`).join(', ')}. Báo dược sĩ.` : 'Đã bù xong, xe đủ lại theo ca này.');
      setOpen(null); load();
    } catch (e) { setMsg((e as Error).message); }
  };
  if (!pending.length && !msg) return null;
  const needWitness = lines.some((l) => l.controlled && checked[l.drug_id]);
  let group = '';
  return (
    <div className="panel col" style={{ borderLeft: '4px solid var(--warn)' }}>
      <h3 style={{ margin: 0 }}>Danh sách bù sau ca {pending.length > 0 && <span className="badge far">{pending.length} ca chưa bù</span>}</h3>
      {msg && <div className="alert blue small">{msg}</div>}
      {pending.map((p) => (
        <div key={p.id} className="col">
          <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => show(p.id)}>
            <span>{open === p.id ? '▾' : '▸'} Phiếu <b>{p.transfer_number ?? p.incident_code}</b> · ký {fmtTime(p.signed_at)}</span>
            <span className="small muted">{p.items} mặt hàng</span>
          </div>
          {open === p.id && (
            <>
              <table className="sheet">
                <thead><tr><th>✓</th><th>Mặt hàng</th><th className="right">Đã dùng</th><th>ĐVT</th><th className="right">Kho điểm còn</th></tr></thead>
                <tbody>{lines.map((l) => {
                  const head = l.group_name !== group ? (group = l.group_name) : null;
                  return (
                    <Fragment key={l.drug_id}>
                      {head && <tr className="group-row"><td colSpan={5}><b>{head}</b></td></tr>}
                      <tr style={checked[l.drug_id] ? { opacity: 0.55 } : undefined}>
                        <td><input type="checkbox" checked={!!checked[l.drug_id]} onChange={(ev) => setChecked({ ...checked, [l.drug_id]: ev.target.checked })} /></td>
                        <td>{l.drug_name}{l.controlled && <span className="badge far" style={{ marginLeft: 6 }}>KSĐB</span>}</td>
                        <td className="right mono"><b>{l.used}</b></td>
                        <td className="small">{l.unit}</td>
                        <td className={`right mono small ${l.in_station < l.used ? 'red' : ''}`}>{l.in_station}</td>
                      </tr>
                    </Fragment>
                  );
                })}</tbody>
              </table>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="ghost small" onClick={() => setChecked(Object.fromEntries(lines.map((l) => [l.drug_id, true])))}>Đánh dấu hết</button>
                <input placeholder={needWitness ? 'Người chứng kiến (bắt buộc: thuốc kiểm soát)' : 'Người chứng kiến'} value={witness} onChange={(ev) => setWitness(ev.target.value)} />
                <button className="primary" disabled={!lines.some((l) => checked[l.drug_id]) || (needWitness && !witness.trim())} onClick={confirm}>Xác nhận đã bù các dòng đánh dấu</button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
