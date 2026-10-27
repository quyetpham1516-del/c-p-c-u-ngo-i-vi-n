'use client';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { SLIP_NAME } from './Requisitions';

const REASON: Record<string, string> = {
  nhap_kho: 'Nhập kho', nhan_kho_tong: 'Nhận từ kho tổng', xuat_kho_diem: 'Xuất cho kho điểm', cap_xe: 'Cấp lên xe', tra_kho: 'Xe trả về kho',
  dieu_chuyen: 'Điều chuyển', dung_cho_nguoi_benh: 'Dùng cho người bệnh', kiem_ke: 'Kiểm kê', huy: 'Hủy', dieu_chinh: 'Điều chỉnh',
};

/** Lịch sử xuất nhập của một kho: khi nào bù, ai xuất, ai nhận, lô nào, bao nhiêu; xuất Excel (CSV) */
export function StockHistory({ stationId, drugs }: { stationId: string; drugs: { id: number; name: string; unit: string }[] }) {
  const [f, setF] = useState({ drugId: '', lot: '', from: '', to: '' });
  const [rows, setRows] = useState<any[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const qs = new URLSearchParams({ stationId, ...(f.drugId && { drugId: f.drugId }), ...(f.lot && { lot: f.lot }), ...(f.from && { from: f.from }), ...(f.to && { to: f.to }) });
    const t = setTimeout(() => api<any[]>('GET', `/api/stock/history?${qs}`).then((r) => { setRows(r); setError(''); }).catch((e) => setError(e.message)), 250);
    return () => clearTimeout(t);
  }, [stationId, f]);
  const what = (r: any) => [REASON[r.reason] ?? r.reason, r.requisition_code && `${SLIP_NAME(r.requisition_source)} ${r.requisition_code}`,
    r.transfer_number && `phiếu ${r.transfer_number}`, r.voucher_code, r.vehicle_id && `xe ${r.vehicle_id}`].filter(Boolean).join(' · ');
  const csv = () => {
    const head = ['Thời gian', 'Mặt hàng', 'Đơn vị', 'Lô', 'Hạn dùng', 'Số lượng', 'Nội dung', 'Người làm', 'Người xuất kho tổng', 'Chứng kiến', 'Ghi chú'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = rows.map((r) => [fmtDateTime(r.at), r.drug_name, r.unit, r.lot, r.expiry, r.delta, what(r), r.user_name, r.issued_by_name, r.witness, r.note].map(esc).join(','));
    const blob = new Blob(['﻿' + [head.map(esc).join(','), ...body].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `lich-su-xuat-nhap-${stationId}.csv`; a.click();
  };
  return (
    <div className="panel col">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select value={f.drugId} onChange={(e) => setF({ ...f, drugId: e.target.value })} style={{ minWidth: 220 }}>
          <option value="">Mọi mặt hàng</option>{drugs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <input placeholder="Số lô" value={f.lot} onChange={(e) => setF({ ...f, lot: e.target.value })} style={{ width: 120 }} />
        <label className="row small">Từ<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="row small">Đến<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <button className="ghost" disabled={!rows.length} onClick={csv}>Xuất Excel</button>
      </div>
      {error && <div className="error">{error}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table className="small">
          <thead><tr><th>Thời gian</th><th>Mặt hàng</th><th>Lô, hạn dùng</th><th className="right">Số lượng</th><th>Nội dung</th><th>Người làm</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDateTime(r.at)}</td><td>{r.drug_name} <span className="muted">{r.unit}</span></td>
                <td className="mono">{r.lot} <span className="muted">HD {r.expiry}</span></td>
                <td className="right" style={{ color: r.delta > 0 ? 'var(--ok)' : 'var(--danger)', fontWeight: 600 }}>{r.delta > 0 ? `+${r.delta}` : r.delta}</td>
                <td>{r.requisition_id ? <a href={`/kho#phieu-linh-${r.requisition_id}`}>{what(r)}</a> : what(r)}
                  {r.issued_by_name && r.reason === 'nhan_kho_tong' && <div className="muted">Kho tổng xuất: {r.issued_by_name}</div>}
                  {r.witness && <div className="muted">Chứng kiến: {r.witness}</div>}{r.note && <div className="muted">{r.note}</div>}</td>
                <td>{r.user_name ?? 'Hệ thống'}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="muted">Chưa có xuất nhập nào trong khoảng này.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="small muted">Hiện 500 dòng gần nhất theo bộ lọc.</div>
    </div>
  );
}
