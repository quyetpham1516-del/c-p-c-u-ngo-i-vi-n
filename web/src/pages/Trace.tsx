import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, fmtDateTime, fmtTime, INCIDENT_STATUS, PRIORITY_LABEL, STATUS_LABEL, TIME_LABEL } from '../api';

function describe(e: any): string {
  const d = e.data ?? {};
  switch (e.action) {
    case 'incident.created': return `Tạo ca ${d.code}, nguồn ${d.source === '115' ? '115' : '1800'}${d.sourceRef ? ` (${d.sourceRef})` : ''}`;
    case 'time.recorded': return `${d.code} – ${TIME_LABEL[d.code] ?? d.label} (${d.source})`;
    case 'incident.updated': return `Cập nhật: ${Object.keys(d).map((k) => `${k} = ${JSON.stringify(d[k]?.to)}`).join('; ')}`;
    case 'triage.answered': return `Trả lời bộ câu hỏi ${d.protocolVersion}${d.group ? `, nhóm ${d.group}` : ''}: máy đề xuất ${d.suggestedPriority ?? '—'} / ${d.suggestedVehicle ?? '—'}`;
    case 'triage.confirmed': return `Xác nhận ${PRIORITY_LABEL[d.finalPriority] ?? d.finalPriority}, xe ${d.finalVehicle}${d.overrideReason ? `. Đổi so với máy (${d.suggestedPriority}/${d.suggestedVehicle}): ${d.overrideReason}` : ' (đúng như máy đề xuất)'}`;
    case 'notify115.queued': return `Đưa thông báo ${d.priority} sang 115 vào hàng gửi`;
    case 'assignment.created': return `Giao xe ${e.entity_id}${d.divertReason ? ` (rút từ ca khác: ${d.divertReason})` : ''}`;
    case 'assignment.acknowledged': return `Kíp ${e.entity_id} xác nhận lệnh`;
    case 'assignment.cancelled': return `Hủy giao xe ${e.entity_id}: ${d.reason}`;
    case 'assignment.diverted': return `Xe ${e.entity_id} bị rút sang ca ${d.toIncident}: ${d.reason}`;
    case 'vehicle.status': return `Xe ${e.entity_id}: ${STATUS_LABEL[d.from] ?? d.from} → ${STATUS_LABEL[d.to] ?? d.to}`;
    case 'hospital.prealert': return `Báo trước bệnh viện ${d.hospital}`;
    case 'transfer.created': return `Tạo phiếu chuyển viện ${d.number}`;
    case 'transfer.saved': return `Lưu phiếu (phiên bản ${d.version}${d.device ? `, máy ${d.device}` : ''})`;
    case 'transfer.signed': return `Ký phiếu ${d.number}`;
    case 'transfer.amended': return `Bổ sung phiếu sau khi ký: ${d.reason}`;
    case 'transfer.viewed': return 'Xem phiếu';
    case 'trace.viewed': return `Mở màn hình truy xuất${d.reason ? `: ${d.reason}` : ''}`;
    case 'incident.closed': return `Đóng ca (${INCIDENT_STATUS[d.status] ?? d.status ?? 'đã đóng'}): ${d.reason ?? ''}`;
    case 'incident.transferred_115': return `Chuyển ca sang 115: ${d.reason}`;
    case 'call.attached': return `Gắn thêm cuộc gọi từ ${d.phone}`;
    case 'outbox.manual_sent': return 'Đã báo 115 qua điện thoại nóng';
    default: return e.action;
  }
}

/** Dựng lại toàn bộ một ca từ nhật ký chỉ ghi thêm (mục 6.3); lượt xem này cũng được ghi lại */
export function Trace() {
  const { id } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { api('GET', `/api/incidents/${id}/trace`).then(setData).catch((e) => setError(e.message)); }, [id]);
  if (error) return <div className="panel error">{error}</div>;
  if (!data) return <div className="panel">Đang tải…</div>;
  return (
    <div className="col" style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Truy xuất ca <span className="mono">{data.incident.code}</span></h2>
        <button className="no-print" onClick={() => print()}>In</button>
      </div>
      <div className={`alert ${data.chain.ok ? 'green' : 'red'}`}>
        {data.chain.ok
          ? `Chuỗi băm toàn vẹn: ${data.chain.count} sự kiện, chưa bị sửa. Mã băm cuối ${data.chain.lastHash.slice(0, 16)}…`
          : `CẢNH BÁO: chuỗi băm bị phá ở sự kiện #${data.chain.brokenAt}. Có thể dữ liệu đã bị sửa trực tiếp trong cơ sở dữ liệu.`}
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>Giờ</th><th>Ai</th><th>Sự kiện</th><th className="no-print">Mã băm</th></tr></thead>
          <tbody>
            {data.events.map((e: any) => (
              <tr key={e.id}>
                <td className="mono small" title={fmtDateTime(e.at)}>{fmtTime(e.at)}</td>
                <td className="small">{e.actor_name}</td>
                <td>{describe(e)}</td>
                <td className="mono small muted no-print">{e.hash.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small muted">Ghi âm cuộc gọi và bản chép lời sẽ hiện ở đây khi nối tổng đài và ASR (giai đoạn sau).</div>
    </div>
  );
}
