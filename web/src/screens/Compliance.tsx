'use client';
import { useEffect, useState } from 'react';
import { api, ROLE_LABEL, session, type Role } from '../api';
import { useStations } from '../catalog';
import { CapaQuick } from './Ops';

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
type Meta = Record<string, any>;
type Ctx = { meta: Meta; run: Run };

const IT = ['admin', 'director'];
const DPO = ['qa', 'admin', 'director'];
const SAFETY_VIEW = ['supervisor', 'qa', 'admin', 'director', 'hr', 'technician'];
const SAFETY_EDIT = ['supervisor', 'qa', 'admin', 'director', 'hr'];
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const nowLocal = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 16);
const toIso = (local: string) => (local ? new Date(`${local}:00+07:00`).toISOString() : null);
const d = (s?: string | null) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '—');
const at = (s?: string | null) => (s ? new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const size = (n?: number | string | null) => (n == null ? '' : `${(Number(n) / 1048576).toFixed(1)} MB`);
const BREACH_SEVERITY: Record<string, string> = { thap: 'Thấp', trung_binh: 'Trung bình', cao: 'Cao' };
const PD_STATUS: Record<string, string> = { moi: 'Mới', dang_xu_ly: 'Đang xử lý', da_tra_loi: 'Đã trả lời', tu_choi: 'Từ chối' };
const DRILL_STATUS: Record<string, string> = { ke_hoach: 'Kế hoạch', da_lam: 'Đã làm', huy: 'Hủy' };

/** Tuân thủ: sao lưu và thử khôi phục, rà soát tài khoản, dữ liệu cá nhân (NĐ 13/2023), an toàn lao động, PCCC, diễn tập */
export function Compliance() {
  const role = session.user?.role ?? '';
  const tabs = [
    ...(IT.includes(role) ? ['Sao lưu', 'Rà soát tài khoản'] : []),
    ...(DPO.includes(role) ? ['Dữ liệu cá nhân'] : []),
    ...(SAFETY_VIEW.includes(role) ? ['An toàn, PCCC, diễn tập'] : []),
  ];
  const [tab, setTab] = useState(tabs[0]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const loadSummary = () => api('GET', '/api/compliance/summary').then(setSummary).catch(() => {});
  useEffect(() => {
    api<Meta>('GET', '/api/compliance/meta').then(setMeta).catch((e) => setError(e.message));
    loadSummary();
  }, []);
  const run: Run = async (fn, ok) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) { setMsg(ok); loadSummary(); } return true; } catch (e) { setError((e as Error).message); return false; }
  };
  if (!tabs.length) return <div className="panel">Vai trò của bạn không dùng màn này.</div>;
  if (!meta) return error ? <div className="error">{error}</div> : null;
  const ctx: Ctx = { meta, run };
  const todo: string[] = summary ? [
    ...(IT.includes(role) ? summary.backupWarnings : []),
    ...(IT.includes(role) && !summary.lastAccessReview ? ['Chưa có đợt rà soát tài khoản nào hoàn tất'] : []),
    ...(DPO.includes(role) && summary.pdRequests.overdue ? [`${summary.pdRequests.overdue} yêu cầu về dữ liệu cá nhân quá hạn ${meta.pdRequestHours} giờ`] : []),
    ...(DPO.includes(role) && summary.breaches.overdue ? [`${summary.breaches.overdue} vi phạm dữ liệu chưa báo cơ quan chức năng quá ${meta.pdBreachHours} giờ`] : []),
    ...summary.drills.filter((x: any) => x.done < x.min).map((x: any) => `Diễn tập ${x.label}: mới làm ${x.done}/${x.min} lần trong năm`),
  ] : [];
  return (
    <div className="col">
      <h2 className="no-print" style={{ margin: 0 }}>Tuân thủ <span className="small muted">sao lưu, tài khoản, dữ liệu cá nhân, an toàn</span></h2>
      {todo.length > 0 && <div className="panel amber small">{todo.map((t) => <div key={t}>• {t}</div>)}</div>}
      <div className="tabs no-print">{tabs.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); setMsg(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {tab === 'Sao lưu' && <Backups {...ctx} />}
      {tab === 'Rà soát tài khoản' && <AccessReviews {...ctx} />}
      {tab === 'Dữ liệu cá nhân' && <PersonalData {...ctx} />}
      {tab === 'An toàn, PCCC, diễn tập' && <Safety {...ctx} />}
    </div>
  );
}

/* ======================= Sao lưu ======================= */

function Backups({ run }: Ctx) {
  const [s, setS] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const load = () => api('GET', '/api/compliance/backups').then(setS);
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const go = async (kind: 'sao_luu' | 'thu_khoi_phuc') => {
    setBusy(kind);
    await run(async () => setS(await api('POST', '/api/compliance/backups/run', { kind })), kind === 'sao_luu' ? 'Đã sao lưu' : 'Thử khôi phục đạt');
    setBusy('');
    load().catch(() => {});
  };
  if (!s) return null;
  return (
    <div className="col">
      <div className="panel">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="primary" disabled={!!busy} onClick={() => go('sao_luu')}>{busy === 'sao_luu' ? 'Đang sao lưu…' : 'Sao lưu ngay'}</button>
          <button disabled={!!busy} onClick={() => go('thu_khoi_phuc')}>{busy === 'thu_khoi_phuc' ? 'Đang thử khôi phục…' : 'Thử khôi phục bản mới nhất'}</button>
        </div>
        <div className="small" style={{ marginTop: 8 }}>
          Bản gần nhất: {s.lastOk ? `${at(s.lastOk.finished_at ?? s.lastOk.started_at)} · ${s.lastOk.file} · ${size(s.lastOk.size_bytes)}` : 'chưa có'}<br />
          Thử khôi phục gần nhất: {s.lastRestore ? at(s.lastRestore.started_at) : 'chưa làm'}<br />
          <span className="muted">Yêu cầu: sao lưu ít nhất mỗi {s.maxAgeHours} giờ (đặt lịch chạy <span className="mono">npm run backup</span> hằng đêm trên máy chủ), thử khôi phục mỗi quý. Thử khôi phục dựng bản sao vào một cơ sở dữ liệu tạm, đối chiếu số dòng rồi xóa đi, không đụng dữ liệu đang chạy.</span>
        </div>
        {s.warnings.map((w: string) => <div key={w} className="small" style={{ color: 'var(--p1)' }}>{w}</div>)}
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>Lúc</th><th>Loại</th><th>Kết quả</th><th>Tệp</th><th>Chi tiết</th><th>Người chạy</th></tr></thead>
          <tbody>{s.recent.map((b: any) => (
            <tr key={b.id}>
              <td className="small">{at(b.started_at)}</td>
              <td>{b.kind === 'sao_luu' ? 'Sao lưu' : 'Thử khôi phục'}</td>
              <td>{b.ok == null ? 'đang chạy' : b.ok ? <span className="badge green">Đạt</span> : <span className="badge red">Lỗi</span>}</td>
              <td className="small mono">{b.file} {size(b.size_bytes)}</td>
              <td className="small">{b.error ?? (b.kind === 'thu_khoi_phuc' && b.ok ? Object.entries(b.detail ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ') : '')}</td>
              <td className="small">{b.actor}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

/* ======================= Rà soát tài khoản ======================= */

function AccessReviews({ meta, run }: Ctx) {
  const [list, setList] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  const load = async () => {
    const l = await api<any[]>('GET', '/api/compliance/access-reviews');
    setList(l);
    setOpen((o: any) => (o ? l.find((x) => x.id === o.id) ?? null : l.find((x) => x.status === 'dang_lam') ?? null));
  };
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const decide = (userId: string, decision: string, newRole: string | null, note: string | null) =>
    run(async () => { await api('PUT', `/api/compliance/access-reviews/${open.id}`, { userId, decision, newRole, note }); await load(); });
  const items: any[] = open?.items ?? [];
  const editable = open?.status === 'dang_lam';
  return (
    <div className="col">
      <div className="panel row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="primary" disabled={list.some((x) => x.status === 'dang_lam')} onClick={() => run(async () => { await api('POST', '/api/compliance/access-reviews'); await load(); }, 'Đã mở đợt rà soát quý này')}>Mở đợt rà soát quý này</button>
        {list.map((r) => <button key={r.id} className={open?.id === r.id ? 'sel' : 'ghost'} onClick={() => setOpen(r)}>{r.code} {r.status === 'da_xong' ? '✓' : '(đang làm)'}</button>)}
        <span className="small muted">Mỗi quý rà soát một lần: tài khoản nào không còn làm việc thì khóa, ai đổi vị trí thì đổi vai trò. Tài khoản không đăng nhập quá {meta.inactiveDays} ngày được đánh dấu.</span>
      </div>
      {open && (
        <div className="panel" style={{ overflowX: 'auto' }}>
          <b>{open.code}</b> · người rà soát {open.reviewer_name}{open.completed_at ? ` · chốt ${at(open.completed_at)}` : ''}
          <table className="table">
            <thead><tr><th>Tài khoản</th><th>Vai trò</th><th>Đăng nhập gần nhất</th><th>Quyết định</th><th>Lý do</th></tr></thead>
            <tbody>{items.map((it) => <AccessRow key={it.userId} it={it} meta={meta} editable={editable} onDecide={decide} />)}</tbody>
          </table>
          {editable && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="small">{items.filter((x) => x.active && !x.decision).length} tài khoản chưa quyết định</span>
              <button className="primary" onClick={() => run(async () => { const r = await api<any>('POST', `/api/compliance/access-reviews/${open.id}/complete`); await load(); setOpen(null); return r; }, 'Đã chốt rà soát, các thay đổi đã áp dụng')}>Chốt và áp dụng</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AccessRow({ it, meta, editable, onDecide }: { it: any; meta: Meta; editable: boolean; onDecide: (u: string, d: string, r: string | null, n: string | null) => void }) {
  const [note, setNote] = useState(it.note ?? '');
  const [newRole, setNewRole] = useState<string>(it.newRole ?? it.role);
  return (
    <tr className={it.stale ? 'amber' : ''}>
      <td>{it.fullName}<div className="small muted mono">{it.username}{!it.active ? ' · đã khóa' : ''}</div></td>
      <td className="small">{ROLE_LABEL[it.role as Role] ?? it.role}</td>
      <td className="small">{it.lastLogin ? at(it.lastLogin) : 'chưa từng'}{it.stale && <div style={{ color: 'var(--p2)' }}>lâu không dùng</div>}</td>
      <td>{editable && it.active ? (
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {Object.entries(meta.accessDecision).map(([k, v]) => (
            <button key={k} className={`small ${it.decision === k ? 'sel' : 'ghost'}`} onClick={() => onDecide(it.userId, k, k === 'doi_vai_tro' ? newRole : null, note || null)}>{v as string}</button>
          ))}
          <select className="small" value={newRole} onChange={(e) => setNewRole(e.target.value)} title="Vai trò mới khi đổi">
            {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      ) : <span className="small">{it.decision ? meta.accessDecision[it.decision] : '—'}{it.newRole ? ` → ${ROLE_LABEL[it.newRole as Role]}` : ''}</span>}</td>
      <td>{editable && it.active ? <input className="small" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bắt buộc khi khóa hoặc đổi" /> : <span className="small">{it.note}</span>}</td>
    </tr>
  );
}

/* ======================= Dữ liệu cá nhân ======================= */

function PersonalData(ctx: Ctx) {
  const [sub, setSub] = useState('Yêu cầu của chủ thể');
  const subs = ['Yêu cầu của chủ thể', 'Vi phạm dữ liệu', 'Hoạt động xử lý', 'Đánh giá tác động'];
  return (
    <div className="col">
      <div className="row" style={{ gap: 4 }}>{subs.map((s) => <button key={s} className={sub === s ? 'sel' : 'ghost'} onClick={() => setSub(s)}>{s}</button>)}</div>
      {sub === 'Yêu cầu của chủ thể' && <PdRequests {...ctx} />}
      {sub === 'Vi phạm dữ liệu' && <PdBreaches {...ctx} />}
      {sub === 'Hoạt động xử lý' && <PdActivities {...ctx} />}
      {sub === 'Đánh giá tác động' && <PdAssessments {...ctx} />}
    </div>
  );
}

function PdRequests({ meta, run }: Ctx) {
  const blank = { kind: 'xem', requester: '', relation: 'Chính chủ', contact: '', patientBa: '', content: '', identityChecked: false };
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState<typeof blank | null>(null);
  const [answer, setAnswer] = useState<{ id: string; response: string } | null>(null);
  const [data, setData] = useState<any>(null);
  const load = () => api<any[]>('GET', '/api/compliance/pd/requests').then(setRows);
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col">
      <div className="panel">
        <div className="small muted">Người bệnh hoặc người đại diện có quyền xem, sửa, xóa, rút đồng ý, hạn chế xử lý dữ liệu của mình. Phải trả lời trong {meta.pdRequestHours} giờ và xác minh danh tính trước khi cung cấp dữ liệu.</div>
        {!f ? <button className="primary" style={{ marginTop: 6 }} onClick={() => setF(blank)}>Ghi nhận yêu cầu mới</button> : (
          <div className="grid2" style={{ marginTop: 6 }}>
            <label className="field">Loại yêu cầu<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(meta.pdRequestKind).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}</select></label>
            <label className="field">Người yêu cầu<input value={f.requester} onChange={(e) => setF({ ...f, requester: e.target.value })} /></label>
            <label className="field">Quan hệ với người bệnh<input value={f.relation} onChange={(e) => setF({ ...f, relation: e.target.value })} /></label>
            <label className="field">Liên hệ<input value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></label>
            <label className="field">Số bệnh án (nếu có)<input value={f.patientBa} onChange={(e) => setF({ ...f, patientBa: e.target.value })} /></label>
            <label className="field row"><input type="checkbox" checked={f.identityChecked} onChange={(e) => setF({ ...f, identityChecked: e.target.checked })} /> Đã xác minh giấy tờ tùy thân</label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>Nội dung<textarea rows={2} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} /></label>
            <div className="row"><button className="primary" disabled={f.requester.length < 2 || f.content.length < 5} onClick={() => run(async () => { await api('POST', '/api/compliance/pd/requests', { ...f, patientBa: f.patientBa || null }); setF(null); await load(); }, 'Đã ghi nhận yêu cầu')}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Bỏ</button></div>
          </div>
        )}
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>Mã</th><th>Loại</th><th>Người yêu cầu</th><th>Bệnh án</th><th>Hạn</th><th>Trạng thái</th><th></th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className={r.overdue ? 'red' : ''}>
              <td className="mono">{r.code}</td><td>{meta.pdRequestKind[r.kind]}</td>
              <td className="small">{r.requester}{r.relation ? ` (${r.relation})` : ''}<div className="muted">{r.content}</div></td>
              <td className="small">{r.ba_number ?? '—'}</td>
              <td className="small">{at(r.due_at)}{r.overdue && <div style={{ color: 'var(--p1)' }}>quá hạn</div>}</td>
              <td className="small">{PD_STATUS[r.status]}{r.identity_checked ? '' : <div className="muted">chưa xác minh danh tính</div>}{r.response && <div className="muted">{r.response}</div>}</td>
              <td className="right">{['moi', 'dang_xu_ly'].includes(r.status) && (
                <div className="col" style={{ gap: 4 }}>
                  {!r.identity_checked && <button className="ghost small" onClick={() => run(async () => { await api('PATCH', `/api/compliance/pd/requests/${r.id}`, { status: 'dang_xu_ly', identityChecked: true }); await load(); })}>Đã xác minh danh tính</button>}
                  {r.patient_id && r.identity_checked && <button className="ghost small" onClick={() => run(async () => setData(await api('GET', `/api/compliance/pd/requests/${r.id}/data`)))}>Xem dữ liệu để cung cấp</button>}
                  <button className="small" onClick={() => setAnswer({ id: r.id, response: '' })}>Trả lời</button>
                </div>
              )}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {answer && (
        <div className="panel">
          <label className="field">Nội dung trả lời<textarea rows={3} value={answer.response} onChange={(e) => setAnswer({ ...answer, response: e.target.value })} /></label>
          <div className="row">
            <button className="primary" disabled={answer.response.length < 3} onClick={() => run(async () => { await api('PATCH', `/api/compliance/pd/requests/${answer.id}`, { status: 'da_tra_loi', response: answer.response }); setAnswer(null); await load(); }, 'Đã trả lời')}>Đã trả lời</button>
            <button disabled={answer.response.length < 3} onClick={() => run(async () => { await api('PATCH', `/api/compliance/pd/requests/${answer.id}`, { status: 'tu_choi', response: answer.response }); setAnswer(null); await load(); }, 'Đã từ chối, có ghi lý do')}>Từ chối (ghi lý do)</button>
            <button className="ghost" onClick={() => setAnswer(null)}>Bỏ</button>
          </div>
        </div>
      )}
      {data && (
        <div className="panel">
          <div className="row"><b>Dữ liệu của {data.patient?.full_name}</b><button className="ghost small" onClick={() => window.print()}>In</button><button className="ghost small no-print" onClick={() => setData(null)}>Đóng</button></div>
          <div className="small muted">{data.note}</div>
          <div className="small">Bệnh án {data.patient?.ba_number} · {data.patient?.dob ? d(data.patient.dob) : ''} · {data.patient?.phone ?? ''} · {data.patient?.address ?? ''}</div>
          <div className="small">{data.transfers.length} phiếu chuyển viện, {data.incidents.length} ca, {data.surveys.length} khảo sát, {data.charges.length} khoản thu.</div>
          {data.transfers.map((t: any, i: number) => <div key={i} className="small">• {d(t.created_at)} {t.transfer_number ?? ''} {t.diagnosis ?? ''} {t.hospital ?? ''}</div>)}
        </div>
      )}
    </div>
  );
}

function PdBreaches({ meta, run }: Ctx) {
  const blank = { detectedAt: nowLocal(), description: '', dataAffected: '', subjectsCount: '', severity: 'trung_binh', containment: '' };
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState<typeof blank | null>(null);
  const load = () => api<any[]>('GET', '/api/compliance/pd/breaches').then(setRows);
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const patch = (id: string, body: any, ok: string) => run(async () => { await api('PATCH', `/api/compliance/pd/breaches/${id}`, body); await load(); }, ok);
  return (
    <div className="col">
      <div className="panel">
        <div className="small muted">Lộ, mất, truy cập trái phép dữ liệu cá nhân phải báo Bộ Công an (A05) trong {meta.pdBreachHours} giờ kể từ khi phát hiện.</div>
        {!f ? <button className="primary" style={{ marginTop: 6 }} onClick={() => setF(blank)}>Ghi nhận vi phạm</button> : (
          <div className="grid2" style={{ marginTop: 6 }}>
            <label className="field">Phát hiện lúc<input type="datetime-local" value={f.detectedAt} onChange={(e) => setF({ ...f, detectedAt: e.target.value })} /></label>
            <label className="field">Mức độ<select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{Object.entries(BREACH_SEVERITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Dữ liệu bị ảnh hưởng<input value={f.dataAffected} onChange={(e) => setF({ ...f, dataAffected: e.target.value })} /></label>
            <label className="field">Số người bị ảnh hưởng<input inputMode="numeric" value={f.subjectsCount} onChange={(e) => setF({ ...f, subjectsCount: e.target.value.replace(/\D/g, '') })} /></label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>Mô tả<textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>Đã ngăn chặn thế nào<textarea rows={2} value={f.containment} onChange={(e) => setF({ ...f, containment: e.target.value })} /></label>
            <div className="row"><button className="primary" disabled={f.description.length < 5} onClick={() => run(async () => {
              await api('POST', '/api/compliance/pd/breaches', { ...f, detectedAt: toIso(f.detectedAt), subjectsCount: f.subjectsCount ? Number(f.subjectsCount) : null });
              setF(null); await load();
            }, 'Đã ghi nhận vi phạm')}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Bỏ</button></div>
          </div>
        )}
      </div>
      {rows.map((b) => (
        <div key={b.id} className={`panel small ${b.overdue ? 'red' : b.status === 'mo' ? 'amber' : ''}`}>
          <b className="mono">{b.code}</b> · {BREACH_SEVERITY[b.severity]} · phát hiện {at(b.detected_at)} · {b.status === 'mo' ? 'đang mở' : 'đã đóng'}
          <div>{b.description}</div>
          {b.data_affected && <div className="muted">Dữ liệu: {b.data_affected}{b.subjects_count != null ? ` · ${b.subjects_count} người` : ''}</div>}
          {b.containment && <div className="muted">Ngăn chặn: {b.containment}</div>}
          <div>Báo cơ quan chức năng: {b.authority_notified_at ? at(b.authority_notified_at) : <span style={{ color: b.overdue ? 'var(--p1)' : undefined }}>chưa (hạn {at(b.authority_due)})</span>} · Báo người bị ảnh hưởng: {b.subjects_notified_at ? at(b.subjects_notified_at) : 'chưa'}</div>
          {b.status === 'mo' && (
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              {!b.authority_notified_at && <button className="small" onClick={() => patch(b.id, { authorityNotifiedAt: new Date().toISOString() }, 'Đã ghi nhận báo cơ quan chức năng')}>Đã báo cơ quan chức năng</button>}
              {!b.subjects_notified_at && <button className="small ghost" onClick={() => patch(b.id, { subjectsNotifiedAt: new Date().toISOString() }, 'Đã ghi nhận báo người bị ảnh hưởng')}>Đã báo người bị ảnh hưởng</button>}
              <button className="small ghost" onClick={() => patch(b.id, { close: true }, 'Đã đóng')}>Đóng vụ việc</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PdActivities({ run }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => api<any[]>('GET', '/api/compliance/pd/activities').then(setRows);
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (a: any) => run(async () => {
    await api('PUT', `/api/compliance/pd/activities/${a.id}`, {
      code: a.code, name: a.name, purpose: a.purpose, subjects: a.subjects, dataBasic: a.data_basic, dataSensitive: a.data_sensitive, legalBasis: a.legal_basis,
      recipients: a.recipients, retentionKey: a.retention_key, crossBorder: a.cross_border, safeguards: a.safeguards, ownerId: a.owner_id, confirmed: !a.confirmed,
    });
    await load();
  }, a.confirmed ? 'Đã chuyển về bản nháp' : 'Đã xác nhận');
  return (
    <div className="col">
      <div className="panel small muted">Sổ hoạt động xử lý dữ liệu cá nhân (căn cứ hồ sơ đánh giá tác động theo NĐ 13/2023). Các dòng mẫu là bản nháp, cần pháp chế hoặc người phụ trách bảo vệ dữ liệu xem lại rồi xác nhận.</div>
      {rows.map((a) => (
        <div key={a.id} className={`panel small ${a.confirmed ? '' : 'amber'}`}>
          <div className="row"><b>{a.code} · {a.name}</b>{!a.confirmed && <span className="badge">nháp</span>}<button className="ghost small" onClick={() => toggle(a)}>{a.confirmed ? 'Bỏ xác nhận' : 'Xác nhận'}</button></div>
          <div>Mục đích: {a.purpose}</div>
          <div>Chủ thể: {a.subjects}</div>
          {a.data_basic && <div>Dữ liệu cơ bản: {a.data_basic}</div>}
          {a.data_sensitive && <div>Dữ liệu nhạy cảm: {a.data_sensitive}</div>}
          <div>Căn cứ: {a.legal_basis}</div>
          {a.recipients && <div>Bên nhận: {a.recipients}</div>}
          <div>Lưu trữ: {a.retention_label ? `${a.retention_label} (${a.retention_years} năm)` : '—'}{a.cross_border ? ' · có chuyển ra nước ngoài' : ''}</div>
          {a.safeguards && <div className="muted">Biện pháp bảo vệ: {a.safeguards}</div>}
        </div>
      ))}
    </div>
  );
}

function PdAssessments({ run }: Ctx) {
  const role = session.user?.role ?? '';
  const blank = { title: '', activityId: '', assessedOn: today(), risks: '', measures: '', conclusion: '' };
  const [rows, setRows] = useState<any[]>([]);
  const [acts, setActs] = useState<any[]>([]);
  const [f, setF] = useState<typeof blank | null>(null);
  const load = () => api<any[]>('GET', '/api/compliance/pd/assessments').then(setRows);
  useEffect(() => { run(async () => { await load(); setActs(await api('GET', '/api/compliance/pd/activities')); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col">
      <div className="panel">
        {!f ? <button className="primary" onClick={() => setF(blank)}>Lập đánh giá tác động</button> : (
          <div className="grid2">
            <label className="field">Tiêu đề<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
            <label className="field">Hoạt động xử lý<select value={f.activityId} onChange={(e) => setF({ ...f, activityId: e.target.value })}><option value="">— Chung —</option>{acts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
            <label className="field">Ngày đánh giá<input type="date" value={f.assessedOn} onChange={(e) => setF({ ...f, assessedOn: e.target.value })} /></label>
            <span />
            <label className="field" style={{ gridColumn: '1 / -1' }}>Rủi ro<textarea rows={3} value={f.risks} onChange={(e) => setF({ ...f, risks: e.target.value })} /></label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>Biện pháp<textarea rows={3} value={f.measures} onChange={(e) => setF({ ...f, measures: e.target.value })} /></label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>Kết luận<textarea rows={2} value={f.conclusion} onChange={(e) => setF({ ...f, conclusion: e.target.value })} /></label>
            <div className="row"><button className="primary" disabled={f.title.length < 3 || f.risks.length < 5 || f.measures.length < 5} onClick={() => run(async () => { await api('POST', '/api/compliance/pd/assessments', { ...f, activityId: f.activityId || null }); setF(null); await load(); }, 'Đã lưu đánh giá')}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Bỏ</button></div>
          </div>
        )}
      </div>
      {rows.map((s) => (
        <div key={s.id} className="panel small">
          <div className="row"><b>{s.title}</b>{s.activity_code && <span className="badge">{s.activity_code}</span>}<span className="muted">{d(s.assessed_on)}</span>
            {s.approved_at ? <span className="badge green">Duyệt bởi {s.approved_by_name}</span>
              : ['director', 'admin'].includes(role) && s.created_by !== session.user?.id && <button className="small" onClick={() => run(async () => { await api('POST', `/api/compliance/pd/assessments/${s.id}/approve`); await load(); }, 'Đã duyệt')}>Duyệt</button>}
          </div>
          <div>Rủi ro: {s.risks}</div><div>Biện pháp: {s.measures}</div>{s.conclusion && <div>Kết luận: {s.conclusion}</div>}
        </div>
      ))}
    </div>
  );
}

/* ======================= An toàn, PCCC, diễn tập ======================= */

function Safety(ctx: Ctx) {
  const [sub, setSub] = useState('Diễn tập');
  return (
    <div className="col">
      <div className="row" style={{ gap: 4 }}>{['Diễn tập', 'Tai nạn lao động'].map((s) => <button key={s} className={sub === s ? 'sel' : 'ghost'} onClick={() => setSub(s)}>{s}</button>)}</div>
      {sub === 'Diễn tập' ? <Drills {...ctx} /> : <Injuries {...ctx} />}
    </div>
  );
}

function Drills({ meta, run }: Ctx) {
  const role = session.user?.role ?? '';
  const canEdit = SAFETY_EDIT.includes(role);
  const [stations] = useStations();
  const [year, setYear] = useState(new Date(Date.now() + 7 * 3600_000).getUTCFullYear());
  const [data, setData] = useState<any>(null);
  const [staff, setStaff] = useState<any[]>([]);
  const blank = { kind: 'pccc', title: '', stationId: '', plannedOn: today(), leadId: '', scenario: '' };
  const [f, setF] = useState<typeof blank | null>(null);
  const [rec, setRec] = useState<{ id: string; doneOn: string; participants: string[]; durationMin: string; findings: string; result: string } | null>(null);
  const load = () => api('GET', `/api/compliance/drills?year=${year}`).then(setData);
  useEffect(() => { run(load); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api<any[]>('GET', '/api/staff').then(setStaff).catch(() => {}); }, []);
  if (!data) return null;
  return (
    <div className="col">
      <div className="panel">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <label className="field">Năm<input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 90 }} /></label>
          {data.compliance.map((c: any) => <span key={c.kind} className={`badge ${c.done >= c.min ? 'green' : 'amber'}`}>{c.label}: {c.done}/{c.min}</span>)}
          {canEdit && !f && <button className="primary" onClick={() => setF(blank)}>Lên kế hoạch diễn tập</button>}
        </div>
        <div className="small muted">Tối thiểu mỗi năm: PCCC 1 lần, đông nạn nhân trên bàn 1 lần, đông nạn nhân thực địa 1 lần, khôi phục hệ thống mỗi quý.</div>
        {f && (
          <div className="grid2" style={{ marginTop: 6 }}>
            <label className="field">Loại<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(meta.drillKind).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}</select></label>
            <label className="field">Tên buổi<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
            <label className="field">Trạm<select value={f.stationId} onChange={(e) => setF({ ...f, stationId: e.target.value })}><option value="">— Toàn trung tâm —</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label className="field">Ngày dự kiến<input type="date" value={f.plannedOn} onChange={(e) => setF({ ...f, plannedOn: e.target.value })} /></label>
            <label className="field">Người chỉ huy<select value={f.leadId} onChange={(e) => setF({ ...f, leadId: e.target.value })}><option value="">—</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></label>
            <span />
            <label className="field" style={{ gridColumn: '1 / -1' }}>Kịch bản<textarea rows={3} value={f.scenario} onChange={(e) => setF({ ...f, scenario: e.target.value })} /></label>
            <div className="row"><button className="primary" disabled={f.title.length < 3} onClick={() => run(async () => { await api('POST', '/api/compliance/drills', { ...f, stationId: f.stationId || null, leadId: f.leadId || null }); setF(null); await load(); }, 'Đã lên kế hoạch')}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Bỏ</button></div>
          </div>
        )}
      </div>
      {data.rows.map((x: any) => (
        <div key={x.id} className={`panel small ${x.late ? 'amber' : ''}`}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <b className="mono">{x.code}</b><b>{x.title}</b><span className="badge">{meta.drillKind[x.kind]}</span><span>{DRILL_STATUS[x.status]}{x.late ? ' (quá ngày dự kiến)' : ''}</span>
            {canEdit && x.status === 'ke_hoach' && <>
              <button className="small" onClick={() => setRec({ id: x.id, doneOn: today(), participants: [], durationMin: '', findings: '', result: 'dat' })}>Ghi kết quả</button>
              <button className="small ghost" onClick={() => run(async () => { await api('POST', `/api/compliance/drills/${x.id}/cancel`); await load(); }, 'Đã hủy')}>Hủy</button>
            </>}
          </div>
          <div>Dự kiến {d(x.planned_on)}{x.station_name ? ` · ${x.station_name}` : ''}{x.lead_name ? ` · chỉ huy ${x.lead_name}` : ''}</div>
          {x.scenario && <div className="muted">{x.scenario}</div>}
          {x.status === 'da_lam' && <div>Làm ngày {d(x.done_on)} · {x.participant_count} người{x.duration_min ? ` · ${x.duration_min} phút` : ''} · <b>{meta.drillResult[x.result]}</b><div>{x.findings}</div></div>}
          {x.status === 'da_lam' && <CapaQuick link={{ source: 'dien_tap', drillId: x.id }} run={run} onDone={load} />}
          {x.open_capa > 0 && <div className="muted">{x.open_capa} hành động khắc phục chưa đóng</div>}
          {rec && rec.id === x.id && (
            <div className="grid2" style={{ marginTop: 6 }}>
              <label className="field">Ngày làm<input type="date" value={rec.doneOn} onChange={(e) => setRec((p) => p && { ...p, doneOn: e.target.value })} /></label>
              <label className="field">Thời lượng (phút)<input inputMode="numeric" value={rec.durationMin} onChange={(e) => setRec((p) => p && { ...p, durationMin: e.target.value.replace(/\D/g, '') })} /></label>
              <label className="field">Kết quả<select value={rec.result} onChange={(e) => setRec((p) => p && { ...p, result: e.target.value })}>{Object.entries(meta.drillResult).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}</select></label>
              <label className="field">Người tham gia ({rec.participants.length})
                <select multiple size={6} value={rec.participants} onChange={(e) => setRec((p) => p && { ...p, participants: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                </select>
              </label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>Nhận xét, điểm cần cải thiện<textarea rows={3} value={rec.findings} onChange={(e) => setRec((p) => p && { ...p, findings: e.target.value })} /></label>
              <div className="row">
                <button className="primary" disabled={!rec.participants.length || rec.findings.length < 3} onClick={() => run(async () => {
                  await api('POST', `/api/compliance/drills/${rec.id}/record`, { doneOn: rec.doneOn, participants: rec.participants, durationMin: rec.durationMin ? Number(rec.durationMin) : null, findings: rec.findings, result: rec.result });
                  setRec(null); await load();
                }, 'Đã ghi kết quả diễn tập')}>Lưu kết quả</button>
                <button className="ghost" onClick={() => setRec(null)}>Bỏ</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Injuries({ meta, run }: Ctx) {
  const canEdit = SAFETY_EDIT.includes(session.user?.role ?? '');
  const [rows, setRows] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const blank = { occurredAt: nowLocal(), staffUser: '', person: '', place: '', kind: 'giao_thong', severity: 'nhe', description: '', daysOff: '', action: '' };
  const [f, setF] = useState<typeof blank | null>(null);
  const load = () => api<any[]>('GET', '/api/compliance/injuries').then(setRows);
  useEffect(() => { run(load); api<any[]>('GET', '/api/staff').then(setStaff).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col">
      <div className="panel">
        <div className="small muted">Tai nạn lao động nặng hoặc chết người phải báo ngay cơ quan lao động và lập biên bản điều tra. Sự cố an toàn người bệnh ghi ở mục Báo sự cố.</div>
        {canEdit && !f && <button className="primary" style={{ marginTop: 6 }} onClick={() => setF(blank)}>Ghi nhận tai nạn lao động</button>}
        {f && (
          <div className="grid2" style={{ marginTop: 6 }}>
            <label className="field">Thời điểm<input type="datetime-local" value={f.occurredAt} onChange={(e) => setF({ ...f, occurredAt: e.target.value })} /></label>
            <label className="field">Nhân viên<select value={f.staffUser} onChange={(e) => { const s = staff.find((x) => x.id === e.target.value); setF({ ...f, staffUser: e.target.value, person: s?.full_name ?? f.person }); }}><option value="">— Người ngoài / chọn sau —</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></label>
            <label className="field">Họ tên người bị nạn<input value={f.person} onChange={(e) => setF({ ...f, person: e.target.value })} /></label>
            <label className="field">Nơi xảy ra<input value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} /></label>
            <label className="field">Loại<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(meta.injuryKind).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}</select></label>
            <label className="field">Mức độ<select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{Object.entries(meta.injurySeverity).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}</select></label>
            <label className="field">Số ngày nghỉ<input inputMode="numeric" value={f.daysOff} onChange={(e) => setF({ ...f, daysOff: e.target.value.replace(/\D/g, '') })} /></label>
            <span />
            <label className="field" style={{ gridColumn: '1 / -1' }}>Diễn biến<textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>Đã xử lý<textarea rows={2} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} /></label>
            <div className="row"><button className="primary" disabled={f.person.length < 2 || f.description.length < 5} onClick={() => run(async () => {
              await api('POST', '/api/compliance/injuries', { ...f, occurredAt: toIso(f.occurredAt), staffUser: f.staffUser || null, daysOff: f.daysOff ? Number(f.daysOff) : null });
              setF(null); await load();
            }, 'Đã ghi nhận')}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Bỏ</button></div>
          </div>
        )}
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>Mã</th><th>Lúc</th><th>Người</th><th>Loại</th><th>Mức độ</th><th>Diễn biến</th><th>Nghỉ</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className={r.severity !== 'nhe' ? 'red' : ''}>
              <td className="mono">{r.code}</td><td className="small">{at(r.occurred_at)}</td><td>{r.person}<div className="small muted">{r.place}</div></td>
              <td className="small">{meta.injuryKind[r.kind]}</td><td className="small">{meta.injurySeverity[r.severity]}</td>
              <td className="small">{r.description}{r.action && <div className="muted">{r.action}</div>}</td><td className="small">{r.days_off ?? ''}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
