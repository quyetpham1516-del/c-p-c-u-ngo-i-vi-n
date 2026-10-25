'use client';
import { useEffect, useState } from 'react';
import { API_BASE } from '../api';
import { Brand } from '../Logo';

/**
 * Trang công khai cho bệnh viện nhận người bệnh: nhập hoặc quét mã in trên phiếu chuyển viện để biết phiếu do Medone phát hành,
 * đã ký, đúng phiên bản. Chỉ hiện tên viết tắt và năm sinh, không có chẩn đoán.
 */
export function Verify() {
  const initial = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('ma') ?? '' : '';
  const [code, setCode] = useState(initial);
  const [r, setR] = useState<any>(null);
  const [error, setError] = useState('');
  const check = async (c: string) => {
    setError(''); setR(null);
    try {
      const res = await fetch(`${API_BASE}/api/public/verify/${encodeURIComponent(c.trim())}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'Không tra cứu được');
      setR(j);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { if (initial) check(initial); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const at = (s?: string | null) => (s ? new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  return (
    <div className="col" style={{ maxWidth: 520, margin: '24px auto', padding: '0 16px' }}>
      <Brand />
      <h2 style={{ margin: 0 }}>Kiểm tra phiếu chuyển viện</h2>
      <div className="small muted">Nhập mã xác thực in góc trên bên phải phiếu (10 ký tự), hoặc quét mã QR trên phiếu.</div>
      <div className="row">
        <input className="grow mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCDE-FGHJK" />
        <button className="primary" disabled={code.replace(/[^0-9A-Z]/gi, '').length < 10} onClick={() => check(code)}>Kiểm tra</button>
      </div>
      {error && <div className="error">{error}</div>}
      {r && !r.found && <div className="alert red">Không tìm thấy phiếu đã ký với mã này. Phiếu có thể bị làm giả hoặc nhập sai mã: gọi tổng đài Medone để xác minh.</div>}
      {r?.found && (
        <div className="panel col">
          <div className="alert green">Phiếu thật, do Medone phát hành và đã ký điện tử.</div>
          <div>Số chuyển viện: <b>{r.transferNumber}</b></div>
          <div>Người bệnh: <b>{r.patient.initials ?? '—'}</b>{r.patient.birthYear ? `, sinh năm ${r.patient.birthYear}` : ''}{r.patient.sex === 'M' ? ', nam' : r.patient.sex === 'F' ? ', nữ' : ''}</div>
          <div>Ký lúc {at(r.signedAt)}{r.signedBy ? ` bởi ${r.signedBy}` : ''}{r.vehicleId ? ` · xe ${r.vehicleId}` : ''}</div>
          <div>Bệnh viện nhận: {r.hospital ?? '—'}{r.handoverAt ? ` · bàn giao ${at(r.handoverAt)}` : ''}</div>
          <div>{r.amendments ? <b>Phiếu đã bổ sung {r.amendments} lần sau khi ký; đối chiếu với bản in mới nhất.</b> : 'Chưa bổ sung sau khi ký.'}</div>
          {r.hashPrefix && <div className="small muted">Dấu nội dung: <span className="mono">{r.hashPrefix}</span></div>}
          <div className="small muted">Thông tin trên đây khớp với bản in thì phiếu hợp lệ. Trang này không hiển thị chẩn đoán hay thông tin định danh.</div>
        </div>
      )}
    </div>
  );
}
