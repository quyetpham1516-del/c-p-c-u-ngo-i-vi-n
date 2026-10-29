'use client';
import { useEffect, useState } from 'react';
import { api, session } from '../api';

export const PHASE_LABEL: Record<string, string> = { dau_ca: 'Đầu ca', hien_truong: 'Tại hiện trường', sau_ca: 'Sau ca, về trạm' };
type Task = { phase: string; task: string };

function TaskList({ tasks }: { tasks: Task[] }) {
  return (
    <div className="grid3" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
      {Object.entries(PHASE_LABEL).map(([k, l]) => (
        <div key={k}>
          <b className="small">{l}</b>
          <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
            {tasks.filter((t) => t.phase === k).map((t, i) => <li key={i}>{t.task}</li>)}
            {!tasks.some((t) => t.phase === k) && <li className="muted">Chưa có</li>}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Việc của tôi trong ca: theo vị trí đang nhận trên xe hoặc vị trí được xếp trong ca trực */
export function MyDutyTasks({ refreshKey }: { refreshKey?: unknown }) {
  const [d, setD] = useState<{ position: string | null; vehicleId: string | null; tasks: Task[] } | null>(null);
  useEffect(() => { api('GET', '/api/duty-tasks/mine').then(setD).catch(() => {}); }, [refreshKey]);
  if (!d?.position) return null;
  return (
    <details className="panel" open>
      <summary><b>Việc của {d.position}</b> {d.vehicleId && <span className="small muted">xe {d.vehicleId}</span>}</summary>
      <TaskList tasks={d.tasks} />
    </details>
  );
}

/**
 * Danh mục việc của từng vị trí trong kíp. Chưa khóa cấu hình: quản trị sửa thẳng.
 * Đã khóa: trưởng nhóm kíp sửa thì thành đề xuất, quản trị duyệt.
 */
export function DutyTasksAdmin() {
  const role = session.user?.role ?? '';
  const [rows, setRows] = useState<{ position: string; tasks: Task[] }[]>([]);
  const [gov, setGov] = useState<any>(null);
  const [edit, setEdit] = useState<{ position: string; tasks: Task[] } | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<any[]>('GET', '/api/duty-tasks').then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); api('GET', '/api/governance').then(setGov).catch(() => {}); }, []);
  const isLead = gov?.myDomains?.some((d: any) => d.domain === 'kip' || d.domain === 'ban_giam_doc');
  const canEdit = gov && (gov.enforced ? isLead : role === 'admin');
  const save = async () => {
    if (!edit) return;
    setError(''); setMsg('');
    try {
      const r = await api('PUT', `/api/duty-tasks/${encodeURIComponent(edit.position)}`, { tasks: edit.tasks.filter((t) => t.task.trim()) });
      setMsg(r?.proposal ? `Đã gửi đề xuất ${r.code}, chờ quản trị duyệt` : `Đã lưu việc của ${edit.position}`);
      setEdit(null); await load();
    } catch (e) { setError((e as Error).message); }
  };
  const setTask = (i: number, patch: Partial<Task>) => edit && setEdit({ ...edit, tasks: edit.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  return (
    <div className="panel col">
      <h3 style={{ margin: 0 }}>Việc của từng vị trí trong kíp</h3>
      <div className="small muted">Đổi người giữa các vị trí trong ca không cần duyệt. Sửa danh sách việc: {gov?.enforced ? 'trưởng nhóm kíp đề xuất, quản trị duyệt.' : 'quản trị sửa thẳng khi chưa khóa cấu hình.'}
        {' '}Việc ban đầu là bản nháp để trưởng nhóm sửa.</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {rows.map((r) => (
        <details key={r.position}>
          <summary><b>{r.position}</b> <span className="small muted">{r.tasks.length} việc</span></summary>
          {edit?.position === r.position ? (
            <div className="col" style={{ gap: 4, marginTop: 6 }}>
              {edit.tasks.map((t, i) => (
                <div className="row" key={i}>
                  <select value={t.phase} onChange={(e) => setTask(i, { phase: e.target.value })}>
                    {Object.entries(PHASE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <input value={t.task} onChange={(e) => setTask(i, { task: e.target.value })} style={{ flex: 1 }} />
                  <button className="ghost" onClick={() => setEdit({ ...edit, tasks: edit.tasks.filter((_, j) => j !== i) })}>Bỏ</button>
                </div>
              ))}
              <div className="row">
                <button className="ghost" onClick={() => setEdit({ ...edit, tasks: [...edit.tasks, { phase: 'hien_truong', task: '' }] })}>Thêm việc</button>
                <button onClick={save}>{gov?.enforced ? 'Gửi đề xuất' : 'Lưu'}</button>
                <button className="ghost" onClick={() => setEdit(null)}>Thôi</button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 6 }}>
              <TaskList tasks={r.tasks} />
              {canEdit && <button className="ghost" onClick={() => setEdit({ position: r.position, tasks: r.tasks.map((t) => ({ ...t })) })}>Sửa</button>}
            </div>
          )}
        </details>
      ))}
    </div>
  );
}
