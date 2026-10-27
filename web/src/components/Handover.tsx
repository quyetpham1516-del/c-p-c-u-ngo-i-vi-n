'use client';
import { useEffect, useState } from 'react';
import { api, fmtDateTime, session } from '../api';

const COND: Record<string, string> = { tot: 'Tốt', thieu: 'Thiếu', hong: 'Hỏng', het_han: 'Hết hạn' };

/**
 * Bàn giao xe giữa hai kíp: kíp cũ đếm, ghi tình trạng, ký giao; kíp mới xem, ký nhận thì biên bản khóa.
 * Quá hạn mà chưa xong (khi xe không có ca) thì xe bị khóa không nhận ca được.
 */
export function Handover() {
  const me = session.user?.id;
  const [list, setList] = useState<any[]>([]);
  const [h, setH] = useState<any>(null);
  const [items, setItems] = useState<Record<number, { counted: string; condition: string; note: string }>>({});
  const [eq, setEq] = useState<Record<string, { condition: string; note: string }>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<any[]>('GET', '/api/handovers/mine').then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  const show = async (id: string) => {
    const d = await api('GET', `/api/handovers/${id}`);
    setH(d); setNote('');
    setItems(Object.fromEntries(d.items.map((i: any) => [i.drugId, { counted: String(i.counted ?? i.book), condition: i.condition ?? 'tot', note: i.note ?? '' }])));
    setEq(Object.fromEntries(d.equipment.map((e: any) => [e.id, { condition: e.condition ?? (e.status === 'hoat_dong' ? 'tot' : 'hong'), note: e.note ?? '' }])));
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(''); setMsg('');
    try { await fn(); setMsg(ok); await load(); if (h) await show(h.id); } catch (e) { setError((e as Error).message); }
  };
  if (!list.length) return null;
  const giving = h?.status === 'cho_giao' && h.outgoing.includes(me);
  const receiving = h?.status === 'cho_nhan' && h.incoming.includes(me);

  return (
    <div className="panel col" id="ban-giao">
      <h3 style={{ margin: 0 }}>Bàn giao xe</h3>
      {list.map((x) => (
        <div key={x.id} className="row click" style={{ justifyContent: 'space-between' }} onClick={() => show(x.id).catch((e) => setError(e.message))}>
          <span><b>{x.vehicle_id}</b> · {x.outgoing.includes(me) ? 'bạn giao' : 'bạn nhận'} · {fmtDateTime(x.created_at)}</span>
          <span className={`badge ${x.status === 'da_khoa' ? 'green' : 'amber'}`}>{x.status === 'cho_giao' ? 'Chờ kíp cũ giao' : x.status === 'cho_nhan' ? 'Chờ kíp mới nhận' : 'Đã bàn giao'}</span>
        </div>
      ))}
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {h && (
        <div className="col" style={{ gap: 6 }}>
          <div className="small">
            Kíp giao: {h.outgoing_people?.map((p: any) => p.name).join(', ')} · Kíp nhận: {h.incoming_people?.map((p: any) => p.name).join(', ')}.
            {' '}Người ký: vị trí <b>{h.position}</b> của mỗi kíp.
            {h.status !== 'da_khoa' && <> Hạn {fmtDateTime(h.dueAt)}{h.blocked && <b style={{ color: 'var(--danger)' }}> · xe đang bị khóa</b>}.</>}
          </div>
          <div style={{ overflowX: 'auto', maxHeight: 460 }}>
            <table className="small">
              <thead><tr><th>Thuốc, vật tư</th><th className="right">Cơ số</th><th className="right">Sổ</th><th className="right">Đếm</th><th>Tình trạng</th></tr></thead>
              <tbody>{h.items.map((i: any) => {
                const v = items[i.drugId];
                return (
                  <tr key={i.drugId}>
                    <td>{i.name} <span className="muted">{i.unit}</span></td><td className="right">{i.par}</td><td className="right">{i.book}</td>
                    <td className="right">{giving ? <input type="number" min={0} style={{ width: 70 }} value={v?.counted ?? ''} onChange={(e) => setItems({ ...items, [i.drugId]: { ...v, counted: e.target.value } })} /> : i.counted ?? '—'}</td>
                    <td>{giving
                      ? <select value={v?.condition} onChange={(e) => setItems({ ...items, [i.drugId]: { ...v, condition: e.target.value } })}>{Object.entries(COND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                      : COND[i.condition] ?? '—'}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          {h.equipment.length > 0 && (
            <table className="small">
              <thead><tr><th>Thiết bị</th><th>Số máy</th><th>Tình trạng</th></tr></thead>
              <tbody>{h.equipment.map((e: any) => (
                <tr key={e.id}><td>{e.name}</td><td className="mono">{e.serial}</td>
                  <td>{giving
                    ? <select value={eq[e.id]?.condition} onChange={(x) => setEq({ ...eq, [e.id]: { ...eq[e.id], condition: x.target.value } })}>{Object.entries(COND).filter(([k]) => k !== 'het_han').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                    : COND[e.condition] ?? '—'}</td></tr>
              ))}</tbody>
            </table>
          )}
          {h.giver_signed_at && <div className="small">Giao: {h.giver_name} · {fmtDateTime(h.giver_signed_at)}{h.giver_note && ` · ${h.giver_note}`}</div>}
          {h.receiver_signed_at && <div className="small">Nhận: {h.receiver_name} · {fmtDateTime(h.receiver_signed_at)}{h.receiver_note && ` · ${h.receiver_note}`}</div>}
          {giving && (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <input placeholder="Ghi chú (bắt buộc nếu lệch số hoặc không tốt)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 280 }} />
              <button className="primary" onClick={() => run(() => api('POST', `/api/handovers/${h.id}/give`, {
                note: note || null,
                items: h.items.map((i: any) => ({ drugId: i.drugId, counted: Number(items[i.drugId]?.counted ?? 0), condition: items[i.drugId]?.condition ?? 'tot' })),
                equipment: h.equipment.map((e: any) => ({ id: e.id, condition: eq[e.id]?.condition ?? 'tot' })),
              }), 'Đã ký giao, chờ kíp mới ký nhận')}>Ký giao</button>
            </div>
          )}
          {receiving && (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <input placeholder="Ý kiến (bắt buộc nếu không đồng ý)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 280 }} />
              <button className="primary" onClick={() => run(() => api('POST', `/api/handovers/${h.id}/receive`, { agree: true, note: note || null }), 'Đã ký nhận, biên bản đã khóa')}>Đồng ý, ký nhận</button>
              <button className="danger" disabled={!note.trim()} onClick={() => run(() => api('POST', `/api/handovers/${h.id}/receive`, { agree: false, note }), 'Đã ký nhận kèm ý kiến không đồng ý, đã báo trưởng ca')}>Không đồng ý, ký kèm ý kiến</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
