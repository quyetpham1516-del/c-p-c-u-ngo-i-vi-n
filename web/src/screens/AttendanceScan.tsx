import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '../api';

interface Result { checkedIn: boolean; at: string; since?: string; station: { id: string; name: string }; distance: number | null; flags: string[] }
const FLAG: Record<string, string> = { khong_vi_tri: 'không có vị trí', sai_so_lon: 'vị trí sai số lớn', ra_khac_tram: 'ra ở trạm khác lúc vào' };
const hm = (d: string) => new Date(d).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });

function position(): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 });
  });
}

/** Trang mở ra khi nhân viên quét mã QR trên máy chấm công ở trạm: lấy vị trí rồi gửi mã lên máy chủ */
export function AttendanceScan() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('m'));
  const [stage, setStage] = useState<'gps' | 'send' | 'done' | 'idle'>(token ? 'gps' : 'idle');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<{ msg: string; code?: string } | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    // Bỏ mã khỏi thanh địa chỉ: tải lại trang không gửi lại
    history.replaceState(null, '', '/cham-cong');
    (async () => {
      const p = await position();
      setStage('send');
      try {
        const r = await api<Result>('POST', '/api/attendance/scan', {
          token, lat: p?.coords.latitude ?? null, lng: p?.coords.longitude ?? null, accuracy: p?.coords.accuracy ?? null,
        });
        setResult(r);
      } catch (e) {
        setError({ msg: (e as Error).message, code: e instanceof ApiError ? e.body?.details?.code : undefined });
      }
      setStage('done');
    })();
  }, [token]);

  return (
    <div className="col" style={{ maxWidth: 560 }}>
      <h2 style={{ margin: 0 }}>Chấm công tại trạm</h2>
      {stage === 'gps' && <div className="panel">Đang lấy vị trí… Nếu điện thoại hỏi, chọn <b>Cho phép</b>.</div>}
      {stage === 'send' && <div className="panel">Đang gửi…</div>}
      {result && (
        <div className={`alert ${result.flags.length ? 'amber' : 'green'}`} style={{ fontSize: 20 }}>
          <b>{result.checkedIn ? 'Đã vào ca' : 'Đã ra ca'}</b> lúc {hm(result.at)} tại {result.station.name}
          {result.since && <div className="small">Vào lúc {hm(result.since)}</div>}
          {result.distance != null && <div className="small">Cách trạm khoảng {result.distance} m</div>}
          {result.flags.length > 0 && <div className="small">Nhân sự sẽ xem lại: {result.flags.map((f) => FLAG[f] ?? f).join(', ')}</div>}
        </div>
      )}
      {error && (
        <div className="alert red">
          <div>{error.msg}</div>
          {error.code === 'GPS_REQUIRED' && <div className="small">Bật định vị (Cài đặt → Quyền riêng tư → Dịch vụ định vị) cho trình duyệt rồi quét lại mã.</div>}
          {error.code === 'BAD_TOKEN' && <div className="small">Mã trên máy đổi mỗi 30 giây; quét mã mới nhất.</div>}
        </div>
      )}
      {stage === 'idle' && (
        <div className="panel col">
          <div>Đến trạm, mở camera điện thoại và quét mã QR trên máy chấm công. Trang này sẽ tự mở và ghi giờ vào hoặc ra.</div>
          <div className="small muted">Lần quét đầu trong ngày là vào ca, lần sau là ra ca. Quét lại trong 2 phút không tính.</div>
        </div>
      )}
      <div><Link href="/ca-nhan">Về trang Cá nhân</Link></div>
    </div>
  );
}
