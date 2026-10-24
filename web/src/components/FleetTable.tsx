import { fmtDuration, fmtTime, STATUS_LABEL, useNow } from '../api';

export interface BoardVehicle {
  id: string; type: string; type_label: string; plate: string | null; station_id: string; station_name: string; duty: string;
  status: string; status_since: string; lat: number | null; lng: number | null; supplies_ok: boolean; supplies_note: string | null;
  equipment_gaps?: string | null;
  crew: { name: string; title: string; role: string }[];
  incident: null | { id: string; code: string; priority: string | null; complaint: string | null; destination: string | null; address: string | null; acknowledged: boolean };
  free: { freeAt: string | null; lowAt: string | null; highAt: string | null; basis: string };
}

export interface Board { vehicles: BoardVehicle[]; waitingCalls: number; oldestWaitingCall: string | null; serverTime: string }

const DUTY: Record<string, string> = { '24/7': '24/7', office: 'Giờ HC', reserve: 'Dự phòng' };

export function FleetTable({ board, compact = false, onPick }: { board: Board | null; compact?: boolean; onPick?: (v: BoardVehicle) => void }) {
  const now = useNow();
  if (!board) return <div className="muted">Đang tải…</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Xe</th>
          <th>Trạng thái</th>
          {!compact && <th>Kíp</th>}
          <th>Đang làm</th>
          <th>Rảnh lúc</th>
          {!compact && <th>Cơ số</th>}
        </tr>
      </thead>
      <tbody>
        {board.vehicles.map((v) => {
          const busy = v.free.freeAt && !['S1', 'S2'].includes(v.status);
          return (
            <tr key={v.id} className={onPick ? 'click' : ''} onClick={() => onPick?.(v)}>
              <td>
                <b>{v.id}</b>
                {v.equipment_gaps && <span className="badge far" style={{ marginLeft: 6 }} title={v.equipment_gaps}>Thiếu thiết bị</span>}
                <div className="small muted">{compact ? v.type : v.type_label} · {v.station_name} · {DUTY[v.duty]}</div>
              </td>
              <td>
                <span className={`st ${v.status}`}>{v.status}</span> <span className="small">{STATUS_LABEL[v.status]}</span>
                <div className="small muted mono">{fmtDuration(now - new Date(v.status_since).getTime())}</div>
                {v.incident && !v.incident.acknowledged && <span className="badge" style={{ borderColor: 'var(--p1)' }}>Chưa xác nhận lệnh</span>}
              </td>
              {!compact && <td className="small">{v.crew.length ? v.crew.map((c) => <div key={c.name}>{c.name} <span className="muted">({c.role})</span></div>) : <span className="muted">Chưa có kíp</span>}</td>}
              <td className="small">
                {v.incident ? (
                  <>
                    <span className={`badge prio ${v.incident.priority ?? 'none'}`}>{v.incident.priority ?? '?'}</span> <b>{v.incident.code}</b>
                    {!compact && <div>{v.incident.complaint ?? ''}{v.incident.destination ? ` → ${v.incident.destination}` : ''}</div>}
                  </>
                ) : <span className="muted">—</span>}
              </td>
              <td className="small mono">
                {v.status === 'S9' ? <span className="muted">Ngoài hoạt động</span>
                  : !busy ? <span style={{ color: 'var(--ok)', fontWeight: 700 }}>Rảnh</span>
                  : <>
                      ~{fmtTime(v.free.freeAt, false)}
                      {v.free.lowAt && <div className="muted">{fmtTime(v.free.lowAt, false)}–{fmtTime(v.free.highAt, false)}</div>}
                      {v.free.basis === 'Kíp báo' && <div className="muted">kíp báo</div>}
                    </>}
              </td>
              {!compact && <td className="small">
                {v.supplies_ok ? <span style={{ color: 'var(--ok)' }}>Đủ</span> : <span className="error">Thiếu: {v.supplies_note}</span>}
                {v.equipment_gaps && <div className="error">Thiết bị: {v.equipment_gaps}</div>}
              </td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
