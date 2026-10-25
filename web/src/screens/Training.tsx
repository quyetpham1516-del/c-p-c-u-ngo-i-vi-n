import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, download, session } from '../api';
import { Stat } from './Hr';

interface Meta {
  questionKinds: Record<string, string>; difficulty: Record<string, string>; purposes: Record<string, string>; checkKinds: Record<string, string>;
  trainingKinds: Record<string, string>; practice: { count: number; minutesPerQuestion: number; passPct: number }; evidenceDays: number;
}
interface Option { key: string; text: string }
interface AQuestion { id: string; code: string; topic: string; kind: string; stem: string; options: Option[]; answer?: string[]; explanation?: string | null; reference?: string | null; correct?: boolean }
interface Attempt {
  id: string; name: string; purpose: string; passPct: number; deadline: string; submittedAt: string | null; autoSubmit: boolean;
  total: number; score: number | null; pct: number | null; passed: boolean | null; byTopic: Record<string, { correct: number; total: number }> | null;
  answers: Record<string, string[]>; questions: AQuestion[];
}
interface Step { id: string; ordinal: number; text: string; critical: boolean }
interface StaffRow { id: string; code: string; full_name: string; title: string | null; station_id: string | null }
type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;

const STATUS: Record<string, string> = { du_thao: 'Dự thảo', hieu_luc: 'Đang hiệu lực', het_hieu_luc: 'Hết hiệu lực', ngung: 'Ngưng dùng' };
const PLAN_STATUS: Record<string, string> = { ke_hoach: 'Kế hoạch', da_to_chuc: 'Đã tổ chức', huy: 'Đã hủy' };
const d = (s: string | null | undefined) => (s ? new Date(s.length === 10 ? `${s}T00:00:00` : s).toLocaleDateString('vi-VN') : '—');
const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const fileToBase64 = (file: File) => new Promise<string>((ok, bad) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result)); rd.onerror = bad; rd.readAsDataURL(file); });

/** Đào tạo và sát hạch (QLCL-13, 14): mỗi người thi và luyện tập trên điện thoại; quản lý soạn đề, tổ chức thi, chấm thực hành, cấp chứng nhận */
export function Training() {
  const role = session.user?.role ?? '';
  const canManage = ['qa', 'supervisor', 'hr', 'admin', 'director'].includes(role);
  const tabs = ['Của tôi', ...(canManage ? ['Ngân hàng câu hỏi', 'Bộ đề', 'Kỳ thi'] : []), 'Quy trình kỹ thuật', ...(canManage ? ['Nhân viên', 'Kế hoạch đào tạo', 'Báo cáo'] : [])];
  const [tab, setTab] = useState('Của tôi');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  useEffect(() => { api<Meta>('GET', '/api/training/meta').then(setMeta).catch((e) => setError(e.message)); }, []);
  const run: Run = async (fn, ok) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  if (!meta) return error ? <div className="error">{error}</div> : null;
  if (attempt) return <TakeAttempt initial={attempt} onClose={() => { setAttempt(null); setTab('Của tôi'); }} />;
  return (
    <div className="col">
      <h2 className="no-print" style={{ margin: 0 }}>Đào tạo và sát hạch <span className="small muted">QLCL-13, 14</span></h2>
      <div className="tabs no-print">{tabs.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); setMsg(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {tab === 'Của tôi' && <Mine meta={meta} run={run} onStart={setAttempt} />}
      {tab === 'Ngân hàng câu hỏi' && <Questions meta={meta} run={run} />}
      {tab === 'Bộ đề' && <Blueprints meta={meta} run={run} />}
      {tab === 'Kỳ thi' && <Exams run={run} />}
      {tab === 'Quy trình kỹ thuật' && <Procedures meta={meta} run={run} canManage={canManage} />}
      {tab === 'Nhân viên' && <StaffTab meta={meta} run={run} />}
      {tab === 'Kế hoạch đào tạo' && <Plan meta={meta} run={run} />}
      {tab === 'Báo cáo' && <Report meta={meta} />}
    </div>
  );
}

/* ======================= Của tôi ======================= */

function Mine({ meta, run, onStart }: { meta: Meta; run: Run; onStart: (a: Attempt) => void }) {
  const [me, setMe] = useState<any>(null);
  const load = () => api('GET', '/api/training/me').then(setMe);
  useEffect(() => { load().catch(() => {}); }, []);
  if (!me) return null;
  const start = (body: unknown, url = '/api/training/attempts') => run(async () => onStart(await api<Attempt>('POST', url, body)));
  const open = (id: string) => run(async () => onStart(await api<Attempt>('GET', `/api/training/attempts/${id}`)));
  return (
    <div className="col">
      {!me.staff && <div className="alert amber">Tài khoản chưa có hồ sơ nhân viên nên chưa thi được. Liên hệ phòng Nhân sự.</div>}
      {me.staff && (
        <div className="grid4">
          <Stat label="Chứng nhận Medone" value={me.cert ? `${me.cert.number}` : 'Chưa có'} tone={me.cert ? (me.cert.expiring ? 'amber' : 'green') : (me.settings?.require_cert ? 'red' : '')} />
          <Stat label="Hạn chứng nhận" value={me.cert ? d(me.cert.expires_on) : '—'} />
          <Stat label="Kỹ thuật được phân quyền" value={me.privileges.filter((p: any) => p.expires_on >= today()).length} />
          <Stat label="Tài liệu cần đọc" value={me.toRead.length} tone={me.toRead.length ? 'amber' : ''} />
        </div>
      )}
      {me.settings?.require_cert && !me.cert && me.staff && <div className="alert red">Trung tâm đang yêu cầu chứng nhận Medone còn hạn mới được nhận ca trên xe. Bạn cần đạt bài thi lý thuyết và sát hạch thực hành.</div>}
      {me.toRead.length > 0 && (
        <div className="panel">
          <b>Tài liệu cần đọc và xác nhận</b>
          <table><tbody>{me.toRead.map((x: any) => (
            <tr key={x.id}>
              <td className="mono">{x.code}</td><td>{x.url ? <a href={x.url} target="_blank" rel="noreferrer">{x.title}</a> : x.title}</td><td>Phiên bản {x.version}</td>
              <td className="right"><button className="primary small" onClick={() => run(async () => { await api('POST', `/api/documents/${x.id}/read`); await load(); }, 'Đã xác nhận đọc')}>Tôi đã đọc và hiểu</button></td>
            </tr>))}</tbody></table>
        </div>
      )}
      <div className="panel">
        <b>Kỳ thi của tôi</b>
        {!me.exams.length && <div className="small muted">Chưa có kỳ thi nào.</div>}
        <table><tbody>{me.exams.map((e: any) => (
          <tr key={e.id}>
            <td><b>{e.name}</b><div className="small muted">{meta.purposes[e.purpose]} · {e.duration_min} phút · đạt từ {e.pass_pct}%</div></td>
            <td>{d(e.opens_on)} – {d(e.closes_on)}</td>
            <td>{e.passed ? <span className="badge green">Đạt ({e.best_pct}%)</span> : e.tries ? <span className="badge red">Chưa đạt ({e.best_pct ?? 0}%)</span> : <span className="badge">Chưa thi</span>}
              {e.max_attempts ? <div className="small muted">Đã thi {e.tries}/{e.max_attempts} lượt</div> : null}</td>
            <td className="right">{e.open && !e.passed && (!e.max_attempts || e.tries < e.max_attempts) && <button className="primary" onClick={() => start({ examId: e.id })}>Vào thi</button>}</td>
          </tr>))}</tbody></table>
      </div>
      <div className="panel">
        <b>Luyện tập</b>
        <div className="small muted">Không tính vào kết quả sát hạch. Mỗi chủ đề {meta.practice.count} câu ngẫu nhiên, {meta.practice.minutesPerQuestion} phút/câu, đạt từ {meta.practice.passPct}%.</div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {me.topics.map((t: any) => <button key={t.topic} onClick={() => start({ topic: t.topic }, '/api/training/practice')}>{t.topic} <span className="muted">({t.n})</span></button>)}
          {me.practice.map((b: any) => <button key={b.id} onClick={() => start({ blueprintId: b.id })}>Đề luyện tập: {b.name}</button>)}
          {!me.topics.length && !me.practice.length && <span className="small muted">Ngân hàng chưa có câu hỏi đã duyệt.</span>}
        </div>
      </div>
      {me.staff && (
        <div className="panel">
          <b>Kết quả của tôi</b>
          <table>
            <thead><tr><th>Bài</th><th>Bắt đầu</th><th className="right">Điểm</th><th>Kết quả</th><th /></tr></thead>
            <tbody>{me.attempts.map((a: any) => (
              <tr key={a.id}>
                <td>{a.name}</td><td>{dt(a.started_at)}</td><td className="right">{a.submitted_at ? `${a.score}/${a.total} (${a.pct}%)` : '—'}</td>
                <td>{!a.submitted_at ? <span className="badge amber">Đang làm</span> : a.passed ? <span className="badge green">Đạt</span> : <span className="badge red">Chưa đạt</span>}</td>
                <td className="right"><button className="ghost small" onClick={() => open(a.id)}>{a.submitted_at ? 'Xem lại' : 'Làm tiếp'}</button></td>
              </tr>))}</tbody>
          </table>
          {me.privileges.length > 0 && <>
            <b style={{ display: 'block', marginTop: 10 }}>Kỹ thuật được phân quyền</b>
            <ul>{me.privileges.map((p: any) => <li key={p.id}>{p.procedure_code} {p.title ?? ''}: đến {d(p.expires_on)}</li>)}</ul>
          </>}
          {me.checks.length > 0 && <>
            <b style={{ display: 'block', marginTop: 10 }}>Sát hạch thực hành</b>
            <ul>{me.checks.map((c: any) => <li key={c.id}>{d(c.at)} · {c.code} {c.title}: {c.score_pct}% {c.passed ? '(đạt)' : '(chưa đạt)'} · {meta.checkKinds[c.kind]}</li>)}</ul>
          </>}
        </div>
      )}
    </div>
  );
}

/** Màn hình làm bài: đồng hồ đếm ngược, lưu từng câu ngay khi chọn, hết giờ tự nộp; nộp xong hiện đáp án và giải thích */
function TakeAttempt({ initial, onClose }: { initial: Attempt; onClose: () => void }) {
  const [a, setA] = useState(initial);
  const [answers, setAnswers] = useState<Record<string, string[]>>(initial.answers ?? {});
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<Record<string, string[]>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const done = !!a.submittedAt;
  const left = Math.max(0, new Date(a.deadline).getTime() - now);

  const flush = async () => {
    const batch = pending.current;
    pending.current = {};
    if (!Object.keys(batch).length) return;
    try {
      const r = await api<Attempt>('PUT', `/api/training/attempts/${a.id}/answers`, { answers: batch });
      if (r.submittedAt) setA(r);
    } catch (e) { pending.current = { ...batch, ...pending.current }; setError(`Chưa lưu được câu trả lời, đang thử lại: ${(e as Error).message}`); }
  };
  const submit = async (auto = false) => {
    if (busy || done) return;
    if (!auto && !window.confirm(`Nộp bài? Còn ${a.questions.filter((q) => !(answers[q.id]?.length)).length} câu chưa trả lời (tính sai).`)) return;
    setBusy(true);
    try { setA(await api<Attempt>('POST', `/api/training/attempts/${a.id}/submit`, { answers })); window.scrollTo(0, 0); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [done]);
  useEffect(() => { if (!done && left === 0) submit(true); }, [left, done]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (q: AQuestion, key: string) => {
    if (done) return;
    const cur = answers[q.id] ?? [];
    const next = q.kind === 'nhieu_dap_an' ? (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key].sort()) : [key];
    setAnswers({ ...answers, [q.id]: next });
    pending.current[q.id] = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };
  const answered = a.questions.filter((q) => answers[q.id]?.length).length;
  const mm = Math.floor(left / 60000);
  const ss = Math.floor((left % 60000) / 1000);
  return (
    <div className="col" style={{ maxWidth: 820, margin: '0 auto' }}>
      <div className="panel row" style={{ position: 'sticky', top: 0, zIndex: 5, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div><b>{a.name}</b><div className="small muted">{a.total} câu · đạt từ {a.passPct}%</div></div>
        {!done && <div style={{ fontSize: 22, fontWeight: 700 }} className={left < 120_000 ? 'red' : ''}>{String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}</div>}
        {!done && <div className="small">Đã trả lời {answered}/{a.total}</div>}
        {!done ? <button className="primary" disabled={busy} onClick={() => submit()}>Nộp bài</button> : <button onClick={onClose}>Quay lại</button>}
      </div>
      {error && <div className="error">{error}</div>}
      {done && (
        <div className={`alert ${a.passed ? 'green' : 'red'}`}>
          <b>{a.passed ? 'ĐẠT' : 'CHƯA ĐẠT'}</b>: {a.score}/{a.total} câu đúng ({a.pct}%){a.autoSubmit ? ' · hết giờ, hệ thống tự nộp' : ''}
          {a.byTopic && <div className="small">{Object.entries(a.byTopic).map(([t, v]) => `${t}: ${v.correct}/${v.total}`).join(' · ')}</div>}
        </div>
      )}
      {a.questions.map((q, i) => (
        <div key={q.id} className={`panel ${done ? (q.correct ? 'green' : 'red') : ''}`}>
          <div className="small muted">Câu {i + 1} · {q.topic} · {q.kind === 'nhieu_dap_an' ? 'chọn tất cả đáp án đúng' : q.kind === 'dung_sai' ? 'đúng hay sai' : 'chọn một đáp án'}</div>
          <div style={{ fontWeight: 600, margin: '4px 0 8px' }}>{q.stem}</div>
          <div className="col" style={{ gap: 6 }}>
            {q.options.map((o) => {
              const sel = (answers[q.id] ?? []).includes(o.key);
              const right = done && q.answer?.includes(o.key);
              return (
                <button key={o.key} className={`choice ${sel ? 'sel' : ''}`} style={{ textAlign: 'left', minHeight: 44, ...(right ? { outline: '2px solid var(--green, #2e7d32)' } : {}) }}
                  onClick={() => choose(q, o.key)} disabled={done}>
                  <b>{o.key}.</b> {o.text}{right ? ' ✓' : ''}
                </button>
              );
            })}
          </div>
          {done && (q.explanation || q.reference) && <div className="small" style={{ marginTop: 6 }}>{q.explanation}{q.reference ? <span className="muted"> · Tham khảo: {q.reference}</span> : null}</div>}
        </div>
      ))}
      {!done && <button className="primary" disabled={busy} onClick={() => submit()}>Nộp bài</button>}
    </div>
  );
}

/* ======================= Ngân hàng câu hỏi ======================= */

const emptyQ = { id: '', topic: '', difficulty: 2, kind: 'mot_dap_an', stem: '', options: ['', '', '', ''], answer: [] as string[], explanation: '', reference: '', roles: '' };

function Questions({ meta, run }: { meta: Meta; run: Run }) {
  const role = session.user?.role ?? '';
  const canApprove = ['qa', 'supervisor', 'admin', 'director'].includes(role);
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [topic, setTopic] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [f, setF] = useState<typeof emptyQ | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const load = () => api<any[]>('GET', `/api/training/questions?${new URLSearchParams({ ...(status ? { status } : {}), ...(topic ? { topic } : {}) })}`).then((r) => { setRows(r); setSel([]); });
  useEffect(() => { load().catch(() => {}); }, [status, topic]); // eslint-disable-line react-hooks/exhaustive-deps
  const topics = useMemo(() => [...new Set(rows.map((r) => r.topic))].sort(), [rows]);
  const me = session.user?.id;

  const save = () => f && run(async () => {
    const body = {
      topic: f.topic, difficulty: Number(f.difficulty), kind: f.kind, stem: f.stem, options: f.kind === 'dung_sai' ? [] : f.options.filter((o) => o.trim()),
      answer: f.answer, explanation: f.explanation || null, reference: f.reference || null, roles: f.roles.split(',').map((s) => s.trim()).filter(Boolean),
    };
    await api(f.id ? 'PUT' : 'POST', f.id ? `/api/training/questions/${f.id}` : '/api/training/questions', body);
    setF(null); await load();
  }, 'Đã lưu câu hỏi (dự thảo, chờ duyệt)');
  const edit = (r: any) => setF({
    id: r.id, topic: r.topic, difficulty: r.difficulty, kind: r.kind, stem: r.stem, options: r.kind === 'dung_sai' ? ['', '', '', ''] : [...r.options.map((o: Option) => o.text), '', ''].slice(0, Math.max(4, r.options.length)),
    answer: r.answer, explanation: r.explanation ?? '', reference: r.reference ?? '', roles: r.roles.join(', '),
  });
  const keys = f ? (f.kind === 'dung_sai' ? ['A', 'B'] : f.options.map((_, i) => 'ABCDEF'[i]).filter((_, i) => f.options[i].trim())) : [];
  const toggleAns = (k: string) => f && setF({ ...f, answer: f.kind === 'nhieu_dap_an' ? (f.answer.includes(k) ? f.answer.filter((x) => x !== k) : [...f.answer, k].sort()) : [k] });
  const importFile = () => run(async () => {
    if (!file) throw new Error('Chọn tệp Excel');
    setImportErrors([]);
    try {
      const r = await api<{ created: number; updated: number }>('POST', '/api/training/questions/import', { fileBase64: await fileToBase64(file) });
      setFile(null); await load();
      return r;
    } catch (e: any) { setImportErrors(e.details?.errors ?? []); throw e; }
  }, 'Đã nạp Excel; câu mới và câu sửa ở dạng dự thảo, cần duyệt');
  const approvable = sel.filter((id) => rows.find((r) => r.id === id)?.created_by !== me);

  return (
    <div className="col">
      <div className="panel row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="field">Trạng thái<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Tất cả</option>{['du_thao', 'hieu_luc', 'ngung'].map((s) => <option key={s} value={s}>{STATUS[s]}</option>)}</select></label>
        <label className="field">Chủ đề<select value={topic} onChange={(e) => setTopic(e.target.value)}><option value="">Tất cả</option>{topics.map((t) => <option key={t}>{t}</option>)}</select></label>
        <button onClick={() => setF({ ...emptyQ, topic })}>Thêm câu hỏi</button>
        <button className="ghost" onClick={() => run(() => download('/api/training/questions.xlsx', 'ngan-hang-cau-hoi.xlsx'))}>Tải Excel</button>
        <label className="field">Nạp từ Excel<input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        {file && <button onClick={importFile}>Nạp tệp</button>}
        {canApprove && <button className="primary" disabled={!approvable.length} onClick={() => run(async () => { await api('POST', '/api/training/questions/approve', { ids: approvable }); await load(); }, 'Đã duyệt')}>Duyệt {approvable.length} câu đã chọn</button>}
      </div>
      {importErrors.length > 0 && <div className="error"><ul>{importErrors.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      <div className="small muted">Câu soạn mới hoặc vừa sửa ở dạng dự thảo; người khác người soạn duyệt mới được rút vào đề. Bài thi lưu bản chụp câu hỏi nên sửa câu không làm đổi kết quả cũ.</div>
      {f && (
        <div className="panel col">
          <b>{f.id ? 'Sửa câu hỏi' : 'Câu hỏi mới'}</b>
          <div className="grid4">
            <label className="field">Chủ đề<input list="tr-topics" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} /><datalist id="tr-topics">{topics.map((t) => <option key={t} value={t} />)}</datalist></label>
            <label className="field">Độ khó<select value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: Number(e.target.value) })}>{Object.entries(meta.difficulty).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Loại<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, answer: [] })}>{Object.entries(meta.questionKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Vị trí áp dụng<input value={f.roles} onChange={(e) => setF({ ...f, roles: e.target.value })} placeholder="Bác sĩ, Điều dưỡng (trống = mọi người)" /></label>
          </div>
          <label className="field">Câu hỏi<textarea rows={2} value={f.stem} onChange={(e) => setF({ ...f, stem: e.target.value })} /></label>
          {f.kind !== 'dung_sai' && f.options.map((o, i) => (
            <label key={i} className="field">Phương án {'ABCDEF'[i]}<input value={o} onChange={(e) => setF({ ...f, options: f.options.map((x, j) => (j === i ? e.target.value : x)) })} /></label>
          ))}
          {f.kind !== 'dung_sai' && f.options.length < 6 && <button className="ghost small" onClick={() => setF({ ...f, options: [...f.options, ''] })}>Thêm phương án</button>}
          <div className="row" style={{ gap: 6 }}>Đáp án đúng: {keys.map((k) => <button key={k} className={`choice ${f.answer.includes(k) ? 'sel' : ''}`} onClick={() => toggleAns(k)}>{f.kind === 'dung_sai' ? (k === 'A' ? 'Đúng' : 'Sai') : k}</button>)}</div>
          <label className="field">Giải thích (hiện sau khi nộp bài)<textarea rows={2} value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} /></label>
          <label className="field">Tài liệu tham khảo<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="QTKT-CC-01, phác đồ..." /></label>
          <div className="row"><button className="primary" onClick={save}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Hủy</button></div>
        </div>
      )}
      <div className="panel">
        <table>
          <thead><tr><th><input type="checkbox" checked={sel.length > 0 && sel.length === rows.filter((r) => r.status === 'du_thao').length} onChange={(e) => setSel(e.target.checked ? rows.filter((r) => r.status === 'du_thao').map((r) => r.id) : [])} /></th>
            <th>Mã</th><th>Chủ đề</th><th>Độ khó</th><th>Câu hỏi</th><th>Đáp án</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td>{r.status === 'du_thao' && <input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} />}</td>
              <td className="mono">{r.code}</td><td>{r.topic}</td><td>{meta.difficulty[r.difficulty]}</td>
              <td>{r.stem}<div className="small muted">{meta.questionKinds[r.kind]}{r.source ? ` · ${r.source.slice(0, 60)}${r.source.length > 60 ? '…' : ''}` : ''}</div></td>
              <td className="mono">{r.answer.join(',')}</td>
              <td><span className="badge">{STATUS[r.status]}</span>{r.approved_by_name && <div className="small muted">{r.approved_by_name}</div>}</td>
              <td className="right" style={{ whiteSpace: 'nowrap' }}>
                {r.status !== 'ngung' && <button className="ghost small" onClick={() => edit(r)}>Sửa</button>}
                {r.status !== 'ngung' ? <button className="ghost small" onClick={() => run(async () => { await api('POST', `/api/training/questions/${r.id}/retire`); await load(); }, 'Đã ngưng dùng')}>Ngưng</button>
                  : <button className="ghost small" onClick={() => run(async () => { await api('POST', `/api/training/questions/${r.id}/restore`); await load(); }, 'Đã khôi phục thành dự thảo')}>Khôi phục</button>}
              </td>
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  );
}

/* ======================= Bộ đề ======================= */

const emptyBp = { id: '', code: '', version: '1', name: '', purpose: 'sat_hach', mode: 'ngau_nhien', rules: [{ topic: '', difficulty: '', count: 10 }] as { topic: string; difficulty: string | number; count: number }[],
  questionIds: [] as string[], durationMin: 30, passPct: 70, maxAttempts: '' as string | number, shuffle: true, note: '' };

function Blueprints({ meta, run }: { meta: Meta; run: Run }) {
  const canApprove = ['director', 'admin'].includes(session.user?.role ?? '');
  const [rows, setRows] = useState<any[]>([]);
  const [topics, setTopics] = useState<any[]>([]);
  const [bank, setBank] = useState<any[]>([]);
  const [f, setF] = useState<typeof emptyBp | null>(null);
  const load = () => api<any[]>('GET', '/api/training/blueprints').then(setRows);
  useEffect(() => {
    load().catch(() => {});
    api<any[]>('GET', '/api/training/topics').then(setTopics).catch(() => {});
    api<any[]>('GET', '/api/training/questions?status=hieu_luc').then(setBank).catch(() => {});
  }, []);
  const avail = (t: string, diff: string | number) => {
    const x = topics.find((y) => y.topic === t);
    if (!x) return 0;
    return diff ? x[`d${diff}`] : x.active;
  };
  const total = f ? (f.mode === 'co_dinh' ? f.questionIds.length : f.rules.reduce((s, r) => s + Number(r.count || 0), 0)) : 0;
  const save = () => f && run(async () => {
    const body = {
      name: f.name, purpose: f.purpose, mode: f.mode, durationMin: Number(f.durationMin), passPct: Number(f.passPct), maxAttempts: f.maxAttempts ? Number(f.maxAttempts) : null,
      shuffle: f.shuffle, note: f.note || null, questionIds: f.questionIds,
      rules: f.rules.filter((r) => r.topic).map((r) => ({ topic: r.topic, difficulty: r.difficulty ? Number(r.difficulty) : null, count: Number(r.count) })),
    };
    if (f.id) await api('PUT', `/api/training/blueprints/${f.id}`, body);
    else await api('POST', '/api/training/blueprints', { ...body, code: f.code, version: f.version });
    setF(null); await load();
  }, 'Đã lưu bộ đề (dự thảo)');
  const edit = async (id: string) => {
    const b = await api<any>('GET', `/api/training/blueprints/${id}`);
    setF({ id: b.id, code: b.code, version: b.version, name: b.name, purpose: b.purpose, mode: b.mode, rules: b.rules.map((r: any) => ({ ...r, difficulty: r.difficulty ?? '' })),
      questionIds: b.question_ids, durationMin: b.duration_min, passPct: b.pass_pct, maxAttempts: b.max_attempts ?? '', shuffle: b.shuffle, note: b.note ?? '' });
  };
  const clone = (b: any) => {
    const version = window.prompt(`Phiên bản mới cho bộ đề "${b.name}":`, '');
    if (version) run(async () => { const r = await api<{ id: string }>('POST', `/api/training/blueprints/${b.id}/clone`, { version }); await load(); await edit(r.id); }, 'Đã tạo bản dự thảo');
  };
  return (
    <div className="col">
      <div className="panel">
        <div className="small muted" style={{ marginBottom: 8 }}>Mặc định theo MedOne: sát hạch 100 câu, 30 phút, đạt từ 70%; chỉnh được từng bộ đề. Bộ đề đã ban hành không sửa trực tiếp, nhân bản thành phiên bản mới.</div>
        <table>
          <thead><tr><th>Mã</th><th>Tên</th><th>Mục đích</th><th>Cách ra đề</th><th className="right">Số câu</th><th>Thời gian</th><th>Đạt</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((b) => (
            <tr key={b.id}>
              <td className="mono">{b.code} v{b.version}</td><td>{b.name}</td><td>{meta.purposes[b.purpose]}</td><td>{b.mode === 'co_dinh' ? 'Cố định' : 'Ngẫu nhiên theo ma trận'}</td>
              <td className="right">{b.question_count}</td><td>{b.duration_min} phút</td><td>{b.pass_pct}%</td><td><span className="badge">{STATUS[b.status]}</span></td>
              <td className="right" style={{ whiteSpace: 'nowrap' }}>
                {b.status === 'du_thao' && <button className="ghost small" onClick={() => run(() => edit(b.id))}>Sửa</button>}
                <button className="ghost small" onClick={() => clone(b)}>Nhân bản</button>
                {canApprove && b.status === 'du_thao' && <button className="ghost small" onClick={() => run(async () => { await api('POST', `/api/training/blueprints/${b.id}/approve`); await load(); }, 'Đã ban hành')}>Ban hành</button>}
                {b.status === 'du_thao' && !b.in_use && <button className="ghost small" onClick={() => window.confirm('Xóa bộ đề dự thảo?') && run(async () => { await api('DELETE', `/api/training/blueprints/${b.id}`); await load(); }, 'Đã xóa')}>Xóa</button>}
              </td>
            </tr>))}</tbody>
        </table>
        {!f && <button style={{ marginTop: 8 }} onClick={() => setF({ ...emptyBp, rules: topics.length ? [{ topic: topics[0].topic, difficulty: '', count: 10 }] : emptyBp.rules })}>Tạo bộ đề</button>}
      </div>
      {f && (
        <div className="panel col">
          <b>{f.id ? `Sửa bộ đề ${f.code} v${f.version}` : 'Bộ đề mới'}</b>
          <div className="grid4">
            {!f.id && <label className="field">Mã<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="DE-SH" /></label>}
            {!f.id && <label className="field">Phiên bản<input value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} /></label>}
            <label className="field">Mục đích<select value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>{Object.entries(meta.purposes).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Cách ra đề<select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="ngau_nhien">Ngẫu nhiên theo ma trận</option><option value="co_dinh">Cố định (chọn từng câu)</option></select></label>
          </div>
          <label className="field">Tên bộ đề<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <div className="grid4">
            <label className="field">Thời gian (phút)<input type="number" value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: Number(e.target.value) })} /></label>
            <label className="field">Điểm đạt (%)<input type="number" value={f.passPct} onChange={(e) => setF({ ...f, passPct: Number(e.target.value) })} /></label>
            <label className="field">Số lượt thi tối đa<input type="number" value={f.maxAttempts} onChange={(e) => setF({ ...f, maxAttempts: e.target.value })} placeholder="không giới hạn" /></label>
            <label className="field row"><input type="checkbox" checked={f.shuffle} onChange={(e) => setF({ ...f, shuffle: e.target.checked })} /> Trộn câu và phương án</label>
          </div>
          {f.mode === 'ngau_nhien' ? (
            <table>
              <thead><tr><th>Chủ đề</th><th>Độ khó</th><th className="right">Số câu</th><th className="right">Ngân hàng có</th><th /></tr></thead>
              <tbody>{f.rules.map((r, i) => {
                const have = avail(r.topic, r.difficulty);
                const set = (p: Partial<typeof r>) => setF({ ...f, rules: f.rules.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                return (
                  <tr key={i}>
                    <td><select value={r.topic} onChange={(e) => set({ topic: e.target.value })}><option value="">—</option>{topics.map((t) => <option key={t.topic}>{t.topic}</option>)}</select></td>
                    <td><select value={r.difficulty} onChange={(e) => set({ difficulty: e.target.value })}><option value="">Mọi mức</option>{Object.entries(meta.difficulty).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                    <td className="right"><input type="number" style={{ width: 80 }} value={r.count} onChange={(e) => set({ count: Number(e.target.value) })} /></td>
                    <td className={`right ${have < r.count ? 'red' : ''}`}>{have} câu đã duyệt</td>
                    <td><button className="ghost small" onClick={() => setF({ ...f, rules: f.rules.filter((_, j) => j !== i) })}>Bỏ</button></td>
                  </tr>
                );
              })}</tbody>
            </table>
          ) : (
            <div style={{ maxHeight: 320, overflow: 'auto' }}>
              <table><tbody>{bank.map((q) => (
                <tr key={q.id}><td><input type="checkbox" checked={f.questionIds.includes(q.id)} onChange={(e) => setF({ ...f, questionIds: e.target.checked ? [...f.questionIds, q.id] : f.questionIds.filter((x) => x !== q.id) })} /></td>
                  <td className="mono">{q.code}</td><td>{q.topic}</td><td>{q.stem}</td></tr>))}</tbody></table>
            </div>
          )}
          <div className="row">
            {f.mode === 'ngau_nhien' && <button className="ghost small" onClick={() => setF({ ...f, rules: [...f.rules, { topic: '', difficulty: '', count: 5 }] })}>Thêm dòng ma trận</button>}
            <b>Tổng: {total} câu</b>
          </div>
          <label className="field">Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <div className="row"><button className="primary" onClick={save}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Hủy</button></div>
        </div>
      )}
    </div>
  );
}

/* ======================= Kỳ thi ======================= */

function Exams({ run }: { run: Run }) {
  const [rows, setRows] = useState<any[]>([]);
  const [bps, setBps] = useState<any[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [open, setOpen] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const load = () => api<any[]>('GET', '/api/training/exams').then(setRows);
  useEffect(() => {
    load().catch(() => {});
    api<any[]>('GET', '/api/training/blueprints').then((b) => setBps(b.filter((x) => x.status === 'hieu_luc' && x.purpose !== 'luyen_tap'))).catch(() => {});
    api<StaffRow[]>('GET', '/api/training/staff').then(setStaff).catch(() => {});
  }, []);
  const titles = useMemo(() => [...new Set(staff.map((s) => s.title).filter(Boolean) as string[])].sort(), [staff]);
  const show = (id: string) => run(async () => setOpen(open?.id === id ? null : await api('GET', `/api/training/exams/${id}`)));
  const save = () => run(async () => {
    const staffIds = f.by === 'nguoi' ? f.staffIds : staff.filter((s) => f.titles.includes(s.title)).map((s) => s.id);
    await api('POST', '/api/training/exams', { blueprintId: f.blueprintId, name: f.name, opensOn: f.opensOn, closesOn: f.closesOn, staffIds });
    setF(null); await load();
  }, 'Đã tạo kỳ thi; người dự thi thấy ở mục Của tôi');
  return (
    <div className="col">
      <div className="panel">
        <table>
          <thead><tr><th>Kỳ thi</th><th>Bộ đề</th><th>Thời gian mở</th><th className="right">Dự thi</th><th className="right">Đã thi</th><th className="right">Đạt</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((e) => (
            <Fragment key={e.id}>
              <tr>
                <td><a href="#" onClick={(x) => { x.preventDefault(); show(e.id); }}>{e.name}</a></td><td>{e.blueprint_name} v{e.blueprint_version}</td><td>{d(e.opens_on)} – {d(e.closes_on)}</td>
                <td className="right">{e.candidates}</td><td className="right">{e.taken}</td><td className="right">{e.passed}</td><td>{e.status === 'mo' ? 'Đang mở' : 'Đã đóng'}</td>
                <td className="right">{e.status === 'mo' && <button className="ghost small" onClick={() => window.confirm('Đóng kỳ thi? Bài đang làm quá giờ sẽ được chấm.') && run(async () => { await api('POST', `/api/training/exams/${e.id}/close`); await load(); }, 'Đã đóng')}>Đóng</button>}</td>
              </tr>
              {open?.id === e.id && (
                <tr><td colSpan={8}>
                  <table>
                    <thead><tr><th>Nhân viên</th><th>Chức danh</th><th className="right">Lượt</th><th className="right">Điểm cao nhất</th><th>Kết quả</th></tr></thead>
                    <tbody>{open.rows.map((r: any) => <tr key={r.staff_id}><td>{r.full_name}</td><td>{r.title}</td><td className="right">{r.tries}</td><td className="right">{r.best_pct ?? '—'}{r.best_pct != null ? '%' : ''}</td>
                      <td>{r.passed ? <span className="badge green">Đạt</span> : r.tries ? <span className="badge red">Chưa đạt</span> : <span className="badge">Chưa thi</span>}</td></tr>)}</tbody>
                  </table>
                  {open.hard.length > 0 && <><b>Câu sai nhiều nhất (nội dung cần đào tạo lại)</b>
                    <ul>{open.hard.filter((h: any) => h.wrong > 0).map((h: any) => <li key={h.code}><span className="mono">{h.code}</span> {h.stem} <span className="muted">({h.wrong}/{h.asked} sai · {h.topic})</span></li>)}</ul></>}
                </td></tr>
              )}
            </Fragment>))}</tbody>
        </table>
        {!f && <button style={{ marginTop: 8 }} disabled={!bps.length} onClick={() => setF({ blueprintId: bps[0]?.id, name: '', opensOn: today(), closesOn: today(), by: 'chuc_danh', titles: [], staffIds: [] })}>Tạo kỳ thi</button>}
        {!bps.length && <div className="small muted">Cần có bộ đề sát hạch hoặc định kỳ đang hiệu lực.</div>}
      </div>
      {f && (
        <div className="panel col">
          <b>Kỳ thi mới</b>
          <div className="grid4">
            <label className="field">Bộ đề<select value={f.blueprintId} onChange={(e) => setF({ ...f, blueprintId: e.target.value })}>{bps.map((b) => <option key={b.id} value={b.id}>{b.name} v{b.version} ({b.question_count} câu)</option>)}</select></label>
            <label className="field">Tên kỳ thi<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Sát hạch đầu vào tháng 11" /></label>
            <label className="field">Mở từ<input type="date" value={f.opensOn} onChange={(e) => setF({ ...f, opensOn: e.target.value })} /></label>
            <label className="field">Đến hết<input type="date" value={f.closesOn} onChange={(e) => setF({ ...f, closesOn: e.target.value })} /></label>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className={`choice ${f.by === 'chuc_danh' ? 'sel' : ''}`} onClick={() => setF({ ...f, by: 'chuc_danh' })}>Theo chức danh</button>
            <button className={`choice ${f.by === 'nguoi' ? 'sel' : ''}`} onClick={() => setF({ ...f, by: 'nguoi' })}>Chọn từng người</button>
          </div>
          {f.by === 'chuc_danh' ? (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{titles.map((t) => <label key={t} className="row"><input type="checkbox" checked={f.titles.includes(t)} onChange={(e) => setF({ ...f, titles: e.target.checked ? [...f.titles, t] : f.titles.filter((x: string) => x !== t) })} /> {t} ({staff.filter((s) => s.title === t).length})</label>)}</div>
          ) : (
            <div style={{ maxHeight: 260, overflow: 'auto' }}>{staff.map((s) => <label key={s.id} className="row"><input type="checkbox" checked={f.staffIds.includes(s.id)} onChange={(e) => setF({ ...f, staffIds: e.target.checked ? [...f.staffIds, s.id] : f.staffIds.filter((x: string) => x !== s.id) })} /> {s.full_name} <span className="muted">{s.title}</span></label>)}</div>
          )}
          <div className="row"><button className="primary" onClick={save}>Tạo kỳ thi</button><button className="ghost" onClick={() => setF(null)}>Hủy</button></div>
        </div>
      )}
    </div>
  );
}

/* ======================= Quy trình kỹ thuật, chấm bảng kiểm ======================= */

function Procedures({ meta, run, canManage }: { meta: Meta; run: Run; canManage: boolean }) {
  const canApprove = ['director', 'admin'].includes(session.user?.role ?? '');
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [check, setCheck] = useState<any>(null);
  const load = () => api<any[]>('GET', '/api/training/procedures').then(setRows);
  useEffect(() => { load().catch(() => {}); }, []);
  const show = (id: string) => run(async () => { setEdit(null); setCheck(null); setOpen(open?.id === id ? null : await api('GET', `/api/training/procedures/${id}`)); });
  const saveEdit = () => run(async () => {
    const body = { title: edit.title, category: edit.category || null, roles: edit.roles.split(',').map((s: string) => s.trim()).filter(Boolean), epcrFlags: edit.epcrFlags.split(',').map((s: string) => s.trim()).filter(Boolean),
      passPct: Number(edit.passPct), privilegeMonths: Number(edit.privilegeMonths), source: edit.source || null, steps: edit.steps };
    if (edit.id) await api('PUT', `/api/training/procedures/${edit.id}`, body);
    else await api('POST', '/api/training/procedures', { ...body, code: edit.code, version: edit.version });
    setEdit(null); setOpen(null); await load();
  }, 'Đã lưu quy trình (dự thảo)');
  const startEdit = (p: any) => setEdit({ ...p, roles: (p.roles ?? []).join(', '), epcrFlags: (p.epcr_flags ?? []).join(', '), passPct: p.pass_pct ?? 80, privilegeMonths: p.privilege_months ?? 12,
    category: p.category ?? '', source: p.source ?? '', steps: (p.steps ?? []).map((s: Step) => ({ text: s.text, critical: s.critical })) });
  const clone = (p: any) => {
    const version = window.prompt(`Phiên bản mới cho ${p.code}:`, '');
    if (version) run(async () => { const r = await api<{ id: string }>('POST', `/api/training/procedures/${p.id}/clone`, { version }); await load(); startEdit(await api('GET', `/api/training/procedures/${r.id}`)); }, 'Đã tạo bản dự thảo');
  };
  if (check) return <SkillCheck meta={meta} run={run} procedure={check} onDone={() => setCheck(null)} />;
  return (
    <div className="col">
      <div className="panel">
        <div className="small muted" style={{ marginBottom: 8 }}>Mỗi quy trình chia theo bước, dùng làm bảng kiểm khi sát hạch thực hành và giám sát tuân thủ. Bước <b>bắt buộc</b> sai là không đạt dù đủ điểm.</div>
        <table>
          <thead><tr><th>Mã</th><th>Tên quy trình</th><th>Nhóm</th><th className="right">Bước</th><th>Đạt</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((p) => (
            <Fragment key={p.id}>
              <tr>
                <td className="mono">{p.code} v{p.version}</td><td><a href="#" onClick={(e) => { e.preventDefault(); show(p.id); }}>{p.title}</a></td><td>{p.category}</td>
                <td className="right">{p.steps} <span className="muted">({p.critical} bắt buộc)</span></td><td>{p.pass_pct}%</td><td><span className="badge">{STATUS[p.status]}</span></td>
                <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  {canManage && p.status === 'hieu_luc' && <button className="primary small" onClick={() => run(async () => setCheck(await api('GET', `/api/training/procedures/${p.id}`)))}>Chấm bảng kiểm</button>}
                  {canManage && p.status === 'du_thao' && <button className="ghost small" onClick={() => run(async () => startEdit(await api('GET', `/api/training/procedures/${p.id}`)))}>Sửa</button>}
                  {canManage && <button className="ghost small" onClick={() => clone(p)}>Nhân bản</button>}
                  {canApprove && p.status === 'du_thao' && <button className="ghost small" onClick={() => run(async () => { await api('POST', `/api/training/procedures/${p.id}/approve`); await load(); }, 'Đã ban hành')}>Ban hành</button>}
                </td>
              </tr>
              {open?.id === p.id && (
                <tr><td colSpan={7}>
                  <div className="small muted">{open.roles?.length ? `Áp dụng: ${open.roles.join(', ')} · ` : ''}Phân quyền {open.privilege_months} tháng{open.source ? ` · ${open.source}` : ''}</div>
                  <ol>{open.steps.map((s: Step) => <li key={s.id}>{s.text}{s.critical && <b className="red"> (bắt buộc)</b>}</li>)}</ol>
                  <button className="ghost small" onClick={() => window.print()}>In bảng kiểm</button>
                </td></tr>
              )}
            </Fragment>))}</tbody>
        </table>
        {canManage && !edit && <button style={{ marginTop: 8 }} onClick={() => setEdit({ code: '', version: '1.0', title: '', category: '', roles: '', epcrFlags: '', passPct: 80, privilegeMonths: 12, source: '', steps: [{ text: '', critical: false }] })}>Thêm quy trình</button>}
      </div>
      {edit && (
        <div className="panel col">
          <b>{edit.id ? `Sửa ${edit.code} v${edit.version}` : 'Quy trình kỹ thuật mới'}</b>
          <div className="grid4">
            {!edit.id && <label className="field">Mã<input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} placeholder="QTKT-CC-08" /></label>}
            {!edit.id && <label className="field">Phiên bản<input value={edit.version} onChange={(e) => setEdit({ ...edit, version: e.target.value })} /></label>}
            <label className="field">Nhóm<input value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} /></label>
            <label className="field">Áp dụng cho<input value={edit.roles} onChange={(e) => setEdit({ ...edit, roles: e.target.value })} placeholder="Bác sĩ, Điều dưỡng" /></label>
            <label className="field">Điểm đạt (%)<input type="number" value={edit.passPct} onChange={(e) => setEdit({ ...edit, passPct: e.target.value })} /></label>
            <label className="field">Phân quyền (tháng)<input type="number" value={edit.privilegeMonths} onChange={(e) => setEdit({ ...edit, privilegeMonths: e.target.value })} /></label>
            <label className="field">Can thiệp ePCR tương ứng<input value={edit.epcrFlags} onChange={(e) => setEdit({ ...edit, epcrFlags: e.target.value })} placeholder="ett, iv, defib" /></label>
          </div>
          <label className="field">Tên quy trình<input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
          {edit.steps.map((s: any, i: number) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <span className="mono">{i + 1}.</span>
              <input style={{ flex: 1 }} value={s.text} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x: any, j: number) => (j === i ? { ...x, text: e.target.value } : x)) })} />
              <label className="row small"><input type="checkbox" checked={s.critical} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x: any, j: number) => (j === i ? { ...x, critical: e.target.checked } : x)) })} /> Bắt buộc</label>
              <button className="ghost small" onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_: any, j: number) => j !== i) })}>Bỏ</button>
            </div>
          ))}
          <button className="ghost small" onClick={() => setEdit({ ...edit, steps: [...edit.steps, { text: '', critical: false }] })}>Thêm bước</button>
          <label className="field">Căn cứ<input value={edit.source} onChange={(e) => setEdit({ ...edit, source: e.target.value })} /></label>
          <div className="row"><button className="primary" onClick={saveEdit}>Lưu</button><button className="ghost" onClick={() => setEdit(null)}>Hủy</button></div>
        </div>
      )}
    </div>
  );
}

/** Phiếu chấm bảng kiểm trên máy tính bảng: chạm Đạt / Không đạt / Không áp dụng cho từng bước */
function SkillCheck({ meta, run, procedure, onDone }: { meta: Meta; run: Run; procedure: any; onDone: () => void }) {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [staffId, setStaffId] = useState('');
  const [kind, setKind] = useState('sat_hach');
  const [res, setRes] = useState<Record<string, boolean | null>>({});
  const [note, setNote] = useState('');
  const [grant, setGrant] = useState(true);
  const [result, setResult] = useState<any>(null);
  useEffect(() => { api<StaffRow[]>('GET', '/api/training/staff').then(setStaff).catch(() => {}); }, []);
  const steps: Step[] = procedure.steps;
  const scored = steps.filter((s) => s.id in res);
  const applicable = scored.filter((s) => res[s.id] !== null);
  const ok = applicable.filter((s) => res[s.id] === true).length;
  const critFail = steps.filter((s) => s.critical && res[s.id] === false).length;
  const pctNow = applicable.length ? Math.round((ok / applicable.length) * 1000) / 10 : 0;
  const save = () => run(async () => {
    setResult(await api('POST', '/api/training/skill-checks', { procedureId: procedure.id, staffId, kind, results: res, note: note || null, grant: kind === 'sat_hach' && grant }));
  });
  const btn = (s: Step, v: boolean | null, label: string) => (
    <button className={`choice ${s.id in res && res[s.id] === v ? 'sel' : ''}`} style={{ minWidth: 90, minHeight: 44 }} onClick={() => setRes({ ...res, [s.id]: v })}>{label}</button>
  );
  if (result) {
    return (
      <div className="col">
        <div className={`alert ${result.passed ? 'green' : 'red'}`}>
          <b>{result.passed ? 'ĐẠT' : 'KHÔNG ĐẠT'}</b>: {result.score_pct}%{result.critical_failed ? ` · sai ${result.critical_failed} bước bắt buộc` : ''}
          {result.privilege && <div>Đã cấp quyền kỹ thuật {result.privilege.procedure_code} đến {d(result.privilege.expires_on)}.</div>}
        </div>
        <div className="row"><button onClick={() => { setResult(null); setRes({}); setStaffId(''); setNote(''); }}>Chấm người tiếp theo</button><button className="ghost" onClick={onDone}>Xong</button></div>
      </div>
    );
  }
  return (
    <div className="col" style={{ maxWidth: 900 }}>
      <div className="panel col">
        <b>{procedure.code} · {procedure.title}</b>
        <div className="grid4">
          <label className="field">Người được chấm<select value={staffId} onChange={(e) => setStaffId(e.target.value)}><option value="">— Chọn —</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}{s.title ? ` (${s.title})` : ''}</option>)}</select></label>
          <label className="field">Hình thức<select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(meta.checkKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {kind === 'sat_hach' && <label className="field row"><input type="checkbox" checked={grant} onChange={(e) => setGrant(e.target.checked)} /> Đạt thì cấp quyền kỹ thuật luôn</label>}
        </div>
      </div>
      {steps.map((s) => (
        <div key={s.id} className="panel row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 240 }}><b>{s.ordinal}.</b> {s.text}{s.critical && <b className="red"> (bắt buộc)</b>}</div>
          <div className="row" style={{ gap: 6 }}>{btn(s, true, 'Đạt')}{btn(s, false, 'Không đạt')}{btn(s, null, 'Không áp dụng')}</div>
        </div>
      ))}
      <div className="panel col">
        <div>Đã chấm {scored.length}/{steps.length} bước · tạm tính {pctNow}% (đạt từ {procedure.pass_pct}%){critFail ? <b className="red"> · sai {critFail} bước bắt buộc</b> : null}</div>
        <label className="field">Nhận xét<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="row"><button className="primary" disabled={!staffId || scored.length < steps.length} onClick={save}>Lưu kết quả</button><button className="ghost" onClick={onDone}>Hủy</button></div>
      </div>
    </div>
  );
}

/* ======================= Nhân viên: chứng nhận, quyền kỹ thuật ======================= */

function StaffTab({ meta, run }: { meta: Meta; run: Run }) {
  const canApprove = ['director', 'admin'].includes(session.user?.role ?? '');
  const [rows, setRows] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [open, setOpen] = useState<any>(null);
  const [q, setQ] = useState('');
  const load = () => Promise.all([api<any[]>('GET', '/api/training/staff').then(setRows), api('GET', '/api/training/settings').then(setSettings)]);
  useEffect(() => { load().catch(() => {}); }, []);
  const show = (id: string) => run(async () => setOpen(open?.id === id ? null : await api('GET', `/api/training/staff/${id}`)));
  const refresh = async () => { await load(); if (open) setOpen(await api('GET', `/api/training/staff/${open.id}`)); };
  const list = rows.filter((r) => !q || `${r.full_name} ${r.code} ${r.title ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="col">
      {settings && (
        <div className="panel row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <span>Yêu cầu chứng nhận Medone để nhận ca: <b>{settings.require_cert ? 'ĐANG BẬT' : 'đang tắt'}</b> · hạn chứng nhận {settings.cert_months} tháng</span>
          {canApprove && <button onClick={() => run(async () => { await api('PUT', '/api/training/settings', { requireCert: !settings.require_cert, certMonths: settings.cert_months }); await load(); }, 'Đã cập nhật')}>{settings.require_cert ? 'Tắt yêu cầu' : 'Bật yêu cầu'}</button>}
          {canApprove && <button className="ghost" onClick={() => { const m = window.prompt('Hạn chứng nhận (tháng):', String(settings.cert_months)); if (m) run(async () => { await api('PUT', '/api/training/settings', { requireCert: settings.require_cert, certMonths: Number(m) }); await load(); }, 'Đã cập nhật'); }}>Đổi hạn</button>}
          <span className="small muted">Cấp chứng nhận khi có bài thi lý thuyết đạt và lượt sát hạch thực hành đạt trong {meta.evidenceDays} ngày gần nhất.</span>
        </div>
      )}
      <div className="panel">
        <input placeholder="Tìm tên, mã, chức danh" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
        <table>
          <thead><tr><th>Nhân viên</th><th>Chức danh</th><th>Chứng nhận</th><th>Bài thi gần nhất</th><th>Thực hành đạt</th><th>Quyền kỹ thuật</th><th /></tr></thead>
          <tbody>{list.map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td><a href="#" onClick={(e) => { e.preventDefault(); show(r.id); }}>{r.full_name}</a> <span className="small muted">{r.code}</span></td><td>{r.title}</td>
                <td>{r.cert_number ? <span className={`badge ${r.cert_expiring ? 'amber' : 'green'}`}>{r.cert_number} · đến {d(r.cert_expires)}</span> : <span className="badge">Chưa có</span>}</td>
                <td>{r.last_exam ? `${r.last_exam.pct}% ${r.last_exam.passed ? '(đạt)' : '(chưa đạt)'}` : '—'}</td>
                <td>{r.recent_checks || '—'}</td><td className="small">{(r.privileges ?? []).join(', ') || '—'}</td>
                <td className="right">{!r.cert_number && r.recent_exam && r.recent_checks > 0 && <button className="primary small" onClick={() => run(async () => { await api('POST', '/api/training/certs', { staffId: r.id }); await refresh(); }, 'Đã cấp chứng nhận')}>Cấp chứng nhận</button>}</td>
              </tr>
              {open?.id === r.id && (
                <tr><td colSpan={7}>
                  <div className="grid4">
                    <div><b>Chứng nhận</b><ul>{open.certs.map((c: any) => <li key={c.id}>{c.number}: {d(c.issued_on)} – {d(c.expires_on)}{c.revoked_at ? ` · thu hồi: ${c.revoke_reason}` : ''}
                      {canApprove && !c.revoked_at && <button className="ghost small" onClick={() => { const reason = window.prompt('Lý do thu hồi:'); if (reason) run(async () => { await api('POST', `/api/training/certs/${c.id}/revoke`, { reason }); await refresh(); }, 'Đã thu hồi'); }}>Thu hồi</button>}</li>)}</ul></div>
                    <div><b>Quyền kỹ thuật</b><ul>{open.privileges.map((p: any) => <li key={p.id}>{p.procedure_code}: {d(p.granted_on)} – {d(p.expires_on)} {p.active ? '' : `(${p.revoke_reason ?? 'hết hạn'})`}
                      {p.active && <button className="ghost small" onClick={() => { const reason = window.prompt('Lý do thu hồi quyền:'); if (reason) run(async () => { await api('POST', `/api/training/privileges/${p.id}/revoke`, { reason }); await refresh(); }, 'Đã thu hồi'); }}>Thu hồi</button>}</li>)}</ul>
                      <button className="ghost small" onClick={() => {
                        const code = window.prompt('Mã quy trình kỹ thuật (ví dụ QTKT-CC-04):'); if (!code) return;
                        const note = window.prompt('Căn cứ cấp quyền khi không qua sát hạch tại Medone (ví dụ chứng chỉ ACLS số...):'); if (!note) return;
                        run(async () => { await api('POST', '/api/training/privileges', { staffId: open.id, procedureCode: code.trim(), note }); await refresh(); }, 'Đã cấp quyền');
                      }}>Cấp quyền theo chứng chỉ ngoài</button></div>
                    <div><b>Bài thi</b><ul>{open.attempts.map((a: any) => <li key={a.id}>{dt(a.submitted_at)} · {a.name}: {a.pct}% {a.passed ? '(đạt)' : ''}</li>)}</ul></div>
                    <div><b>Thực hành</b><ul>{open.checks.map((c: any) => <li key={c.id}>{d(c.at)} · {c.code}: {c.score_pct}% {c.passed ? '(đạt)' : '(chưa đạt)'} · {c.examiner}</li>)}</ul></div>
                  </div>
                </td></tr>
              )}
            </Fragment>))}</tbody>
        </table>
      </div>
    </div>
  );
}

/* ======================= Kế hoạch đào tạo năm ======================= */

function Plan({ meta, run }: { meta: Meta; run: Run }) {
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const [rows, setRows] = useState<any[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [f, setF] = useState<any>(null);
  const [att, setAtt] = useState<{ id: string; heldOn: string; staffIds: string[] } | null>(null);
  const load = () => api<any[]>('GET', `/api/training/plan?year=${year}`).then(setRows);
  useEffect(() => { load().catch(() => {}); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api<StaffRow[]>('GET', '/api/training/staff').then(setStaff).catch(() => {}); }, []);
  const titles = useMemo(() => [...new Set(staff.map((s) => s.title).filter(Boolean) as string[])].sort(), [staff]);
  const save = () => run(async () => {
    const body = { year, title: f.title, kind: f.kind, hours: Number(f.hours), plannedMonth: Number(f.plannedMonth), targetTitles: f.targetTitles, procedureCode: f.procedureCode || null, trainer: f.trainer || null, provider: f.provider || null, note: f.note || null };
    await api(f.id ? 'PUT' : 'POST', f.id ? `/api/training/plan/${f.id}` : '/api/training/plan', body);
    setF(null); await load();
  }, 'Đã lưu');
  const openAtt = (p: any) => setAtt({ id: p.id, heldOn: today(), staffIds: staff.filter((s) => !p.target_titles.length || p.target_titles.includes(s.title)).map((s) => s.id) });
  return (
    <div className="col">
      <div className="panel">
        <div className="row" style={{ gap: 8 }}>
          <label className="field">Năm<input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 100 }} /></label>
          <button onClick={() => setF({ title: '', kind: 'cme', hours: 4, plannedMonth: 1, targetTitles: [], procedureCode: '', trainer: '', provider: '', note: '' })}>Thêm lớp</button>
          <span className="small muted">Kết thúc lớp và điểm danh thì giờ đào tạo tự ghi vào hồ sơ từng người.</span>
        </div>
        <table>
          <thead><tr><th>Tháng</th><th>Lớp</th><th>Loại</th><th className="right">Giờ</th><th>Đối tượng</th><th className="right">Có mặt / cần học</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id}>
              <td>{p.planned_month}</td><td>{p.title}{p.trainer ? <div className="small muted">{p.trainer}</div> : null}</td><td>{meta.trainingKinds[p.kind] ?? p.kind}</td><td className="right">{p.hours}</td>
              <td className="small">{p.target_titles.join(', ') || 'Mọi người'}</td><td className="right">{p.attendees}/{p.target}</td>
              <td><span className="badge">{PLAN_STATUS[p.status]}</span>{p.held_on && <div className="small muted">{d(p.held_on)}</div>}</td>
              <td className="right" style={{ whiteSpace: 'nowrap' }}>{p.status === 'ke_hoach' && <>
                <button className="primary small" onClick={() => openAtt(p)}>Kết thúc, điểm danh</button>
                <button className="ghost small" onClick={() => setF({ ...p, plannedMonth: p.planned_month, targetTitles: p.target_titles, procedureCode: p.procedure_code ?? '', trainer: p.trainer ?? '', provider: p.provider ?? '', note: p.note ?? '' })}>Sửa</button>
                <button className="ghost small" onClick={() => { const reason = window.prompt('Lý do hủy lớp:'); if (reason) run(async () => { await api('POST', `/api/training/plan/${p.id}/cancel`, { reason }); await load(); }, 'Đã hủy'); }}>Hủy</button>
              </>}</td>
            </tr>))}</tbody>
        </table>
      </div>
      {f && (
        <div className="panel col">
          <b>{f.id ? 'Sửa lớp' : 'Lớp mới'}</b>
          <div className="grid4">
            <label className="field">Tên lớp<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
            <label className="field">Loại<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(meta.trainingKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Số giờ (tiết)<input type="number" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></label>
            <label className="field">Tháng dự kiến<input type="number" min={1} max={12} value={f.plannedMonth} onChange={(e) => setF({ ...f, plannedMonth: e.target.value })} /></label>
            <label className="field">Giảng viên<input value={f.trainer} onChange={(e) => setF({ ...f, trainer: e.target.value })} /></label>
            <label className="field">Đơn vị tổ chức<input value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} /></label>
            <label className="field">Quy trình kỹ thuật liên quan<input value={f.procedureCode} onChange={(e) => setF({ ...f, procedureCode: e.target.value })} placeholder="QTKT-CC-01" /></label>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>Đối tượng: {titles.map((t) => <label key={t} className="row"><input type="checkbox" checked={f.targetTitles.includes(t)} onChange={(e) => setF({ ...f, targetTitles: e.target.checked ? [...f.targetTitles, t] : f.targetTitles.filter((x: string) => x !== t) })} /> {t}</label>)}<span className="small muted">(không chọn = mọi người)</span></div>
          <div className="row"><button className="primary" onClick={save}>Lưu</button><button className="ghost" onClick={() => setF(null)}>Hủy</button></div>
        </div>
      )}
      {att && (
        <div className="panel col">
          <b>Điểm danh và kết thúc lớp</b>
          <label className="field">Ngày tổ chức<input type="date" value={att.heldOn} onChange={(e) => setAtt({ ...att, heldOn: e.target.value })} /></label>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>{staff.map((s) => <label key={s.id} className="row"><input type="checkbox" checked={att.staffIds.includes(s.id)} onChange={(e) => setAtt({ ...att, staffIds: e.target.checked ? [...att.staffIds, s.id] : att.staffIds.filter((x) => x !== s.id) })} /> {s.full_name} <span className="muted">{s.title}</span></label>)}</div>
          <div className="row"><button className="primary" onClick={() => run(async () => { await api('POST', `/api/training/plan/${att.id}/close`, { heldOn: att.heldOn, staffIds: att.staffIds }); setAtt(null); await load(); }, 'Đã ghi giờ đào tạo cho người có mặt')}>Kết thúc lớp ({att.staffIds.length} người)</button><button className="ghost" onClick={() => setAtt(null)}>Hủy</button></div>
        </div>
      )}
    </div>
  );
}

/* ======================= Báo cáo ======================= */

function Report({ meta }: { meta: Meta }) {
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const [r, setR] = useState<any>(null);
  useEffect(() => { api('GET', `/api/training/report?year=${year}`).then(setR).catch(() => {}); }, [year]);
  if (!r) return null;
  return (
    <div className="col">
      <div className="row no-print" style={{ gap: 8 }}>
        <label className="field">Năm<input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 100 }} /></label>
        <button className="ghost" onClick={() => window.print()}>In</button>
      </div>
      <div className="grid4">
        <Stat label="Nhân viên đang làm" value={r.staff} />
        <Stat label="Được đào tạo trong năm" value={`${r.trained.staff} (${r.trained.pct}%)`} />
        <Stat label="Có chứng nhận Medone còn hạn" value={`${r.certified.staff} (${r.certified.pct}%)`} />
        <Stat label="Kế hoạch đã thực hiện" value={`${r.plan.held}/${r.plan.items} lớp (${r.plan.pct}%)`} />
        <Stat label="Tổng giờ đào tạo" value={r.trained.hours} />
        <Stat label="Lượt thi (đạt)" value={`${r.exams.attempts} (${r.exams.passed})`} />
        <Stat label="Điểm thi trung bình" value={r.exams.avg_pct != null ? `${r.exams.avg_pct}%` : '—'} />
        <Stat label="Chấm thực hành (giám sát)" value={`${r.checks.n} (${r.checks.audits})`} />
      </div>
      <div className="small muted">Số liệu dùng cho các tiêu chí chất lượng về đào tạo, sát hạch, phân quyền kỹ thuật (ví dụ tỷ lệ nhân viên được tập huấn, có quy trình kỹ thuật và giám sát tuân thủ).</div>
      <div className="panel">
        <b>Theo loại đào tạo</b>
        <table><thead><tr><th>Loại</th><th className="right">Người</th><th className="right">Giờ</th></tr></thead>
          <tbody>{r.byKind.map((k: any) => <tr key={k.kind}><td>{meta.trainingKinds[k.kind] ?? k.kind}</td><td className="right">{k.staff}</td><td className="right">{k.hours}</td></tr>)}</tbody></table>
      </div>
      <div className="panel">
        <b>Phân quyền kỹ thuật theo quy trình</b>
        <table><thead><tr><th>Quy trình</th><th className="right">Số người được phân quyền</th></tr></thead>
          <tbody>{r.privileges.map((p: any) => <tr key={p.code}><td>{p.code} {p.title}</td><td className="right">{p.staff}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}
