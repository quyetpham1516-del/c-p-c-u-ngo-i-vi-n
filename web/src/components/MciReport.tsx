'use client';
import { useEffect, useState } from 'react';
import { api, fmtTime } from '../api';

const COLORS: [key: 'red' | 'yellow' | 'green' | 'black', label: string, tone: string][] = [
  ['red', 'Đỏ (nặng, cấp cứu ngay)', 'red'], ['yellow', 'Vàng (trì hoãn được)', 'amber'], ['green', 'Xanh (nhẹ, tự đi được)', 'green'], ['black', 'Đen (tử vong, không cứu được)', ''],
];
const EMPTY = { red: 0, yellow: 0, green: 0, black: 0, commanderPresent: false, commanderName: '', commanderUnit: '', commanderPhone: '', hazards: '', access: '', resourcesNeeded: '', note: '' };

/**
 * Báo nhanh hiện trường nhiều nạn nhân: số nạn nhân theo màu phân loại, chỉ huy hiện trường (họ tên, đơn vị, SĐT),
 * nguy hiểm, đường vào, lực lượng cần thêm. Gửi về điều phối; lần báo đầu kích hoạt quy trình đông nạn nhân.
 */
export function MciReport({ incidentId, onSent }: { incidentId: string; onSent?: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [last, setLast] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    api<any>('GET', `/api/ops/mci/${incidentId}/scene-report`).then((r) => {
      if (!r) return;
      setLast(r);
      setF({ red: r.red, yellow: r.yellow, green: r.green, black: r.black, commanderPresent: r.commander_present, commanderName: r.commander_name ?? '',
        commanderUnit: r.commander_unit ?? '', commanderPhone: r.commander_phone ?? '', hazards: r.hazards ?? '', access: r.access ?? '', resourcesNeeded: r.resources_needed ?? '', note: r.note ?? '' });
    }).catch(() => {});
  }, [open, incidentId]);
  const total = f.red + f.yellow + f.green + f.black;
  const step = (k: typeof COLORS[number][0], d: number) => setF({ ...f, [k]: Math.max(0, f[k] + d) });
  const send = async () => {
    setMsg(''); setBusy(true);
    try {
      const r = await api<{ activated: boolean; level: number }>('POST', `/api/ops/mci/${incidentId}/scene-report`, f);
      setMsg(r.activated ? 'Đã gửi. Điều phối đã nhận và quy trình đông nạn nhân được kích hoạt.' : `Đã gửi cập nhật cho điều phối (mức ${r.level}).`);
      setLast({ ...f, created_at: new Date().toISOString() });
      onSent?.();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="panel col" style={open ? { borderLeft: '4px solid var(--danger)' } : undefined}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className={open ? 'ghost' : 'danger'} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} Nhiều nạn nhân</button>
        {last?.created_at && <span className="small muted">Đã báo lúc {fmtTime(last.created_at, false)}</span>}
      </div>
      {open && (
        <>
          <div className="grid4">
            {COLORS.map(([k, label, tone]) => (
              <div key={k} className={`panel col ${tone}`} style={{ alignItems: 'center' }}>
                <div className="small">{label}</div>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <button className="big" onClick={() => step(k, -1)}>−</button>
                  <input style={{ width: 64, fontSize: 24, textAlign: 'center' }} inputMode="numeric" value={f[k]}
                    onChange={(e) => setF({ ...f, [k]: Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0) })} />
                  <button className="big" onClick={() => step(k, 1)}>+</button>
                </div>
              </div>
            ))}
          </div>
          <div className="small">Tổng {total} nạn nhân · nặng (đỏ + vàng) {f.red + f.yellow}</div>
          <div className="row">
            <b>Chỉ huy hiện trường</b>
            <label className="row small"><input type="radio" checked={!f.commanderPresent} onChange={() => setF({ ...f, commanderPresent: false })} /> Chưa có</label>
            <label className="row small"><input type="radio" checked={f.commanderPresent} onChange={() => setF({ ...f, commanderPresent: true })} /> Đã có</label>
          </div>
          {f.commanderPresent && (
            <div className="grid3">
              <label className="field">Họ tên<input value={f.commanderName} onChange={(e) => setF({ ...f, commanderName: e.target.value })} /></label>
              <label className="field">Đơn vị (CSGT, PCCC, y tế...)<input value={f.commanderUnit} onChange={(e) => setF({ ...f, commanderUnit: e.target.value })} /></label>
              <label className="field">Số điện thoại<input inputMode="tel" value={f.commanderPhone} onChange={(e) => setF({ ...f, commanderPhone: e.target.value })} /></label>
            </div>
          )}
          <div className="grid3">
            <label className="field">Nguy hiểm tại hiện trường<input placeholder="Cháy, hóa chất, sập, giao thông..." value={f.hazards} onChange={(e) => setF({ ...f, hazards: e.target.value })} /></label>
            <label className="field">Đường vào, điểm tập kết xe<input value={f.access} onChange={(e) => setF({ ...f, access: e.target.value })} /></label>
            <label className="field">Cần thêm lực lượng<input placeholder="Số xe, cứu hỏa, công an..." value={f.resourcesNeeded} onChange={(e) => setF({ ...f, resourcesNeeded: e.target.value })} /></label>
          </div>
          <input placeholder="Ghi chú khác" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <div className="row">
            <button className="danger big" disabled={busy || total === 0 || (f.commanderPresent && !f.commanderName.trim())} onClick={send}>Gửi về điều phối</button>
            {msg && <span className="small">{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}
