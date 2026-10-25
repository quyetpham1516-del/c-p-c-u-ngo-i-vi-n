import { Fragment, useEffect, useState } from 'react';
import { api, session } from '../api';
import { useStations } from '../catalog';
import { QualityCriteria } from './QualityCriteria';

interface Meta { categories: Record<string, string>; severity: Record<string, string>; factors: string[] }
interface Staff { id: string; full_name: string; role: string; title: string | null }

const EV_STATUS: Record<string, string> = { moi: 'Mới', dang_xu_ly: 'Đang xử lý', da_phan_tich: 'Đã phân tích', dong: 'Đã đóng' };
const C_STATUS: Record<string, string> = { moi: 'Mới', dang_xu_ly: 'Đang xử lý', da_phan_hoi: 'Đã phản hồi', dong: 'Đã đóng' };
const C_CAT: Record<string, string> = { thai_do: 'Thái độ', thoi_gian: 'Thời gian', chuyen_mon: 'Chuyên môn', chi_phi: 'Chi phí', khac: 'Khác' };
const CHANNEL: Record<string, string> = { dien_thoai: 'Điện thoại', truc_tiep: 'Trực tiếp', email: 'Email', mang_xa_hoi: 'Mạng xã hội', khao_sat: 'Khảo sát', khac: 'Khác' };
const MOMENT: Record<string, string> = { truoc_tiep_xuc: 'Trước tiếp xúc người bệnh', truoc_vo_khuan: 'Trước thủ thuật vô khuẩn', sau_dich_co_the: 'Sau phơi nhiễm dịch cơ thể', sau_tiep_xuc: 'Sau tiếp xúc người bệnh', sau_moi_truong: 'Sau tiếp xúc môi trường quanh người bệnh' };
const WASTE: Record<string, string> = { lay_nhiem: 'Lây nhiễm', sac_nhon: 'Sắc nhọn', nguy_hai: 'Nguy hại khác', thong_thuong: 'Thông thường', tai_che: 'Tái chế' };
const EXPOSURE: Record<string, string> = { kim_dam: 'Kim đâm', vat_sac: 'Vật sắc nhọn', mau_ban_niem_mac: 'Máu bắn niêm mạc', mau_ban_da_ton_thuong: 'Máu dính da tổn thương', khac: 'Khác' };
const LEVEL: Record<string, string> = { thuong_quy: 'Thường quy', tang_cuong: 'Tăng cường', toan_dien: 'Toàn diện' };
const at = (s: string) => new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const pct = (ok: number, n: number) => (n ? `${Math.round((ok / n) * 100)}%` : '—');

/** Chất lượng và an toàn: sự cố y khoa, khắc phục, khiếu nại, khảo sát hài lòng, kiểm soát nhiễm khuẩn */
export function Quality() {
  const role = session.user?.role ?? '';
  const isQuality = ['qa', 'supervisor', 'admin', 'director'].includes(role);
  const isIpc = ['ipc', 'qa', 'supervisor', 'admin', 'director'].includes(role);
  const tabs = [
    ...(isQuality || role === 'ipc' ? ['Sự cố'] : []), 'Tiêu chí chất lượng', ...(isQuality ? ['Gợi ý từ dữ liệu', 'Khắc phục (CAPA)', 'Khiếu nại', 'Khảo sát hài lòng'] : []),
    ...(isIpc ? ['Kiểm soát nhiễm khuẩn'] : []), ...(['admin', 'qa', 'supervisor'].includes(role) ? ['Tin nhắn chờ gửi'] : []),
  ];
  const [tab, setTab] = useState(tabs[0]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api<Meta>('GET', '/api/quality/meta').then(setMeta).catch(() => {});
    api<Staff[]>('GET', '/api/staff').then(setStaff).catch(() => {});
  }, []);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  const ctx = { meta, staff, run, canEdit: isQuality };
  return (
    <div className="col">
      <h2 className="no-print" style={{ margin: 0 }}>Chất lượng và an toàn <span className="small muted">QLCL-01, 02, 03, 05, 07, 08, 10</span></h2>
      <div className="tabs no-print">{tabs.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); setMsg(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {meta && tab === 'Sự cố' && <EventsTab {...ctx} />}
      {meta && tab === 'Gợi ý từ dữ liệu' && <SuggestTab {...ctx} />}
      {tab === 'Tiêu chí chất lượng' && <QualityCriteria staff={staff} run={run} />}
      {tab === 'Khắc phục (CAPA)' && <CapaTab {...ctx} />}
      {tab === 'Khiếu nại' && <ComplaintsTab {...ctx} />}
      {tab === 'Khảo sát hài lòng' && <SurveyTab />}
      {tab === 'Kiểm soát nhiễm khuẩn' && <IpcTab {...ctx} />}
      {tab === 'Tin nhắn chờ gửi' && <OutboxTab run={run} />}
    </div>
  );
}

type Ctx = { meta: Meta | null; staff: Staff[]; run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>; canEdit: boolean };

function StaffSelect({ staff, value, onChange, placeholder = '— Chọn người —' }: { staff: Staff[]; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)}><option value="">{placeholder}</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}{s.title ? ` (${s.title})` : ''}</option>)}</select>;
}

function EventsTab({ meta, staff, run, canEdit }: Ctx) {
  const [list, setList] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<any>(null);
  const [edit, setEdit] = useState<any>({});
  const [capa, setCapa] = useState({ description: '', ownerId: '', dueDate: '', kind: 'khac_phuc' });
  const load = () => api<any[]>('GET', `/api/quality/events${status ? `?status=${status}` : ''}`).then(setList);
  useEffect(() => { load().catch(() => {}); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = async (id: string) => {
    if (open?.id === id) { setOpen(null); return; }
    const e = await api('GET', `/api/quality/events/${id}`);
    setOpen(e); setEdit({ severity: e.severity ?? e.severity_reported, handlerId: e.handler_id ?? '', rootCause: e.root_cause ?? '', factors: e.factors ?? [], lessons: e.lessons ?? '' });
  };
  const refresh = async () => { await load(); if (open) setOpen(await api('GET', `/api/quality/events/${open.id}`)); };
  const save = (extra: object = {}) => run(async () => {
    await api('PATCH', `/api/quality/events/${open.id}`, { severity: edit.severity, handlerId: edit.handlerId || null, rootCause: edit.rootCause || null, factors: edit.factors, lessons: edit.lessons || null, ...extra });
    await refresh();
  }, 'Đã lưu.');
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Mọi trạng thái</option>{Object.entries(EV_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <span className="small muted">NC3 phải báo cơ quan quản lý trong 24 giờ và do Ban Giám đốc đóng.</span>
      </div>
      <table>
        <thead><tr><th>Mã</th><th>Báo lúc</th><th>Nhóm</th><th>Mức</th><th>Ca/xe</th><th>Xử lý</th><th>Trạng thái</th></tr></thead>
        <tbody>{list.map((e) => (
          <Fragment key={e.id}>
            <tr style={{ cursor: 'pointer' }} onClick={() => show(e.id)}>
              <td className="mono">{e.code}{e.anonymous && <div className="small muted">ẩn danh</div>}</td><td className="small">{at(e.reported_at)}</td>
              <td className="small">{meta!.categories[e.category] ?? e.category}</td>
              <td><span className={`badge ${['NC2', 'NC3'].includes(e.severity ?? e.severity_reported) ? 'far' : ''}`}>{e.severity ?? e.severity_reported}</span></td>
              <td className="small">{e.incident_code ?? ''} {e.vehicle_id ?? ''}</td><td className="small">{e.handler_name ?? '—'}</td>
              <td>{EV_STATUS[e.status]}{e.open_capa > 0 && <div className="small muted">{e.open_capa} việc khắc phục đang mở</div>}{e.report_overdue && <div className="small error">Quá 24 giờ chưa báo cơ quan</div>}</td>
            </tr>
            {open?.id === e.id && (
              <tr><td colSpan={7}>
                <div className="col">
                  <div><b>Mô tả:</b> {open.description}</div>
                  {open.immediate_action && <div><b>Đã xử trí:</b> {open.immediate_action}</div>}
                  <div className="small muted">Xảy ra {at(open.occurred_at)} · người báo: {open.anonymous ? 'ẩn danh' : open.reporter_name} · mức người báo chọn: {open.severity_reported}{open.patient_affected ? ' · có ảnh hưởng người bệnh' : ''}</div>
                  {canEdit && open.status !== 'dong' && (
                    <>
                      <div className="grid4">
                        <label className="field">Mức độ (QLCL)<select value={edit.severity} onChange={(x) => setEdit({ ...edit, severity: x.target.value })}>{Object.entries(meta!.severity).map(([k, v]) => <option key={k} value={k}>{k}: {v}</option>)}</select></label>
                        <label className="field">Người xử lý<StaffSelect staff={staff.filter((s) => ['qa', 'supervisor', 'admin', 'director', 'ipc'].includes(s.role))} value={edit.handlerId} onChange={(v) => setEdit({ ...edit, handlerId: v })} /></label>
                      </div>
                      <label className="field">Nguyên nhân gốc (RCA)<textarea rows={3} value={edit.rootCause} onChange={(x) => setEdit({ ...edit, rootCause: x.target.value })} /></label>
                      <div className="row small">Nhóm yếu tố: {meta!.factors.map((f) => (
                        <label key={f} className="row"><input type="checkbox" checked={edit.factors.includes(f)} onChange={(x) => setEdit({ ...edit, factors: x.target.checked ? [...edit.factors, f] : edit.factors.filter((y: string) => y !== f) })} />{f}</label>))}</div>
                      <label className="field">Bài học<textarea rows={2} value={edit.lessons} onChange={(x) => setEdit({ ...edit, lessons: x.target.value })} /></label>
                      <div className="row">
                        <button onClick={() => save()}>Lưu</button>
                        <button onClick={() => save({ status: 'da_phan_tich' })}>Lưu, chuyển "đã phân tích"</button>
                        {(edit.severity === 'NC3') && !open.authority_reported_at && <button className="danger" onClick={() => save({ authorityReported: true })}>Đã báo cơ quan quản lý</button>}
                        <button className="primary" onClick={() => { const note = prompt('Kết luận khi đóng sự cố:'); if (note) run(async () => { await api('POST', `/api/quality/events/${open.id}/close`, { note }); await refresh(); }, 'Đã đóng sự cố.'); }}>Đóng sự cố</button>
                      </div>
                    </>
                  )}
                  {open.authority_reported_at && <div className="small">Đã báo cơ quan quản lý lúc {at(open.authority_reported_at)}</div>}
                  {open.status === 'dong' && <div className="small">Đóng bởi {open.closed_by_name} lúc {at(open.closed_at)}: {open.close_note}</div>}
                  <h3>Hành động khắc phục, phòng ngừa</h3>
                  <table><tbody>{open.capa.map((c: any) => <tr key={c.id}><td>{c.kind === 'phong_ngua' ? 'Phòng ngừa' : 'Khắc phục'}: {c.description}</td><td className="small">{c.owner_name} · hạn {c.due_date}</td><td>{c.status === 'mo' ? 'Đang mở' : c.status === 'xong' ? `Xong: ${c.evidence}` : 'Hủy'}</td></tr>)}</tbody></table>
                  {canEdit && open.status !== 'dong' && (
                    <div className="row">
                      <select value={capa.kind} onChange={(x) => setCapa({ ...capa, kind: x.target.value })}><option value="khac_phuc">Khắc phục</option><option value="phong_ngua">Phòng ngừa</option></select>
                      <input placeholder="Việc cần làm" style={{ minWidth: 260 }} value={capa.description} onChange={(x) => setCapa({ ...capa, description: x.target.value })} />
                      <StaffSelect staff={staff} value={capa.ownerId} onChange={(v) => setCapa({ ...capa, ownerId: v })} placeholder="— Người phụ trách —" />
                      <input type="date" value={capa.dueDate} onChange={(x) => setCapa({ ...capa, dueDate: x.target.value })} />
                      <button disabled={capa.description.trim().length < 5 || !capa.ownerId || !capa.dueDate} onClick={() => run(async () => {
                        await api('POST', '/api/quality/capa', { eventId: open.id, ...capa }); setCapa({ description: '', ownerId: '', dueDate: '', kind: 'khac_phuc' }); await refresh();
                      }, 'Đã giao việc khắc phục.')}>Giao việc</button>
                    </div>
                  )}
                </div>
              </td></tr>
            )}
          </Fragment>
        ))}</tbody>
      </table>
      {!list.length && <div className="small muted">Chưa có báo cáo sự cố.</div>}
    </div>
  );
}

function SuggestTab({ meta, run }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => api<any[]>('GET', '/api/quality/suggestions').then(setRows);
  useEffect(() => { load().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const create = (s: any) => {
    const sev = prompt('Mức độ (NC0, NC1, NC2, NC3):', 'NC0')?.toUpperCase();
    if (!sev || !['NC0', 'NC1', 'NC2', 'NC3'].includes(sev)) return;
    run(async () => { await api('POST', '/api/quality/events', { occurredAt: s.at, category: s.category, description: s.text, severity: sev, sourceRef: s.ref, incidentId: s.incident_id, vehicleId: s.vehicle_id }); await load(); }, 'Đã tạo báo cáo sự cố từ gợi ý.');
  };
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <div className="small muted" style={{ marginBottom: 8 }}>Hệ thống tự rà 30 ngày: ca P1 xe lăn bánh chậm hoặc tới nơi quá 15 phút, phiếu sửa sau khi ký, xe thiếu thiết bị vẫn được cho đi, lô tiệt khuẩn không đạt, khiếu nại về chuyên môn.</div>
      <table><tbody>{rows.map((s) => (
        <tr key={s.ref}><td className="small mono">{at(s.at)}</td><td className="small">{meta!.categories[s.category]}</td><td>{s.text}</td>
          <td className="right"><button className="small" onClick={() => create(s)}>Tạo báo cáo</button></td></tr>))}</tbody></table>
      {!rows.length && <div className="small muted">Không có gợi ý mới.</div>}
    </div>
  );
}

function CapaTab({ run }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => api<any[]>('GET', '/api/quality/capa').then(setRows);
  useEffect(() => { load().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <table>
        <thead><tr><th>Việc</th><th>Nguồn</th><th>Phụ trách</th><th>Hạn</th><th>Trạng thái</th><th /></tr></thead>
        <tbody>{rows.map((c) => (
          <tr key={c.id}><td>{c.kind === 'phong_ngua' ? 'Phòng ngừa' : 'Khắc phục'}: {c.description}</td><td className="mono small">{c.event_code ?? c.complaint_code}</td><td className="small">{c.owner_name}</td>
            <td className="mono small" style={c.overdue ? { color: 'var(--p1)', fontWeight: 700 } : undefined}>{c.due_date}</td>
            <td>{c.status === 'mo' ? (c.overdue ? 'Quá hạn' : 'Đang mở') : c.status === 'xong' ? 'Xong' : 'Hủy'}{c.evidence && <div className="small muted">{c.evidence}</div>}</td>
            <td className="right">{c.status === 'mo' && <>
              <button className="ghost small" onClick={() => { const ev = prompt('Bằng chứng đã làm xong:'); if (ev && ev.length >= 3) run(async () => { await api('POST', `/api/quality/capa/${c.id}/finish`, { status: 'xong', evidence: ev }); await load(); }); }}>Xong</button>{' '}
              <button className="ghost small" onClick={() => { const ev = prompt('Lý do hủy:'); if (ev && ev.length >= 3) run(async () => { await api('POST', `/api/quality/capa/${c.id}/finish`, { status: 'huy', evidence: ev }); await load(); }); }}>Hủy</button></>}</td></tr>))}</tbody>
      </table>
      {!rows.length && <div className="small muted">Chưa có.</div>}
    </div>
  );
}

function ComplaintsTab({ staff, run }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState({ channel: 'dien_thoai', complainant: '', phone: '', incidentCode: '', category: 'thoi_gian', content: '', urgent: false });
  const load = () => api<any[]>('GET', '/api/quality/complaints').then(setRows);
  useEffect(() => { load().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const patch = (id: string, body: object, ok: string) => run(async () => { await api('PATCH', `/api/quality/complaints/${id}`, body); await load(); }, ok);
  return (
    <>
      <div className="panel col">
        <h3 style={{ margin: 0 }}>Tiếp nhận khiếu nại <span className="small muted">QLCL-07</span></h3>
        <div className="grid4">
          <label className="field">Kênh<select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{Object.entries(CHANNEL).filter(([k]) => k !== 'khao_sat').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Người khiếu nại<input value={f.complainant} onChange={(e) => setF({ ...f, complainant: e.target.value })} /></label>
          <label className="field">Điện thoại<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <label className="field">Mã ca (nếu có)<input value={f.incidentCode} onChange={(e) => setF({ ...f, incidentCode: e.target.value })} placeholder="MD-..." /></label>
          <label className="field">Nội dung về<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(C_CAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        <label className="field">Nội dung<textarea rows={3} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} /></label>
        <div className="row">
          <label className="row small"><input type="checkbox" checked={f.urgent} onChange={(e) => setF({ ...f, urgent: e.target.checked })} /> Khẩn (phản hồi trong 24 giờ, thường 48 giờ)</label>
          <button className="primary" disabled={f.content.trim().length < 5} onClick={() => run(async () => {
            await api('POST', '/api/quality/complaints', { ...f, complainant: f.complainant || null, phone: f.phone || null, incidentCode: f.incidentCode || null });
            setF({ ...f, complainant: '', phone: '', incidentCode: '', content: '' }); await load();
          }, 'Đã tiếp nhận khiếu nại.')}>Tiếp nhận</button>
        </div>
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Mã</th><th>Nhận lúc</th><th>Kênh</th><th>Nội dung</th><th>Hạn phản hồi</th><th>Phụ trách</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id}>
              <td className="mono">{c.code}{c.incident_code && <div className="small muted">{c.incident_code}</div>}</td><td className="small">{at(c.received_at)}</td><td className="small">{CHANNEL[c.channel]}</td>
              <td><b>{C_CAT[c.category]}</b>: {c.content}{c.complainant && <div className="small muted">{c.complainant} {c.phone}</div>}{c.response && <div className="small">Đã phản hồi: {c.response}</div>}</td>
              <td className="small mono" style={c.overdue ? { color: 'var(--p1)', fontWeight: 700 } : undefined}>{at(c.due_at)}{c.overdue ? ' (quá hạn)' : ''}</td>
              <td>{c.status !== 'dong' ? <StaffSelect staff={staff} value={c.assigned_to ?? ''} onChange={(v) => patch(c.id, { assignedTo: v || null }, 'Đã giao người xử lý.')} placeholder="— Chưa giao —" /> : <span className="small">{c.assigned_name}</span>}</td>
              <td>{C_STATUS[c.status]}{c.satisfied != null && <div className="small muted">{c.satisfied ? 'Hài lòng với phản hồi' : 'Chưa hài lòng'}</div>}</td>
              <td className="right">{c.status !== 'dong' && <>
                <button className="ghost small" onClick={() => { const r = prompt('Nội dung đã phản hồi người khiếu nại:'); if (r && r.length >= 3) patch(c.id, { response: r }, 'Đã ghi phản hồi.'); }}>Phản hồi</button>{' '}
                {c.response && <button className="ghost small" onClick={() => patch(c.id, { close: true, satisfied: confirm('Người khiếu nại hài lòng với phản hồi?') }, 'Đã đóng khiếu nại.')}>Đóng</button>}</>}</td>
            </tr>))}</tbody>
        </table>
        {!rows.length && <div className="small muted">Chưa có khiếu nại.</div>}
      </div>
    </>
  );
}

function SurveyTab() {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api('GET', '/api/quality/surveys').then(setD).catch(() => {}); }, []);
  if (!d) return <div className="panel muted">Đang tải…</div>;
  const s = d.stats;
  return (
    <>
      <div className="grid4">
        {[['Đã gửi', s.sent], ['Trả lời', `${s.answered} (${pct(s.answered, s.sent)})`], ['Hài lòng (4–5 điểm)', pct(s.satisfied, s.answered)], ['Điểm chung', s.overall ?? '—']].map(([k, v]) => (
          <div key={k} className="panel"><div className="small muted">{k}</div><div style={{ fontSize: 26, fontWeight: 700 }}>{v}</div></div>))}
      </div>
      <div className="panel small">Điểm trung bình 90 ngày: kịp thời {s.timeliness ?? '—'}, thái độ {s.attitude ?? '—'}, chăm sóc {s.care ?? '—'} (thang 5). Trả lời từ 2 điểm trở xuống tự thành khiếu nại.</div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table><thead><tr><th>Ca</th><th>Trả lời lúc</th><th className="right">Chung</th><th className="right">Kịp thời</th><th className="right">Thái độ</th><th className="right">Chăm sóc</th><th>Góp ý</th></tr></thead>
          <tbody>{d.recent.map((r: any) => <tr key={r.id}><td className="mono">{r.incident_code}</td><td className="small">{at(r.answered_at)}</td><td className="right">{r.overall}</td><td className="right">{r.timeliness ?? '—'}</td><td className="right">{r.attitude ?? '—'}</td><td className="right">{r.care ?? '—'}</td><td className="small">{r.comment}</td></tr>)}</tbody></table>
        {!d.recent.length && <div className="small muted">Chưa có trả lời.</div>}
      </div>
    </>
  );
}

function IpcTab({ staff, run }: Ctx) {
  const role = session.user?.role ?? '';
  const canWrite = ['ipc', 'supervisor', 'admin'].includes(role);
  const canExposure = ['ipc', 'admin', 'director'].includes(role);
  const [stations] = useStations();
  const [sum, setSum] = useState<any>(null);
  const [dis, setDis] = useState<any[]>([]);
  const [hh, setHh] = useState<any>(null);
  const [ex, setEx] = useState<any[]>([]);
  const [vac, setVac] = useState<any[]>([]);
  const [waste, setWaste] = useState<any>(null);
  const [obs, setObs] = useState({ stationId: '', staffId: '', staffGroup: '', moment: 'truoc_tiep_xuc', method: 'chua_con' });
  const [v, setV] = useState({ staffId: '', vaccine: 'Viêm gan B', dose: '', givenOn: '', nextDue: '' });
  const [w, setW] = useState({ stationId: '', onDate: new Date().toISOString().slice(0, 10), kind: 'lay_nhiem', kg: '', handedTo: '' });
  const load = () => Promise.all([
    api('GET', '/api/ipc/summary').then(setSum), api<any[]>('GET', '/api/ipc/disinfections').then(setDis), api('GET', '/api/ipc/hand-hygiene/stats').then(setHh),
    api<any[]>('GET', '/api/ipc/exposures').then(setEx), api<any[]>('GET', '/api/ipc/vaccinations').then(setVac), api('GET', '/api/ipc/waste').then(setWaste),
  ]);
  useEffect(() => { load().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const observe = (compliant: boolean) => run(async () => {
    await api('POST', '/api/ipc/hand-hygiene', { stationId: obs.stationId || null, staffId: obs.staffId || null, staffGroup: obs.staffGroup || null, moment: obs.moment, compliant, method: compliant ? obs.method : 'khong' });
    await load();
  }, compliant ? 'Đã ghi: tuân thủ.' : 'Đã ghi: không tuân thủ.');
  if (!sum) return <div className="panel muted">Đang tải…</div>;
  return (
    <>
      <div className="grid4">
        <div className="panel"><div className="small muted">Phiếu khử khuẩn chờ làm</div><div style={{ fontSize: 26, fontWeight: 700 }}>{sum.pendingDisinfections}</div></div>
        <div className="panel"><div className="small muted">Tuân thủ vệ sinh tay 30 ngày</div><div style={{ fontSize: 26, fontWeight: 700 }}>{pct(sum.handHygiene.ok, sum.handHygiene.n)}</div><div className="small muted">{sum.handHygiene.n} lần quan sát</div></div>
        <div className="panel"><div className="small muted">Phơi nhiễm đang theo dõi</div><div style={{ fontSize: 26, fontWeight: 700 }}>{sum.openExposures}</div></div>
        <div className="panel"><div className="small muted">Mũi tiêm đến hạn 30 ngày</div><div style={{ fontSize: 26, fontWeight: 700 }}>{sum.vaccinesDue.length}</div></div>
      </div>
      {sum.infectiousPending.length > 0 && <div className="alert red">Xe chờ khử khuẩn ca nghi lây nhiễm: {sum.infectiousPending.map((p: any) => `${p.vehicle_id} (${p.incident_code}, ${LEVEL[p.required_level]})`).join('; ')}</div>}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Khử khuẩn xe 30 ngày</h3>
        <table><thead><tr><th>Xe</th><th>Ca</th><th>Mức cần</th><th>Trạng thái</th><th>Hóa chất</th><th>Người làm</th></tr></thead>
          <tbody>{dis.map((d) => <tr key={d.id}><td>{d.vehicle_id}</td><td className="mono small">{d.incident_code ?? '—'}</td><td>{LEVEL[d.required_level]}</td>
            <td>{d.status === 'da_ky' ? `Đã ký ${LEVEL[d.level]}` : <span className={`badge ${d.required_level !== 'thuong_quy' ? 'far' : ''}`}>Chờ làm</span>}</td>
            <td className="small">{d.chemical ?? ''} {d.concentration ?? ''}{d.contact_minutes ? ` · ${d.contact_minutes} phút` : ''}</td><td className="small">{d.done_by_name ?? ''}{d.done_at ? ` · ${at(d.done_at)}` : ''}</td></tr>)}</tbody></table>
        {!dis.length && <div className="small muted">Chưa có.</div>}
      </div>
      <div className="panel col">
        <h3 style={{ margin: 0 }}>Giám sát vệ sinh tay (5 thời điểm)</h3>
        {canWrite || role === 'qa' ? (
          <div className="grid4">
            <label className="field">Điểm<select value={obs.stationId} onChange={(e) => setObs({ ...obs, stationId: e.target.value })}><option value="">—</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
            <label className="field">Nhân viên<StaffSelect staff={staff} value={obs.staffId} onChange={(x) => setObs({ ...obs, staffId: x })} placeholder="— Không ghi tên —" /></label>
            {!obs.staffId && <label className="field">Nhóm<input value={obs.staffGroup} onChange={(e) => setObs({ ...obs, staffGroup: e.target.value })} placeholder="Bác sĩ, điều dưỡng, lái xe..." /></label>}
            <label className="field">Thời điểm<select value={obs.moment} onChange={(e) => setObs({ ...obs, moment: e.target.value })}>{Object.entries(MOMENT).map(([k, x]) => <option key={k} value={k}>{x}</option>)}</select></label>
            <label className="field">Cách<select value={obs.method} onChange={(e) => setObs({ ...obs, method: e.target.value })}><option value="chua_con">Dung dịch chứa cồn</option><option value="xa_phong">Nước và xà phòng</option></select></label>
            <div className="row" style={{ alignItems: 'flex-end' }}><button className="primary" onClick={() => observe(true)}>Tuân thủ</button><button className="danger" onClick={() => observe(false)}>Không tuân thủ</button></div>
          </div>
        ) : null}
        {hh && <table><tbody>{hh.byMoment.map((m: any) => <tr key={m.moment}><td>{MOMENT[m.moment]}</td><td className="right mono">{pct(m.ok, m.n)}</td><td className="right small muted">{m.n} lần</td></tr>)}</tbody></table>}
      </div>
      {canExposure && (
        <div className="panel" style={{ overflowX: 'auto' }}>
          <h3 style={{ marginTop: 0 }}>Phơi nhiễm nghề nghiệp (bảo mật)</h3>
          <table><tbody>{ex.map((x) => (
            <tr key={x.id}><td className="small">{at(x.occurred_at)}</td><td>{x.staff_name}</td><td>{EXPOSURE[x.kind]}<div className="small muted">{x.description}</div></td>
              <td className="small">{x.pep_started_at ? `Dự phòng từ ${at(x.pep_started_at)}` : 'Chưa dự phòng'}{x.followups.map((f: any, i: number) => <div key={i}>{f.on}: {f.test} {f.result}</div>)}</td>
              <td className="right">{x.status === 'dang_theo_doi' ? <>
                {!x.pep_started_at && <button className="ghost small" onClick={() => run(async () => { await api('PATCH', `/api/ipc/exposures/${x.id}`, { pepStarted: true }); await load(); })}>Bắt đầu dự phòng</button>}{' '}
                <button className="ghost small" onClick={() => { const test = prompt('Xét nghiệm (Anti-HIV, HBsAg, Anti-HCV...):'); const result = test ? prompt('Kết quả:') : null; if (test && result !== null) run(async () => { await api('PATCH', `/api/ipc/exposures/${x.id}`, { followup: { on: new Date().toISOString().slice(0, 10), test, result } }); await load(); }); }}>Ghi xét nghiệm</button>{' '}
                <button className="ghost small" onClick={() => run(async () => { await api('PATCH', `/api/ipc/exposures/${x.id}`, { close: true }); await load(); })}>Kết thúc</button></> : 'Đã kết thúc'}</td></tr>))}</tbody></table>
          {!ex.length && <div className="small muted">Không có.</div>}
        </div>
      )}
      <div className="grid2">
        <div className="panel" style={{ overflowX: 'auto' }}>
          <h3 style={{ marginTop: 0 }}>Tiêm chủng nhân viên</h3>
          {canWrite && <div className="row" style={{ marginBottom: 6 }}>
            <StaffSelect staff={staff} value={v.staffId} onChange={(x) => setV({ ...v, staffId: x })} />
            <input style={{ width: 120 }} value={v.vaccine} onChange={(e) => setV({ ...v, vaccine: e.target.value })} />
            <input style={{ width: 80 }} placeholder="Mũi" value={v.dose} onChange={(e) => setV({ ...v, dose: e.target.value })} />
            <input type="date" title="Ngày tiêm" value={v.givenOn} onChange={(e) => setV({ ...v, givenOn: e.target.value })} />
            <input type="date" title="Hạn mũi kế tiếp" value={v.nextDue} onChange={(e) => setV({ ...v, nextDue: e.target.value })} />
            <button disabled={!v.staffId || !v.givenOn} onClick={() => run(async () => { await api('POST', '/api/ipc/vaccinations', { ...v, dose: v.dose || null, nextDue: v.nextDue || null }); await load(); }, 'Đã ghi mũi tiêm.')}>Ghi</button>
          </div>}
          <table><tbody>{vac.map((x) => <tr key={x.id}><td>{x.staff_name}</td><td>{x.vaccine} {x.dose ?? ''}</td><td className="small mono">{x.given_on}</td><td className="small mono">{x.next_due ? `hạn ${x.next_due}` : ''}</td></tr>)}</tbody></table>
        </div>
        <div className="panel" style={{ overflowX: 'auto' }}>
          <h3 style={{ marginTop: 0 }}>Chất thải y tế 90 ngày</h3>
          {canWrite && <div className="row" style={{ marginBottom: 6 }}>
            <select value={w.stationId} onChange={(e) => setW({ ...w, stationId: e.target.value })}><option value="">— Điểm —</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select>
            <input type="date" value={w.onDate} onChange={(e) => setW({ ...w, onDate: e.target.value })} />
            <select value={w.kind} onChange={(e) => setW({ ...w, kind: e.target.value })}>{Object.entries(WASTE).map(([k, x]) => <option key={k} value={k}>{x}</option>)}</select>
            <input style={{ width: 70 }} placeholder="kg" inputMode="decimal" value={w.kg} onChange={(e) => setW({ ...w, kg: e.target.value })} />
            <input style={{ width: 140 }} placeholder="Bàn giao cho" value={w.handedTo} onChange={(e) => setW({ ...w, handedTo: e.target.value })} />
            <button disabled={!w.stationId || w.kg === ''} onClick={() => run(async () => { await api('POST', '/api/ipc/waste', { ...w, kg: Number(w.kg), handedTo: w.handedTo || null }); setW({ ...w, kg: '' }); await load(); }, 'Đã ghi.')}>Ghi</button>
          </div>}
          <table><tbody>{waste?.summary.map((x: any) => <tr key={`${x.station_id}-${x.kind}`}><td>{x.station_id}</td><td>{WASTE[x.kind]}</td><td className="right mono">{x.kg} kg</td></tr>)}</tbody></table>
        </div>
      </div>
    </>
  );
}

function OutboxTab({ run }: { run: Ctx['run'] }) {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => api<any[]>('GET', '/api/messages/outbox').then(setRows);
  useEffect(() => { load().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <div className="small muted" style={{ marginBottom: 8 }}>Tin nhắn khảo sát và thông báo chờ gửi. Khi nối nhà cung cấp SMS/Zalo, bộ phận gửi tự lấy hàng đợi này; trước đó có thể gửi tay rồi đánh dấu.</div>
      <table><tbody>{rows.map((m) => (
        <tr key={m.id}><td className="small mono">{at(m.created_at)}</td><td className="mono">{m.to_phone}</td><td className="small">{m.body}</td><td>{m.status === 'cho_gui' ? 'Chờ gửi' : m.status === 'da_gui' ? 'Đã gửi' : `Lỗi: ${m.error ?? ''}`}</td>
          <td className="right">{m.status === 'cho_gui' && <button className="ghost small" onClick={() => run(async () => { await api('POST', `/api/messages/outbox/${m.id}/sent`, { ok: true }); await load(); })}>Đã gửi</button>}</td></tr>))}</tbody></table>
      {!rows.length && <div className="small muted">Không có tin nhắn.</div>}
    </div>
  );
}
