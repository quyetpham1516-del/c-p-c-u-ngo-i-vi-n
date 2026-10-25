'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Chữ ký điện tử của người bệnh, người nhà hoặc bên nhận ngay trên máy tính bảng.
 * Lời cam kết đi kèm được lưu nguyên văn cùng chữ ký (máy chủ băm lại khi ký phiếu), chạy được cả khi mất mạng.
 * Nội dung giữ khớp với SIGNATURE_KIND ở máy chủ (server/src/safety.ts).
 */
export const SIGNATURE_KIND: Record<string, { label: string; statement: string; detail?: string }> = {
  dong_y_thu_thuat: {
    label: 'Đồng ý thủ thuật, can thiệp',
    statement: 'Tôi đã được nhân viên y tế giải thích về tình trạng bệnh, thủ thuật/can thiệp dự kiến, lợi ích và nguy cơ có thể xảy ra. Tôi đồng ý thực hiện.',
    detail: 'Thủ thuật, can thiệp',
  },
  tu_choi_van_chuyen: {
    label: 'Từ chối vận chuyển, từ chối điều trị',
    statement: 'Tôi đã được nhân viên y tế giải thích rõ tình trạng bệnh và nguy cơ (kể cả nguy cơ tử vong) nếu không được vận chuyển, điều trị. Tôi vẫn từ chối và tự chịu trách nhiệm.',
    detail: 'Từ chối điều gì',
  },
  nhan_ban_giao: {
    label: 'Bệnh viện nhận bàn giao người bệnh',
    statement: 'Tôi xác nhận đã nhận bàn giao người bệnh cùng tình trạng, hồ sơ và thuốc đã dùng như ghi trên phiếu.',
  },
};

export type Signature = {
  id: string; kind: string; signerName: string; relation?: string; statement: string; detail?: string;
  image: string; signedAt: string; witness?: string; hash?: string;
};

/** Ô ký bằng ngón tay hoặc bút; trả về ảnh PNG */
function Pad({ onChange }: { onChange: (png: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);
  useEffect(() => {
    const c = ref.current!;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const g = c.getContext('2d')!;
    g.scale(ratio, ratio);
    g.lineWidth = 2.5; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#111';
  }, []);
  const pos = (ev: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top] as const;
  };
  const down = (ev: React.PointerEvent) => {
    ev.preventDefault();
    ref.current!.setPointerCapture(ev.pointerId);
    drawing.current = true;
    const g = ref.current!.getContext('2d')!;
    const [x, y] = pos(ev);
    g.beginPath(); g.moveTo(x, y);
  };
  const move = (ev: React.PointerEvent) => {
    if (!drawing.current) return;
    const g = ref.current!.getContext('2d')!;
    const [x, y] = pos(ev);
    g.lineTo(x, y); g.stroke();
    inked.current = true;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (inked.current) onChange(ref.current!.toDataURL('image/png'));
  };
  const clear = () => {
    const c = ref.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    inked.current = false;
    onChange(null);
  };
  return (
    <div className="col" style={{ gap: 4 }}>
      <canvas ref={ref} className="sig-pad" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
      <div className="row"><span className="small muted">Ký bằng ngón tay hoặc bút trong khung</span><button type="button" className="ghost small" onClick={clear}>Ký lại</button></div>
    </div>
  );
}

export function SignaturesSection({ value, locked, onChange, suggest }: {
  value: Signature[]; locked: boolean; onChange: (v: Signature[]) => void; suggest?: string;
}) {
  const [f, setF] = useState<{ kind: string; signerName: string; relation: string; detail: string; witness: string; image: string | null } | null>(null);
  const start = (kind: string) => setF({ kind, signerName: '', relation: kind === 'nhan_ban_giao' ? 'Bác sĩ/điều dưỡng tiếp nhận' : 'Người bệnh', detail: '', witness: '', image: null });
  const save = () => {
    if (!f?.image) return;
    const k = SIGNATURE_KIND[f.kind];
    onChange([...value, {
      id: crypto.randomUUID(), kind: f.kind, signerName: f.signerName.trim(), relation: f.relation || undefined, statement: k.statement,
      detail: f.detail || undefined, witness: f.witness || undefined, image: f.image, signedAt: new Date().toISOString(),
    }]);
    setF(null);
  };
  return (
    <div className="panel col">
      <h3 style={{ margin: 0 }}>Chữ ký của người bệnh, người nhà, bên nhận</h3>
      {value.map((s) => (
        <div key={s.id} className="row sig-item">
          <img src={s.image} alt={`Chữ ký ${s.signerName}`} />
          <div className="small grow">
            <b>{SIGNATURE_KIND[s.kind]?.label}</b>{s.detail ? `: ${s.detail}` : ''}
            <div>{s.signerName}{s.relation ? ` (${s.relation})` : ''} · {new Date(s.signedAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })}{s.witness ? ` · chứng kiến: ${s.witness}` : ''}</div>
            {s.hash && <div className="muted mono">đã cố định khi ký phiếu</div>}
          </div>
          {!locked && !s.hash && <button type="button" className="ghost small" onClick={() => onChange(value.filter((x) => x.id !== s.id))}>Xóa</button>}
        </div>
      ))}
      {!value.length && <div className="small muted">Chưa có chữ ký.</div>}
      {!locked && !f && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {Object.entries(SIGNATURE_KIND).map(([k, v]) => <button type="button" key={k} className={suggest === k ? 'primary' : ''} onClick={() => start(k)}>Ký: {v.label}</button>)}
        </div>
      )}
      {f && (
        <div className="col">
          <div className="alert blue small"><b>{SIGNATURE_KIND[f.kind].label}.</b> {SIGNATURE_KIND[f.kind].statement}</div>
          <div className="grid2">
            <label className="field">Họ tên người ký<input value={f.signerName} onChange={(ev) => setF({ ...f, signerName: ev.target.value })} /></label>
            <label className="field">Quan hệ với người bệnh, chức danh<input value={f.relation} onChange={(ev) => setF({ ...f, relation: ev.target.value })} /></label>
            {SIGNATURE_KIND[f.kind].detail && <label className="field">{SIGNATURE_KIND[f.kind].detail}<input value={f.detail} onChange={(ev) => setF({ ...f, detail: ev.target.value })} /></label>}
            {f.kind !== 'nhan_ban_giao' && <label className="field">Người chứng kiến (nếu có)<input value={f.witness} onChange={(ev) => setF({ ...f, witness: ev.target.value })} /></label>}
          </div>
          <Pad onChange={(png) => setF((x) => x && { ...x, image: png })} />
          <div className="row">
            <button type="button" className="primary" disabled={!f.image || f.signerName.trim().length < 2} onClick={save}>Lưu chữ ký</button>
            <button type="button" className="ghost" onClick={() => setF(null)}>Bỏ</button>
          </div>
        </div>
      )}
    </div>
  );
}
