'use client';
import { useEffect, useState } from 'react';
import { api, download, fmtDateTime } from '../api';
import { useHashRecord } from '../hashNav';

/** Báo cáo kho tự động sau mỗi lần kiểm kê: nhập, xuất, tồn, chênh lệch; tải Excel */
export function InventoryReports({ stationId, compact = false }: { stationId?: string; compact?: boolean }) {
  const [list, setList] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<any[]>('GET', `/api/inventory-reports${stationId ? `?stationId=${stationId}` : ''}`).then((l) => {
      setList(l);
    }).catch((e) => setError(e.message));
  }, [stationId]);
  useHashRecord('bao-cao', (id) => api('GET', `/api/inventory-reports/${id}`).then(setOpen).catch(() => setError('Không mở được báo cáo này: đã xóa hoặc bạn không có quyền xem')));
  if (compact && !list.length) return null;
  const shown = compact ? list.slice(0, 5) : list;
  return (
    <div className="panel col" id="bao-cao-kho">
      <h3 style={{ margin: 0 }}>Báo cáo kho tự động</h3>
      {error && <div className="error">{error}</div>}
      <table className="small">
        <thead><tr><th>Báo cáo</th><th>Kho</th><th>Ngày kiểm kê</th><th>Kết quả</th><th /></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className="click" onClick={() => api('GET', `/api/inventory-reports/${r.id}`).then(setOpen).catch((e) => setError(e.message))}>
              <td className="mono">{r.code}</td><td>{r.station_name} <span className="muted">{r.scope === 'kho_tong' ? 'kho tổng' : 'kho điểm'}</span></td>
              <td>{r.summary.dueDate}{r.summary.late && <span className="badge red" style={{ marginLeft: 4 }}>Trễ</span>}</td>
              <td>{r.summary.diffItems ? <span className="badge red">Lệch {r.summary.diffItems} mặt hàng</span> : <span className="badge green">Khớp</span>}</td>
              <td className="right"><button className="ghost small" onClick={(e) => { e.stopPropagation(); download(`/api/inventory-reports/${r.id}/xlsx`, `${r.code}.xlsx`).catch((x) => setError(x.message)); }}>Excel</button></td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={5} className="muted">Chưa có báo cáo. Báo cáo tự lập khi nộp kiểm kê.</td></tr>}
        </tbody>
      </table>
      {open && (
        <div className="col" style={{ gap: 6 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>{open.code} · {open.station_name}</b>
            <button className="ghost" onClick={() => setOpen(null)}>Đóng</button>
          </div>
          <div className="small muted">Kỳ {fmtDateTime(open.period_start)} đến {fmtDateTime(open.period_end)} · nhập {open.summary.received}, dùng cho người bệnh {open.summary.used}, xuất {open.summary.issued}</div>
          <div style={{ overflowX: 'auto', maxHeight: 420 }}>
            <table className="small">
              <thead><tr><th>Mặt hàng</th><th className="right">Đầu kỳ</th><th className="right">Nhập</th><th className="right">Dùng</th><th className="right">Xuất</th><th className="right">Điều chỉnh</th><th className="right">Sổ sách</th><th className="right">Đếm</th><th className="right">Lệch</th></tr></thead>
              <tbody>{open.rows.map((r: any) => (
                <tr key={r.drug_id}><td>{r.drug_name} <span className="muted">{r.unit}</span></td>
                  <td className="right">{r.opening}</td><td className="right">{r.received}</td><td className="right">{r.used}</td><td className="right">{r.issued}</td>
                  <td className="right">{r.adjusted}</td><td className="right">{r.book}</td><td className="right">{r.counted}</td>
                  <td className="right" style={r.diff ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>{r.diff}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
