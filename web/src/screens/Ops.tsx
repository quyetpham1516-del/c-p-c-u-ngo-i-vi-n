'use client';
import dynamic from 'next/dynamic';
import { Fragment, useEffect, useState } from 'react';
import { api, money, session } from '../api';
import { useHospitals } from '../catalog';

const TrackMap = dynamic(() => import('../components/TrackMap').then((m) => m.TrackMap), { ssr: false });

interface Meta {
  utstein: Record<string, Record<string, string>>; reviewReasons: Record<string, string>; reviewCriteria: [string, string][]; reviewScore: Record<string, string>;
  triage: Record<string, string>; victimStatus: Record<string, string>; icsRoles: Record<string, string>; mciLevel: Record<string, string>; mciSupportThreshold: number;
  vehicleDocKind: Record<string, string>; blockingDocs: string[]; docWarnDays: number; maintenanceKind: Record<string, string>;
}
type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
type Ctx = { meta: Meta; run: Run };

const REVIEWERS = ['qa', 'supervisor', 'admin', 'director'];
const MCI_VIEW = ['calltaker', 'dispatcher', 'supervisor', 'admin', 'crew', 'qa', 'director'];
const MCI_COMMAND = ['supervisor', 'admin'];
const FLEET_VIEW = ['calltaker', 'dispatcher', 'supervisor', 'admin', 'crew', 'technician', 'qa', 'director', 'accountant'];
const FLEET_EDIT = ['technician', 'supervisor', 'admin'];
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 7 * 3600_000 - n * 86400000).toISOString().slice(0, 10);
const d = (s?: string | null) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '—');
const at = (s?: string | null) => (s ? new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const num = (v: number | string | null | undefined) => Number(v ?? 0).toLocaleString('vi-VN');
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
const min = (v: number | null | undefined) => (v == null ? '—' : `${v} phút`);
const TRIAGE_TONE: Record<string, string> = { do: 'red', vang: 'amber', xanh: 'green', den: '' };
const SCORE_TONE: Record<string, string> = { dat: 'green', can_cai_thien: 'amber', khong_dat: 'red', khong_ap_dung: '' };

/** Vận hành cấp cứu ngoại viện: bình ca, sổ Utstein, đông nạn nhân, xe và bảo dưỡng, lộ trình GPS */
export function Ops() {
  const role = session.user?.role ?? '';
  const tabs = [
    ...(REVIEWERS.includes(role) ? ['Bình ca', 'Ngừng tuần hoàn (Utstein)'] : []),
    ...(MCI_VIEW.includes(role) ? ['Đông nạn nhân'] : []),
    ...(FLEET_VIEW.includes(role) ? ['Xe và bảo dưỡng'] : []),
    ...([...REVIEWERS, 'dispatcher', 'calltaker'].includes(role) ? ['Lộ trình xe'] : []),
  ];
  const initial = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null;
  const [tab, setTab] = useState(initial && tabs.includes(initial) ? initial : tabs[0]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { api<Meta>('GET', '/api/ops/meta').then(setMeta).catch((e) => setError(e.message)); }, []);
  const run: Run = async (fn, ok) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  if (!tabs.length) return <div className="panel">Vai trò của bạn không dùng màn này.</div>;
  if (!meta) return error ? <div className="error">{error}</div> : null;
  const ctx: Ctx = { meta, run };
  return (
    <div className="col">
      <h2 className="no-print" style={{ margin: 0 }}>Vận hành <span className="small muted">bình ca, Utstein, đông nạn nhân, xe (QL-19)</span></h2>
      <div className="tabs no-print">{tabs.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); setMsg(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {tab === 'Bình ca' && <CaseReviews {...ctx} />}
      {tab === 'Ngừng tuần hoàn (Utstein)' && <Utstein {...ctx} />}
      {tab === 'Đông nạn nhân' && <MciList {...ctx} />}
      {tab === 'Xe và bảo dưỡng' && <Fleet {...ctx} />}
      {tab === 'Lộ trình xe' && <Track {...ctx} />}
    </div>
  );
}

/* ======================= Bình ca ======================= */

function CaseReviews({ meta, run }: Ctx) {
  const [from, setFrom] = useState(daysAgo(14));
  const [to, setTo] = useState(today());
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [view, setView] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const load = () => api<any>('GET', `/api/ops/case-reviews?from=${from}&to=${to}&open=${open ? 1 : 0}`).then((r) => setRows(r.rows));
  useEffect(() => { load().catch(() => {}); }, [from, to, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = (body: object) => run(async () => { const r = await api<any>('POST', '/api/ops/case-reviews', body); setView(r.id); });
  if (view) return <CaseReviewView id={view} meta={meta} run={run} onBack={() => { setView(null); load(); }} />;
  return (
    <div className="col">
      <div className="panel row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="field">Từ ngày<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">Đến ngày<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="row small"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Chỉ ca chưa bình xong</label>
        <label className="field">Bình ca khác theo mã<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="MD-..." /></label>
        <button disabled={code.trim().length < 3} onClick={() => start({ incidentCode: code.trim(), reason: 'Người rà soát chọn' })}>Bình ca này</button>
      </div>
      <div className="small muted">Kế hoạch: họp bình ca hằng tuần các ca tử vong, ngừng tim, khiếu nại, phân loại sai. Phản hồi theo hướng không trừng phạt; người trong kíp không tự bình ca mình.</div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Ca</th><th>Thời gian</th><th>Ưu tiên</th><th>Xe</th><th>Lý do bình</th><th>Phiếu</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.code}</td><td className="small">{at(r.created_at)}</td><td>{r.final_priority}</td><td className="small">{r.vehicles}</td>
              <td>{r.reasons.map((x: string) => <span key={x} className={`badge ${['tu_vong', 'ngung_tim', 'khieu_nai', 'su_co'].includes(x) ? 'red' : ''}`} style={{ marginRight: 4 }}>{meta.reviewReasons[x]}</span>)}</td>
              <td className="small">{r.review_code ? <>{r.review_code}<div className="muted">{r.review_status === 'da_xong' ? 'Đã xong' : 'Đang bình'} · {r.reviewer_name}</div></> : '—'}</td>
              <td className="right">{r.review_id ? <button className="ghost small" onClick={() => setView(r.review_id)}>Mở</button> : <button className="small" onClick={() => start({ incidentId: r.id })}>Bình ca</button>}</td>
            </tr>))}</tbody>
        </table>
        {!rows.length && <div className="small muted">Không có ca cần bình trong khoảng này.</div>}
      </div>
    </div>
  );
}

function CaseReviewView({ id, meta, run, onBack }: Ctx & { id: string; onBack: () => void }) {
  const [r, setR] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const me = session.user?.id;
  const load = () => api<any>('GET', `/api/ops/case-reviews/${id}`).then((x) => {
    setR(x); setF({ scores: x.scores ?? {}, summary: x.summary ?? '', goodPractice: x.good_practice ?? '', learning: x.learning ?? '' });
  });
  useEffect(() => { load().catch(() => {}); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r || !f) return null;
  const editable = r.status !== 'da_xong' && r.reviewer_id === me;
  const save = (finish: boolean) => run(async () => { await api('PUT', `/api/ops/case-reviews/${id}`, { ...f, finish }); await load(); }, finish ? 'Đã chốt phiếu bình ca, kíp sẽ thấy phản hồi' : 'Đã lưu nháp');
  return (
    <div className="col">
      <div className="row no-print"><button className="ghost" onClick={onBack}>← Danh sách</button><button className="ghost" onClick={() => window.print()}>In phiếu</button></div>
      <div className="panel col">
        <b>PHIẾU BÌNH CA {r.code} · ca {r.incident_code}</b>
        <div className="small">{at(r.incident_at)} · {r.final_priority}{r.suggested_priority && r.suggested_priority !== r.final_priority ? ` (máy gợi ý ${r.suggested_priority}: ${r.override_reason ?? 'không ghi lý do'})` : ''} · {r.address ?? ''}</div>
        <div className="small">Lý do bình: {r.reasons.map((x: string) => meta.reviewReasons[x]).join(', ')} · Người bình: {r.reviewer_name}</div>
        <div className="small">Kíp: {r.crew.map((c: any) => `${c.full_name} (${c.crew_role}, ${c.vehicle_id})`).join('; ') || 'không xác định'}</div>
        <div className="small">Mốc: {r.times.map((t: any) => `${t.code} ${new Date(t.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`).join(' · ')}</div>
        {r.transfers.map((t: any) => <div key={t.id} className="small">Phiếu {t.transfer_number ?? '(chưa số)'} {t.vehicle_id}: {t.diagnosis ?? '—'} · {t.disposition ?? ''} {t.hospital ?? ''}{t.arrest ? ' · có ngừng tuần hoàn' : ''} {t.status === 'signed' ? '' : '(chưa ký)'}</div>)}
        {r.track.map((v: any) => <div key={v.vehicleId} className={`small ${v.flags.length ? 'red' : ''}`}>GPS {v.vehicleId}: {v.points} điểm, {v.km} km{v.declaredKm != null ? ` (khai ${v.declaredKm} km)` : ''}{v.flags.length ? ` · ${v.flags.join('; ')}` : ''}</div>)}
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>Tiêu chí</th>{Object.entries(meta.reviewScore).map(([k, v]) => <th key={k} className="center">{v}</th>)}</tr></thead>
          <tbody>{meta.reviewCriteria.map(([k, label]) => (
            <tr key={k}><td>{label}</td>{Object.keys(meta.reviewScore).map((s) => (
              <td key={s} className="center">{editable
                ? <input type="radio" name={k} checked={f.scores[k] === s} onChange={() => setF({ ...f, scores: { ...f.scores, [k]: s } })} />
                : f.scores[k] === s ? <span className={`badge ${SCORE_TONE[s]}`}>✓</span> : ''}</td>))}</tr>))}</tbody>
        </table>
      </div>
      <div className="panel col">
        <label className="field">Nhận xét chung<textarea rows={3} disabled={!editable} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></label>
        <label className="field">Điểm làm tốt<textarea rows={2} disabled={!editable} value={f.goodPractice} onChange={(e) => setF({ ...f, goodPractice: e.target.value })} /></label>
        <label className="field">Bài học, điều cần cải thiện<textarea rows={2} disabled={!editable} value={f.learning} onChange={(e) => setF({ ...f, learning: e.target.value })} /></label>
        {editable && <div className="row no-print"><button onClick={() => save(false)}>Lưu nháp</button><button className="primary" onClick={() => save(true)}>Chốt và gửi phản hồi cho kíp</button></div>}
      </div>
      {r.status === 'da_xong' && (
        <div className="panel col">
          <b>Kíp đã đọc</b>
          {r.acks.length ? r.acks.map((a: any) => <div key={a.user_id} className="small">{a.full_name} · {at(a.acked_at)}{a.comment ? `: ${a.comment}` : ''}</div>) : <div className="small muted">Chưa ai xác nhận.</div>}
          <b>Hành động khắc phục</b>
          {r.capa.map((c: any) => <div key={c.id} className="small">{c.description} · {c.owner_name} · hạn {d(c.due_date)} · {c.status}</div>)}
          <CapaQuick link={{ caseReviewId: r.id }} run={run} onDone={load} />
        </div>
      )}
    </div>
  );
}

/** Giao nhanh một hành động khắc phục (dùng chung bảng khắc phục của QLCL) */
export function CapaQuick({ link, run, onDone }: { link: Record<string, string>; run: Run; onDone: () => void }) {
  const [staff, setStaff] = useState<any[]>([]);
  const [f, setF] = useState<{ description: string; ownerId: string; dueDate: string } | null>(null);
  useEffect(() => { if (f && !staff.length) api<any[]>('GET', '/api/staff').then(setStaff).catch(() => {}); }, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!REVIEWERS.includes(session.user?.role ?? '') && !['hr'].includes(session.user?.role ?? '')) return null;
  if (!f) return <div className="no-print"><button className="ghost small" onClick={() => setF({ description: '', ownerId: '', dueDate: daysAgo(-30) })}>Giao hành động khắc phục</button></div>;
  return (
    <div className="row no-print" style={{ flexWrap: 'wrap', gap: 6 }}>
      <input style={{ flex: 3, minWidth: 200 }} placeholder="Việc cần làm" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      <select value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}><option value="">— Người phụ trách —</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select>
      <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
      <button className="primary small" disabled={f.description.length < 5 || !f.ownerId} onClick={() => run(async () => { await api('POST', '/api/quality/capa', { ...link, ...f }); setF(null); onDone(); }, 'Đã giao hành động khắc phục')}>Giao</button>
      <button className="ghost small" onClick={() => setF(null)}>Bỏ</button>
    </div>
  );
}

/* ======================= Utstein ======================= */

function Utstein({ meta, run }: Ctx) {
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const [data, setData] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const role = session.user?.role ?? '';
  const load = () => api<any>('GET', `/api/ops/arrests?from=${from}&to=${to}`).then(setData);
  useEffect(() => { load().catch(() => {}); }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const R = data.report;
  const L = meta.utstein;
  const dist = (obj: Record<string, number>, labels: Record<string, string>) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${labels[k] ?? 'Chưa ghi'} ${n}`).join(' · ') || '—';
  const O = (o: any) => <>{o.n} ca · ROSC {o.roscAny} · còn tuần hoàn khi tới viện {o.roscOnArrival} · nhập viện {o.admitted} · sống 30 ngày {o.survived} · CPC 1–2 {o.goodCpc} <span className="muted">(đã theo dõi {o.followedUp}/{o.n})</span></>;
  return (
    <div className="col">
      <div className="panel row no-print" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="field">Từ ngày<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">Đến ngày<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="ghost" onClick={() => window.print()}>In báo cáo</button>
        {['admin', 'director'].includes(role) && <button className="ghost" onClick={() => { const v = prompt('Dân số địa bàn phục vụ (người):', R.populationServed ?? ''); if (v) run(async () => { await api('PUT', '/api/ops/settings/population', { value: Number(v.replace(/\D/g, '')) }); await load(); }, 'Đã lưu dân số'); }}>Dân số địa bàn: {R.populationServed ? num(R.populationServed) : 'chưa đặt'}</button>}
      </div>
      <div className="panel col">
        <b>BÁO CÁO NGỪNG TUẦN HOÀN NGOÀI VIỆN THEO UTSTEIN · {d(from)} – {d(to)}</b>
        <div className="utstein-flow">
          <div className="box">Ngừng tuần hoàn kíp tới xử trí<b>{R.flow.total}</b></div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="box">Không hồi sức<b>{R.flow.notAttempted}</b><span className="small">{dist(R.flow.notAttemptedReasons, L.notAttemptedReason)}</span></div>
            <div className="box strong">Có hồi sức<b>{R.flow.attempted}</b>{R.incidencePer100k != null && <span className="small">{R.incidencePer100k}/100.000 dân</span>}</div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="box">Kíp chứng kiến<b>{R.flow.emsWitnessed}</b></div>
            <div className="box">Trước khi kíp tới<b>{R.flow.beforeEms}</b></div>
            <div className="box">Do tim<b>{R.flow.cardiac}</b></div>
            <div className="box strong">Nhóm so sánh Utstein<b>{R.flow.comparator}</b><span className="small">người dân chứng kiến, nhịp sốc được</span></div>
          </div>
        </div>
      </div>
      <div className="grid2">
        <div className="panel col small">
          <b>Đặc điểm (ca có hồi sức)</b>
          <div>Nguyên nhân: {dist(R.characteristics.cause, L.cause)}</div>
          <div>Nơi xảy ra: {dist(R.characteristics.location, L.location)}</div>
          <div>Chứng kiến: {dist(R.characteristics.witnessed, L.witnessed)}</div>
          <div>Nhịp đầu: {dist(R.characteristics.firstRhythm, L.firstRhythm)} · sốc được {pct(R.characteristics.shockablePct)}</div>
          <div>Tuổi trung vị {R.characteristics.age ?? '—'} · nam {R.characteristics.male}</div>
        </div>
        <div className="panel col small">
          <b>Người dân và thời gian (trung vị)</b>
          <div>Người dân ép tim {pct(R.bystander.cprPct)} · điều phối viên hướng dẫn ép tim {pct(R.bystander.dispatcherCprPct)}</div>
          <div>Dùng AED công cộng {pct(R.bystander.publicAedPct)} · AED công cộng đã sốc {pct(R.bystander.publicShockPct)}</div>
          <div>Gọi tới xe đến {min(R.intervals.callToArrival)} · ngã quỵ tới ép tim {min(R.intervals.collapseToCpr)}</div>
          <div>Gọi tới sốc đầu (nhịp sốc được) {min(R.intervals.callToShock)} · ép tim tới adrenalin {min(R.intervals.cprToAdrenaline)}</div>
          <div>Can thiệp: sốc {R.treatment.shocked} · adrenalin {R.treatment.adrenaline} · đường thở nâng cao {R.treatment.advancedAirway} · ép tim cơ học {R.treatment.mechanical} · hạ thân nhiệt {R.treatment.ttm} · ECPR {R.treatment.ecpr}</div>
        </div>
      </div>
      <div className="panel col small">
        <b>Kết cục</b>
        <div>Tất cả ca có hồi sức: {O(R.outcomes.all)}</div>
        <div>Trước khi kíp tới: {O(R.outcomes.beforeEms)}</div>
        <div>Kíp chứng kiến: {O(R.outcomes.emsWitnessed)}</div>
        <div><b>Nhóm so sánh Utstein: {O(R.outcomes.comparator)}</b></div>
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table className="small">
          <thead><tr><th>Ca</th><th>Phiếu</th><th>Chứng kiến</th><th>Người dân ép tim</th><th>Nhịp đầu</th><th>Gọi → tới</th><th>ROSC</th><th>Tới viện</th><th>Nhập viện</th><th>Sống 30 ngày</th><th>CPC</th><th /></tr></thead>
          <tbody>{data.rows.map((x: any) => {
            const a = x.arrest ?? {};
            return (
              <Fragment key={x.transfer_id}>
                <tr>
                  <td className="mono">{x.incident_code}{x.comparator && <div><span className="badge">Nhóm so sánh</span></div>}</td><td className="mono">{x.transfer_number}</td>
                  <td>{a.attempted === false ? <span className="muted">Không hồi sức: {L.notAttemptedReason[a.notAttemptedReason] ?? '—'}</span> : L.witnessed[a.witnessed] ?? '—'}</td>
                  <td>{L.bystanderCpr[a.bystanderCpr] ?? (a.witnessed === 'kip' ? 'Không áp dụng' : '—')}{a.publicAed && a.publicAed !== 'khong' ? ` · AED ${L.publicAed[a.publicAed]}` : ''}</td>
                  <td>{L.firstRhythm[a.firstRhythm] ?? '—'}</td><td>{min(x.intervals.callToArrival)}</td>
                  <td>{a.roscAny == null ? '—' : a.roscAny ? 'Có' : 'Không'}</td><td>{a.roscOnArrival == null ? '—' : a.roscOnArrival ? 'Còn' : 'Mất'}</td>
                  <td>{x.admitted == null ? '—' : x.admitted ? 'Có' : 'Không'}</td><td>{x.survived_30d == null ? <span className="muted">Chưa theo dõi</span> : x.survived_30d ? 'Sống' : 'Tử vong'}</td><td>{x.cpc ?? '—'}</td>
                  <td className="right no-print">{['qa', 'admin', 'director'].includes(role) && a.attempted && <button className="ghost small" onClick={() => setEdit({ id: x.transfer_id, admitted: x.admitted, survived30d: x.survived_30d, dischargedOn: x.discharged_on ?? '', cpc: x.cpc ?? '', note: x.outcome_note ?? '' })}>Kết cục</button>}</td>
                </tr>
                {edit?.id === x.transfer_id && (
                  <tr className="no-print"><td colSpan={12}>
                    <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                      {([['admitted', 'Nhập viện còn sống'], ['survived30d', 'Sống 30 ngày hoặc ra viện']] as const).map(([k, l]) => (
                        <label key={k} className="field">{l}<select value={edit[k] == null ? '' : edit[k] ? '1' : '0'} onChange={(e) => setEdit({ ...edit, [k]: e.target.value === '' ? null : e.target.value === '1' })}>
                          <option value="">Chưa rõ</option><option value="1">Có</option><option value="0">Không</option></select></label>))}
                      <label className="field">Ngày ra viện<input type="date" value={edit.dischargedOn} onChange={(e) => setEdit({ ...edit, dischargedOn: e.target.value })} /></label>
                      <label className="field">CPC khi ra viện<select value={edit.cpc} onChange={(e) => setEdit({ ...edit, cpc: e.target.value })}><option value="">—</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
                      <label className="field" style={{ flex: 1 }}>Ghi chú (nguồn: gọi bệnh viện, gia đình...)<input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></label>
                      <button className="primary" onClick={() => run(async () => {
                        await api('PUT', `/api/ops/arrests/${edit.id}/outcome`, { admitted: edit.admitted, survived30d: edit.survived30d, dischargedOn: edit.dischargedOn || null, cpc: edit.cpc ? Number(edit.cpc) : null, note: edit.note || null });
                        setEdit(null); await load();
                      }, 'Đã lưu kết cục')}>Lưu</button>
                      <button className="ghost" onClick={() => setEdit(null)}>Bỏ</button>
                    </div>
                    <div className="small muted">CPC 1: chức năng não tốt · 2: tàn tật vừa · 3: tàn tật nặng · 4: hôn mê, sống thực vật · 5: chết não</div>
                  </td></tr>
                )}
              </Fragment>
            );
          })}</tbody>
        </table>
        {!data.rows.length && <div className="small muted">Chưa có ca ngừng tuần hoàn nào có phiếu đã ký trong khoảng này.</div>}
      </div>
    </div>
  );
}

/* ======================= Đông nạn nhân ======================= */

function MciList({ meta, run }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const initial = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('ca') : null;
  const [view, setView] = useState<string | null>(initial);
  useEffect(() => { api<any[]>('GET', '/api/ops/mci').then(setRows).catch(() => {}); }, [view]);
  if (view) return <MciBoard id={view} meta={meta} run={run} onBack={() => setView(null)} />;
  return (
    <div className="col">
      <div className="small muted">Trưởng ca kích hoạt chế độ đông nạn nhân từ màn điều phối của ca. Từ {meta.mciSupportThreshold} người bệnh nặng trở lên là kích hoạt hỗ trợ 115 và đơn vị bạn.</div>
      <div className="panel">
        <table>
          <thead><tr><th>Ca</th><th>Địa điểm</th><th>Mức</th><th>Kích hoạt</th><th>Nạn nhân</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}><td className="mono">{r.code}</td><td>{r.address}</td><td>{r.mci_level}</td><td className="small">{at(r.mci_declared_at)}</td><td>{r.victims}</td>
              <td>{r.mci_ended_at ? <span className="badge green">Đã kết thúc</span> : <span className="badge red">Đang diễn ra</span>}</td>
              <td className="right"><button className="small" onClick={() => setView(r.id)}>Mở</button></td></tr>))}</tbody>
        </table>
        {!rows.length && <div className="small muted">Chưa có sự cố đông nạn nhân.</div>}
      </div>
    </div>
  );
}

export function MciBoard({ id, meta, run, onBack }: Ctx & { id: string; onBack?: () => void }) {
  const [b, setB] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [cmd, setCmd] = useState<any>(null);
  const hospitals = useHospitals();
  const role = session.user?.role ?? '';
  const canLog = ['crew', 'dispatcher', 'supervisor', 'admin'].includes(role);
  const load = () => api<any>('GET', `/api/ops/mci/${id}`).then(setB);
  useEffect(() => { load().catch(() => {}); const t = setInterval(() => load().catch(() => {}), 10000); return () => clearInterval(t); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!b) return null;
  const inc = b.incident;
  const empty = { id: '', tag: String(b.victims.length + 1).padStart(2, '0'), triage: 'vang', sex: '', ageGroup: '', note: '', status: 'hien_truong', vehicleId: '', hospital: '' };
  const save = () => run(async () => {
    const body = { ...f, sex: f.sex || null, ageGroup: f.ageGroup || null, note: f.note || null, vehicleId: f.vehicleId || null, hospital: f.hospital || null };
    await api(f.id ? 'PUT' : 'POST', f.id ? `/api/ops/mci/${id}/victims/${f.id}` : `/api/ops/mci/${id}/victims`, body);
    setF(null); await load();
  }, 'Đã ghi nạn nhân');
  return (
    <div className="col">
      {onBack && <div className="row no-print"><button className="ghost" onClick={onBack}>← Danh sách</button><button className="ghost" onClick={() => window.print()}>In báo cáo</button></div>}
      <div className={`panel col ${inc.mci_ended_at ? '' : 'red'}`}>
        <b>ĐÔNG NẠN NHÂN · ca {inc.code} · {inc.address ?? ''}</b>
        {inc.mci_declared_at ? <div className="small">{meta.mciLevel[inc.mci_level]} · kích hoạt {at(inc.mci_declared_at)} bởi {inc.declared_by}{inc.mci_ended_at ? ` · kết thúc ${at(inc.mci_ended_at)}` : ''}</div> : <div className="small">Chưa kích hoạt</div>}
        {inc.mci_note && <div className="small">{inc.mci_note}</div>}
        <div className="small">ICS: {Object.entries(meta.icsRoles).map(([k, l]) => `${l}: ${inc.mci_roles?.[k] || '—'}`).join(' · ')}</div>
        {MCI_COMMAND.includes(role) && !inc.mci_ended_at && <div className="row no-print">
          <button onClick={() => setCmd({ level: inc.mci_level ?? 1, note: inc.mci_note ?? '', roles: { ...(inc.mci_roles ?? {}) } })}>{inc.mci_declared_at ? 'Đổi mức, vai trò ICS' : 'Kích hoạt'}</button>
          {inc.mci_declared_at && <button className="ghost" onClick={() => { const n = prompt('Ghi chú kết thúc sự cố:'); if (n && n.length >= 3) run(async () => { await api('POST', `/api/ops/mci/${id}/end`, { note: n }); await load(); }, 'Đã kết thúc chế độ đông nạn nhân'); }}>Kết thúc</button>}
        </div>}
      </div>
      {cmd && <MciCommand meta={meta} value={cmd} onCancel={() => setCmd(null)} onSave={(v) => run(async () => { await api('POST', `/api/ops/mci/${id}/declare`, v); setCmd(null); await load(); }, 'Đã cập nhật')} />}
      {b.advice.map((a: string) => <div key={a} className="alert amber">{a}</div>)}
      <div className="grid4">
        {Object.entries(meta.triage).map(([k, l]) => <div key={k} className={`panel ${TRIAGE_TONE[k]}`}><div className="small">{l}</div><div style={{ fontSize: 28, fontWeight: 700 }}>{b.byTriage[k]}</div></div>)}
      </div>
      <div className="grid2">
        <div className="panel small">
          <b>Phân bổ bệnh viện</b>
          {Object.entries(b.byHospital).map(([h, c]: [string, any]) => <div key={h}>{h}: đỏ {c.do} · vàng {c.vang} · xanh {c.xanh}</div>)}
          {!Object.keys(b.byHospital).length && <div className="muted">Chưa chuyển ai.</div>}
        </div>
        <div className="panel small">
          <b>Xe tham gia ({b.activeVehicles} đang ở ca)</b>
          {b.vehicles.map((v: any) => <div key={v.vehicle_id + v.assigned_at}>{v.vehicle_id} ({v.type}) {v.status} · giao {at(v.assigned_at)}{v.ended_at ? ' · đã xong' : ''}</div>)}
        </div>
      </div>
      {inc.mci_declared_at && !inc.mci_ended_at && canLog && !f && <div className="no-print"><button className="primary" onClick={() => setF(empty)}>Thêm nạn nhân (thẻ phân loại)</button></div>}
      {f && (
        <div className="panel col no-print">
          <div className="grid4">
            <label className="field">Số thẻ<input value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} /></label>
            <label className="field">Giới<select value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value })}><option value="">—</option><option value="M">Nam</option><option value="F">Nữ</option><option value="U">Không rõ</option></select></label>
            <label className="field">Nhóm tuổi<input value={f.ageGroup} onChange={(e) => setF({ ...f, ageGroup: e.target.value })} placeholder="trẻ em, 30–40..." /></label>
            <label className="field">Trạng thái<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{Object.entries(meta.victimStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          </div>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {Object.entries(meta.triage).map(([k, l]) => <button key={k} className={`choice ${f.triage === k ? 'sel' : ''} ${TRIAGE_TONE[k]}`} style={{ minHeight: 48 }} onClick={() => setF({ ...f, triage: k })}>{l}</button>)}
          </div>
          {['dang_chuyen', 'da_den_vien'].includes(f.status) && (
            <div className="grid2">
              <label className="field">Xe<select value={f.vehicleId} onChange={(e) => setF({ ...f, vehicleId: e.target.value })}><option value="">—</option>{b.vehicles.map((v: any) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_id}</option>)}</select></label>
              <label className="field">Bệnh viện nhận<input list="mci-hospitals" value={f.hospital} onChange={(e) => setF({ ...f, hospital: e.target.value })} />
                <datalist id="mci-hospitals">{hospitals.map((h) => <option key={h.id} value={h.name} />)}</datalist></label>
            </div>
          )}
          <label className="field">Tổn thương, ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <div className="row"><button className="primary" disabled={!f.tag.trim()} onClick={save}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Bỏ</button></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Thẻ</th><th>Phân loại</th><th>Giới, tuổi</th><th>Ghi chú</th><th>Trạng thái</th><th>Xe</th><th>Bệnh viện</th><th /></tr></thead>
          <tbody>{b.victims.map((v: any) => (
            <tr key={v.id}><td className="mono">{v.tag}</td><td><span className={`badge ${TRIAGE_TONE[v.triage]}`}>{meta.triage[v.triage]}</span></td>
              <td className="small">{v.sex === 'M' ? 'Nam' : v.sex === 'F' ? 'Nữ' : ''} {v.age_group ?? ''}</td><td className="small">{v.note}</td>
              <td>{meta.victimStatus[v.status]}</td><td>{v.vehicle_id ?? '—'}</td><td className="small">{v.hospital ?? '—'}</td>
              <td className="right no-print">{canLog && !inc.mci_ended_at && <button className="ghost small" onClick={() => setF({ id: v.id, tag: v.tag, triage: v.triage, sex: v.sex ?? '', ageGroup: v.age_group ?? '', note: v.note ?? '', status: v.status, vehicleId: v.vehicle_id ?? '', hospital: v.hospital ?? '' })}>Sửa</button>}</td></tr>))}</tbody>
        </table>
        {!b.victims.length && <div className="small muted">Chưa ghi nạn nhân nào.</div>}
      </div>
    </div>
  );
}

export function MciCommand({ meta, value, onSave, onCancel }: { meta: Meta; value: any; onSave: (v: any) => void; onCancel: () => void }) {
  const [v, setV] = useState(value);
  return (
    <div className="panel col">
      <label className="field">Mức<select value={v.level} onChange={(e) => setV({ ...v, level: Number(e.target.value) })}>{Object.entries(meta.mciLevel).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className="field">Mô tả<input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="Tai nạn liên hoàn 3 xe khách, ước 15 người bị thương" /></label>
      <div className="grid3">{Object.entries(meta.icsRoles).map(([k, l]) => (
        <label key={k} className="field">{l}<input value={v.roles[k] ?? ''} onChange={(e) => setV({ ...v, roles: { ...v.roles, [k]: e.target.value } })} /></label>))}</div>
      <div className="row"><button className="primary" onClick={() => onSave({ level: v.level, note: v.note || null, roles: Object.fromEntries(Object.entries(v.roles).filter(([, x]) => x)) })}>Lưu, báo 115</button><button className="ghost" onClick={onCancel}>Bỏ</button></div>
      <div className="small muted">Lần kích hoạt đầu và mỗi lần đổi mức đều đưa thông báo vào hàng gửi 115; khi chưa có kết nối, điều phối viên gọi đường nóng rồi đánh dấu đã báo.</div>
    </div>
  );
}

/* ======================= Xe và bảo dưỡng ======================= */

function Fleet({ meta, run }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const [view, setView] = useState<string | null>(null);
  const load = () => api<any[]>('GET', '/api/ops/fleet').then(setRows);
  useEffect(() => { load().catch(() => {}); }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  if (view) return <VehicleView id={view} meta={meta} run={run} onBack={() => setView(null)} />;
  return (
    <div className="col">
      <div className="small muted">Đăng kiểm hoặc bảo hiểm bắt buộc hết hạn là khóa xe: không gợi ý, không ai giao được. Cảnh báo trước {meta.docWarnDays} ngày. Bảo dưỡng theo km hoặc tháng, cái nào đến trước.</div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Xe</th><th>Điểm</th><th>Km</th><th>Đăng kiểm</th><th>Bảo hiểm TNDS</th><th>Bảo dưỡng tới hạn</th><th>Cảnh báo</th><th /></tr></thead>
          <tbody>{rows.map((v) => {
            const doc = (k: string) => v.docs.find((x: any) => x.kind === k);
            const cell = (k: string) => { const x = doc(k); return x ? <span className={x.days_left < 0 ? 'red' : x.days_left <= meta.docWarnDays ? 'amber' : ''}>{d(x.expires_on)}</span> : <span className="muted">chưa nhập</span>; };
            return (
              <tr key={v.id}>
                <td><b>{v.id}</b> <span className="small muted">{v.type} {v.plate}</span>{v.blocks.length > 0 && <div><span className="badge red">Khóa</span></div>}</td>
                <td className="small">{v.station_name}</td><td className="mono">{v.odometerKm != null ? num(v.odometerKm) : '—'}</td>
                <td>{cell('dang_kiem')}</td><td>{cell('bao_hiem_tnds')}</td>
                <td className="small">{v.maintenance.dueOn ? d(v.maintenance.dueOn) : '—'}{v.maintenance.dueKm != null ? ` · ${num(v.maintenance.dueKm)} km` : ''}</td>
                <td className="small">{[...v.blocks.map((b: string) => <div key={b} className="red">{b}</div>), ...v.warnings.map((w: string) => <div key={w}>{w}</div>)]}</td>
                <td className="right"><button className="ghost small" onClick={() => setView(v.id)}>Hồ sơ</button></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </div>
  );
}

function VehicleView({ id, meta, run, onBack }: Ctx & { id: string; onBack: () => void }) {
  const [v, setV] = useState<any>(null);
  const [doc, setDoc] = useState<any>(null);
  const [mt, setMt] = useState<any>(null);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const role = session.user?.role ?? '';
  const canEdit = FLEET_EDIT.includes(role);
  const load = () => api<any>('GET', `/api/ops/fleet/${id}`).then(setV);
  useEffect(() => {
    load().catch(() => {});
    if (canEdit) api<any[]>('GET', '/api/qms/suppliers').then((r) => setSuppliers(r.filter((s) => s.category === 'xe' || s.category === 'dich_vu'))).catch(() => {});
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return null;
  const m = v.maintenance;
  return (
    <div className="col">
      <div className="row"><button className="ghost" onClick={onBack}>← Danh sách xe</button></div>
      <div className={`panel col ${v.blocks.length ? 'red' : ''}`}>
        <b>{id} · {v.type} · {v.odometerKm != null ? `${num(v.odometerKm)} km (ghi ${at(v.odometerAt)})` : 'chưa ghi km'}</b>
        {v.blocks.map((b: string) => <div key={b}>Khóa: {b}</div>)}
        {v.warnings.map((w: string) => <div key={w} className="small">{w}</div>)}
        <div className="small">Bảo dưỡng định kỳ mỗi {num(m.intervalKm)} km hoặc {m.intervalMonths} tháng · lần gần nhất {d(m.lastOn)}{m.lastKm != null ? ` (${num(m.lastKm)} km)` : ''} · tới hạn {d(m.dueOn)}{m.dueKm != null ? ` hoặc ${num(m.dueKm)} km` : ''}
          {canEdit && <button className="ghost small" onClick={() => { const km = prompt('Bảo dưỡng mỗi bao nhiêu km?', String(m.intervalKm)); const mo = km && prompt('Hoặc mỗi bao nhiêu tháng?', String(m.intervalMonths)); if (km && mo) run(async () => { await api('PUT', `/api/ops/fleet/${id}/plan`, { intervalKm: Number(km), intervalMonths: Number(mo) }); await load(); }, 'Đã lưu định mức'); }}>Đổi định mức</button>}
        </div>
      </div>
      <div className="panel col">
        <div className="row" style={{ justifyContent: 'space-between' }}><b>Giấy tờ xe</b>{canEdit && !doc && <button className="small" onClick={() => setDoc({ kind: 'dang_kiem', number: '', issuedOn: '', expiresOn: '', note: '' })}>Thêm, gia hạn</button>}</div>
        {doc && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <select value={doc.kind} onChange={(e) => setDoc({ ...doc, kind: e.target.value })}>{Object.entries(meta.vehicleDocKind).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input placeholder="Số" value={doc.number} onChange={(e) => setDoc({ ...doc, number: e.target.value })} />
            <label className="field">Ngày cấp<input type="date" value={doc.issuedOn} onChange={(e) => setDoc({ ...doc, issuedOn: e.target.value })} /></label>
            <label className="field">Hết hạn<input type="date" value={doc.expiresOn} onChange={(e) => setDoc({ ...doc, expiresOn: e.target.value })} /></label>
            <button className="primary small" disabled={!doc.expiresOn} onClick={() => run(async () => { await api('POST', `/api/ops/fleet/${id}/docs`, { ...doc, number: doc.number || null, issuedOn: doc.issuedOn || null, note: doc.note || null }); setDoc(null); await load(); }, 'Đã lưu giấy tờ')}>Lưu</button>
            <button className="ghost small" onClick={() => setDoc(null)}>Bỏ</button>
          </div>
        )}
        <table className="small"><thead><tr><th>Loại</th><th>Số</th><th>Ngày cấp</th><th>Hết hạn</th><th>Người nhập</th></tr></thead>
          <tbody>{v.docs.map((x: any) => <tr key={x.id}><td>{meta.vehicleDocKind[x.kind]}{meta.blockingDocs.includes(x.kind) ? ' *' : ''}</td><td>{x.number}</td><td>{d(x.issued_on)}</td><td>{d(x.expires_on)}</td><td>{x.created_by_name}</td></tr>)}</tbody></table>
        <div className="small muted">* hết hạn là khóa xe</div>
      </div>
      <div className="panel col">
        <div className="row" style={{ justifyContent: 'space-between' }}><b>Bảo dưỡng, sửa chữa, tai nạn</b>{canEdit && !mt && <button className="small" onClick={() => setMt({ kind: 'dinh_ky', doneOn: today(), odometerKm: v.odometerKm ?? '', supplierId: '', work: '', cost: '', outOfServiceHours: '' })}>Ghi</button>}</div>
        {mt && (
          <div className="col">
            <div className="grid4">
              <label className="field">Loại<select value={mt.kind} onChange={(e) => setMt({ ...mt, kind: e.target.value })}>{Object.entries(meta.maintenanceKind).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
              <label className="field">Ngày<input type="date" value={mt.doneOn} onChange={(e) => setMt({ ...mt, doneOn: e.target.value })} /></label>
              <label className="field">Km lúc làm<input inputMode="numeric" value={mt.odometerKm} onChange={(e) => setMt({ ...mt, odometerKm: e.target.value })} /></label>
              <label className="field">Gara, nhà cung cấp<select value={mt.supplierId} onChange={(e) => setMt({ ...mt, supplierId: e.target.value })}><option value="">—</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
              <label className="field">Chi phí (đồng)<input inputMode="numeric" value={mt.cost} onChange={(e) => setMt({ ...mt, cost: e.target.value })} /></label>
              <label className="field">Số giờ xe nằm<input inputMode="decimal" value={mt.outOfServiceHours} onChange={(e) => setMt({ ...mt, outOfServiceHours: e.target.value })} /></label>
            </div>
            <label className="field">Nội dung<input value={mt.work} onChange={(e) => setMt({ ...mt, work: e.target.value })} /></label>
            <div className="row"><button className="primary" disabled={mt.work.length < 3} onClick={() => run(async () => {
              await api('POST', `/api/ops/fleet/${id}/maintenance`, { kind: mt.kind, doneOn: mt.doneOn, work: mt.work, odometerKm: mt.odometerKm === '' ? null : Number(mt.odometerKm), supplierId: mt.supplierId || null, cost: mt.cost === '' ? null : Number(mt.cost), outOfServiceHours: mt.outOfServiceHours === '' ? null : Number(mt.outOfServiceHours) });
              setMt(null); await load();
            }, 'Đã ghi')}>Lưu</button><button className="ghost" onClick={() => setMt(null)}>Bỏ</button></div>
          </div>
        )}
        <table className="small"><thead><tr><th>Ngày</th><th>Loại</th><th>Km</th><th>Nội dung</th><th>Gara</th><th className="right">Chi phí</th><th>Giờ nằm</th></tr></thead>
          <tbody>{v.maintenanceLog.map((x: any) => <tr key={x.id}><td>{d(x.done_on)}</td><td>{meta.maintenanceKind[x.kind]}</td><td>{x.odometer_km != null ? num(x.odometer_km) : ''}</td><td>{x.work}</td><td>{x.supplier_name}</td><td className="right">{x.cost != null ? money(x.cost) : ''}</td><td>{x.out_of_service_hours ?? ''}</td></tr>)}</tbody></table>
      </div>
      <div className="panel col">
        <div className="row" style={{ justifyContent: 'space-between' }}><b>Km, nhiên liệu</b>
          <button className="small" onClick={() => { const km = prompt('Số km trên đồng hồ:'); if (!km) return; const l = prompt('Đổ nhiên liệu (lít, bỏ trống nếu không):') ?? ''; const c = l ? prompt('Tiền nhiên liệu (đồng):') ?? '' : ''; run(async () => { await api('POST', `/api/ops/fleet/${id}/odometer`, { km: Number(km), fuelLiters: l ? Number(l) : null, fuelCost: c ? Number(c) : null }); await load(); }, 'Đã ghi km'); }}>Ghi km</button></div>
        <table className="small"><thead><tr><th>Lúc</th><th>Km</th><th>Nhiên liệu</th><th>Người ghi</th><th>Ghi chú</th></tr></thead>
          <tbody>{v.odometer.map((x: any) => <tr key={x.id}><td>{at(x.at)}</td><td>{num(x.km)}</td><td>{x.fuel_liters != null ? `${x.fuel_liters} lít${x.fuel_cost ? `, ${money(x.fuel_cost)}` : ''}` : ''}</td><td>{x.user_name}</td><td>{x.note}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}

/* ======================= Lộ trình ======================= */

function Track({ run }: Ctx) {
  const initial = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('ca') ?? '' : '';
  const [code, setCode] = useState(initial);
  const [t, setT] = useState<any>(null);
  const find = (c: string) => run(async () => {
    setT(await api('GET', `/api/ops/tracks/by-code/${encodeURIComponent(c.trim().toUpperCase())}`));
  });
  useEffect(() => { if (initial) find(initial); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col">
      <div className="panel row" style={{ gap: 8 }}>
        <label className="field">Mã ca<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="MD-..." /></label>
        <button className="primary" disabled={code.trim().length < 3} onClick={() => find(code)}>Xem lộ trình</button>
      </div>
      {t && (
        <>
          {t.vehicles.map((v: any) => (
            <div key={v.vehicleId} className={`panel small ${v.flags.length ? 'amber' : ''}`}>
              <b>{v.vehicleId}</b> · {at(v.from)} – {v.to ? at(v.to) : 'đang làm'} · {v.points.length} điểm · {v.km} km{v.declaredKm != null ? ` (kíp khai ${v.declaredKm} km)` : ''}
              {v.nearestToSceneKm != null && ` · gần hiện trường nhất ${v.nearestToSceneKm} km`}
              {v.flags.map((f: string) => <div key={f}>{f}</div>)}
            </div>
          ))}
          {!t.vehicles.length && <div className="panel muted">Ca chưa giao xe.</div>}
          <TrackMap scene={t.incident} tracks={t.vehicles} />
        </>
      )}
    </div>
  );
}
