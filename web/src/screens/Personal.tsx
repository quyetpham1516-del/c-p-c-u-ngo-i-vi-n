import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { ProposalForm } from './Finance';
import { MyPpe } from './Logistics';
import { Payslip } from './Payroll';

const DOC: Record<string, string> = {
  gphn: 'Giấy phép/chứng chỉ hành nghề', bang_lai: 'Giấy phép lái xe', bls: 'BLS', acls: 'ACLS', phtls: 'PHTLS', ksnk: 'KSNK', pccc: 'PCCC', khac: 'Khác',
};
const SHIFT: Record<string, string> = { ngay: 'Ca ngày', dem: 'Ca đêm', truc_24: 'Trực 24 giờ', hanh_chinh: 'Hành chính' };
const LEAVE: Record<string, string> = { phep_nam: 'Phép năm', om: 'Nghỉ ốm', viec_rieng: 'Việc riêng có lương', khong_luong: 'Không lương', thai_san: 'Thai sản', khac: 'Khác' };
const LSTATUS: Record<string, string> = { cho_duyet: 'Chờ duyệt', da_duyet: 'Đã duyệt', tu_choi: 'Từ chối', huy: 'Hủy' };
const PSTATUS: Record<string, string> = { cho_duyet_1: 'Chờ kế toán', cho_duyet_2: 'Chờ Ban Giám đốc', da_duyet: 'Đã duyệt', tu_choi: 'Từ chối', da_chi: 'Đã chi', huy: 'Hủy' };
const vnDate = (d = 0) => new Date(Date.now() + 7 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);

/** Trang cá nhân của mọi nhân viên: giấy tờ, lịch trực, chấm công, xin nghỉ, đề xuất chi */
export function Personal() {
  const [me, setMe] = useState<any>(null);
  const [props, setProps] = useState<any[]>([]);
  const [lv, setLv] = useState({ kind: 'phep_nam', fromDate: vnDate(1), toDate: vnDate(1), reason: '' });
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => Promise.all([
    api('GET', '/api/hr/me').then(setMe),
    api<any[]>('GET', '/api/finance/proposals?mine=1').then(setProps),
  ]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); await load(); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  if (!me) return <div className="panel">{error || 'Đang tải…'}</div>;
  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Cá nhân {me.staff && <span className="small muted">{me.staff.code} · {me.staff.title}</span>}</h2>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      <CaseFeedback />
      <MyPayslips />
      <MyPpe />
      {!me.staff && <div className="alert amber">Tài khoản chưa có hồ sơ nhân sự. Liên hệ phòng Nhân sự.</div>}
      {me.staff && (
        <>
          {me.blocking?.length > 0 && <div className="alert red">Bạn không nhận ca trên xe được: {me.blocking.join('; ')}. Liên hệ phòng Nhân sự để cập nhật.</div>}
          {me.warnings?.length > 0 && <div className="alert amber small">{me.warnings.join(' · ')}</div>}
          <div className="grid2">
            <div className="panel col">
              <h3 style={{ margin: 0 }}>Chấm công</h3>
              <div>{me.openCheckIn ? `Đã vào lúc ${new Date(me.openCheckIn).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })}${me.openStation ? ` tại ${me.openStation}` : ''}` : 'Chưa chấm công vào.'}</div>
              <div className="small">Ở trạm: mở camera điện thoại, quét mã QR trên máy chấm công. Bấm tay bên dưới chỉ khi trạm chưa có máy; nhân sự sẽ đối chiếu.</div>
              <div><button className="primary big" onClick={() => run(() => api('POST', '/api/hr/attendance/check'), me.openCheckIn ? 'Đã chấm công ra.' : 'Đã chấm công vào.')}>{me.openCheckIn ? 'Chấm công ra' : 'Chấm công vào'}</button></div>
              <div className="small muted">Kíp đi xe không cần chấm công: giờ làm tính theo lúc bắt đầu và kết thúc ca trên máy tính bảng.</div>
            </div>
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Lịch trực 14 ngày tới</h3>
              <table><tbody>{me.roster.map((r: any, i: number) => <tr key={i}><td>{new Date(r.work_date + 'T00:00:00').toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' })}</td><td>{SHIFT[r.shift]}</td><td className="small">{r.station_id} {r.vehicle_id}</td></tr>)}</tbody></table>
              {!me.roster.length && <div className="small muted">Chưa có lịch.</div>}
            </div>
          </div>
          <div className="grid2">
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Giấy tờ hành nghề</h3>
              <table><tbody>{me.docs.map((d: any, i: number) => <tr key={i}><td>{DOC[d.kind]}<div className="small mono">{d.number}</div></td><td className="small">{d.expires_on ? `hết hạn ${d.expires_on}` : 'không thời hạn'}</td>
                <td>{d.suspended ? <span className="badge far">Đình chỉ</span> : d.expired ? <span className="badge far">Hết hạn</span> : <span className="badge">Còn hiệu lực</span>}</td></tr>)}</tbody></table>
              {!me.docs.length && <div className="small muted">Chưa có. Gửi bản chụp cho phòng Nhân sự để cập nhật.</div>}
            </div>
            <div className="panel col">
              <h3 style={{ margin: 0 }}>Xin nghỉ</h3>
              <div className="grid4">
                <label className="field">Loại<select value={lv.kind} onChange={(e) => setLv({ ...lv, kind: e.target.value })}>{Object.entries(LEAVE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                <label className="field">Từ<input type="date" value={lv.fromDate} onChange={(e) => setLv({ ...lv, fromDate: e.target.value })} /></label>
                <label className="field">Đến<input type="date" value={lv.toDate} onChange={(e) => setLv({ ...lv, toDate: e.target.value })} /></label>
                <label className="field">Lý do<input value={lv.reason} onChange={(e) => setLv({ ...lv, reason: e.target.value })} /></label>
              </div>
              <div><button onClick={() => run(() => api('POST', '/api/hr/leave', { ...lv, reason: lv.reason || null }), 'Đã gửi đơn nghỉ.')}>Gửi đơn</button></div>
              <table><tbody>{me.leave.map((l: any) => <tr key={l.id}><td>{LEAVE[l.kind]}</td><td className="small">{l.from_date} → {l.to_date}</td><td>{LSTATUS[l.status]}</td></tr>)}</tbody></table>
            </div>
          </div>
        </>
      )}
      <div className="panel col">
        <h3 style={{ margin: 0 }}>Đề xuất chi của tôi <span className="small muted">mua sắm, sửa chữa, tạm ứng: kế toán duyệt, khoản lớn Ban Giám đốc duyệt thêm</span></h3>
        <ProposalForm meta={{ proposalKind: { mua_sam: 'Mua sắm', sua_chua: 'Sửa chữa', chi_phi: 'Chi phí hoạt động', tam_ung: 'Tạm ứng', khac: 'Khác' } }} run={run} onDone={() => load()} />
        <table><tbody>{props.map((p) => <tr key={p.id}><td className="mono">{p.code}</td><td>{p.title}</td><td className="right">{money(p.amount)}</td>
          <td className="small">{PSTATUS[p.status]}{(p.l1_note || p.l2_note) && <div className="muted">{p.l2_note ?? p.l1_note}</div>}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}

/** Phản hồi bình ca: kết quả rà soát các ca mình tham gia; kíp đọc và xác nhận đã nhận */
function CaseFeedback() {
  const [rows, setRows] = useState<any[]>([]);
  const [meta, setMeta] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const load = () => api<any[]>('GET', '/api/ops/my-feedback').then(setRows).catch(() => {});
  useEffect(() => { load(); api('GET', '/api/ops/meta').then(setMeta).catch(() => {}); }, []);
  if (!rows.length || !meta) return null;
  const pending = rows.filter((r) => !r.acked_at).length;
  return (
    <div className={`panel col ${pending ? 'amber' : ''}`}>
      <h3 style={{ margin: 0 }}>Phản hồi bình ca {pending > 0 && <span className="badge amber">{pending} chưa đọc</span>}</h3>
      {rows.slice(0, 20).map((r) => (
        <div key={r.id} className="small">
          <div className="row">
            <b className="mono">{r.incident_code}</b><span className="muted">{r.code} · {new Date(r.reviewed_at).toLocaleDateString('vi-VN')}</span>
            {r.acked_at && <span className="muted">đã xác nhận</span>}
            <button className="ghost small" onClick={() => { setOpen(open === r.id ? null : r.id); setComment(''); }}>{open === r.id ? 'Thu gọn' : r.acked_at ? 'Xem' : 'Đọc'}</button>
          </div>
          {open === r.id && (
            <div className="col" style={{ gap: 4, marginTop: 4 }}>
              {meta.reviewCriteria.map(([k, l]: [string, string]) => r.scores?.[k] && <div key={k}>{l}: <b>{meta.reviewScore[r.scores[k]]}</b></div>)}
              <div>Nhận xét: {r.summary}</div>
              {r.good_practice && <div>Làm tốt: {r.good_practice}</div>}
              {r.learning && <div>Cần cải thiện: {r.learning}</div>}
              {!r.acked_at && <div className="row">
                <input style={{ flex: 1 }} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Ý kiến của bạn (không bắt buộc)" />
                <button className="primary small" onClick={async () => { await api('POST', `/api/ops/my-feedback/${r.id}/ack`, { comment: comment || null }); setOpen(null); await load(); }}>Đã đọc</button>
              </div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Phiếu lương của tôi (bảng lương đã được Ban Giám đốc duyệt) */
function MyPayslips() {
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api<any[]>('GET', '/api/payroll/me').then(setRows).catch(() => {}); }, []);
  if (!rows.length) return null;
  return (
    <div className="panel col">
      <h3 style={{ margin: 0 }}>Phiếu lương</h3>
      {rows.map((r) => (
        <div key={r.month} className="col">
          <div className="row"><b>Tháng {r.month}</b><span>Thực lĩnh {money(r.net)}</span><span className="small muted">{r.status === 'da_chi' ? 'đã chi' : 'đã duyệt'}</span>
            <button className="ghost" onClick={() => setOpen(open === r.month ? null : r.month)}>{open === r.month ? 'Ẩn' : 'Xem chi tiết'}</button></div>
          {open === r.month && <Payslip r={r.result} />}
        </div>
      ))}
    </div>
  );
}
