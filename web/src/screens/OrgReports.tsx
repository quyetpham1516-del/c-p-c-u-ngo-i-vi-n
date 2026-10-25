import { useEffect, useState } from 'react';
import { api, fmtDateTime, useLive } from '../api';

const TABS = ['Báo cáo bộ phận', 'Sơ đồ tổ chức'] as const;
const STATUS: Record<string, { label: string; cls: string }> = {
  chua_lam: { label: 'Chưa làm', cls: '' }, nhap: { label: 'Nháp', cls: 'amber' }, da_nop: { label: 'Đã nộp', cls: 'amber' },
  da_duyet: { label: 'Đã duyệt', cls: 'green' }, tra_lai: { label: 'Trả lại', cls: 'red' },
};
const EVENT: Record<string, string> = { tao: 'Lập báo cáo', nop: 'Nộp', duyet: 'Duyệt', tra_lai: 'Trả lại' };
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const dmy = (s: string) => s.split('-').reverse().join('/');

type Meta = { domains: Record<string, string>; periods: Record<string, string>; metrics: Record<string, string> };
type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;

function Status({ s, overdue }: { s: string; overdue?: boolean }) {
  const st = STATUS[s] ?? { label: s, cls: '' };
  return <><span className={`badge ${st.cls}`}>{st.label}</span>{overdue && <span className="badge red" style={{ marginLeft: 4 }}>Quá hạn</span>}</>;
}

/** Trưởng nhóm từng bộ phận lập báo cáo kỳ, nộp lên cấp trên; cấp trên duyệt hoặc trả lại rồi tổng hợp lên Ban Giám đốc */
export function OrgReports() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Báo cáo bộ phận');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [me, setMe] = useState<any>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const run: Run = async (fn, ok) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  useEffect(() => {
    api<Meta>('GET', '/api/org/meta').then(setMeta).catch(() => {});
    api('GET', '/api/org/me').then(setMe).catch(() => {});
  }, []);
  if (!meta || !me) return <div className="muted">Đang tải…</div>;
  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Bộ phận và báo cáo</h2>
      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); setMsg(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {tab === 'Báo cáo bộ phận' && <Reports meta={meta} me={me} run={run} />}
      {tab === 'Sơ đồ tổ chức' && <OrgChart meta={meta} canManage={me.canManage} run={run} />}
    </div>
  );
}

function Reports({ meta, me, run }: { meta: Meta; me: any; run: Run }) {
  const [period, setPeriod] = useState('tuan');
  const [date, setDate] = useState(today());
  const [dash, setDash] = useState<any>(null);
  const [open, setOpen] = useState<any>(null);
  const load = () => api('GET', `/api/org/dashboard?period=${period}&date=${date}`).then(setDash).catch(() => {});
  useEffect(() => { load(); }, [period, date]);
  useLive((e) => { if (e.type === 'unit_report') { load(); if (open && e.id === open.id) api('GET', `/api/org/reports/${open.id}`).then(setOpen).catch(() => {}); } });

  if (!me.hasReports) {
    return <div className="panel muted">Bạn chưa là trưởng nhóm của bộ phận nào. Quản trị, Ban Giám đốc hoặc nhân sự chỉ định trưởng nhóm ở tab Sơ đồ tổ chức.</div>;
  }
  const openUnit = (u: any) => run(async () => {
    setOpen(u.report_id ? await api('GET', `/api/org/reports/${u.report_id}`) : await api('POST', '/api/org/reports', { unitId: u.id, period, date }));
    await load();
  });
  const depth = (u: any): number => { const p = dash?.units.find((x: any) => x.id === u.parent_id); return p ? 1 + depth(p) : 0; };
  return (
    <div className="col">
      <div className="panel row">
        <div className="tabs">{Object.entries(meta.periods).map(([k, v]) => <button key={k} className={period === k ? 'sel' : ''} onClick={() => { setPeriod(k); setOpen(null); }}>{v}</button>)}</div>
        <input type="date" value={date} max={today()} onChange={(e) => { setDate(e.target.value || today()); setOpen(null); }} />
        {dash && <span className="small muted">Kỳ {dmy(dash.start)}{dash.start !== dash.end && ` – ${dmy(dash.end)}`} · hạn nộp {dmy(dash.due)}</span>}
        <span className="grow" />
        {me.leadUnits.length > 0 && <span className="small">Bạn là trưởng nhóm: <b>{me.leadUnits.map((u: any) => u.name).join(', ')}</b></span>}
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Bộ phận</th><th>Trưởng nhóm</th><th>Trạng thái</th><th>Nộp lúc</th><th></th></tr></thead>
          <tbody>{dash?.units.map((u: any) => (
            <tr key={u.id} className={open?.unit_id === u.id ? 'sel' : undefined}>
              <td style={{ paddingLeft: 8 + depth(u) * 18 }}>{u.name}<div className="small muted">{u.code}</div></td>
              <td className="small">{u.leads ?? <span className="muted">Chưa chỉ định</span>}</td>
              <td><Status s={u.status} overdue={u.overdue} />{u.status === 'tra_lai' && u.review_note && <div className="small muted">{u.review_note}</div>}</td>
              <td className="small">{u.submitted_at ? fmtDateTime(u.submitted_at) : ''}</td>
              <td className="right">
                {u.report_id ? <button onClick={() => openUnit(u)}>{u.mine && ['nhap', 'tra_lai'].includes(u.status) ? 'Sửa' : 'Xem'}</button>
                  : u.mine ? <button className="primary" onClick={() => openUnit(u)}>Lập báo cáo</button> : null}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {open && <ReportView key={open.id} r={open} meta={meta} run={run} onChange={(r) => { setOpen(r); load(); }} />}
    </div>
  );
}

function Metrics({ m, labels }: { m: Record<string, any>; labels: Record<string, string> }) {
  const keys = Object.keys(m ?? {});
  if (!keys.length) return <div className="small muted">Không có số liệu.</div>;
  return (
    <div className="grid4">{keys.map((k) => (
      <div key={k} className="small">{labels[k] ?? k}<br /><b>{m[k] == null ? '—' : typeof m[k] === 'number' ? m[k].toLocaleString('vi-VN') : String(m[k])}</b></div>
    ))}</div>
  );
}

function ReportView({ r, meta, run, onChange }: { r: any; meta: Meta; run: Run; onChange: (r: any) => void }) {
  const [f, setF] = useState({ summary: r.summary ?? '', issues: r.issues ?? '', proposals: r.proposals ?? '', nextPlan: r.next_plan ?? '' });
  const [note, setNote] = useState('');
  const save = () => api('PUT', `/api/org/reports/${r.id}`, f);
  const field = (k: keyof typeof f, label: string, rows = 3) => (
    <label className="col small">{label}
      {r.canEdit ? <textarea rows={rows} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        : <div style={{ whiteSpace: 'pre-wrap' }}>{f[k] || <span className="muted">—</span>}</div>}
    </label>
  );
  return (
    <div className="panel col">
      <div className="row">
        <h3 style={{ margin: 0 }}>{r.unit_name} · {meta.periods[r.period]} {dmy(r.period_start)}{r.period_start !== r.period_end && ` – ${dmy(r.period_end)}`}</h3>
        <Status s={r.status} overdue={r.overdue} />
        <span className="grow" />
        <span className="small muted">Nộp lên: {r.parent_name ?? 'Cấp cao nhất'} · hạn {dmy(r.due)}</span>
      </div>
      {r.status === 'tra_lai' && <div className="alert red">Cấp trên trả lại: {r.review_note}</div>}

      <div className="row"><b>Số liệu từ phần mềm</b><span className="small muted">tự lấy khi lập và khi nộp</span><span className="grow" />
        {r.canEdit && <button className="ghost" onClick={() => run(async () => onChange(await api('POST', `/api/org/reports/${r.id}/refresh`)), 'Đã lấy lại số liệu và báo cáo cấp dưới.')}>Lấy lại số liệu</button>}
      </div>
      <Metrics m={r.metrics} labels={meta.metrics} />

      {r.children?.length > 0 && <>
        <b>Báo cáo các nhóm cấp dưới</b>
        <table className="small">
          <thead><tr><th>Nhóm</th><th>Trạng thái</th><th>Tóm tắt</th><th>Vướng mắc / đề xuất</th></tr></thead>
          <tbody>{r.children.map((c: any) => (
            <tr key={c.unit_id}><td>{c.name}</td><td><Status s={c.status} /></td>
              <td style={{ whiteSpace: 'pre-wrap' }}>{c.summary ?? <span className="muted">Chưa nộp</span>}</td>
              <td style={{ whiteSpace: 'pre-wrap' }}>{[c.issues, c.proposals].filter(Boolean).join('\n')}</td></tr>
          ))}</tbody>
        </table>
      </>}

      <div className="grid2">
        {field('summary', 'Tóm tắt tình hình (bắt buộc)', 4)}
        {field('issues', 'Vướng mắc, sự cố', 4)}
        {field('proposals', 'Đề xuất lên cấp trên')}
        {field('nextPlan', 'Kế hoạch kỳ tới')}
      </div>

      {r.canEdit && <div className="row">
        <button onClick={() => run(async () => onChange(await save()), 'Đã lưu nháp.')}>Lưu nháp</button>
        <button className="primary" onClick={() => run(async () => { await save(); onChange(await api('POST', `/api/org/reports/${r.id}/submit`)); },
          r.parent_id ? 'Đã nộp lên cấp trên.' : 'Đã hoàn tất báo cáo.')}>{r.parent_id ? 'Nộp lên cấp trên' : 'Hoàn tất'}</button>
      </div>}

      {r.canReview && <div className="row">
        <input className="grow" placeholder="Nhận xét (bắt buộc khi trả lại)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button onClick={() => run(async () => onChange(await api('POST', `/api/org/reports/${r.id}/review`, { decision: 'tra_lai', note })), 'Đã trả lại cho trưởng nhóm.')}>Trả lại</button>
        <button className="primary" onClick={() => run(async () => onChange(await api('POST', `/api/org/reports/${r.id}/review`, { decision: 'duyet', note: note || null })), 'Đã duyệt.')}>Duyệt</button>
      </div>}

      <div className="small muted">
        Lập: {r.created_by_name}{r.submitted_by_name && ` · Nộp: ${r.submitted_by_name}`}{r.reviewed_by_name && ` · Duyệt/trả lại: ${r.reviewed_by_name}`}
      </div>
      <details className="small"><summary>Lịch sử</summary>
        {r.events.map((e: any, k: number) => <div key={k}>{fmtDateTime(e.at)} · {EVENT[e.action] ?? e.action} · {e.actor_name}{e.note && `: ${e.note}`}</div>)}
      </details>
    </div>
  );
}

function OrgChart({ meta, canManage, run }: { meta: Meta; canManage: boolean; run: Run }) {
  const [units, setUnits] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [stations, setStations] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const load = () => api<any[]>('GET', '/api/org/units').then(setUnits).catch(() => {});
  useEffect(() => {
    load();
    if (canManage) {
      api<any[]>('GET', '/api/org/staff').then(setStaff).catch(() => {});
      api<any[]>('GET', '/api/stations').then(setStations).catch(() => {});
    }
  }, [canManage]);
  const kids = (id: number | null) => units.filter((u) => u.parent_id === id);
  const node = (u: any, d: number): React.ReactNode => (
    <div key={u.id}>
      <UnitCard u={u} d={d} meta={meta} canManage={canManage} staff={staff} run={run} reload={load} onEdit={() => setEdit({ ...u, parentId: u.parent_id, stationId: u.station_id })} />
      {kids(u.id).map((k) => node(k, d + 1))}
    </div>
  );
  return (
    <div className="col">
      {canManage && <div className="row">
        <button className="primary" onClick={() => setEdit({ code: '', name: '', parentId: units.find((u) => u.parent_id === null)?.id ?? null, domain: 'khac', stationId: null, sort: 0 })}>Thêm bộ phận, nhóm</button>
        <span className="small muted">Mỗi bộ phận có trưởng nhóm (có thể thêm phó nhóm cùng quyền). Trưởng nhóm lập báo cáo; trưởng bộ phận cấp trên và Ban Giám đốc duyệt.</span>
      </div>}
      {edit && <UnitForm v={edit} units={units} stations={stations} meta={meta} run={run} onDone={() => { setEdit(null); load(); }} />}
      {kids(null).map((u) => node(u, 0))}
    </div>
  );
}

function UnitCard({ u, d, meta, canManage, staff, run, reload, onEdit }: {
  u: any; d: number; meta: Meta; canManage: boolean; staff: any[]; run: Run; reload: () => void; onEdit: () => void;
}) {
  const [pick, setPick] = useState('');
  const set = (staffId: string, isLead: boolean, ok: string) => run(async () => { await api('PUT', `/api/org/units/${u.id}/members/${staffId}`, { isLead }); reload(); }, ok);
  const free = staff.filter((s) => !u.members.some((m: any) => m.staff_id === s.id));
  return (
    <div className="panel col" style={{ marginLeft: d * 24, opacity: u.active ? 1 : 0.55 }}>
      <div className="row">
        <b>{u.name}</b><span className="badge">{u.code}</span><span className="small muted">{meta.domains[u.domain]}{u.station_name && ` · ${u.station_name}`}</span>
        {!u.active && <span className="badge red">Ngừng</span>}
        <span className="grow" />
        {canManage && <button className="ghost" onClick={onEdit}>Sửa</button>}
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {u.members.map((m: any) => (
          <span key={m.staff_id} className={`badge ${m.is_lead ? 'green' : ''}`} title={m.title ?? ''}>
            {m.is_lead && 'Trưởng nhóm · '}{m.full_name}
            {canManage && <>
              <button className="ghost small" style={{ padding: '0 4px' }} title={m.is_lead ? 'Bỏ trưởng nhóm' : 'Đặt làm trưởng nhóm'}
                onClick={() => set(m.staff_id, !m.is_lead, m.is_lead ? `Đã bỏ trưởng nhóm: ${m.full_name}` : `Đã đặt ${m.full_name} làm trưởng nhóm ${u.name}`)}>{m.is_lead ? '↓' : '★'}</button>
              <button className="ghost small" style={{ padding: '0 4px' }} title="Rút khỏi bộ phận"
                onClick={() => run(async () => { await api('DELETE', `/api/org/units/${u.id}/members/${m.staff_id}`); reload(); }, `Đã rút ${m.full_name} khỏi ${u.name}`)}>×</button>
            </>}
          </span>
        ))}
        {!u.members.length && <span className="small muted">Chưa có thành viên</span>}
        {!u.members.some((m: any) => m.is_lead) && u.active && <span className="badge amber">Chưa có trưởng nhóm</span>}
      </div>
      {canManage && u.active && <div className="row">
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Thêm thành viên…</option>
          {free.map((s) => <option key={s.id} value={s.id}>{s.full_name} ({s.code}{s.title ? ` · ${s.title}` : ''})</option>)}
        </select>
        <button disabled={!pick} onClick={() => set(pick, false, 'Đã thêm thành viên.').then(() => setPick(''))}>Thêm</button>
        <button disabled={!pick} onClick={() => set(pick, true, 'Đã thêm trưởng nhóm.').then(() => setPick(''))}>Thêm làm trưởng nhóm</button>
      </div>}
    </div>
  );
}

function UnitForm({ v, units, stations, meta, run, onDone }: { v: any; units: any[]; stations: any[]; meta: Meta; run: Run; onDone: () => void }) {
  const [f, setF] = useState(v);
  const save = () => run(async () => {
    const body = { code: f.code, name: f.name, parentId: f.parentId ? Number(f.parentId) : null, domain: f.domain, stationId: f.stationId || null, sort: Number(f.sort) || 0 };
    if (v.id) await api('PATCH', `/api/org/units/${v.id}`, { ...body, active: f.active });
    else await api('POST', '/api/org/units', body);
    onDone();
  }, 'Đã lưu bộ phận.');
  return (
    <div className="panel col">
      <b>{v.id ? `Sửa ${v.name}` : 'Thêm bộ phận, nhóm'}</b>
      <div className="grid4">
        <label className="col small">Mã<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="VD: EOC-DP" /></label>
        <label className="col small">Tên<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="VD: Nhóm điều phối" /></label>
        <label className="col small">Thuộc
          <select value={f.parentId ?? ''} onChange={(e) => setF({ ...f, parentId: e.target.value || null })}>
            <option value="">(Cấp cao nhất)</option>
            {units.filter((u) => u.id !== v.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label className="col small">Loại số liệu báo cáo
          <select value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })}>
            {Object.entries(meta.domains).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="col small">Trạm (nếu có)
          <select value={f.stationId ?? ''} onChange={(e) => setF({ ...f, stationId: e.target.value || null })}>
            <option value="">Toàn trung tâm</option>
            {stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="col small">Thứ tự<input type="number" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} /></label>
        {v.id && <label className="row small"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Đang hoạt động</label>}
      </div>
      <div className="row"><button className="primary" onClick={save}>Lưu</button><button className="ghost" onClick={onDone}>Hủy</button></div>
    </div>
  );
}
