import { useLive } from '../api';
import { FleetTable } from '../components/FleetTable';
import { MapView } from '../components/MapView';
import { useBoard } from './Eoc';

/** Bảng trạng thái đội xe thời gian thực cho EOC và Ban Giám đốc (mục 5.12) */
export function Board() {
  const { board, onEvent } = useBoard();
  const connected = useLive(onEvent);
  const counts = board?.vehicles.reduce<Record<string, number>>((m, v) => {
    const k = ['S1', 'S2'].includes(v.status) ? 'free' : v.status === 'S9' ? 'off' : 'busy';
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {}) ?? {};
  return (
    <div className="col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Bảng đội xe</h2>
        <div className="row small">
          <span className="badge" style={{ color: 'var(--ok)' }}>Rảnh {counts.free ?? 0}</span>
          <span className="badge" style={{ color: 'var(--p1)' }}>Đang làm {counts.busy ?? 0}</span>
          <span className="badge">Ngoài hoạt động {counts.off ?? 0}</span>
          <span className="badge">Cuộc gọi chờ {board?.waitingCalls ?? 0}</span>
          <span><span className={`live-dot ${connected ? 'on' : ''}`} />{connected ? 'Cập nhật trực tiếp' : 'Mất kết nối'}</span>
        </div>
      </div>
      <MapView className="map-big" vehicles={board?.vehicles ?? []} zoom={12} />
      <div className="panel" style={{ overflowX: 'auto' }}>
        <FleetTable board={board} />
        <div className="small muted" style={{ marginTop: 8 }}>
          Giờ rảnh là ước tính theo trung vị thời gian từng trạng thái trong 90 ngày (dùng số mặc định khi chưa đủ dữ liệu); kíp có thể báo “rảnh trong 5 phút”.
        </div>
      </div>
    </div>
  );
}
