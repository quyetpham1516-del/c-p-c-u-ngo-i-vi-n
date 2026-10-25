import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '../api';

const hm = (d: string | null | undefined) => d ? new Date(d).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }) : '';
const SEX: Record<string, string> = { M: 'Nam', F: 'Nữ', U: '' };
const PRIO: Record<string, string> = { P1: 'Đe dọa tính mạng', P2: 'Khẩn cấp', P3: 'Cần chuyển viện', P4: 'Không khẩn', HEN: 'Theo hẹn' };
const STAGE: Record<string, string> = { dang_dieu: 'Đang điều xe', dang_toi: 'Xe cấp cứu đang tới', da_toi: 'Kíp cấp cứu đã tới nơi', chuyen_vien: 'Đang chuyển người bệnh tới bệnh viện' };

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Lỗi ${res.status}`);
  return json;
}

/** Trang công khai mở từ tin nhắn: /bv (bệnh viện nhận) và /theo-doi (người nhà). Tự làm mới 20 giây một lần. */
export function ShareView() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('m') ?? '');
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => call('GET', `/api/public/share/${encodeURIComponent(token)}`).then((x) => { setD(x); setError(''); }).catch((e) => setError(e.message)), [token]);
  useEffect(() => {
    if (!token) { setError('Thiếu mã trong đường dẫn'); return; }
    load();
    const t = window.setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [token, load]);

  return (
    <div className="share-page col">
      <div className="row" style={{ gap: 10 }}><img src="/logo.svg" alt="" width={36} height={36} /><b style={{ fontSize: 20 }}>Medone – Cấp cứu ngoại viện</b></div>
      {error && <div className="alert red">{error}</div>}
      {d?.ended && <div className="panel">Ca <b>{d.code}</b> đã kết thúc. Cảm ơn bạn.</div>}
      {d && !d.ended && d.kind === 'nguoi_nha' && <Family d={d} />}
      {d && !d.ended && d.kind === 'benh_vien' && <Hospital d={d} token={token} onDone={setD} />}
      {d && <div className="small muted">Cập nhật lúc {hm(new Date().toISOString())} · tự làm mới mỗi 20 giây · đường dẫn hết hạn lúc {hm(d.expiresAt)}</div>}
    </div>
  );
}

function Family({ d }: { d: any }) {
  return (
    <div className="panel col">
      <div className="muted">Ca {d.code}</div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{STAGE[d.stage]}</div>
      {d.vehicle && <div>Xe <b>{d.vehicle.plate}</b> ({d.vehicle.type})</div>}
      {d.eta && <div style={{ fontSize: 20 }}>Dự kiến tới sau khoảng <b>{d.eta.minutes} phút</b> <span className="small muted">(cách {d.eta.km} km{d.eta.road ? ' theo đường bộ' : ', ước tính theo khoảng cách'})</span></div>}
      {d.arrivedAt && d.stage === 'da_toi' && <div>Tới lúc {hm(d.arrivedAt)}</div>}
      {d.hospital && <div>Bệnh viện: <b>{d.hospital}</b></div>}
      <div className="small muted">Giữ điện thoại bên mình; kíp hoặc tổng đài có thể gọi lại để hỏi đường. Mở cửa, bật đèn, dọn lối đi giúp kíp vào nhanh.</div>
    </div>
  );
}

function Hospital({ d, token, onDone }: { d: any; token: string; onDone: (x: any) => void }) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const send = async (response: 'san_sang' | 'khong_nhan') => {
    setErr('');
    try { onDone(await call('POST', `/api/public/share/${encodeURIComponent(token)}/respond`, { response, name, note: note || null })); } catch (e) { setErr((e as Error).message); }
  };
  const v = d.vitals;
  return (
    <div className="col">
      <div className="panel col">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div><div className="muted">Báo trước ca {d.code}</div><div style={{ fontSize: 22, fontWeight: 700 }}>{d.hospital}{d.department ? ` – ${d.department}` : ''}</div></div>
          {d.priority && <span className={`badge ${d.priority === 'P1' ? 'red' : d.priority === 'P2' ? 'amber' : ''}`}>{d.priority} · {PRIO[d.priority] ?? ''}</span>}
        </div>
        <div style={{ fontSize: 20 }}>
          {d.arrivedAt ? <>Xe đã tới bệnh viện lúc <b>{hm(d.arrivedAt)}</b></>
            : d.eta ? <>Dự kiến tới sau khoảng <b>{d.eta.minutes} phút</b> <span className="small muted">({d.eta.km} km)</span></>
            : d.status === 'transporting' ? 'Đang trên đường tới' : 'Kíp đang xử trí tại hiện trường'}
        </div>
        {d.vehicle && <div className="small">Xe {d.vehicle.plate} ({d.vehicle.type}){d.leftSceneAt && ` · rời hiện trường ${hm(d.leftSceneAt)}`}</div>}
      </div>
      <div className="panel col">
        <h3 style={{ margin: 0 }}>Người bệnh</h3>
        <div>{d.patient ? [d.patient.initials, d.patient.age != null ? `${d.patient.age} tuổi` : null, SEX[d.patient.sex]].filter(Boolean).join(' · ') : 'Chưa có thông tin hành chính'}</div>
        {d.chiefComplaint && <div>Lý do: <b>{d.chiefComplaint}</b></div>}
        {d.diagnosis && <div>Chẩn đoán sơ bộ: <b>{d.diagnosis}</b></div>}
        {d.arrest && <div className="alert red">Ngừng tuần hoàn trước viện</div>}
        {v ? (
          <div className="share-vitals">
            {v.hr != null && <div><span>Mạch</span><b>{v.hr}</b></div>}
            {v.sbp != null && <div><span>Huyết áp</span><b>{v.sbp}/{v.dbp ?? '–'}</b></div>}
            {v.spo2 != null && <div><span>SpO₂</span><b>{v.spo2}%</b></div>}
            {v.rr != null && <div><span>Nhịp thở</span><b>{v.rr}</b></div>}
            {v.temp != null && <div><span>Nhiệt độ</span><b>{v.temp}</b></div>}
            {v.gcs != null && <div><span>GCS</span><b>{v.gcs}</b></div>}
            {v.at && <div className="small muted" style={{ alignSelf: 'end' }}>đo lúc {hm(v.at)}</div>}
          </div>
        ) : <div className="muted">Kíp chưa ghi sinh hiệu.</div>}
      </div>
      <div className="panel col">
        <h3 style={{ margin: 0 }}>Xác nhận tiếp nhận</h3>
        {d.response && <div className={`alert ${d.response.value === 'san_sang' ? 'green' : 'red'}`}>
          {d.response.value === 'san_sang' ? 'Đã báo sẵn sàng tiếp nhận' : `Đã báo không nhận được: ${d.response.note}`} ({d.response.by}, {hm(d.response.at)}). Điều phối Medone đã nhận.</div>}
        <input placeholder="Họ tên, chức danh người xác nhận" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Ghi chú (bắt buộc khi không nhận được: hết giường, không có chuyên khoa...)" value={note} onChange={(e) => setNote(e.target.value)} />
        {err && <div className="error">{err}</div>}
        <div className="row">
          <button className="primary big" disabled={name.trim().length < 2} onClick={() => send('san_sang')}>Sẵn sàng tiếp nhận</button>
          <button className="big" disabled={name.trim().length < 2} onClick={() => send('khong_nhan')}>Không nhận được</button>
        </div>
      </div>
    </div>
  );
}
