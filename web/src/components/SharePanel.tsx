import { useEffect, useState } from 'react';
import { api } from '../api';
import { useHospitals } from '../catalog';

const KIND: Record<string, string> = { benh_vien: 'Bệnh viện nhận', nguoi_nha: 'Người nhà' };
const SMS: Record<string, string> = { cho_gui: 'chờ gửi tin', da_gui: 'đã gửi tin', loi: 'gửi tin lỗi' };
const hm = (d: string) => new Date(d).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
/** Địa chỉ người ngoài mở được: NEXT_PUBLIC_VERIFY_URL khi có địa chỉ công khai, không thì chính máy chủ đang mở */
const publicBase = () => (process.env.NEXT_PUBLIC_VERIFY_URL || window.location.origin).replace(/\/$/, '');

/** Liên thông: gửi đường dẫn theo dõi xe cho người nhà, báo trước có sinh hiệu cho bệnh viện nhận; xem bệnh viện phản hồi */
export function SharePanel({ inc, version, canDispatch, run }: { inc: any; version: number; canDispatch: boolean; run: (fn: () => Promise<any>) => Promise<any> }) {
  const [rows, setRows] = useState<any[]>([]);
  const [made, setMade] = useState<{ kind: string; url: string } | null>(null);
  const [famPhone, setFamPhone] = useState(inc.callback_phone || inc.caller_phone || '');
  const hospitals = useHospitals();
  const h = hospitals.find((x) => x.name === inc.destination);
  const [bvPhone, setBvPhone] = useState('');
  useEffect(() => { if (h?.phone && !bvPhone) setBvPhone(h.phone); }, [h?.phone]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = () => api<any[]>('GET', `/api/incidents/${inc.id}/shares`).then(setRows).catch(() => {});
  useEffect(() => { load(); }, [inc.id, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = (kind: 'nguoi_nha' | 'benh_vien', phone: string) => run(async () => {
    const r = await api<any>('POST', `/api/incidents/${inc.id}/share`, { kind, baseUrl: publicBase(), phone: phone.trim() || null });
    setMade({ kind, url: r.url });
    await load();
  });
  const declined = rows.find((r) => r.kind === 'benh_vien' && r.active && r.response === 'khong_nhan');

  return (
    <div className="panel col">
      <h3 style={{ margin: 0 }}>Liên thông</h3>
      {declined && <div className="alert red"><b>{declined.hospital} báo không nhận được</b> ({declined.response_by}, {hm(declined.responded_at)}): {declined.response_note}. Chọn bệnh viện khác và báo trước lại.</div>}
      {made && (
        <div className="alert amber col small">
          <div>Đường dẫn cho {KIND[made.kind].toLowerCase()} (chỉ hiện lần này): gửi qua tin nhắn hoặc Zalo cho đúng người.</div>
          <div className="row"><input readOnly value={made.url} style={{ flex: 1, minWidth: 200 }} onFocus={(e) => e.target.select()} />
            <button onClick={() => navigator.clipboard?.writeText(made.url)}>Sao chép</button><button onClick={() => setMade(null)}>Ẩn</button></div>
        </div>
      )}
      <div className="row">
        <input placeholder="SĐT người nhà" value={famPhone} onChange={(e) => setFamPhone(e.target.value)} style={{ width: 140 }} />
        <button onClick={() => create('nguoi_nha', famPhone)}>Gửi theo dõi xe cho người nhà</button>
      </div>
      {canDispatch && (
        <div className="row">
          <input placeholder="SĐT bệnh viện" value={bvPhone} onChange={(e) => setBvPhone(e.target.value)} style={{ width: 140 }} />
          <button disabled={!inc.destination} onClick={() => create('benh_vien', bvPhone)}>Gửi báo trước cho {inc.destination ?? 'bệnh viện (báo trước BV trước)'}</button>
        </div>
      )}
      <div className="small muted">Bỏ trống số điện thoại thì chỉ tạo đường dẫn để sao chép. Người nhà chỉ thấy xe và giờ dự kiến tới; bệnh viện thấy tuổi, giới, lý do, sinh hiệu mới nhất kíp ghi và giờ dự kiến tới.</div>
      {rows.length > 0 && (
        <table>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td>{KIND[r.kind]}{r.hospital && <div className="small muted">{r.hospital}</div>}</td>
              <td className="small">{hm(r.created_at)} · {r.views} lượt xem{r.sms_status && ` · ${SMS[r.sms_status]}`}
                {!r.active && <div className="muted">{r.revoked_at ? 'đã thu hồi' : 'hết hạn'}</div>}</td>
              <td>{r.response === 'san_sang' && <span className="badge green">Sẵn sàng · {r.response_by}</span>}
                {r.response === 'khong_nhan' && <span className="badge red">Không nhận</span>}</td>
              <td className="right">{r.active && <button className="ghost" onClick={() => run(async () => { await api('POST', `/api/shares/${r.id}/revoke`); await load(); })}>Thu hồi</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
