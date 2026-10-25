import { useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import { API_BASE } from '../api';

interface Kiosk { station: { id: string; name: string }; token: string; refreshInMs: number; serverTime: string; recent: { name: string; kind: 'vao' | 'ra'; at: string }[] }

const keyName = (id: string) => `medone.kiosk.${id}`;
const hm = (d: string | number | Date, sec = false) => new Date(d).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) });

/**
 * Máy chấm công đặt ở trạm (máy tính bảng, không đăng nhập): hiện mã QR đổi mỗi 30 giây.
 * Khóa máy lấy từ đường dẫn nhân sự cấp (sau dấu #), lưu vào máy rồi xóa khỏi thanh địa chỉ.
 */
export function AttendanceKiosk() {
  const stationId = new URLSearchParams(window.location.search).get('tram') ?? '';
  const [key] = useState(() => {
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('k');
    try {
      if (fromHash) { localStorage.setItem(keyName(stationId), fromHash); history.replaceState(null, '', window.location.pathname + window.location.search); }
      return fromHash ?? localStorage.getItem(keyName(stationId));
    } catch { return fromHash; }
  });
  const [data, setData] = useState<Kiosk | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [nextAt, setNextAt] = useState(0);

  useEffect(() => {
    if (!stationId || !key) return;
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/attendance/kiosk/${encodeURIComponent(stationId)}`, { headers: { 'x-kiosk-key': key } });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error ?? `Lỗi ${res.status}`);
        setData(json); setError('');
        setNextAt(Date.now() + json.refreshInMs);
        // Đổi mã đúng lúc sang bước mới; giữa chừng cập nhật danh sách người vừa quét mỗi 5 giây
        if (!stop) timer = window.setTimeout(tick, Math.min(json.refreshInMs + 300, 5000));
      } catch (e) {
        setData(null); setError((e as Error).message);
        if (!stop) timer = window.setTimeout(tick, 5000);
      }
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [stationId, key]);

  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // Giữ màn hình máy tính bảng luôn sáng
  useEffect(() => {
    let lock: any;
    const req = () => (navigator as any).wakeLock?.request('screen').then((l: any) => { lock = l; }).catch(() => {});
    req();
    const onVis = () => { if (document.visibilityState === 'visible') req(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); lock?.release?.(); };
  }, []);

  if (!stationId || !key) {
    return (
      <div className="kiosk"><div className="panel col" style={{ maxWidth: 520 }}>
        <h2 style={{ margin: 0 }}>Máy chấm công chưa được cấp</h2>
        <div>Phòng Nhân sự vào <b>Nhân sự → Chấm công QR</b>, chọn trạm và bấm <b>Cấp máy chấm công</b>, rồi mở đường dẫn được cấp trên máy tính bảng này.</div>
      </div></div>
    );
  }

  const left = Math.max(0, Math.ceil((nextAt - now) / 1000));
  let svg = '';
  if (data) {
    const q = qrcode(0, 'M');
    q.addData(`${window.location.origin}/cham-cong?m=${encodeURIComponent(data.token)}`);
    q.make();
    svg = q.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  }
  return (
    <div className="kiosk">
      <div className="kiosk-head">
        <div><div className="kiosk-station">{data?.station.name ?? stationId}</div><div className="muted">Chấm công vào / ra ca</div></div>
        <div className="kiosk-clock">{hm(now, true)}</div>
      </div>
      {error && <div className="alert red" style={{ fontSize: 18 }}>{error}</div>}
      <div className="kiosk-body">
        <div className="col" style={{ alignItems: 'center' }}>
          {data ? <span className="kiosk-qr" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="kiosk-qr kiosk-off">{error ? 'Mất kết nối' : 'Đang tải…'}</div>}
          {data && <div className="kiosk-bar"><span style={{ width: `${(left / 30) * 100}%` }} /></div>}
          <div className="kiosk-help">Mở camera điện thoại, quét mã. Điện thoại cần đăng nhập Medone và bật định vị.</div>
        </div>
        <div className="panel col kiosk-recent">
          <h3 style={{ margin: 0 }}>Vừa chấm công</h3>
          {data?.recent.length ? data.recent.map((r, i) => (
            <div key={i} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{r.name}</span><span><span className={`badge ${r.kind === 'vao' ? 'green' : ''}`}>{r.kind === 'vao' ? 'Vào' : 'Ra'}</span> <span className="mono">{hm(r.at)}</span></span>
            </div>
          )) : <div className="muted">Chưa có ai trong 12 giờ qua.</div>}
        </div>
      </div>
    </div>
  );
}
