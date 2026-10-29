import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import qrcode from 'qrcode-generator';
import { api, fmtDateTime } from '../api';
import { StarOfLife } from '../Logo';
import { SLIP_NAME } from '../components/Requisitions';

const STEP: Record<string, string> = { lap_phieu: 'Người lập phiếu', duyet: 'Kho tổng duyệt', xuat_kho: 'Thủ kho xuất', nhan_hang: 'Người nhận (quản lý điểm)' };

/**
 * In phiếu lĩnh: hàng kho tổng đã xuất cho điểm (từ phiếu đề xuất của điểm, hoặc kho tổng phát định kỳ).
 * Bảng mặt hàng theo lô, hạn dùng, số xuất, số nhận, chênh lệch; chữ ký số từng bước và chỗ ký tay; QR mở lại phiếu.
 */
export function SlipPrint() {
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { api('GET', `/api/requisitions/${id}`).then(setR).catch((e) => setError(e.message)); }, [id]);
  if (error) return <div className="error" style={{ margin: 16 }}>{error}</div>;
  if (!r) return <div className="muted" style={{ margin: 16 }}>Đang tải…</div>;
  const q = qrcode(0, 'M'); q.addData(`${window.location.origin}/kho#phieu-linh-${r.id}`); q.make();
  const sig = (p: string) => r.signatures?.find((s: any) => s.purpose === p);
  const rows = r.lines.flatMap((l: any) => (l.issues.length ? l.issues : [null]).map((i: any) => ({ l, i })));
  return (
    <div className="print-page">
      <div className="no-print row" style={{ marginBottom: 12 }}><button onClick={() => window.print()}>In</button></div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="row" style={{ gap: 8 }}><StarOfLife size={36} /><div><b>MEDONE</b><div>Kho tổng: {r.central_name}</div></div></div>
        <span dangerouslySetInnerHTML={{ __html: q.createSvgTag({ cellSize: 2, margin: 0, scalable: true }) }} style={{ width: 80, display: 'inline-block' }} />
      </div>
      <h1>PHIẾU LĨNH THUỐC, VẬT TƯ</h1>
      <div style={{ textAlign: 'center' }}>Số <b className="mono">{r.code}</b> · {r.source === 'tu_dong' ? 'Kho tổng phát định kỳ theo định mức' : `Xuất theo phiếu đề xuất của điểm${r.urgent ? ' (khẩn)' : ''}`}</div>
      <p>Kho nhận: <b>{r.station_name}</b> ({r.station_id}) · Xuất lúc: {r.issued_at ? fmtDateTime(r.issued_at) : '—'} · Nhận lúc: {r.received_at ? fmtDateTime(r.received_at) : 'chưa nhận'}</p>
      {r.note && <p>Ghi chú: {r.note}</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th>STT</th><th>Tên thuốc, vật tư</th><th>ĐVT</th><th>Số lô</th><th>Hạn dùng</th><th>{SLIP_NAME(r.source) === 'Phiếu đề xuất' ? 'Đề xuất' : 'Định mức phát'}</th><th>Duyệt</th><th>Thực xuất</th><th>Thực nhận</th><th>Chênh lệch</th></tr></thead>
        <tbody>{rows.map(({ l, i }: any, k: number) => (
          <tr key={k}>
            <td>{k + 1}</td><td>{l.drug_name}</td><td>{l.unit}</td><td className="mono">{i?.lot ?? ''}</td><td>{i ? String(i.expiry).slice(0, 10) : ''}</td>
            <td style={{ textAlign: 'right' }}>{l.requested_qty}</td><td style={{ textAlign: 'right' }}>{l.approved_qty ?? ''}</td>
            <td style={{ textAlign: 'right' }}>{i?.qty ?? 0}</td><td style={{ textAlign: 'right' }}>{i?.receivedQty ?? ''}</td>
            <td style={{ textAlign: 'right' }}>{i && i.receivedQty != null && i.receivedQty !== i.qty ? i.receivedQty - i.qty : ''}</td>
          </tr>
        ))}</tbody>
      </table>
      {r.receive_note && <p>Lý do chênh lệch khi nhận: {r.receive_note}</p>}
      {r.witness && <p>Người chứng kiến (thuốc kiểm soát đặc biệt): {r.witness}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${r.source === 'tu_dong' ? 3 : 4}, 1fr)`, gap: 8, marginTop: 24, textAlign: 'center' }}>
        {Object.entries(STEP).filter(([p]) => !(r.source === 'tu_dong' && p === 'duyet')).map(([p, step]) => {
          const label = r.source === 'tu_dong' && p === 'lap_phieu' ? 'Kho tổng lập phiếu' : step;
          const s = sig(p);
          return (
            <div key={p}>
              <b>{label}</b>
              <div style={{ height: 56 }} />
              <div>{s ? s.full_name : ' '}</div>
              {s && <div style={{ fontSize: 11 }}>Đã ký số {fmtDateTime(s.signed_at)}<br />CT {String(s.serial).slice(0, 12)}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
