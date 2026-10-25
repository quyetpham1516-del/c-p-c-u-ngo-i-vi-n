'use client';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, ROLE_LABEL, session, type Role } from '../api';
import { useStations } from '../catalog';
import { Stat } from './Hr';

interface Meta {
  riskLevels: Record<string, string>; findingKinds: Record<string, string>; auditStatus: Record<string, string>; capaSources: Record<string, string>;
  capaStatus: Record<string, string>; capaVerifyDays: number; supplierCategories: Record<string, string>; supplierCriteria: [string, string][];
  samplePct: number; autoIndicators: Record<string, string>;
}
interface Staff { id: string; full_name: string; role: string; title: string | null }
type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
type Ctx = { meta: Meta; staff: Staff[]; run: Run; canEdit: boolean };

const QM_VIEW = ['qa', 'supervisor', 'admin', 'director', 'ipc'];
const QM = ['qa', 'supervisor', 'admin', 'director'];
const BOARD = ['director', 'admin'];
const SUPPLIER_ROLES = ['pharmacist', 'technician', 'accountant'];
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const thisPeriod = () => today().slice(0, 7);
const lastPeriod = () => { const d = new Date(Date.now() + 7 * 3600_000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const d = (s?: string | null) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '—');
const STATUS_TEXT: Record<string, string> = { dat: 'Đạt', canh_bao: 'Cảnh báo', khong_dat: 'Không đạt' };
const STATUS_TONE: Record<string, string> = { dat: 'green', canh_bao: 'amber', khong_dat: 'red' };
const LEVEL_TONE: Record<string, string> = { cao: 'red', trung_binh: 'amber', thap: 'green' };
const SUPPLIER_STATUS: Record<string, string> = { duoc_duyet: 'Được duyệt', theo_doi: 'Theo dõi', ngung: 'Ngừng hợp tác' };
const SUPPLIER_RESULT: Record<string, string> = { dat: 'Đạt', theo_doi: 'Theo dõi', khong_dat: 'Không đạt' };
const RESULT_TONE: Record<string, string> = { dat: 'green', theo_doi: 'amber', khong_dat: 'red' };
const CHECK_RESULT: Record<string, string> = { dat: 'Đạt', khong_dat: 'Không đạt', khong_ap_dung: 'Không áp dụng' };

/** Hệ thống quản lý chất lượng (QLCL-02, 04, 09, 10, 11, 12, 17, 18) */
export function Qms() {
  const role = session.user?.role ?? '';
  const view = QM_VIEW.includes(role);
  const tabs = [
    ...(view ? ['Tổng quan', 'Chỉ số', 'Rủi ro'] : []), 'Đánh giá nội bộ', ...(view ? ['Khắc phục (CAPA)', 'Giám sát gọi lại'] : []),
    ...(view || SUPPLIER_ROLES.includes(role) ? ['Nhà cung cấp'] : []), ...(view ? ['Xem xét của lãnh đạo', 'Lưu trữ hồ sơ'] : []),
  ];
  const [tab, setTab] = useState(tabs[0]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api<Meta>('GET', '/api/qms/meta').then(setMeta).catch((e) => setError(e.message));
    api<Staff[]>('GET', '/api/staff').then(setStaff).catch(() => {});
  }, []);
  const run: Run = async (fn, ok) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  if (!meta) return error ? <div className="error">{error}</div> : null;
  const ctx: Ctx = { meta, staff, run, canEdit: QM.includes(role) };
  return (
    <div className="col">
      <h2 className="no-print" style={{ margin: 0 }}>Hệ thống quản lý chất lượng <span className="small muted">ISO 9001 · QLCL-02, 04, 09–12, 17, 18</span></h2>
      <div className="tabs no-print">{tabs.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); setMsg(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {tab === 'Tổng quan' && <Overview go={setTab} />}
      {tab === 'Chỉ số' && <Indicators {...ctx} />}
      {tab === 'Rủi ro' && <Risks {...ctx} />}
      {tab === 'Đánh giá nội bộ' && <Audits {...ctx} />}
      {tab === 'Khắc phục (CAPA)' && <CapaList {...ctx} />}
      {tab === 'Giám sát gọi lại' && <Callbacks {...ctx} />}
      {tab === 'Nhà cung cấp' && <Suppliers {...ctx} canEdit={QM.includes(role) || ['pharmacist', 'technician'].includes(role)} />}
      {tab === 'Xem xét của lãnh đạo' && <Reviews {...ctx} />}
      {tab === 'Lưu trữ hồ sơ' && <Retention {...ctx} />}
    </div>
  );
}

export function StaffSelect({ staff, value, onChange, placeholder = '— Chọn người —' }: { staff: Staff[]; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)}><option value="">{placeholder}</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}{s.title ? ` (${s.title})` : ''}</option>)}</select>;
}

/* ======================= Tổng quan ======================= */

function Overview({ go }: { go: (t: string) => void }) {
  const [s, setS] = useState<any>(null);
  useEffect(() => { api('GET', '/api/qms/summary').then(setS).catch(() => {}); }, []);
  if (!s) return null;
  const link = (t: string, label: string) => <button className="ghost small" onClick={() => go(t)}>{label}</button>;
  return (
    <div className="col">
      <div className="grid4">
        <Stat label="Rủi ro cao đang mở" value={s.risks.high} tone={s.risks.needsAction ? 'red' : ''} />
        <Stat label="Rủi ro cao chưa có khắc phục" value={s.risks.needsAction} tone={s.risks.needsAction ? 'red' : ''} />
        <Stat label="Rủi ro quá hạn rà soát" value={s.risks.reviewOverdue} tone={s.risks.reviewOverdue ? 'amber' : ''} />
        <Stat label={`Chỉ số không đạt tháng ${s.period.slice(5)}/${s.period.slice(0, 4)}`} value={s.indicators.missed.length} tone={s.indicators.missed.length ? 'red' : 'green'} />
        <Stat label="Khắc phục đang làm (quá hạn)" value={`${s.capa.open} (${s.capa.overdue})`} tone={s.capa.overdue ? 'red' : ''} />
        <Stat label="Chờ kiểm tra hiệu quả (quá hạn)" value={`${s.capa.verify} (${s.capa.verify_overdue})`} tone={s.capa.verify_overdue ? 'amber' : ''} />
        <Stat label="Đánh giá nội bộ năm nay: xong / kế hoạch" value={`${s.audits.done}/${s.audits.planned}`} tone={s.audits.late ? 'amber' : ''} />
        <Stat label="Ca chờ gọi lại giám sát" value={s.callbacks.pending} />
      </div>
      {s.indicators.missed.length > 0 && (
        <div className="panel">
          <b>Chỉ số không đạt tháng trước</b> {link('Chỉ số', 'Xem bảng chỉ số')}
          <ul>{s.indicators.missed.map((m: any) => <li key={m.code}>{m.code} {m.name}: {m.value}{m.unit === '%' ? '%' : ` ${m.unit}`} (chỉ tiêu {m.target}{m.unit === '%' ? '%' : ''})</li>)}</ul>
        </div>
      )}
      {(s.suppliers.watch > 0 || s.suppliers.expiring > 0) && (
        <div className="alert amber">{s.suppliers.watch} nhà cung cấp đang theo dõi, {s.suppliers.expiring} hợp đồng hết hạn trong 30 ngày. {link('Nhà cung cấp', 'Xem')}</div>
      )}
      <div className="small muted">Vòng cải tiến: chỉ số, rủi ro, đánh giá nội bộ, gọi lại giám sát và xem xét của lãnh đạo đều giao việc qua mục Khắc phục (CAPA). Việc xong phải có người khác người phụ trách kiểm tra hiệu quả.</div>
    </div>
  );
}

/* ======================= Khắc phục dùng chung ======================= */

/** Biểu mẫu giao hành động khắc phục, gắn sẵn nguồn (rủi ro, phát hiện, chỉ số...) hoặc chọn nguồn khác */
export function CapaForm({ staff, run, link, sources, onDone }: {
  staff: Staff[]; run: Run; link?: Record<string, string>; sources?: Record<string, string>; onDone: () => void;
}) {
  const [f, setF] = useState({ kind: 'khac_phuc', description: '', rootCause: '', ownerId: '', dueDate: '', source: 'tieu_chi', sourceRef: '' });
  const free = !link;
  return (
    <div className="panel col" style={{ marginTop: 6 }}>
      <div className="grid4">
        {free && sources && <label className="field">Nguồn<select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{Object.entries(sources).filter(([k]) => ['tieu_chi', 'khac'].includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
        {free && <label className="field">Mã nguồn<input value={f.sourceRef} onChange={(e) => setF({ ...f, sourceRef: e.target.value })} placeholder="TC-DV-CCNV TC9, biên bản..." /></label>}
        <label className="field">Loại<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="khac_phuc">Khắc phục</option><option value="phong_ngua">Phòng ngừa</option></select></label>
        <label className="field">Người phụ trách<StaffSelect staff={staff} value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} /></label>
        <label className="field">Hạn<input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></label>
      </div>
      <label className="field">Việc cần làm<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <label className="field">Nguyên nhân gốc (nếu đã phân tích)<input value={f.rootCause} onChange={(e) => setF({ ...f, rootCause: e.target.value })} /></label>
      <div className="row">
        <button className="primary" disabled={f.description.trim().length < 5 || !f.ownerId || !f.dueDate || (free && !f.sourceRef.trim())} onClick={() => run(async () => {
          await api('POST', '/api/quality/capa', { ...(link ?? { source: f.source, sourceRef: f.sourceRef }), ...(link?.indicatorId ? { sourceRef: link.sourceRef } : {}),
            kind: f.kind, description: f.description, rootCause: f.rootCause || null, ownerId: f.ownerId, dueDate: f.dueDate });
          onDone();
        }, 'Đã giao hành động khắc phục')}>Giao việc</button>
        <button className="ghost" onClick={onDone}>Hủy</button>
      </div>
    </div>
  );
}

export function CapaList({ meta, staff, run, canEdit }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const me = session.user?.id;
  const load = () => api<any[]>('GET', `/api/quality/capa?${new URLSearchParams({ ...(source ? { source } : {}), ...(status ? { status } : {}) })}`).then(setRows);
  useEffect(() => { load().catch(() => {}); }, [source, status]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = (c: any) => c.event_code ?? c.complaint_code ?? c.finding_code ?? c.risk_code ?? c.review_code ?? (c.indicator_code ? `${c.indicator_code} ${c.source_ref ?? ''}` : null) ?? c.callback_incident_code ?? c.source_ref;
  const verify = (c: any, effective: boolean) => {
    const note = prompt(effective ? 'Bằng chứng hành động có hiệu quả (đã kiểm tra gì, kết quả):' : 'Vì sao chưa hiệu quả:');
    if (!note || note.length < 3) return;
    const newDueDate = effective ? null : prompt('Hạn mới (YYYY-MM-DD):', today());
    if (!effective && !newDueDate) return;
    run(async () => { await api('POST', `/api/quality/capa/${c.id}/verify`, { effective, note, newDueDate }); await load(); }, effective ? 'Đã xác nhận hiệu quả' : 'Đã mở lại hành động');
  };
  return (
    <div className="col">
      <div className="panel row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="field">Nguồn<select value={source} onChange={(e) => setSource(e.target.value)}><option value="">Tất cả</option>{Object.entries(meta.capaSources).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">Trạng thái<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Tất cả</option>{Object.entries(meta.capaStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {canEdit && !adding && <button onClick={() => setAdding(true)}>Giao việc từ tiêu chí hoặc nguồn khác</button>}
        <span className="small muted">Xong rồi thì sau {meta.capaVerifyDays} ngày QLCL kiểm tra hiệu quả; người phụ trách không tự xác nhận.</span>
      </div>
      {adding && <CapaForm staff={staff} run={run} sources={meta.capaSources} onDone={() => { setAdding(false); load(); }} />}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Việc</th><th>Nguồn</th><th>Phụ trách</th><th>Hạn</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id}>
              <td>{c.kind === 'phong_ngua' ? 'Phòng ngừa' : 'Khắc phục'}: {c.description}{c.root_cause && <div className="small muted">Nguyên nhân: {c.root_cause}</div>}</td>
              <td className="small">{meta.capaSources[c.source]}<div className="mono">{ref(c)}</div></td>
              <td className="small">{c.owner_name}</td>
              <td className={`mono small ${c.overdue ? 'red' : ''}`}>{d(c.due_date)}{c.overdue ? ' (quá hạn)' : ''}</td>
              <td><span className={`badge ${c.status === 'da_xac_nhan' ? 'green' : c.overdue || c.verify_overdue ? 'red' : c.status === 'xong' ? 'amber' : ''}`}>{meta.capaStatus[c.status]}</span>
                {c.evidence && <div className="small muted">Đã làm: {c.evidence}</div>}
                {c.status === 'xong' && <div className="small muted">Kiểm tra hiệu quả trước {d(c.verify_due)}</div>}
                {c.verify_note && <div className="small muted">{c.effective ? 'Hiệu quả' : 'Chưa hiệu quả'}: {c.verify_note} ({c.verified_by_name})</div>}</td>
              <td className="right" style={{ whiteSpace: 'nowrap' }}>
                {c.status === 'mo' && (c.owner_id === me || canEdit) && <>
                  <button className="ghost small" onClick={() => { const ev = prompt('Đã làm gì (bằng chứng):'); if (ev && ev.length >= 3) run(async () => { await api('POST', `/api/quality/capa/${c.id}/finish`, { status: 'xong', evidence: ev }); await load(); }, 'Đã báo xong, chờ kiểm tra hiệu quả'); }}>Xong</button>
                  <button className="ghost small" onClick={() => { const ev = prompt('Lý do hủy:'); if (ev && ev.length >= 3) run(async () => { await api('POST', `/api/quality/capa/${c.id}/finish`, { status: 'huy', evidence: ev }); await load(); }, 'Đã hủy'); }}>Hủy</button></>}
                {c.status === 'xong' && canEdit && c.owner_id !== me && <>
                  <button className="primary small" onClick={() => verify(c, true)}>Hiệu quả</button>
                  <button className="ghost small" onClick={() => verify(c, false)}>Chưa hiệu quả</button></>}
              </td>
            </tr>))}</tbody>
        </table>
        {!rows.length && <div className="small muted">Chưa có.</div>}
      </div>
    </div>
  );
}

/* ======================= Chỉ số ======================= */

const emptyInd = { id: '', code: '', name: '', definition: '', formula: '', unit: '%', direction: 'cao_tot', target: '' as string | number, warn: '' as string | number, autoKey: '', ownerId: '' };

function Indicators({ meta, staff, run, canEdit }: Ctx) {
  const [period, setPeriod] = useState(lastPeriod());
  const [b, setB] = useState<any>(null);
  const [f, setF] = useState<typeof emptyInd | null>(null);
  const [capa, setCapa] = useState<{ id: string; period: string } | null>(null);
  const load = () => api('GET', `/api/qms/indicators?period=${period}&months=12`).then(setB);
  useEffect(() => { load().catch(() => {}); }, [period]); // eslint-disable-line react-hooks/exhaustive-deps
  const enter = (r: any, p: string) => {
    if (!canEdit) return;
    if (r.auto_key) {
      const note = prompt(`Ghi chú cho ${r.code} tháng ${p} (chỉ số tính tự động):`, r.values[p]?.note ?? '');
      if (note !== null) run(async () => { await api('PUT', `/api/qms/indicators/${r.id}/values/${p}`, { note }); await load(); }, 'Đã ghi chú');
      return;
    }
    const raw = prompt(`${r.code} ${r.name}, tháng ${p}.\nNhập "tử số/mẫu số" (ví dụ 58/60) hoặc một giá trị:`, '');
    if (!raw) return;
    const [n, den] = raw.split('/').map((x) => Number(x.trim().replace(',', '.')));
    const body = den ? { numerator: n, denominator: den } : { value: n };
    run(async () => { await api('PUT', `/api/qms/indicators/${r.id}/values/${p}`, body); await load(); }, 'Đã lưu số liệu');
  };
  const save = () => f && run(async () => {
    const body = { code: f.code, name: f.name, definition: f.definition || null, formula: f.formula || null, unit: f.unit, direction: f.direction, target: Number(f.target),
      warn: f.warn === '' ? null : Number(f.warn), autoKey: f.autoKey || null, ownerId: f.ownerId || null };
    await api(f.id ? 'PUT' : 'POST', f.id ? `/api/qms/indicators/${f.id}` : '/api/qms/indicators', body);
    setF(null); await load();
  }, 'Đã lưu chỉ số');
  if (!b) return null;
  const fmt = (v: any, unit: string) => (v?.value == null ? '' : `${v.value}${unit === '%' ? '' : ''}`);
  return (
    <div className="col">
      <div className="panel row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="field">Đến tháng<input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
        {canEdit && <button onClick={() => run(async () => { await api('POST', '/api/qms/indicators/compute', { period }); await load(); }, `Đã tính lại chỉ số tự động tháng ${period}`)}>Tính lại tháng {period.slice(5)}/{period.slice(0, 4)}</button>}
        {canEdit && <button onClick={() => run(async () => { await api('POST', '/api/qms/indicators/compute', { period: thisPeriod() }); await load(); }, 'Đã tính tháng hiện tại')}>Tính tháng này (tạm)</button>}
        {canEdit && <button className="ghost" onClick={() => setF({ ...emptyInd })}>Thêm chỉ số</button>}
        <button className="ghost" onClick={() => window.print()}>In</button>
      </div>
      <div className="small muted">Bấm vào ô để nhập số liệu tháng (chỉ số nhập tay) hoặc ghi chú (chỉ số tự động). Ô đỏ là không đạt chỉ tiêu, ô vàng là đạt nhưng dưới ngưỡng cảnh báo.</div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Chỉ số</th><th>Chỉ tiêu</th>{b.periods.map((p: string) => <th key={p} className="right">{p.slice(5)}/{p.slice(2, 4)}</th>)}<th /></tr></thead>
          <tbody>{b.rows.map((r: any) => {
            const last = r.values[period];
            return (
              <Fragment key={r.id}>
                <tr>
                  <td><b className="mono">{r.code}</b> {r.name}<div className="small muted">{r.auto_key ? `Tự động: ${r.autoLabel}` : 'Nhập tay'}{r.owner_name ? ` · ${r.owner_name}` : ''}</div></td>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{r.direction === 'cao_tot' ? '≥' : '≤'} {r.target}{r.unit === '%' ? '%' : ` ${r.unit}`}{r.warn != null ? <div className="muted">cảnh báo {r.warn}</div> : null}</td>
                  {b.periods.map((p: string) => {
                    const v = r.values[p];
                    return <td key={p} className={v?.status ? `cell-${v.status}` : 'right'} style={{ cursor: canEdit ? 'pointer' : undefined }} title={v ? `${v.numerator ?? ''}${v.denominator ? `/${v.denominator}` : ''}${v.note ? ` · ${v.note}` : ''}${v.status ? ` · ${STATUS_TEXT[v.status]}` : ''}` : 'Chưa có số liệu'}
                      onClick={() => enter(r, p)}>{fmt(v, r.unit)}{v?.note ? '*' : ''}{v?.capa ? ' ⚑' : ''}</td>;
                  })}
                  <td className="right" style={{ whiteSpace: 'nowrap' }}>
                    {canEdit && last?.status === 'khong_dat' && !last.capa && <button className="primary small" onClick={() => setCapa({ id: r.id, period })}>Giao khắc phục</button>}
                    {canEdit && <button className="ghost small" onClick={() => setF({ id: r.id, code: r.code, name: r.name, definition: r.definition ?? '', formula: r.formula ?? '', unit: r.unit, direction: r.direction, target: r.target, warn: r.warn ?? '', autoKey: r.auto_key ?? '', ownerId: r.owner_id ?? '' })}>Sửa</button>}
                  </td>
                </tr>
                {capa && capa.id === r.id && <tr><td colSpan={b.periods.length + 3}><CapaForm staff={staff} run={run} link={{ indicatorId: r.id, sourceRef: capa.period }} onDone={() => { setCapa(null); load(); }} /></td></tr>}
              </Fragment>
            );
          })}</tbody>
        </table>
        <div className="small muted">* có ghi chú · ⚑ đã giao hành động khắc phục</div>
      </div>
      {f && (
        <div className="panel col">
          <b>{f.id ? `Sửa chỉ số ${f.code}` : 'Chỉ số mới'}</b>
          <div className="grid4">
            <label className="field">Mã<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="CS-13" /></label>
            <label className="field">Đơn vị<input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></label>
            <label className="field">Chiều tốt<select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="cao_tot">Càng cao càng tốt</option><option value="thap_tot">Càng thấp càng tốt</option></select></label>
            <label className="field">Chỉ tiêu<input type="number" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></label>
            <label className="field">Ngưỡng cảnh báo<input type="number" value={f.warn} onChange={(e) => setF({ ...f, warn: e.target.value })} placeholder="không bắt buộc" /></label>
            <label className="field">Cách tính<select value={f.autoKey} onChange={(e) => setF({ ...f, autoKey: e.target.value })}><option value="">Nhập tay hằng tháng</option>{Object.entries(meta.autoIndicators).map(([k, v]) => <option key={k} value={k}>Tự động: {v}</option>)}</select></label>
            <label className="field">Người theo dõi<StaffSelect staff={staff} value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} /></label>
          </div>
          <label className="field">Tên chỉ số<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field">Định nghĩa<input value={f.definition} onChange={(e) => setF({ ...f, definition: e.target.value })} /></label>
          <label className="field">Công thức (tử số / mẫu số)<input value={f.formula} onChange={(e) => setF({ ...f, formula: e.target.value })} /></label>
          <div className="row"><button className="primary" disabled={!f.code || f.name.length < 3 || f.target === ''} onClick={save}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Hủy</button></div>
        </div>
      )}
    </div>
  );
}

/* ======================= Rủi ro ======================= */

const emptyRisk = { id: '', area: '', hazard: '', cause: '', consequence: '', likelihood: 3, impact: 3, controls: '', ownerId: '', reviewMonths: 6 };
const LIKELIHOOD = ['', 'Hiếm', 'Ít khi', 'Có thể', 'Thường', 'Gần như chắc chắn'];
const IMPACT = ['', 'Không đáng kể', 'Nhẹ', 'Trung bình', 'Nặng', 'Rất nặng, tử vong'];

function Risks({ meta, staff, run, canEdit }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState<typeof emptyRisk | null>(null);
  const [open, setOpen] = useState<{ id: string; mode: 'history' | 'review' | 'capa'; data?: any[] } | null>(null);
  const [rv, setRv] = useState({ likelihood: 3, impact: 3, note: '', close: false });
  const load = () => api<any[]>('GET', '/api/qms/risks').then(setRows);
  useEffect(() => { load().catch(() => {}); }, []);
  const save = () => f && run(async () => {
    const body = { area: f.area, hazard: f.hazard, cause: f.cause || null, consequence: f.consequence || null, likelihood: Number(f.likelihood), impact: Number(f.impact),
      controls: f.controls || null, ownerId: f.ownerId || null, reviewMonths: Number(f.reviewMonths) };
    await api(f.id ? 'PUT' : 'POST', f.id ? `/api/qms/risks/${f.id}` : '/api/qms/risks', body);
    setF(null); await load();
  }, 'Đã lưu rủi ro');
  const score = f ? Number(f.likelihood) * Number(f.impact) : 0;
  const lvl = score >= 15 ? 'cao' : score >= 8 ? 'trung_binh' : 'thap';
  return (
    <div className="col">
      <div className="panel row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {canEdit && <button onClick={() => setF({ ...emptyRisk })}>Thêm rủi ro</button>}
        <span className="small muted">Mức rủi ro = khả năng xảy ra × hậu quả (1–5). Từ 15 là cao: phải có hành động khắc phục. Rà soát lại theo chu kỳ (mặc định 6 tháng).</span>
      </div>
      {f && (
        <div className="panel col">
          <b>{f.id ? 'Sửa rủi ro' : 'Rủi ro mới'}</b>
          <div className="grid4">
            <label className="field">Khâu, dịch vụ<input value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} placeholder="Điều phối, vận chuyển, thuốc..." /></label>
            <label className="field">Khả năng xảy ra<select value={f.likelihood} onChange={(e) => setF({ ...f, likelihood: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}. {LIKELIHOOD[n]}</option>)}</select></label>
            <label className="field">Hậu quả<select value={f.impact} onChange={(e) => setF({ ...f, impact: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}. {IMPACT[n]}</option>)}</select></label>
            <div className="field">Mức rủi ro<div><span className={`badge ${LEVEL_TONE[lvl]}`}>{score} · {meta.riskLevels[lvl]}</span></div></div>
            <label className="field">Người theo dõi<StaffSelect staff={staff} value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} /></label>
            <label className="field">Rà soát sau (tháng)<input type="number" value={f.reviewMonths} onChange={(e) => setF({ ...f, reviewMonths: Number(e.target.value) })} /></label>
          </div>
          <label className="field">Mối nguy<input value={f.hazard} onChange={(e) => setF({ ...f, hazard: e.target.value })} /></label>
          <label className="field">Nguyên nhân<input value={f.cause} onChange={(e) => setF({ ...f, cause: e.target.value })} /></label>
          <label className="field">Hậu quả có thể<input value={f.consequence} onChange={(e) => setF({ ...f, consequence: e.target.value })} /></label>
          <label className="field">Biện pháp kiểm soát đang có<textarea rows={2} value={f.controls} onChange={(e) => setF({ ...f, controls: e.target.value })} /></label>
          <div className="row"><button className="primary" disabled={f.area.length < 2 || f.hazard.length < 5} onClick={save}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Hủy</button></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Mã</th><th>Khâu</th><th>Mối nguy</th><th>Mức</th><th>Biện pháp</th><th>Rà soát</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <Fragment key={r.id}>
              <tr style={r.status === 'dong' ? { opacity: 0.6 } : undefined}>
                <td className="mono">{r.code}</td><td>{r.area}</td>
                <td>{r.hazard}{r.consequence && <div className="small muted">Hậu quả: {r.consequence}</div>}{r.source && <div className="small muted">{r.source}</div>}</td>
                <td style={{ whiteSpace: 'nowrap' }}><span className={`badge ${LEVEL_TONE[r.level]}`}>{r.score} · {meta.riskLevels[r.level]}</span><div className="small muted">K{r.likelihood} × H{r.impact}</div>
                  {r.needs_action && <div className="small red">Chưa có khắc phục</div>}{r.open_capa > 0 && <div className="small muted">{r.open_capa} việc khắc phục</div>}</td>
                <td className="small">{r.controls}{r.owner_name && <div className="muted">{r.owner_name}</div>}</td>
                <td className={`small ${r.review_overdue ? 'red' : ''}`}>{r.status === 'dong' ? 'Đã đóng' : `Hạn ${d(r.review_due)}`}</td>
                <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  <button className="ghost small" onClick={() => run(async () => setOpen(open && open.id === r.id && open.mode === 'history' ? null : { id: r.id, mode: 'history', data: await api('GET', `/api/qms/risks/${r.id}/history`) }))}>Lịch sử</button>
                  {canEdit && r.status === 'mo' && <>
                    <button className="ghost small" onClick={() => { setRv({ likelihood: r.likelihood, impact: r.impact, note: '', close: false }); setOpen({ id: r.id, mode: 'review' }); }}>Đánh giá lại</button>
                    <button className="ghost small" onClick={() => setF({ id: r.id, area: r.area, hazard: r.hazard, cause: r.cause ?? '', consequence: r.consequence ?? '', likelihood: r.likelihood, impact: r.impact, controls: r.controls ?? '', ownerId: r.owner_id ?? '', reviewMonths: r.review_months })}>Sửa</button>
                    <button className={`${r.needs_action ? 'primary' : 'ghost'} small`} onClick={() => setOpen({ id: r.id, mode: 'capa' })}>Giao khắc phục</button></>}
                </td>
              </tr>
              {open && open.id === r.id && (
                <tr><td colSpan={7}>
                  {open.mode === 'history' && <ul>{open.data!.map((h: any) => <li key={h.id}>{d(h.reviewed_on)}: mức {h.score} (K{h.likelihood} × H{h.impact}) · {h.note}{h.reviewed_by_name ? ` · ${h.reviewed_by_name}` : ''}</li>)}</ul>}
                  {open.mode === 'review' && (
                    <div className="panel col">
                      <div className="grid4">
                        <label className="field">Khả năng<select value={rv.likelihood} onChange={(e) => setRv({ ...rv, likelihood: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}. {LIKELIHOOD[n]}</option>)}</select></label>
                        <label className="field">Hậu quả<select value={rv.impact} onChange={(e) => setRv({ ...rv, impact: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}. {IMPACT[n]}</option>)}</select></label>
                        <label className="field row"><input type="checkbox" checked={rv.close} onChange={(e) => setRv({ ...rv, close: e.target.checked })} /> Đóng rủi ro (không còn)</label>
                      </div>
                      <label className="field">Nhận xét<input value={rv.note} onChange={(e) => setRv({ ...rv, note: e.target.value })} placeholder="Sau khắc phục, mức rủi ro giảm vì..." /></label>
                      <div className="row"><button className="primary" disabled={rv.note.length < 3} onClick={() => run(async () => { await api('POST', `/api/qms/risks/${r.id}/review`, rv); setOpen(null); await load(); }, 'Đã đánh giá lại')}>Lưu</button><button className="ghost" onClick={() => setOpen(null)}>Hủy</button></div>
                    </div>
                  )}
                  {open.mode === 'capa' && <CapaForm staff={staff} run={run} link={{ riskId: r.id }} onDone={() => { setOpen(null); load(); }} />}
                </td></tr>
              )}
            </Fragment>))}</tbody>
        </table>
      </div>
    </div>
  );
}

/* ======================= Đánh giá nội bộ ======================= */

const UNIT_ROLES: [string, string[]][] = [
  ['Trung tâm điều phối', ['calltaker', 'dispatcher', 'supervisor']], ['Kíp cấp cứu', ['crew']], ['Kho – dược', ['pharmacist']], ['Kỹ thuật thiết bị', ['technician']],
  ['Kiểm soát nhiễm khuẩn', ['ipc']], ['Hành chính – nhân sự', ['hr']], ['Kế toán', ['accountant']], ['Quản lý chất lượng', ['qa']],
];
const emptyAudit = { id: '', year: Number(today().slice(0, 4)), title: '', scope: '', auditedUnit: UNIT_ROLES[0][0], auditedRoles: UNIT_ROLES[0][1], auditedStation: '', plannedMonth: Number(today().slice(5, 7)), leadId: '', auditorIds: [] as string[], checklist: [{ q: '', ref: '' }] };

function Audits({ meta, staff, run, canEdit }: Ctx) {
  const [stations] = useStations();
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState<typeof emptyAudit | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api<any[]>('GET', `/api/qms/audits?year=${year}`).then(setRows);
  useEffect(() => { load().catch(() => {}); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => f && run(async () => {
    const body = { year: Number(f.year), title: f.title, scope: f.scope || null, auditedUnit: f.auditedUnit, auditedRoles: f.auditedRoles, auditedStation: f.auditedStation || null,
      plannedMonth: Number(f.plannedMonth), leadId: f.leadId || null, auditorIds: f.auditorIds, checklist: f.checklist.filter((c) => c.q.trim()).map((c) => ({ q: c.q, ref: c.ref || null })) };
    await api(f.id ? 'PUT' : 'POST', f.id ? `/api/qms/audits/${f.id}` : '/api/qms/audits', body);
    setF(null); await load();
  }, 'Đã lưu kế hoạch đánh giá');
  const edit = async (id: string) => {
    const a = await api<any>('GET', `/api/qms/audits/${id}`);
    setF({ id: a.id, year: a.year, title: a.title, scope: a.scope ?? '', auditedUnit: a.audited_unit, auditedRoles: a.audited_roles, auditedStation: a.audited_station ?? '',
      plannedMonth: a.planned_month, leadId: a.lead_id ?? '', auditorIds: a.auditor_ids.filter((x: string) => x !== a.lead_id), checklist: a.checklist.map((c: any) => ({ q: c.q, ref: c.ref ?? '' })) });
  };
  if (open) return <AuditView id={open} meta={meta} staff={staff} run={run} canEdit={canEdit} onBack={() => { setOpen(null); load(); }} />;
  const eligible = f ? staff.filter((s) => !f.auditedRoles.includes(s.role)) : [];
  return (
    <div className="col">
      <div className="panel row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="field">Năm<input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 100 }} /></label>
        {canEdit && <button onClick={() => setF({ ...emptyAudit, year })}>Lập kế hoạch đánh giá</button>}
        <span className="small muted">Đánh giá viên không được thuộc bộ phận được đánh giá (QLCL-09). Điểm không phù hợp phải có khắc phục được xác nhận hiệu quả mới đóng được cuộc đánh giá.</span>
      </div>
      {f && (
        <div className="panel col">
          <b>{f.id ? 'Sửa kế hoạch đánh giá' : 'Cuộc đánh giá mới'}</b>
          <div className="grid4">
            <label className="field">Năm<input type="number" value={f.year} onChange={(e) => setF({ ...f, year: Number(e.target.value) })} /></label>
            <label className="field">Tháng dự kiến<input type="number" min={1} max={12} value={f.plannedMonth} onChange={(e) => setF({ ...f, plannedMonth: Number(e.target.value) })} /></label>
            <label className="field">Bộ phận được đánh giá<select value={f.auditedUnit} onChange={(e) => { const u = UNIT_ROLES.find(([n]) => n === e.target.value)!; setF({ ...f, auditedUnit: u[0], auditedRoles: u[1], leadId: '', auditorIds: [] }); }}>{UNIT_ROLES.map(([n]) => <option key={n}>{n}</option>)}</select></label>
            <label className="field">Điểm trạm (nếu có)<select value={f.auditedStation} onChange={(e) => setF({ ...f, auditedStation: e.target.value })}><option value="">Toàn trung tâm</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label className="field">Trưởng đoàn<StaffSelect staff={eligible} value={f.leadId} onChange={(v) => setF({ ...f, leadId: v })} /></label>
          </div>
          <div className="small muted">Vai trò thuộc bộ phận: {f.auditedRoles.map((r) => ROLE_LABEL[r as Role] ?? r).join(', ')}. Danh sách chỉ hiện người độc lập.</div>
          <label className="field">Tên cuộc đánh giá<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Đánh giá quy trình tiếp nhận và điều phối" /></label>
          <label className="field">Phạm vi<input value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} placeholder="QT-DP-01, 02; tiêu chí TC1–TC3" /></label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>Thành viên đoàn: {eligible.filter((s) => s.id !== f.leadId).map((s) => <label key={s.id} className="row small"><input type="checkbox" checked={f.auditorIds.includes(s.id)} onChange={(e) => setF({ ...f, auditorIds: e.target.checked ? [...f.auditorIds, s.id] : f.auditorIds.filter((x) => x !== s.id) })} /> {s.full_name}</label>)}</div>
          <b>Bảng kiểm</b>
          {f.checklist.map((c, i) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <span className="mono">{i + 1}.</span>
              <input style={{ flex: 3 }} value={c.q} onChange={(e) => setF({ ...f, checklist: f.checklist.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)) })} placeholder="Câu hỏi đánh giá" />
              <input style={{ flex: 1 }} value={c.ref} onChange={(e) => setF({ ...f, checklist: f.checklist.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)) })} placeholder="Căn cứ" />
              <button className="ghost small" onClick={() => setF({ ...f, checklist: f.checklist.filter((_, j) => j !== i) })}>Bỏ</button>
            </div>
          ))}
          <button className="ghost small" onClick={() => setF({ ...f, checklist: [...f.checklist, { q: '', ref: '' }] })}>Thêm câu hỏi</button>
          <div className="row"><button className="primary" disabled={f.title.length < 3 || (!f.leadId && !f.auditorIds.length)} onClick={save}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Hủy</button></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Mã</th><th>Cuộc đánh giá</th><th>Bộ phận</th><th>Tháng</th><th>Đoàn</th><th className="right">Phát hiện (không phù hợp)</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.code}</td><td><a href="#" onClick={(e) => { e.preventDefault(); setOpen(a.id); }}>{a.title}</a></td><td>{a.audited_unit}</td>
              <td>{a.planned_month}{a.performed_on ? <div className="small muted">làm {d(a.performed_on)}</div> : null}</td><td className="small">{a.auditors}</td>
              <td className="right">{a.findings} ({a.nc})</td><td><span className={`badge ${a.status === 'dong' ? 'green' : ''}`}>{meta.auditStatus[a.status]}</span></td>
              <td className="right">{canEdit && a.status === 'ke_hoach' && <><button className="ghost small" onClick={() => run(() => edit(a.id))}>Sửa</button>
                <button className="ghost small" onClick={() => confirm('Hủy cuộc đánh giá này?') && run(async () => { await api('POST', `/api/qms/audits/${a.id}/advance`, { to: 'huy' }); await load(); }, 'Đã hủy')}>Hủy</button></>}</td>
            </tr>))}</tbody>
        </table>
        {!rows.length && <div className="small muted">Chưa có cuộc đánh giá nào trong năm.</div>}
      </div>
    </div>
  );
}

function AuditView({ id, meta, staff, run, canEdit, onBack }: Ctx & { id: string; onBack: () => void }) {
  const [a, setA] = useState<any>(null);
  const [res, setRes] = useState<{ result: string | null; note: string }[]>([]);
  const [summary, setSummary] = useState('');
  const [performedOn, setPerformedOn] = useState(today());
  const [fd, setFd] = useState({ kind: 'nc_nho', reference: '', description: '', evidence: '' });
  const [capaFor, setCapaFor] = useState<string | null>(null);
  const load = async () => {
    const x = await api<any>('GET', `/api/qms/audits/${id}`);
    setA(x); setRes(x.checklist.map((c: any) => ({ result: c.result, note: c.note ?? '' }))); setSummary(x.summary ?? ''); setPerformedOn(x.performed_on ?? today());
  };
  useEffect(() => { load().catch(() => {}); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a) return null;
  const me = session.user?.id ?? '';
  const inTeam = a.auditor_ids.includes(me) || BOARD.includes(session.user?.role ?? '');
  const writable = inTeam && ['ke_hoach', 'dang_danh_gia'].includes(a.status);
  return (
    <div className="col">
      <div className="row no-print"><button className="ghost" onClick={onBack}>← Danh sách</button><button className="ghost" onClick={() => window.print()}>In báo cáo</button></div>
      <div className="panel">
        <h3 style={{ margin: 0 }}>{a.code} · {a.title}</h3>
        <div className="small muted">Bộ phận: {a.audited_unit}{a.audited_station ? ` · ${a.audited_station}` : ''} · tháng {a.planned_month}/{a.year} · Trưởng đoàn: {a.lead_name ?? '—'} · Đoàn: {(a.team ?? []).map((t: any) => t.name).join(', ')}{a.scope ? ` · Phạm vi: ${a.scope}` : ''}</div>
        <span className="badge">{meta.auditStatus[a.status]}</span>
      </div>
      <div className="panel col">
        <b>Bảng kiểm</b>
        {a.checklist.map((c: any, i: number) => (
          <div key={i} className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
            <div style={{ flex: 1, minWidth: 240 }}><b>{i + 1}.</b> {c.q}{c.ref && <span className="small muted"> · {c.ref}</span>}</div>
            {writable ? <div className="row" style={{ gap: 4 }}>{Object.entries(CHECK_RESULT).map(([k, v]) => <button key={k} className={`choice ${res[i]?.result === k ? 'sel' : ''}`} style={{ minHeight: 40 }} onClick={() => setRes(res.map((x, j) => (j === i ? { ...x, result: k } : x)))}>{v}</button>)}
              <input placeholder="Ghi chú, bằng chứng" value={res[i]?.note ?? ''} onChange={(e) => setRes(res.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} /></div>
              : <div>{c.result ? <span className={`badge ${c.result === 'dat' ? 'green' : c.result === 'khong_dat' ? 'red' : ''}`}>{CHECK_RESULT[c.result]}</span> : <span className="muted">Chưa chấm</span>}{c.note && <div className="small muted">{c.note}</div>}</div>}
          </div>
        ))}
        {writable ? <>
          <div className="grid4"><label className="field">Ngày đánh giá<input type="date" value={performedOn} onChange={(e) => setPerformedOn(e.target.value)} /></label></div>
          <label className="field">Kết luận chung<textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
          <div className="row">
            <button className="primary" onClick={() => run(async () => { await api('POST', `/api/qms/audits/${id}/record`, { results: res.map((r) => ({ result: r.result, note: r.note || null })), performedOn, summary: summary || null }); await load(); }, 'Đã lưu kết quả')}>Lưu kết quả</button>
            <button onClick={() => run(async () => { await api('POST', `/api/qms/audits/${id}/record`, { results: res.map((r) => ({ result: r.result, note: r.note || null })), performedOn, summary: summary || null }); await api('POST', `/api/qms/audits/${id}/advance`, { to: 'da_bao_cao' }); await load(); }, 'Đã nộp báo cáo đánh giá')}>Nộp báo cáo</button>
          </div>
        </> : a.summary && <div><b>Kết luận:</b> {a.summary}</div>}
      </div>
      <div className="panel col">
        <b>Phát hiện</b>
        <table><tbody>{a.findings.map((f: any) => (
          <Fragment key={f.id}>
            <tr>
              <td className="mono">{f.code}</td>
              <td><span className={`badge ${f.kind.startsWith('nc') ? 'red' : f.kind === 'diem_manh' ? 'green' : 'amber'}`}>{meta.findingKinds[f.kind]}</span></td>
              <td>{f.description}{f.reference && <div className="small muted">Căn cứ: {f.reference}</div>}{f.evidence && <div className="small muted">Bằng chứng: {f.evidence}</div>}
                {(f.capa ?? []).map((c: any) => <div key={c.id} className="small">→ {c.description} · {c.owner} · hạn {d(c.due_date)} · <b>{meta.capaStatus[c.status]}</b></div>)}</td>
              <td className="right">{canEdit && f.kind.startsWith('nc') && a.status !== 'dong' && <button className={`${(f.capa ?? []).length ? 'ghost' : 'primary'} small`} onClick={() => setCapaFor(capaFor === f.id ? null : f.id)}>Giao khắc phục</button>}</td>
            </tr>
            {capaFor === f.id && <tr><td colSpan={4}><CapaForm staff={staff} run={run} link={{ findingId: f.id }} onDone={() => { setCapaFor(null); load(); }} /></td></tr>}
          </Fragment>))}</tbody></table>
        {!a.findings.length && <div className="small muted">Chưa có phát hiện.</div>}
        {inTeam && !['dong', 'huy'].includes(a.status) && (
          <div className="grid4">
            <label className="field">Loại<select value={fd.kind} onChange={(e) => setFd({ ...fd, kind: e.target.value })}>{Object.entries(meta.findingKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Căn cứ<input value={fd.reference} onChange={(e) => setFd({ ...fd, reference: e.target.value })} placeholder="QT-DP-02, ISO 9001 mục 8.5" /></label>
            <label className="field">Mô tả<input value={fd.description} onChange={(e) => setFd({ ...fd, description: e.target.value })} /></label>
            <label className="field">Bằng chứng<input value={fd.evidence} onChange={(e) => setFd({ ...fd, evidence: e.target.value })} /></label>
            <div><button disabled={fd.description.length < 5} onClick={() => run(async () => { await api('POST', `/api/qms/audits/${id}/findings`, { ...fd, reference: fd.reference || null, evidence: fd.evidence || null }); setFd({ ...fd, description: '', evidence: '', reference: '' }); await load(); }, 'Đã ghi phát hiện')}>Ghi phát hiện</button></div>
          </div>
        )}
      </div>
      {canEdit && a.status === 'da_bao_cao' && <div className="row"><button className="primary" onClick={() => run(async () => { await api('POST', `/api/qms/audits/${id}/advance`, { to: 'dong' }); await load(); }, 'Đã đóng cuộc đánh giá')}>Đóng cuộc đánh giá</button></div>}
    </div>
  );
}

/* ======================= Giám sát gọi lại ======================= */

function Callbacks({ meta, staff, run, canEdit }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  const [f, setF] = useState({ from: `${lastPeriod()}-01`, to: today(), pct: meta.samplePct });
  const [capaFor, setCapaFor] = useState<string | null>(null);
  const load = () => api<any[]>('GET', '/api/qms/callback-rounds').then(setRows);
  useEffect(() => { load().catch(() => {}); }, []);
  const show = (id: string) => run(async () => setOpen(await api('GET', `/api/qms/callback-rounds/${id}`)));
  const record = (c: any, status: 'da_goi' | 'khong_lien_lac') => {
    if (status === 'khong_lien_lac') return run(async () => { await api('PUT', `/api/qms/callbacks/${c.id}`, { status }); await show(open.id); }, 'Đã ghi không liên lạc được');
    const confirmed = confirm('Người nhà xác nhận có được Medone phục vụ ca này?');
    const att = prompt('Đánh giá thái độ kíp (1–5):', '5');
    const issues = prompt('Vấn đề người nhà nêu (để trống nếu không có):', '') ?? '';
    return run(async () => { await api('PUT', `/api/qms/callbacks/${c.id}`, { status, confirmed, attitude: att ? Number(att) : null, issues: issues || null }); await show(open.id); }, 'Đã ghi kết quả gọi');
  };
  return (
    <div className="col">
      {canEdit && (
        <div className="panel row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <label className="field">Từ ngày<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label className="field">Đến ngày<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
          <label className="field">Tỷ lệ rút (%)<input type="number" min={meta.samplePct} max={100} value={f.pct} onChange={(e) => setF({ ...f, pct: Number(e.target.value) })} style={{ width: 90 }} /></label>
          <button className="primary" onClick={() => run(async () => { const r = await api<any>('POST', '/api/qms/callback-rounds', f); await load(); await show(r.id); }, 'Đã rút mẫu')}>Rút mẫu ngẫu nhiên</button>
          <span className="small muted">QLCL-12: rút ngẫu nhiên tối thiểu {meta.samplePct}% ca đã đóng để gọi lại người nhà; hệ thống tự kiểm tra hồ sơ từng ca.</span>
        </div>
      )}
      <div className="panel">
        <table>
          <thead><tr><th>Đợt</th><th>Khoảng ngày</th><th className="right">Tổng ca</th><th className="right">Rút mẫu</th><th className="right">Đã gọi</th><th className="right">Có vấn đề</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td><a href="#" onClick={(e) => { e.preventDefault(); show(r.id); }}>{r.code}</a></td><td>{d(r.date_from)} – {d(r.date_to)}</td><td className="right">{r.population}</td><td className="right">{r.sample} ({r.sample_pct}%)</td><td className="right">{r.done}</td><td className={`right ${r.issues ? 'red' : ''}`}>{r.issues}</td></tr>)}</tbody>
        </table>
        {!rows.length && <div className="small muted">Chưa có đợt giám sát.</div>}
      </div>
      {open && (
        <div className="panel" style={{ overflowX: 'auto' }}>
          <b>{open.code}</b>
          <table>
            <thead><tr><th>Ca</th><th>Kiểm tra hồ sơ</th><th>Gọi lại</th><th /></tr></thead>
            <tbody>{open.rows.map((c: any) => (
              <Fragment key={c.id}>
                <tr>
                  <td className="mono">{c.incident_code}<div className="small muted">{d(c.incident_at)} · {c.final_priority} · {c.phone}</div></td>
                  <td className="small">{c.checks.flags?.length ? <ul style={{ margin: 0, paddingLeft: 16 }}>{c.checks.flags.map((x: string) => <li key={x} className="red">{x}</li>)}</ul> : <span className="badge green">Hồ sơ đủ</span>}
                    <div className="muted">Tới hiện trường {c.checks.responseMin ?? '—'} phút · tại hiện trường {c.checks.sceneMin ?? '—'} phút</div></td>
                  <td className="small">{c.status === 'cho_goi' ? <span className="badge">Chờ gọi</span> : c.status === 'khong_lien_lac' ? <span className="badge amber">Không liên lạc được</span>
                    : <>{c.confirmed === false ? <span className="badge red">Không xác nhận được phục vụ</span> : <span className="badge green">Xác nhận</span>} Thái độ {c.attitude ?? '—'}/5{c.issues && <div>{c.issues}</div>}<div className="muted">{c.called_by_name}</div></>}</td>
                  <td className="right" style={{ whiteSpace: 'nowrap' }}>{canEdit && c.status === 'cho_goi' && <><button className="primary small" onClick={() => record(c, 'da_goi')}>Đã gọi</button><button className="ghost small" onClick={() => record(c, 'khong_lien_lac')}>Không liên lạc</button></>}
                    {canEdit && (c.confirmed === false || (c.attitude ?? 5) <= 2 || c.checks.flags?.length > 0) && <button className="ghost small" onClick={() => setCapaFor(capaFor === c.id ? null : c.id)}>Giao khắc phục{c.capa ? ` (${c.capa})` : ''}</button>}</td>
                </tr>
                {capaFor === c.id && <tr><td colSpan={4}><CapaForm staff={staff} run={run} link={{ callbackId: c.id }} onDone={() => { setCapaFor(null); show(open.id); }} /></td></tr>}
              </Fragment>))}</tbody>
          </table>
          <div className="small muted">Chưa đối chiếu được lộ trình GPS vì hệ thống chưa lưu vết vị trí xe theo thời gian; hiện kiểm tra theo các mốc thời gian của ca.</div>
        </div>
      )}
    </div>
  );
}

/* ======================= Nhà cung cấp ======================= */

function Suppliers({ meta, run, canEdit }: Ctx) {
  const isBoard = BOARD.includes(session.user?.role ?? '');
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState<any>(null);
  const [ev, setEv] = useState<{ id: string; period: string; scores: Record<string, number>; note: string } | null>(null);
  const [hist, setHist] = useState<{ id: string; rows: any[] } | null>(null);
  const load = () => api<any[]>('GET', '/api/qms/suppliers').then(setRows);
  useEffect(() => { load().catch(() => {}); }, []);
  const save = () => run(async () => {
    await api(f.id ? 'PUT' : 'POST', f.id ? `/api/qms/suppliers/${f.id}` : '/api/qms/suppliers', { name: f.name, category: f.category, contact: f.contact || null, contractUntil: f.contractUntil || null, note: f.note || null, ...(f.status ? { status: f.status } : {}) });
    setF(null); await load();
  }, 'Đã lưu');
  const total = ev ? meta.supplierCriteria.reduce((s, [k]) => s + (ev.scores[k] ?? 0), 0) : 0;
  const pct = Math.round((total / (meta.supplierCriteria.length * 5)) * 1000) / 10;
  return (
    <div className="col">
      <div className="panel row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {canEdit && <button onClick={() => setF({ name: '', category: 'thuoc_vat_tu', contact: '', contractUntil: '', note: '' })}>Thêm nhà cung cấp</button>}
        <span className="small muted">QLCL-17: đánh giá ít nhất mỗi năm, 5 tiêu chí 1–5 điểm. Từ 70% đạt, 50–69% theo dõi, dưới 50% không đạt. Ngừng hợp tác do Ban Giám đốc quyết định.</span>
      </div>
      {f && (
        <div className="panel col">
          <div className="grid4">
            <label className="field">Tên<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field">Nhóm<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(meta.supplierCategories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Liên hệ<input value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></label>
            <label className="field">Hợp đồng đến<input type="date" value={f.contractUntil} onChange={(e) => setF({ ...f, contractUntil: e.target.value })} /></label>
            {f.id && <label className="field">Trạng thái<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{Object.entries(SUPPLIER_STATUS).filter(([k]) => k !== 'ngung' || isBoard || f.status === 'ngung').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
          </div>
          <label className="field">Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <div className="row"><button className="primary" disabled={f.name.length < 2} onClick={save}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Hủy</button></div>
        </div>
      )}
      {ev && (
        <div className="panel col">
          <b>Đánh giá {rows.find((r) => r.id === ev.id)?.name}</b>
          <label className="field">Kỳ<input value={ev.period} onChange={(e) => setEv({ ...ev, period: e.target.value })} placeholder="2026 hoặc 2026-H2" style={{ width: 160 }} /></label>
          {meta.supplierCriteria.map(([k, label]) => (
            <div key={k} className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span>{label}</span>
              <div className="row" style={{ gap: 4 }}>{[1, 2, 3, 4, 5].map((n) => <button key={n} className={`choice ${ev.scores[k] === n ? 'sel' : ''}`} style={{ minWidth: 44, minHeight: 40 }} onClick={() => setEv({ ...ev, scores: { ...ev.scores, [k]: n } })}>{n}</button>)}</div>
            </div>
          ))}
          <div>Tổng {total}/{meta.supplierCriteria.length * 5} · {pct}% <span className={`badge ${RESULT_TONE[pct >= 70 ? 'dat' : pct >= 50 ? 'theo_doi' : 'khong_dat']}`}>{SUPPLIER_RESULT[pct >= 70 ? 'dat' : pct >= 50 ? 'theo_doi' : 'khong_dat']}</span></div>
          <label className="field">Nhận xét<input value={ev.note} onChange={(e) => setEv({ ...ev, note: e.target.value })} /></label>
          <div className="row"><button className="primary" disabled={Object.keys(ev.scores).length < meta.supplierCriteria.length} onClick={() => run(async () => { await api('POST', `/api/qms/suppliers/${ev.id}/evaluations`, { period: ev.period, scores: ev.scores, note: ev.note || null }); setEv(null); await load(); }, 'Đã lưu đánh giá')}>Lưu đánh giá</button><button className="ghost" onClick={() => setEv(null)}>Hủy</button></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Nhà cung cấp</th><th>Nhóm</th><th>Hợp đồng đến</th><th>Đánh giá gần nhất</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((s) => (
            <Fragment key={s.id}>
              <tr>
                <td>{s.name}{s.contact && <div className="small muted">{s.contact}</div>}</td><td className="small">{meta.supplierCategories[s.category]}</td>
                <td className={s.contract_expiring ? 'red small' : 'small'}>{d(s.contract_until)}</td>
                <td>{s.last_result ? <><span className={`badge ${RESULT_TONE[s.last_result]}`}>{SUPPLIER_RESULT[s.last_result]}</span> <span className="small muted">{s.last_pct}% · {s.last_period}</span></> : <span className="small muted">Chưa đánh giá</span>}</td>
                <td><span className={`badge ${s.status === 'duoc_duyet' ? 'green' : s.status === 'theo_doi' ? 'amber' : 'red'}`}>{SUPPLIER_STATUS[s.status]}</span></td>
                <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  {canEdit && s.status !== 'ngung' && <button className="primary small" onClick={() => setEv({ id: s.id, period: today().slice(0, 4), scores: {}, note: '' })}>Đánh giá</button>}
                  <button className="ghost small" onClick={() => run(async () => setHist(hist && hist.id === s.id ? null : { id: s.id, rows: await api('GET', `/api/qms/suppliers/${s.id}/evaluations`) }))}>Lịch sử</button>
                  {canEdit && <button className="ghost small" onClick={() => setF({ id: s.id, name: s.name, category: s.category, contact: s.contact ?? '', contractUntil: s.contract_until ?? '', note: s.note ?? '', status: s.status })}>Sửa</button>}
                </td>
              </tr>
              {hist && hist.id === s.id && <tr><td colSpan={6}><ul>{hist.rows.map((e: any) => <li key={e.id}>{e.period}: {e.pct}% {SUPPLIER_RESULT[e.result]} · {e.evaluated_by_name}{e.note ? ` · ${e.note}` : ''}</li>)}</ul></td></tr>}
            </Fragment>))}</tbody>
        </table>
        {!rows.length && <div className="small muted">Chưa có nhà cung cấp.</div>}
      </div>
    </div>
  );
}

/* ======================= Xem xét của lãnh đạo ======================= */

function Reviews({ meta, staff, run, canEdit }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState<any>(null);
  const load = () => api<any[]>('GET', '/api/qms/reviews').then(setRows);
  useEffect(() => { load().catch(() => {}); }, []);
  const board = staff.filter((s) => BOARD.includes(s.role));
  if (open) return <ReviewView id={open} meta={meta} staff={staff} run={run} canEdit={canEdit} onBack={() => { setOpen(null); load(); }} />;
  const q = () => { const t = new Date(Date.now() + 7 * 3600_000); const m = Math.floor(t.getUTCMonth() / 3) * 3; return `${t.getUTCFullYear()}-${String(m + 1).padStart(2, '0')}-01`; };
  return (
    <div className="col">
      <div className="panel row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {canEdit && <button onClick={() => setF({ from: q(), to: today(), meetingOn: today(), chairId: board[0]?.id ?? '', attendees: '' })}>Lập biên bản họp</button>}
        <span className="small muted">QLCL-18, ISO 9001 mục 9.3: họp hằng quý. Đầu vào (chỉ số, sự cố, khiếu nại, đánh giá nội bộ, khắc phục, rủi ro, nhà cung cấp, đào tạo) tự lấy từ dữ liệu; chủ trì ký chốt thì số liệu cố định.</span>
      </div>
      {f && (
        <div className="panel grid4">
          <label className="field">Kỳ từ<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label className="field">Đến<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
          <label className="field">Ngày họp<input type="date" value={f.meetingOn} onChange={(e) => setF({ ...f, meetingOn: e.target.value })} /></label>
          <label className="field">Chủ trì<StaffSelect staff={board} value={f.chairId} onChange={(v) => setF({ ...f, chairId: v })} /></label>
          <label className="field">Thành phần<input value={f.attendees} onChange={(e) => setF({ ...f, attendees: e.target.value })} /></label>
          <div className="row"><button className="primary" onClick={() => run(async () => { const r = await api<any>('POST', '/api/qms/reviews', { ...f, chairId: f.chairId || null, attendees: f.attendees || null }); setF(null); await load(); setOpen(r.id); }, 'Đã lập biên bản, số liệu đầu vào đã lấy')}>Lập</button><button className="ghost" onClick={() => setF(null)}>Hủy</button></div>
        </div>
      )}
      <div className="panel">
        <table>
          <thead><tr><th>Mã</th><th>Kỳ</th><th>Ngày họp</th><th>Chủ trì</th><th className="right">Việc giao (đang mở)</th><th>Trạng thái</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td><a href="#" onClick={(e) => { e.preventDefault(); setOpen(r.id); }}>{r.code}</a></td><td>{d(r.date_from)} – {d(r.date_to)}</td><td>{d(r.meeting_on)}</td><td>{r.chair_name}</td><td className="right">{r.actions} ({r.open_actions})</td>
            <td><span className={`badge ${r.status === 'da_chot' ? 'green' : ''}`}>{r.status === 'da_chot' ? 'Đã chốt' : 'Dự thảo'}</span></td></tr>)}</tbody>
        </table>
        {!rows.length && <div className="small muted">Chưa có biên bản.</div>}
      </div>
    </div>
  );
}

function ReviewView({ id, meta, staff, run, canEdit, onBack }: Ctx & { id: string; onBack: () => void }) {
  const [r, setR] = useState<any>(null);
  const [conclusions, setConclusions] = useState('');
  const [adding, setAdding] = useState(false);
  const load = async () => { const x = await api<any>('GET', `/api/qms/reviews/${id}`); setR(x); setConclusions(x.conclusions ?? ''); };
  useEffect(() => { load().catch(() => {}); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const me = session.user;
  const inp = r?.inputs;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const sevTotal = useMemo(() => (inp?.events ?? []).reduce((s: number, e: any) => s + e.n, 0), [inp]);
  if (!r) return null;
  const draft = r.status === 'du_thao';
  return (
    <div className="col">
      <div className="row no-print"><button className="ghost" onClick={onBack}>← Danh sách</button><button className="ghost" onClick={() => window.print()}>In biên bản</button>
        {draft && canEdit && <button onClick={() => run(async () => { await api('PATCH', `/api/qms/reviews/${id}`, { refresh: true }); await load(); }, 'Đã lấy lại số liệu mới nhất')}>Lấy lại số liệu</button>}</div>
      <div className="panel">
        <h3 style={{ margin: 0 }}>Biên bản xem xét của lãnh đạo {r.code}</h3>
        <div className="small muted">Kỳ {d(r.date_from)} – {d(r.date_to)} · họp ngày {d(r.meeting_on)} · chủ trì {r.chair_name ?? '—'}{r.attendees ? ` · thành phần: ${r.attendees}` : ''}</div>
        {r.status === 'da_chot' && <div className="alert green" style={{ marginTop: 6 }}>Đã ký chốt bởi {r.signed_by_name} lúc {new Date(r.signed_at).toLocaleString('vi-VN')}. Số liệu dưới đây cố định tại thời điểm chốt.</div>}
      </div>
      <div className="panel">
        <b>1. Chỉ số chất lượng</b>
        <table><thead><tr><th>Chỉ số</th><th>Chỉ tiêu</th><th className="right">Tháng gần nhất</th><th className="right">Số tháng không đạt</th></tr></thead>
          <tbody>{inp.indicators.map((i: any) => <tr key={i.code}><td>{i.code} {i.name}</td><td>{i.direction === 'cao_tot' ? '≥' : '≤'} {i.target}{i.unit === '%' ? '%' : ` ${i.unit}`}</td>
            <td className={i.status ? `cell-${i.status}` : 'right'}>{i.last ?? '—'}</td><td className={`right ${i.missed ? 'red' : ''}`}>{i.missed}</td></tr>)}</tbody></table>
      </div>
      <div className="grid4">
        <div className="panel"><b>2. Sự cố y khoa</b><div>{sevTotal} sự cố</div><div className="small">{inp.events.map((e: any) => `${e.severity}: ${e.n} (đóng ${e.closed})`).join(' · ') || 'Không có'}</div></div>
        <div className="panel"><b>3. Khiếu nại, hài lòng</b><div className="small">{inp.complaints.n} khiếu nại, đúng hạn {pct(inp.complaints.on_time, inp.complaints.n)}, còn mở {inp.complaints.open}</div>
          <div className="small">Hài lòng {pct(inp.surveys.satisfied, inp.surveys.answered)} trên {inp.surveys.answered} phiếu (điểm TB {inp.surveys.avg ?? '—'})</div></div>
        <div className="panel"><b>4. Khắc phục</b><div className="small">Đang làm {inp.capa.open} (quá hạn {inp.capa.overdue}) · chờ kiểm tra {inp.capa.awaiting_verify}</div><div className="small">Trong kỳ: hiệu quả {inp.capa.effective}, chưa hiệu quả {inp.capa.not_effective}</div></div>
        <div className="panel"><b>5. Đào tạo {inp.training.year}</b><div className="small">{inp.training.staff} nhân viên · được đào tạo {inp.training.trainedPct}% · có chứng nhận {inp.training.certifiedPct}% · kế hoạch đạt {inp.training.planPct}%</div></div>
      </div>
      <div className="panel">
        <b>6. Đánh giá nội bộ</b>
        <ul>{inp.audits.map((a: any) => <li key={a.code}>{a.code} {a.title} ({a.audited_unit}): {meta.auditStatus[a.status]}</li>)}</ul>
        <div className="small">Phát hiện: {inp.findings.map((f: any) => `${meta.findingKinds[f.kind]} ${f.n}`).join(' · ') || 'không có'}</div>
      </div>
      <div className="grid4">
        <div className="panel"><b>7. Rủi ro cao</b><ul>{inp.highRisks.map((x: any) => <li key={x.code}>{x.code} {x.hazard} ({x.score})</li>)}</ul>{!inp.highRisks.length && <div className="small muted">Không có</div>}</div>
        <div className="panel"><b>8. Nhà cung cấp chưa đạt</b><ul>{inp.suppliers.map((x: any) => <li key={x.name + x.period}>{x.name}: {x.pct}% ({SUPPLIER_RESULT[x.result]})</li>)}</ul>{!inp.suppliers.length && <div className="small muted">Không có</div>}</div>
        <div className="panel"><b>9. Giám sát gọi lại</b><div className="small">{inp.callbacks.n} ca rút mẫu, đã gọi {inp.callbacks.called}, có vấn đề {inp.callbacks.issues}</div></div>
      </div>
      <div className="panel col">
        <b>10. Kết luận và quyết định của lãnh đạo</b>
        {draft && canEdit ? <textarea rows={5} value={conclusions} onChange={(e) => setConclusions(e.target.value)} placeholder="Đánh giá sự phù hợp, hiệu lực của hệ thống chất lượng; nhu cầu nguồn lực; cơ hội cải tiến" /> : <div style={{ whiteSpace: 'pre-wrap' }}>{r.conclusions}</div>}
        {draft && canEdit && <div><button onClick={() => run(async () => { await api('PATCH', `/api/qms/reviews/${id}`, { conclusions }); await load(); }, 'Đã lưu kết luận')}>Lưu kết luận</button></div>}
      </div>
      <div className="panel col">
        <b>11. Việc giao</b>
        <table><tbody>{r.actions.map((c: any) => <tr key={c.id}><td>{c.kind === 'phong_ngua' ? 'Phòng ngừa' : 'Cải tiến'}: {c.description}</td><td>{c.owner_name}</td><td>{d(c.due_date)}</td><td>{meta.capaStatus[c.status]}</td></tr>)}</tbody></table>
        {canEdit && !adding && <div><button className="ghost" onClick={() => setAdding(true)}>Giao việc</button></div>}
        {adding && <CapaForm staff={staff} run={run} link={{ reviewId: id }} onDone={() => { setAdding(false); load(); }} />}
      </div>
      {draft && me && BOARD.includes(me.role) && <div className="row"><button className="primary" onClick={() => confirm('Ký chốt biên bản? Sau khi chốt không sửa được.') && run(async () => { await api('PATCH', `/api/qms/reviews/${id}`, { conclusions }).catch(() => {}); await api('POST', `/api/qms/reviews/${id}/sign`); await load(); }, 'Đã ký chốt biên bản')}>Ký chốt biên bản</button></div>}
    </div>
  );
}

/* ======================= Lưu trữ hồ sơ ======================= */

function Retention({ run, canEdit }: Ctx) {
  const role = session.user?.role ?? '';
  const isBoard = BOARD.includes(role);
  const canSet = ['qa', 'admin', 'director'].includes(role);
  const [data, setData] = useState<any>(null);
  const load = () => api('GET', '/api/qms/retention').then(setData);
  useEffect(() => { load().catch(() => {}); }, []);
  if (!data) return null;
  const edit = (r: any) => {
    const y = prompt(`Thời hạn lưu "${r.label}" (năm):`, String(r.years));
    if (!y) return;
    const basis = prompt('Căn cứ (văn bản pháp luật, quy định nội bộ):', r.basis ?? '');
    if (basis === null) return;
    run(async () => { await api('PUT', `/api/qms/retention/${r.key}`, { years: Number(y), basis: basis || null, confirmed: confirm('Đã đối chiếu căn cứ và xác nhận thời hạn này?') }); await load(); }, 'Đã cập nhật');
  };
  return (
    <div className="col">
      <div className="small muted">QLCL-02: thời hạn lưu từng loại hồ sơ. Phần mềm không tự xóa dữ liệu; hồ sơ quá hạn chỉ được hủy theo biên bản của Hội đồng do Ban Giám đốc chủ trì, sau khi QLCL xác nhận căn cứ.{canEdit ? '' : ''}</div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Loại hồ sơ</th><th className="right">Lưu (năm)</th><th>Căn cứ</th><th>Mốc</th><th className="right">Đã quá hạn lưu</th><th /></tr></thead>
          <tbody>{data.rows.map((r: any) => (
            <tr key={r.key}>
              <td>{r.label}</td><td className="right">{r.years}</td>
              <td className="small">{r.basis}<div>{r.confirmed ? <span className="badge green">Đã xác nhận</span> : <span className="badge amber">Chưa xác nhận</span>}{r.updated_by_name ? <span className="muted"> {r.updated_by_name}</span> : null}</div></td>
              <td className="small">trước {d(r.cutoff)}</td><td className="right">{r.expired}</td>
              <td className="right" style={{ whiteSpace: 'nowrap' }}>{canSet && <button className="ghost small" onClick={() => edit(r)}>Sửa</button>}
                {isBoard && r.confirmed && r.expired > 0 && <button className="ghost small" onClick={() => { const decision = prompt(`Ghi quyết định hủy ${r.expired} hồ sơ "${r.label}" (số quyết định, thành phần Hội đồng, cách hủy):`); if (decision && decision.length >= 10) run(async () => { await api('POST', '/api/qms/disposals', { recordKey: r.key, decision }); await load(); }, 'Đã ghi biên bản hủy'); }}>Ghi biên bản hủy</button>}</td>
            </tr>))}</tbody>
        </table>
      </div>
      {data.disposals.length > 0 && (
        <div className="panel"><b>Biên bản hủy hồ sơ</b>
          <ul>{data.disposals.map((x: any) => <li key={x.id}>{new Date(x.created_at).toLocaleDateString('vi-VN')}: {x.label}, {x.records} hồ sơ trước {d(x.before_date)} · {x.decision} · {x.approved_by_name}</li>)}</ul></div>
      )}
    </div>
  );
}
