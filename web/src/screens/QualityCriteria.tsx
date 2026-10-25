import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, download, session } from '../api';
import { Stat } from './Hr';

interface Meta { facilityKinds: Record<string, string>; assessmentKinds: Record<string, string>; methods: string[] }
interface QcSet { id: string; code: string; name: string; version: string; facility_kind: string; source: string | null; status: string; criteria: number; in_use: boolean; created_by: string | null }
interface Item { id: string; level: number; ordinal: number; text: string }
interface Criterion {
  id: string; part: string; part_name: string; chapter: string; chapter_name: string; code: string; title: string;
  legal_basis: string | null; owner_unit: string | null; weight: number; items: Item[];
}
interface SetDetail extends Omit<QcSet, 'criteria'> { criteria: Criterion[]; approved_by_name: string | null; approved_at: string | null }
interface Assessment {
  id: string; name: string; kind: string; period_from: string; period_to: string; status: string; set_id: string; set_code: string; set_name: string; set_version: string;
  total: number; done: number; mine: number; mine_todo: number; average: number | null;
}
interface Row {
  criterion_id: string; part: string; part_name: string; chapter: string; chapter_name: string; code: string; title: string; owner_unit: string | null; weight: number;
  assessor_id: string | null; assessor_name: string | null; applicable: boolean; computed_level: number | null; final_level: number | null; scored_at: string | null; scored_by_name: string | null;
}
type Staff = { id: string; full_name: string; title: string | null; role: string };
type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
type Results = Record<string, boolean | null>;

const SET_STATUS: Record<string, string> = { du_thao: 'Dự thảo', hieu_luc: 'Đang hiệu lực', het_hieu_luc: 'Hết hiệu lực' };
const A_STATUS: Record<string, string> = { dang_cham: 'Đang chấm', da_chot: 'Đã chốt' };
const d = (s: string | null | undefined) => (s ? new Date(s.length === 10 ? `${s}T00:00:00` : s).toLocaleDateString('vi-VN') : '—');
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/** Cùng quy tắc với máy chủ (QĐ 6858): có tiểu mục mức 1 xảy ra → mức 1; còn lại là mức cao nhất mà mọi tiểu mục từ mức 2 tới đó đều đạt */
export function computeLevel(items: Item[], results: Results): number | null {
  const at = (l: number) => items.filter((i) => i.level === l);
  if (at(1).some((i) => results[i.id] === true)) return 1;
  if (at(1).some((i) => !(i.id in results))) return null;
  let level = 1;
  for (let l = 2; l <= 5; l++) {
    if (at(l).filter((i) => results[i.id] !== null).every((i) => results[i.id] === true)) level = l;
    else break;
  }
  return level;
}

/** Tab "Tiêu chí chất lượng" trong trang Chất lượng: bộ tiêu chí sửa được, đợt đánh giá, phiếu chấm, báo cáo */
export function QualityCriteria({ staff, run }: { staff: Staff[]; run: Run }) {
  const role = session.user?.role ?? '';
  const canManage = ['qa', 'supervisor', 'admin', 'director'].includes(role);
  const canApprove = ['director', 'admin'].includes(role);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [view, setView] = useState<'dot' | 'bo'>('dot');
  useEffect(() => { api<Meta>('GET', '/api/qc/meta').then(setMeta).catch(() => {}); }, []);
  if (!meta) return null;
  return (
    <div className="col">
      <div className="row no-print" style={{ gap: 6 }}>
        <button className={`choice ${view === 'dot' ? 'sel' : ''}`} onClick={() => setView('dot')}>Đợt đánh giá</button>
        <button className={`choice ${view === 'bo' ? 'sel' : ''}`} onClick={() => setView('bo')}>Bộ tiêu chí</button>
        <span className="small muted">Khung chấm theo Quyết định 6858/QĐ-BYT: 5 mức, mỗi mức gồm các tiểu mục.</span>
      </div>
      {view === 'dot' && <Assessments meta={meta} staff={staff} run={run} canManage={canManage} canApprove={canApprove} />}
      {view === 'bo' && <Sets meta={meta} run={run} canManage={canManage} canApprove={canApprove} />}
    </div>
  );
}

/* ======================= Bộ tiêu chí ======================= */

function Sets({ meta, run, canManage, canApprove }: { meta: Meta; run: Run; canManage: boolean; canApprove: boolean }) {
  const [sets, setSets] = useState<QcSet[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<null | 'moi' | 'excel'>(null);
  const [f, setF] = useState({ code: '', name: '', version: '', facilityKind: 'ccnv', source: '' });
  const [file, setFile] = useState<File | null>(null);
  const load = () => api<QcSet[]>('GET', '/api/qc/sets').then(setSets);
  useEffect(() => { load().catch(() => {}); }, []);
  if (open) return <SetView id={open} meta={meta} run={run} canManage={canManage} canApprove={canApprove} onBack={() => { setOpen(null); load().catch(() => {}); }} />;

  const clone = (s: QcSet) => {
    const version = window.prompt(`Phiên bản mới cho bộ "${s.name}" (ví dụ 2026-MD):`, '');
    if (!version) return;
    run(async () => { const r = await api<{ id: string }>('POST', `/api/qc/sets/${s.id}/clone`, { version }); await load(); setOpen(r.id); }, 'Đã tạo bản dự thảo để sửa');
  };
  const create = () => run(async () => {
    const body = { code: f.code, name: f.name, version: f.version, facilityKind: f.facilityKind, source: f.source || null };
    let r: { id: string };
    if (form === 'excel') {
      if (!file) throw new Error('Chọn tệp Excel');
      const fileBase64 = await new Promise<string>((ok, bad) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result)); rd.onerror = bad; rd.readAsDataURL(file); });
      r = await api('POST', '/api/qc/sets/import', { ...body, fileBase64 });
    } else r = await api('POST', '/api/qc/sets', body);
    setForm(null); setFile(null); await load(); setOpen(r.id);
  }, form === 'excel' ? 'Đã nạp Excel thành bản dự thảo' : 'Đã tạo bộ tiêu chí');

  return (
    <div className="col">
      <div className="panel">
        <div className="small muted" style={{ marginBottom: 8 }}>
          Bộ đang hiệu lực không sửa trực tiếp: bấm <b>Nhân bản để sửa</b> (hoặc tải Excel, sửa, rồi <b>Nạp từ Excel</b>), sửa bản dự thảo, rồi giám đốc ban hành.
          Đợt đánh giá cũ vẫn giữ bộ tiêu chí cũ.
        </div>
        <table>
          <thead><tr><th>Mã</th><th>Tên bộ tiêu chí</th><th>Loại cơ sở</th><th>Phiên bản</th><th className="right">Tiêu chí</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{sets.map((s) => (
            <tr key={s.id}>
              <td className="mono">{s.code}</td><td><a href="#" onClick={(e) => { e.preventDefault(); setOpen(s.id); }}>{s.name}</a></td>
              <td>{meta.facilityKinds[s.facility_kind]}</td><td>{s.version}</td><td className="right">{s.criteria}</td>
              <td><span className="badge">{SET_STATUS[s.status]}</span></td>
              <td className="right" style={{ whiteSpace: 'nowrap' }}>
                <button className="ghost small" onClick={() => run(() => download(`/api/qc/sets/${s.id}/xlsx`, `${s.code}-${s.version}.xlsx`))}>Tải Excel</button>
                {canManage && <button className="ghost small" onClick={() => clone(s)}>Nhân bản để sửa</button>}
                {canApprove && s.status === 'du_thao' && <button className="ghost small" onClick={() => run(async () => { await api('POST', `/api/qc/sets/${s.id}/approve`); await load(); }, 'Đã ban hành')}>Ban hành</button>}
                {canManage && s.status === 'du_thao' && !s.in_use && <button className="ghost small" onClick={() => window.confirm('Xóa bản dự thảo này?') && run(async () => { await api('DELETE', `/api/qc/sets/${s.id}`); await load(); }, 'Đã xóa')}>Xóa</button>}
              </td>
            </tr>))}</tbody>
        </table>
        {canManage && !form && <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => setForm('excel')}>Nạp từ Excel</button>
          <button onClick={() => setForm('moi')}>Tạo bộ mới trống (ví dụ phòng khám)</button>
        </div>}
      </div>
      {form && (
        <div className="panel col">
          <b>{form === 'excel' ? 'Nạp bộ tiêu chí từ Excel' : 'Tạo bộ tiêu chí mới'}</b>
          {form === 'excel' && <div className="small muted">Tệp Excel theo mẫu "Tải Excel": mỗi dòng một tiểu mục, các cột Phần, Tên phần, Chương, Tên chương, Mã tiêu chí, Tên tiêu chí, Căn cứ pháp lý, Khoa/phòng phụ trách, Hệ số, Mức, Nội dung tiểu mục. Trùng mã bộ thì đặt phiên bản mới.</div>}
          <div className="grid4">
            <label className="field">Mã bộ<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="TC-PK" /></label>
            <label className="field">Phiên bản<input value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} placeholder="1.0" /></label>
            <label className="field">Loại cơ sở<select value={f.facilityKind} onChange={(e) => setF({ ...f, facilityKind: e.target.value })}>{Object.entries(meta.facilityKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            {form === 'excel' && <label className="field">Tệp Excel (.xlsx)<input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>}
          </div>
          <label className="field">Tên bộ tiêu chí<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field">Căn cứ ban hành<input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></label>
          <div className="row"><button className="primary" onClick={create}>Lưu</button><button className="ghost" onClick={() => setForm(null)}>Hủy</button></div>
        </div>
      )}
    </div>
  );
}

const emptyCriterion = (last?: Criterion): Criterion => ({
  id: '', part: last?.part ?? 'A', part_name: last?.part_name ?? '', chapter: last?.chapter ?? 'A1', chapter_name: last?.chapter_name ?? '',
  code: '', title: '', legal_basis: null, owner_unit: null, weight: 1, items: [],
});

function SetView({ id, meta, run, canManage, canApprove, onBack }: { id: string; meta: Meta; run: Run; canManage: boolean; canApprove: boolean; onBack: () => void }) {
  const [s, setS] = useState<SetDetail | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [edit, setEdit] = useState<Criterion | null>(null);
  const load = () => api<SetDetail>('GET', `/api/qc/sets/${id}`).then(setS);
  useEffect(() => { load().catch(() => {}); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const editable = canManage && s.status === 'du_thao';
  const chapters = groupBy(s.criteria, (c) => `${c.chapter}`);
  return (
    <div className="col">
      <div className="row no-print"><button className="ghost" onClick={onBack}>← Danh sách bộ tiêu chí</button>
        <button className="ghost" onClick={() => run(() => download(`/api/qc/sets/${id}/xlsx`, `${s.code}-${s.version}.xlsx`))}>Tải Excel</button>
        <button className="ghost" onClick={() => setExpanded(Object.fromEntries(s.criteria.map((c) => [c.id, true])))}>Mở hết</button>
        <button className="ghost" onClick={() => window.print()}>In</button>
        {canApprove && s.status === 'du_thao' && <button className="primary" onClick={() => run(async () => { await api('POST', `/api/qc/sets/${id}/approve`); await load(); }, 'Đã ban hành')}>Ban hành</button>}
      </div>
      <div className="panel">
        <h3 style={{ margin: 0 }}>{s.name}</h3>
        <div className="small muted">Mã {s.code} · phiên bản {s.version} · {meta.facilityKinds[s.facility_kind]} · {SET_STATUS[s.status]}{s.approved_at ? ` · ban hành ${d(s.approved_at)}${s.approved_by_name ? ` bởi ${s.approved_by_name}` : ''}` : ''} · {s.criteria.length} tiêu chí</div>
        {s.source && <div className="small" style={{ marginTop: 4 }}>{s.source}</div>}
        {!editable && canManage && <div className="small muted" style={{ marginTop: 4 }}>Muốn sửa: quay lại danh sách, bấm "Nhân bản để sửa".</div>}
      </div>
      {edit && <CriterionForm setId={id} c={edit} run={run} onDone={(changed) => { setEdit(null); if (changed) load().catch(() => {}); }} />}
      {chapters.map(([ch, list]) => (
        <div key={ch} className="panel">
          <div className="small muted">Phần {list[0].part}. {list[0].part_name}</div>
          <b>Chương {ch}. {list[0].chapter_name}</b>
          <table style={{ marginTop: 6 }}>
            <tbody>{list.map((c) => (
              <Fragment key={c.id}>
                <tr>
                  <td className="mono" style={{ width: 60 }}>{c.code}</td>
                  <td><a href="#" onClick={(e) => { e.preventDefault(); setExpanded({ ...expanded, [c.id]: !expanded[c.id] }); }}>{c.title}</a></td>
                  <td className="small muted" style={{ width: 120 }}>{c.owner_unit ?? ''}</td>
                  <td className="small" style={{ width: 70 }}>{c.weight !== 1 ? `hệ số ${c.weight}` : ''}</td>
                  <td className="small muted right" style={{ width: 80 }}>{c.items.length} tiểu mục</td>
                  {editable && <td className="right no-print" style={{ width: 110 }}>
                    <button className="ghost small" onClick={() => setEdit(c)}>Sửa</button>
                    <button className="ghost small" onClick={() => window.confirm(`Xóa tiêu chí ${c.code}?`) && run(async () => { await api('DELETE', `/api/qc/sets/${id}/criteria/${c.id}`); await load(); }, 'Đã xóa tiêu chí')}>Xóa</button>
                  </td>}
                </tr>
                {expanded[c.id] && <tr><td /><td colSpan={editable ? 5 : 4}><Levels c={c} /></td></tr>}
              </Fragment>))}</tbody>
          </table>
        </div>
      ))}
      {editable && !edit && <button className="no-print" onClick={() => setEdit(emptyCriterion(s.criteria[s.criteria.length - 1]))}>+ Thêm tiêu chí</button>}
    </div>
  );
}

function Levels({ c }: { c: Criterion }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      {c.legal_basis && <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}><b>Căn cứ:</b> {c.legal_basis}</div>}
      {[1, 2, 3, 4, 5].map((l) => (
        <div key={l} className="small"><b>Mức {l}{l === 1 ? ' (có vấn đề)' : ''}:</b>
          {c.items.filter((i) => i.level === l).map((i) => <div key={i.id} style={{ paddingLeft: 12 }}>{i.ordinal}. {i.text}</div>)}
          {!c.items.some((i) => i.level === l) && <span className="muted"> không có tiểu mục</span>}
        </div>
      ))}
    </div>
  );
}

function CriterionForm({ setId, c, run, onDone }: { setId: string; c: Criterion; run: Run; onDone: (changed: boolean) => void }) {
  const [f, setF] = useState({
    part: c.part, partName: c.part_name, chapter: c.chapter, chapterName: c.chapter_name, code: c.code, title: c.title,
    legalBasis: c.legal_basis ?? '', ownerUnit: c.owner_unit ?? '', weight: String(c.weight),
    levels: [1, 2, 3, 4, 5].map((l) => c.items.filter((i) => i.level === l).map((i) => i.text).join('\n')),
  });
  const save = () => run(async () => {
    const body = { ...f, legalBasis: f.legalBasis || null, ownerUnit: f.ownerUnit || null, weight: Number(f.weight.replace(',', '.')) || 1,
      levels: f.levels.map((t) => t.split('\n').map((x) => x.trim()).filter(Boolean)) };
    if (c.id) await api('PUT', `/api/qc/sets/${setId}/criteria/${c.id}`, body);
    else await api('POST', `/api/qc/sets/${setId}/criteria`, body);
    onDone(true);
  }, 'Đã lưu tiêu chí');
  return (
    <div className="panel col no-print" style={{ borderColor: 'var(--brand)' }}>
      <b>{c.id ? `Sửa tiêu chí ${c.code}` : 'Thêm tiêu chí'}</b>
      <div className="grid4">
        <label className="field">Phần<input value={f.part} onChange={(e) => setF({ ...f, part: e.target.value })} /></label>
        <label className="field">Tên phần<input value={f.partName} onChange={(e) => setF({ ...f, partName: e.target.value })} /></label>
        <label className="field">Chương<input value={f.chapter} onChange={(e) => setF({ ...f, chapter: e.target.value })} /></label>
        <label className="field">Tên chương<input value={f.chapterName} onChange={(e) => setF({ ...f, chapterName: e.target.value })} /></label>
        <label className="field">Mã tiêu chí<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="A1.1" /></label>
        <label className="field">Khoa/phòng phụ trách<input value={f.ownerUnit} onChange={(e) => setF({ ...f, ownerUnit: e.target.value })} /></label>
        <label className="field">Hệ số<input value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} /></label>
      </div>
      <label className="field">Tên tiêu chí<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field">Căn cứ pháp lý<textarea rows={2} value={f.legalBasis} onChange={(e) => setF({ ...f, legalBasis: e.target.value })} /></label>
      <div className="small muted">Mỗi dòng là một tiểu mục. Số thứ tự tiểu mục tự đánh lại liên tục từ mức 1 đến mức 5 khi lưu.</div>
      {f.levels.map((t, k) => (
        <label key={k} className="field">Mức {k + 1}{k === 0 ? ' — các tiểu mục "có vấn đề" (xảy ra một mục là tiêu chí ở mức 1)' : ' — các tiểu mục cần đạt'}
          <textarea rows={Math.max(2, t.split('\n').length + 1)} value={t} onChange={(e) => setF({ ...f, levels: f.levels.map((x, j) => (j === k ? e.target.value : x)) })} />
        </label>
      ))}
      <div className="row"><button className="primary" onClick={save}>Lưu tiêu chí</button><button className="ghost" onClick={() => onDone(false)}>Hủy</button></div>
    </div>
  );
}

function groupBy<T>(list: T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of list) { const k = key(x); m.set(k, [...(m.get(k) ?? []), x]); }
  return [...m.entries()];
}

/* ======================= Đợt đánh giá ======================= */

function Assessments({ meta, staff, run, canManage, canApprove }: { meta: Meta; staff: Staff[]; run: Run; canManage: boolean; canApprove: boolean }) {
  const [list, setList] = useState<Assessment[]>([]);
  const [sets, setSets] = useState<QcSet[]>([]);
  const [open, setOpen] = useState<{ id: string; report?: boolean } | null>(null);
  const [form, setForm] = useState(false);
  const [f, setF] = useState({ setId: '', name: '', kind: 'tu_danh_gia', periodFrom: `${today().slice(0, 4)}-01-01`, periodTo: today(), note: '' });
  const load = () => api<Assessment[]>('GET', '/api/qc/assessments').then(setList);
  useEffect(() => {
    load().catch(() => {});
    api<QcSet[]>('GET', '/api/qc/sets').then((s) => { setSets(s); const eff = s.find((x) => x.status === 'hieu_luc'); if (eff) setF((v) => ({ ...v, setId: v.setId || eff.id })); }).catch(() => {});
  }, []);
  if (open?.report) return <Report id={open.id} meta={meta} onBack={() => setOpen({ id: open.id })} />;
  if (open) return <AssessmentView id={open.id} meta={meta} staff={staff} run={run} canManage={canManage} canApprove={canApprove} onBack={() => { setOpen(null); load().catch(() => {}); }} onReport={() => setOpen({ id: open.id, report: true })} />;
  const create = () => run(async () => {
    const r = await api<{ id: string }>('POST', '/api/qc/assessments', { ...f, note: f.note || null });
    setForm(false); await load(); setOpen({ id: r.id });
  }, 'Đã tạo đợt đánh giá. Phân công người chấm cho từng tiêu chí.');
  return (
    <div className="col">
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Đợt đánh giá</th><th>Hình thức</th><th>Kỳ</th><th>Bộ tiêu chí</th><th className="right">Đã chấm</th><th className="right">Điểm TB</th><th>Của tôi</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{list.map((a) => (
            <tr key={a.id}>
              <td><a href="#" onClick={(e) => { e.preventDefault(); setOpen({ id: a.id }); }}>{a.name}</a></td>
              <td className="small">{meta.assessmentKinds[a.kind]}</td><td className="small">{d(a.period_from)} – {d(a.period_to)}</td>
              <td className="small">{a.set_code} ({a.set_version})</td>
              <td className="right mono">{a.done}/{a.total}</td><td className="right mono">{a.average?.toFixed(2) ?? '—'}</td>
              <td>{a.mine ? (a.mine_todo ? <span className="badge far">{a.mine_todo} chưa chấm</span> : <span className="badge">Xong {a.mine}</span>) : ''}</td>
              <td><span className="badge">{A_STATUS[a.status]}</span></td>
              <td className="right"><button className="ghost small" onClick={() => setOpen({ id: a.id, report: true })}>Báo cáo</button></td>
            </tr>))}
            {!list.length && <tr><td colSpan={9} className="muted small">Chưa có đợt đánh giá nào.</td></tr>}</tbody>
        </table>
        {canManage && !form && <button style={{ marginTop: 8 }} onClick={() => setForm(true)}>+ Tạo đợt đánh giá</button>}
      </div>
      {form && (
        <div className="panel col">
          <b>Tạo đợt đánh giá</b>
          <div className="grid4">
            <label className="field">Bộ tiêu chí<select value={f.setId} onChange={(e) => setF({ ...f, setId: e.target.value })}>
              {sets.filter((s) => s.status === 'hieu_luc').map((s) => <option key={s.id} value={s.id}>{s.code} ({s.version}) – {s.criteria} tiêu chí</option>)}</select></label>
            <label className="field">Hình thức<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(meta.assessmentKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Từ ngày<input type="date" value={f.periodFrom} onChange={(e) => setF({ ...f, periodFrom: e.target.value })} /></label>
            <label className="field">Đến ngày<input type="date" value={f.periodTo} onChange={(e) => setF({ ...f, periodTo: e.target.value })} /></label>
          </div>
          <label className="field">Tên đợt<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Tự đánh giá chất lượng 6 tháng đầu năm 2027" /></label>
          <label className="field">Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <div className="row"><button className="primary" onClick={create}>Tạo</button><button className="ghost" onClick={() => setForm(false)}>Hủy</button></div>
        </div>
      )}
    </div>
  );
}

function AssessmentView({ id, meta, staff, run, canManage, canApprove, onBack, onReport }: {
  id: string; meta: Meta; staff: Staff[]; run: Run; canManage: boolean; canApprove: boolean; onBack: () => void; onReport: () => void;
}) {
  const me = session.user?.id;
  const [a, setA] = useState<(Assessment & { rows: Row[]; note: string | null }) | null>(null);
  const [mineOnly, setMineOnly] = useState(!canManage);
  const [scoring, setScoring] = useState<string | null>(null);
  const [bulk, setBulk] = useState({ unit: '', assessorId: '' });
  const load = () => api('GET', `/api/qc/assessments/${id}`).then(setA);
  useEffect(() => { load().catch(() => {}); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const units = useMemo(() => [...new Set((a?.rows ?? []).map((r) => r.owner_unit).filter(Boolean) as string[])], [a]);
  if (!a) return null;
  const open = a.status === 'dang_cham';
  const rows = a.rows.filter((r) => !mineOnly || r.assessor_id === me);
  if (scoring) {
    const k = rows.findIndex((r) => r.criterion_id === scoring);
    return <ScoreForm key={scoring} aid={id} cid={scoring} meta={meta} run={run} kind={a.kind}
      onBack={() => { setScoring(null); load().catch(() => {}); }}
      onNext={k >= 0 && k < rows.length - 1 ? () => setScoring(rows[k + 1].criterion_id) : undefined} />;
  }
  const assign = (criterionId: string, assessorId: string) => run(async () => { await api('PUT', `/api/qc/assessments/${id}/assign`, { rows: [{ criterionId, assessorId: assessorId || null }] }); await load(); });
  const assignBulk = () => run(async () => {
    const list = a.rows.filter((r) => (bulk.unit === '*' || r.owner_unit === bulk.unit));
    if (!list.length) throw new Error('Không có tiêu chí nào khớp');
    await api('PUT', `/api/qc/assessments/${id}/assign`, { rows: list.map((r) => ({ criterionId: r.criterion_id, assessorId: bulk.assessorId || null })) });
    await load();
  }, 'Đã phân công');
  const done = a.rows.filter((r) => !r.applicable || r.final_level != null).length;
  const unassigned = a.rows.filter((r) => !r.assessor_id).length;
  return (
    <div className="col">
      <div className="row no-print"><button className="ghost" onClick={onBack}>← Các đợt đánh giá</button>
        <button onClick={onReport}>Báo cáo tổng hợp</button>
        {canManage && open && <button className="primary" onClick={() => window.confirm('Chốt kết quả? Sau khi chốt không sửa được phiếu.') && run(async () => { await api('POST', `/api/qc/assessments/${id}/close`); await load(); }, 'Đã chốt kết quả')}>Chốt kết quả</button>}
        {canApprove && !open && <button onClick={() => { const reason = window.prompt('Lý do mở lại đợt đánh giá:'); if (reason) run(async () => { await api('POST', `/api/qc/assessments/${id}/reopen`, { reason }); await load(); }, 'Đã mở lại'); }}>Mở lại</button>}
      </div>
      <div className="panel">
        <h3 style={{ margin: 0 }}>{a.name}</h3>
        <div className="small muted">{meta.assessmentKinds[a.kind]} · {d(a.period_from)} – {d(a.period_to)} · bộ {a.set_code} ({a.set_version}) · {A_STATUS[a.status]}</div>
        <div className="row small" style={{ marginTop: 6, gap: 16 }}>
          <span>Đã chấm <b>{done}/{a.rows.length}</b></span>
          {canManage && <span className={unassigned ? 'error' : ''}>Chưa phân công <b>{unassigned}</b></span>}
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Chỉ tiêu chí tôi được giao chấm</label>
        </div>
      </div>
      {canManage && open && (
        <div className="panel row no-print" style={{ alignItems: 'flex-end' }}>
          <label className="field">Giao các tiêu chí của khoa/phòng<select value={bulk.unit} onChange={(e) => setBulk({ ...bulk, unit: e.target.value })}>
            <option value="">— Chọn —</option><option value="*">Tất cả tiêu chí</option>{units.map((u) => <option key={u} value={u}>{u}</option>)}</select></label>
          <label className="field">cho người chấm<select value={bulk.assessorId} onChange={(e) => setBulk({ ...bulk, assessorId: e.target.value })}>
            <option value="">— Bỏ phân công —</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}{s.title ? ` (${s.title})` : ''}</option>)}</select></label>
          <button disabled={!bulk.unit} onClick={assignBulk}>Phân công</button>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Mã</th><th>Tiêu chí</th><th>Phụ trách</th><th>Người chấm</th><th className="right">Mức</th><th /></tr></thead>
          <tbody>{rows.map((r, k) => (
            <Fragment key={r.criterion_id}>
              {(k === 0 || rows[k - 1].chapter !== r.chapter) && <tr><td colSpan={6} className="small muted" style={{ paddingTop: 10 }}><b>{r.chapter}. {r.chapter_name}</b></td></tr>}
              <tr>
                <td className="mono">{r.code}</td><td>{r.title}</td><td className="small muted">{r.owner_unit ?? ''}</td>
                <td className="small">{canManage && open
                  ? <select value={r.assessor_id ?? ''} onChange={(e) => assign(r.criterion_id, e.target.value)}><option value="">— Chưa giao —</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select>
                  : r.assessor_name ?? '—'}</td>
                <td className="right">{!r.applicable ? <span className="small muted">Không áp dụng</span> : r.final_level != null ? <b>{r.final_level}</b> : <span className="small muted">chưa chấm</span>}</td>
                <td className="right"><button className="ghost small" onClick={() => setScoring(r.criterion_id)}>{open && (canManage || r.assessor_id === me) ? 'Chấm' : 'Xem'}</button></td>
              </tr>
            </Fragment>))}
            {!rows.length && <tr><td colSpan={6} className="small muted">{mineOnly ? 'Bạn chưa được giao tiêu chí nào trong đợt này.' : 'Không có tiêu chí.'}</td></tr>}</tbody>
        </table>
      </div>
    </div>
  );
}

function ScoreForm({ aid, cid, meta, run, kind, onBack, onNext }: { aid: string; cid: string; meta: Meta; run: Run; kind: string; onBack: () => void; onNext?: () => void }) {
  const [s, setS] = useState<any>(null);
  const [results, setResults] = useState<Results>({});
  const [f, setF] = useState({ applicable: true, finalLevel: '', currentState: '', methods: [] as string[], explanation: '', doubts: '', evidence: '', improvement: '', reviewerNote: '' });
  useEffect(() => {
    api('GET', `/api/qc/assessments/${aid}/criteria/${cid}`).then((x) => {
      setS(x);
      const r: Results = { ...(x.results ?? {}) };
      // Mức 1 mặc định "không xảy ra" để người chấm chỉ đánh dấu khi có vấn đề
      for (const i of x.items as Item[]) if (i.level === 1 && !(i.id in r)) r[i.id] = false;
      setResults(r);
      setF({ applicable: x.applicable, finalLevel: x.final_level != null && x.final_level !== x.computed_level ? String(x.final_level) : '', currentState: x.current_state ?? '', methods: x.methods ?? [],
        explanation: x.explanation ?? '', doubts: x.doubts ?? '', evidence: x.evidence ?? '', improvement: x.improvement ?? '', reviewerNote: x.reviewer_note ?? '' });
    }).catch(() => {});
  }, [aid, cid]);
  if (!s) return null;
  const items: Item[] = s.items;
  const computed = computeLevel(items, results);
  const ro = !s.canEdit;
  const save = (next?: boolean) => run(async () => {
    await api('PUT', `/api/qc/assessments/${aid}/criteria/${cid}`, {
      applicable: f.applicable, results, finalLevel: f.finalLevel ? Number(f.finalLevel) : null, currentState: f.currentState || null, methods: f.methods,
      explanation: f.explanation || null, doubts: f.doubts || null, evidence: f.evidence || null, improvement: f.improvement || null, reviewerNote: f.reviewerNote || null,
    });
    if (next && onNext) onNext(); else onBack();
  }, 'Đã lưu phiếu chấm');
  const Pick = ({ i }: { i: Item }) => {
    const v = results[i.id];
    const opts: [boolean | null, string][] = i.level === 1 ? [[false, 'Không xảy ra'], [true, 'Có xảy ra']] : [[true, 'Đạt'], [false, 'Chưa đạt'], [null, 'Không áp dụng']];
    return <span className="row no-print" style={{ gap: 4, flexWrap: 'nowrap' }}>{opts.map(([val, label]) => (
      <button key={label} disabled={ro} className={`choice small ${v === val && (i.id in results) ? 'sel' : ''} ${val === true && i.level === 1 && v === true ? 'p1' : ''}`}
        onClick={() => setResults({ ...results, [i.id]: val })}>{label}</button>))}</span>;
  };
  const mark = (i: Item) => { const v = results[i.id]; if (!(i.id in results)) return '☐'; if (v === null) return 'KAD'; return i.level === 1 ? (v ? '☒' : '☐') : (v ? '☑' : '☐'); };
  return (
    <div className="col">
      <div className="row no-print"><button className="ghost" onClick={onBack}>← Danh sách tiêu chí</button><button className="ghost" onClick={() => window.print()}>In phiếu đánh giá</button></div>
      <div className="panel">
        <div className="small muted">PHIẾU ĐÁNH GIÁ TIÊU CHÍ CHẤT LƯỢNG · {s.assessment_name}</div>
        <h3 style={{ margin: '4px 0', textTransform: 'none', color: 'var(--text)', fontSize: 17 }}>{s.code}. {s.title}</h3>
        <div className="small muted">Chương {s.chapter}. {s.chapter_name}{s.owner_unit ? ` · phụ trách: ${s.owner_unit}` : ''}{s.weight !== 1 ? ` · hệ số ${s.weight}` : ''} · người chấm: {s.assessor_name ?? 'chưa phân công'}</div>
        {s.legal_basis && <div className="small muted" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}><b>Căn cứ:</b> {s.legal_basis}</div>}
        <label className="row no-print" style={{ gap: 6, marginTop: 8 }}><input type="checkbox" disabled={ro} checked={!f.applicable} onChange={(e) => setF({ ...f, applicable: !e.target.checked })} /> Tiêu chí không áp dụng cho đơn vị (ghi lý do ở phần giải trình)</label>
        {f.applicable && [1, 2, 3, 4, 5].map((l) => (
          <div key={l} style={{ marginTop: 10 }}>
            <b>Mức {l}</b>{l === 1 && <span className="small muted"> — nếu có tiểu mục xảy ra, tiêu chí xếp mức 1</span>}
            {items.filter((i) => i.level === l).map((i) => (
              <div key={i.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
                <span className="small"><span className="print-only">{mark(i)} </span>{i.ordinal}. {i.text}</span>
                <Pick i={i} />
              </div>))}
            {!items.some((i) => i.level === l) && <div className="small muted">Không có tiểu mục (coi như đạt)</div>}
          </div>
        ))}
        <div className="row" style={{ marginTop: 12, gap: 16, alignItems: 'flex-end' }}>
          <div>Mức tính theo tiểu mục: <b style={{ fontSize: 20 }}>{f.applicable ? (computed ?? '—') : 'Không áp dụng'}</b></div>
          {f.applicable && <label className="field">Xếp mức (nếu khác, phải giải trình)<select disabled={ro} value={f.finalLevel} onChange={(e) => setF({ ...f, finalLevel: e.target.value })}>
            <option value="">Theo tiểu mục ({computed ?? 'chưa đủ'})</option>{[1, 2, 3, 4, 5].map((l) => <option key={l} value={l}>Mức {l}</option>)}</select></label>}
        </div>
        <div className="col" style={{ marginTop: 10 }}>
          <label className="field">1. Mô tả thực trạng, điểm mạnh, điểm yếu (có thông tin, số liệu kèm theo)<textarea rows={3} disabled={ro} value={f.currentState} onChange={(e) => setF({ ...f, currentState: e.target.value })} /></label>
          <div className="field small">2. Phương pháp đánh giá
            <div className="row" style={{ gap: 4 }}>{meta.methods.map((m) => (
              <label key={m} className={`chk ${f.methods.includes(m) ? 'on' : ''}`}><input type="checkbox" disabled={ro} checked={f.methods.includes(m)} onChange={(e) => setF({ ...f, methods: e.target.checked ? [...f.methods, m] : f.methods.filter((x) => x !== m) })} />{m}</label>))}</div>
          </div>
          <label className="field">3. Giải trình tại sao xếp ở mức này<textarea rows={3} disabled={ro} value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} /></label>
          <label className="field">4. Những điểm còn phân vân, khó quyết định<textarea rows={2} disabled={ro} value={f.doubts} onChange={(e) => setF({ ...f, doubts: e.target.value })} /></label>
          <label className="field">Minh chứng (số văn bản, đường dẫn tài liệu)<textarea rows={2} disabled={ro} value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} /></label>
          <label className="field">Kế hoạch cải tiến<textarea rows={2} disabled={ro} value={f.improvement} onChange={(e) => setF({ ...f, improvement: e.target.value })} /></label>
          {kind !== 'tu_danh_gia' && <label className="field">Góp ý của đoàn kiểm tra<textarea rows={2} disabled={ro} value={f.reviewerNote} onChange={(e) => setF({ ...f, reviewerNote: e.target.value })} /></label>}
        </div>
        {s.scored_at && <div className="small muted" style={{ marginTop: 6 }}>Chấm lần cuối {new Date(s.scored_at).toLocaleString('vi-VN')}{s.scored_by_name ? ` bởi ${s.scored_by_name}` : ''}</div>}
        <div className="print-only"><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', marginTop: 24, textAlign: 'center' }}><div>Ngày chấm: ........................</div><div>Người đánh giá ký tên</div></div></div>
      </div>
      {!ro && <div className="row no-print"><button className="primary" onClick={() => save()}>Lưu</button>{onNext && <button onClick={() => save(true)}>Lưu và chấm tiêu chí tiếp</button>}</div>}
    </div>
  );
}

/* ======================= Báo cáo ======================= */

function Report({ id, meta, onBack }: { id: string; meta: Meta; onBack: () => void }) {
  const [r, setR] = useState<any>(null);
  useEffect(() => { api('GET', `/api/qc/assessments/${id}/summary`).then(setR).catch(() => {}); }, [id]);
  if (!r) return null;
  const a = r.assessment;
  const o = r.overall;
  const prev = r.previous;
  const maxN = Math.max(1, ...r.byLevel.map((l: any) => l.n));
  return (
    <div className="col">
      <div className="row no-print"><button className="ghost" onClick={onBack}>← Về đợt đánh giá</button>
        <button className="ghost" onClick={() => download(`/api/qc/assessments/${id}/summary?format=csv`, 'danh-gia-chat-luong.csv')}>Tải Excel (CSV)</button>
        <button className="ghost" onClick={() => window.print()}>In / lưu PDF</button></div>
      <div className="panel">
        <h3 style={{ margin: 0 }}>Báo cáo kết quả đánh giá chất lượng</h3>
        <div>{a.name}</div>
        <div className="small muted">{meta.assessmentKinds[a.kind]} · kỳ {d(a.period_from)} – {d(a.period_to)} · bộ {a.set_name} ({a.set_version}) · {A_STATUS[a.status]}{a.closed_at ? ` ngày ${d(a.closed_at)}` : ''}</div>
        {a.status !== 'da_chot' && <div className="alert amber" style={{ marginTop: 6 }}>Đợt đánh giá chưa chốt: số liệu có thể còn thay đổi.</div>}
      </div>
      <div className="grid4">
        <Stat label="Tiêu chí áp dụng" value={`${o.applicable}/${o.total} (${o.total ? Math.round((o.applicable / o.total) * 100) : 0}%)`} />
        <Stat label="Đã chấm" value={o.scored} />
        <Stat label="Tổng điểm" value={o.points} />
        <Stat label={prev ? `Điểm trung bình (kỳ trước ${prev.average ?? '—'})` : 'Điểm trung bình'} value={o.average?.toFixed(2) ?? '—'} />
      </div>
      <div className="grid2">
        <div className="panel">
          <b>Số tiêu chí theo mức</b>
          <table style={{ marginTop: 6 }}>
            <thead><tr><th>Mức</th><th className="right">Số tiêu chí</th><th className="right">Tỷ lệ</th><th style={{ width: '45%' }} /></tr></thead>
            <tbody>{r.byLevel.map((l: any) => (
              <tr key={l.level} title={`Mức ${l.level}: ${l.n} tiêu chí (${l.pct}%)`}>
                <td>Mức {l.level}</td><td className="right mono">{l.n}</td><td className="right mono">{l.pct}%</td>
                <td><div style={{ background: 'var(--panel-2)', borderRadius: 4, height: 10 }}><div style={{ width: `${(100 * l.n) / maxN}%`, minWidth: l.n ? 3 : 0, height: 10, borderRadius: 4, background: 'var(--brand)' }} /></div></td>
              </tr>))}</tbody>
          </table>
        </div>
        <div className="panel">
          <b>Điểm trung bình theo phần</b>
          <table style={{ marginTop: 6 }}>
            <thead><tr><th>Phần</th><th className="right">Áp dụng</th><th className="right">Điểm</th><th className="right">Trung bình</th><th style={{ width: '35%' }} /></tr></thead>
            <tbody>{r.parts.map((p: any) => (
              <tr key={p.code} title={`${p.code}. ${p.name}: trung bình ${p.average ?? '—'}`}>
                <td className="small">{p.code}. {p.name}</td><td className="right mono">{p.applicable}</td><td className="right mono">{p.points}</td><td className="right mono">{p.average?.toFixed(2) ?? '—'}</td>
                <td><div style={{ background: 'var(--panel-2)', borderRadius: 4, height: 10 }}><div style={{ width: `${((p.average ?? 0) / 5) * 100}%`, height: 10, borderRadius: 4, background: 'var(--brand)' }} /></div></td>
              </tr>))}</tbody>
          </table>
          <div className="small muted">Thang điểm 1–5.</div>
        </div>
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <b>Bảng điểm các tiêu chí</b>
        <table style={{ marginTop: 6 }}>
          <thead><tr><th>Mã</th><th>Tiêu chí</th><th>Người chấm</th><th className="right">Mức</th>{prev && <th className="right">Kỳ trước</th>}<th>Giải trình / góp ý</th></tr></thead>
          <tbody>{r.rows.map((x: any, k: number) => (
            <Fragment key={x.criterion_id}>
              {(k === 0 || r.rows[k - 1].chapter !== x.chapter) && <tr><td colSpan={prev ? 6 : 5} className="small muted"><b>{x.chapter}. {x.chapter_name}</b></td></tr>}
              <tr>
                <td className="mono">{x.code}</td><td className="small">{x.title}</td><td className="small">{x.assessor_name ?? ''}</td>
                <td className="right"><b>{x.applicable ? (x.final_level ?? '—') : 'KAD'}</b></td>
                {prev && <td className="right mono">{prev.levels[x.code] ?? '—'}</td>}
                <td className="small" style={{ whiteSpace: 'pre-wrap' }}>{[x.explanation, x.reviewer_note && `Góp ý: ${x.reviewer_note}`].filter(Boolean).join('\n')}</td>
              </tr>
            </Fragment>))}</tbody>
        </table>
        <div className="small muted">KAD: không áp dụng.</div>
      </div>
      <div className="panel">
        <b>Vấn đề ưu tiên cải tiến</b>
        <div className="small muted">Các tiểu mục chưa đạt để lên mức kế tiếp, ưu tiên tiêu chí điểm thấp và hệ số cao.</div>
        {r.priorities.length === 0 && <div className="small muted">Không có.</div>}
        {r.priorities.map((p: any) => (
          <div key={p.code} style={{ marginTop: 8 }}>
            <b>{p.code}. {p.title}</b> <span className="small muted">— đang mức {p.level}, mục tiêu mức {p.target}{p.owner_unit ? ` · ${p.owner_unit}` : ''}</span>
            {p.items.map((i: any) => <div key={i.ordinal} className="small" style={{ paddingLeft: 12 }}>• (mức {i.level}) {i.ordinal}. {i.text}</div>)}
            {p.improvement && <div className="small" style={{ paddingLeft: 12 }}><i>Kế hoạch: {p.improvement}</i></div>}
          </div>))}
      </div>
    </div>
  );
}
