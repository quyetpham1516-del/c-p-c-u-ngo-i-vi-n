import { useEffect, useState } from 'react';
import { api } from '../api';

interface Meta { categories: Record<string, string>; severity: Record<string, string>; factors: string[] }
const EXPOSURE: Record<string, string> = { kim_dam: 'Kim đâm', vat_sac: 'Vật sắc nhọn khác', mau_ban_niem_mac: 'Máu/dịch bắn vào niêm mạc', mau_ban_da_ton_thuong: 'Máu/dịch dính da tổn thương', khac: 'Khác' };
const STATUS: Record<string, string> = { moi: 'Mới', dang_xu_ly: 'Đang xử lý', da_phan_tich: 'Đã phân tích', dong: 'Đã đóng' };
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/**
 * Báo cáo sự cố y khoa tự nguyện (QLCL-03, TT 43/2018/TT-BYT) và phơi nhiễm nghề nghiệp (QLCL-05):
 * mọi nhân viên dùng được, sự cố có thể báo ẩn danh. Cũng là nơi xem hành động khắc phục được giao cho mình.
 */
export function Report() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [f, setF] = useState({ occurredAt: localNow(), anonymous: false, category: '', severity: 'NC1', patientAffected: false, description: '', immediateAction: '', vehicleId: '' });
  const [ex, setEx] = useState({ occurredAt: localNow(), kind: 'kim_dam', description: '', firstAid: '' });
  const [mine, setMine] = useState<any[]>([]);
  const [capa, setCapa] = useState<any[]>([]);
  const [exposures, setExposures] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const load = () => Promise.all([
    api<any[]>('GET', '/api/quality/my-events').then(setMine),
    api<any[]>('GET', '/api/quality/capa?mine=1').then(setCapa),
    api<any[]>('GET', '/api/ipc/exposures').then(setExposures),
  ]);
  useEffect(() => { api<Meta>('GET', '/api/quality/meta').then(setMeta).catch(() => {}); load().catch(() => {}); }, []);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); await load(); } catch (e) { setError((e as Error).message); }
  };
  const submit = () => run(async () => {
    const r = await api<{ code: string }>('POST', '/api/quality/events', {
      ...f, occurredAt: new Date(f.occurredAt).toISOString(), vehicleId: f.vehicleId || null, immediateAction: f.immediateAction || null,
    });
    setF({ ...f, description: '', immediateAction: '', category: '' });
    setMsg(`Đã gửi báo cáo ${r.code}${f.anonymous ? ' (ẩn danh)' : ''}. Cảm ơn bạn đã báo cáo.`);
  }, '');
  const submitExposure = () => run(async () => {
    await api('POST', '/api/ipc/exposures', { occurredAt: new Date(ex.occurredAt).toISOString(), kind: ex.kind, description: ex.description, firstAid: ex.firstAid || null });
    setEx({ ...ex, description: '', firstAid: '' });
  }, 'Đã báo phơi nhiễm. Bộ phận KSNK sẽ liên hệ để đánh giá và điều trị dự phòng nếu cần; báo trưởng ca ngay.');

  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Báo cáo sự cố <span className="small muted">QLCL-03 · TT 43/2018/TT-BYT</span></h2>
      <div className="alert blue small">Báo cáo sự cố để học và cải tiến, không để quy lỗi cá nhân. Có thể báo ẩn danh: khi đó hệ thống không lưu tên người báo.</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {meta && (
        <div className="panel col">
          <div className="grid4">
            <label className="field">Thời điểm xảy ra<input type="datetime-local" value={f.occurredAt} onChange={(e) => setF({ ...f, occurredAt: e.target.value })} /></label>
            <label className="field">Nhóm sự cố<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              <option value="">— Chọn —</option>{Object.entries(meta.categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Mức độ (theo bạn đánh giá)<select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
              {Object.entries(meta.severity).map(([k, v]) => <option key={k} value={k}>{k}: {v}</option>)}</select></label>
            <label className="field">Xe liên quan (nếu có)<input value={f.vehicleId} onChange={(e) => setF({ ...f, vehicleId: e.target.value.toUpperCase() })} placeholder="MD-ALS-01" /></label>
          </div>
          <label className="field">Mô tả sự việc<textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Chuyện gì đã xảy ra, ở đâu, diễn biến" /></label>
          <label className="field">Đã xử trí ngay<textarea rows={2} value={f.immediateAction} onChange={(e) => setF({ ...f, immediateAction: e.target.value })} /></label>
          <div className="row">
            <label className="row small"><input type="checkbox" checked={f.patientAffected} onChange={(e) => setF({ ...f, patientAffected: e.target.checked })} /> Có ảnh hưởng tới người bệnh</label>
            <label className="row small"><input type="checkbox" checked={f.anonymous} onChange={(e) => setF({ ...f, anonymous: e.target.checked })} /> Báo ẩn danh</label>
          </div>
          {f.severity === 'NC3' && <div className="alert red small">Sự cố nghiêm trọng: báo ngay trưởng ca và QLCL bằng điện thoại, ngoài báo cáo này.</div>}
          <div><button className="primary" disabled={!f.category || f.description.trim().length < 10} onClick={submit}>Gửi báo cáo</button></div>
        </div>
      )}

      <div className="panel col">
        <h3 style={{ margin: 0 }}>Báo phơi nhiễm nghề nghiệp <span className="small muted">QLCL-05, bảo mật</span></h3>
        <div className="small">Rửa ngay vùng phơi nhiễm dưới vòi nước, không nặn máu, báo trưởng ca. Hồ sơ chỉ bạn, KSNK và Ban Giám đốc xem được.</div>
        <div className="grid4">
          <label className="field">Thời điểm<input type="datetime-local" value={ex.occurredAt} onChange={(e) => setEx({ ...ex, occurredAt: e.target.value })} /></label>
          <label className="field">Loại<select value={ex.kind} onChange={(e) => setEx({ ...ex, kind: e.target.value })}>{Object.entries(EXPOSURE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        <label className="field">Mô tả<textarea rows={2} value={ex.description} onChange={(e) => setEx({ ...ex, description: e.target.value })} /></label>
        <label className="field">Đã sơ cứu<input value={ex.firstAid} onChange={(e) => setEx({ ...ex, firstAid: e.target.value })} /></label>
        <div><button className="danger" disabled={ex.description.trim().length < 5} onClick={submitExposure}>Báo phơi nhiễm</button></div>
        {exposures.length > 0 && <table><tbody>{exposures.map((x) => (
          <tr key={x.id}><td className="small mono">{new Date(x.occurred_at).toLocaleString('vi-VN')}</td><td>{EXPOSURE[x.kind]}</td><td className="small">{x.staff_name}</td>
            <td className="small">{x.pep_started_at ? 'Đã dự phòng' : ''} {x.status === 'ket_thuc' ? 'Đã kết thúc theo dõi' : 'Đang theo dõi'}</td></tr>))}</tbody></table>}
      </div>

      <div className="grid2">
        <div className="panel" style={{ overflowX: 'auto' }}>
          <h3 style={{ marginTop: 0 }}>Báo cáo của tôi</h3>
          <table><tbody>{mine.map((e) => <tr key={e.id}><td className="mono">{e.code}</td><td className="small">{meta?.categories[e.category]}</td><td>{e.severity_reported}</td><td>{STATUS[e.status]}</td></tr>)}</tbody></table>
          {!mine.length && <div className="small muted">Chưa có (báo ẩn danh không hiện ở đây).</div>}
        </div>
        <div className="panel" style={{ overflowX: 'auto' }}>
          <h3 style={{ marginTop: 0 }}>Việc khắc phục được giao cho tôi</h3>
          <table><tbody>{capa.map((c) => (
            <tr key={c.id}><td>{c.description}<div className="small muted">{c.event_code ?? c.complaint_code} · hạn {c.due_date}</div></td>
              <td>{c.status === 'mo' ? <span className={`badge ${c.overdue ? 'far' : ''}`}>{c.overdue ? 'Quá hạn' : 'Đang mở'}</span> : c.status === 'xong' ? 'Xong' : 'Hủy'}</td>
              <td className="right">{c.status === 'mo' && <button className="ghost small" onClick={() => {
                const ev = prompt('Bằng chứng đã làm xong (biên bản, danh sách ký...):');
                if (ev && ev.trim().length >= 3) run(() => api('POST', `/api/quality/capa/${c.id}/finish`, { status: 'xong', evidence: ev }), 'Đã cập nhật.');
              }}>Báo xong</button>}</td></tr>))}</tbody></table>
          {!capa.length && <div className="small muted">Không có.</div>}
        </div>
      </div>
    </div>
  );
}
