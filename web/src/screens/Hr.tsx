import { useEffect, useMemo, useState } from 'react';
import { api, download, session } from '../api';
import { useStations } from '../catalog';

interface Meta {
  docKinds: Record<string, string>; trainingKinds: Record<string, string>; shifts: Record<string, { label: string; hours: number }>;
  leaveKinds: Record<string, string>; cmeRequiredHours: number; expiryWarnDays: number;
}
const STATUS: Record<string, string> = { dang_lam: 'Đang làm', tam_nghi: 'Tạm nghỉ', nghi_viec: 'Nghỉ việc' };
const CONTRACT: Record<string, string> = { thu_viec: 'Thử việc', xac_dinh: 'Xác định thời hạn', khong_xac_dinh: 'Không xác định thời hạn', cong_tac_vien: 'Cộng tác viên' };
const LSTATUS: Record<string, string> = { cho_duyet: 'Chờ duyệt', da_duyet: 'Đã duyệt', tu_choi: 'Từ chối', huy: 'Hủy' };
const TABS = ['Nhân viên', 'Giấy tờ hết hạn', 'Lịch trực', 'Nghỉ phép', 'Bảng công', 'Chấm công QR'] as const;
const vnDate = (d = 0) => new Date(Date.now() + 7 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const dm = (s: string) => s.slice(8, 10) + '/' + s.slice(5, 7);

/** Nhân sự: hồ sơ, giấy tờ hành nghề (chặn nhận ca khi hết hạn), đào tạo, lịch trực, nghỉ phép, bảng công */
export function Hr() {
  const role = session.user?.role ?? '';
  const canEdit = ['hr', 'admin'].includes(role);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Nhân viên');
  const [summary, setSummary] = useState<any>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api<Meta>('GET', '/api/hr/meta').then(setMeta).catch((e) => setError(e.message));
    api('GET', '/api/hr/summary').then(setSummary).catch(() => {});
  }, [tab]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  if (!meta) return <div className="panel">{error || 'Đang tải…'}</div>;
  const ctx = { meta, canEdit, run };
  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Nhân sự</h2>
      {summary && (
        <div className="grid4">
          <Stat label="Đang làm" value={summary.active} />
          <Stat label="Có lịch trực hôm nay" value={summary.rostered_today} />
          <Stat label="Nghỉ hôm nay / đơn chờ duyệt" value={`${summary.on_leave_today} / ${summary.leave_pending}`} />
          <Stat label="Hợp đồng hết hạn trong 30 ngày" value={summary.contracts_ending} />
        </div>
      )}
      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); setMsg(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {tab === 'Nhân viên' && <StaffTab {...ctx} />}
      {tab === 'Giấy tờ hết hạn' && <ExpiringTab {...ctx} />}
      {tab === 'Lịch trực' && <RosterTab {...ctx} />}
      {tab === 'Nghỉ phép' && <LeaveTab {...ctx} />}
      {tab === 'Bảng công' && <TimesheetTab {...ctx} />}
      {tab === 'Chấm công QR' && <QrAttendanceTab {...ctx} />}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return <div className={`panel ${tone ?? ''}`} style={{ padding: 12, marginTop: 0 }}><div className="small muted">{label}</div><div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div></div>;
}

type Ctx = { meta: Meta; canEdit: boolean; run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean> };

function StaffTab({ meta, canEdit, run }: Ctx) {
  const [stations] = useStations();
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('dang_lam');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [nf, setNf] = useState({ fullName: '', title: '', stationId: '', phone: '' });
  const load = () => api<any[]>('GET', `/api/hr/staff?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setRows);
  useEffect(() => { load().catch(() => {}); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col">
      <div className="row">
        <input placeholder="Tìm tên hoặc mã NV" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <button onClick={() => load()}>Tìm</button>
        {canEdit && <button className="primary" onClick={() => setAdding(!adding)}>+ Nhân viên chưa có tài khoản</button>}
      </div>
      {adding && (
        <div className="panel grid4">
          <label className="field">Họ tên<input value={nf.fullName} onChange={(e) => setNf({ ...nf, fullName: e.target.value })} /></label>
          <label className="field">Chức danh<input value={nf.title} onChange={(e) => setNf({ ...nf, title: e.target.value })} placeholder="Lái xe, Điều dưỡng..." /></label>
          <label className="field">Điểm<select value={nf.stationId} onChange={(e) => setNf({ ...nf, stationId: e.target.value })}><option value="">—</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
          <label className="field">Điện thoại<input value={nf.phone} onChange={(e) => setNf({ ...nf, phone: e.target.value })} /></label>
          <div><button className="primary" disabled={nf.fullName.trim().length < 2} onClick={async () => {
            if (await run(() => api('POST', '/api/hr/staff', { ...nf, stationId: nf.stationId || null, title: nf.title || null, phone: nf.phone || null }), 'Đã thêm nhân viên. Admin tạo tài khoản ở trang Quản trị nếu cần đăng nhập.')) {
              setAdding(false); setNf({ fullName: '', title: '', stationId: '', phone: '' }); load();
            }
          }}>Lưu</button></div>
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Mã</th><th>Họ tên</th><th>Chức danh</th><th>Điểm</th><th>Tài khoản</th><th>Giấy tờ</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.code}</td><td><b>{r.full_name}</b></td><td>{r.title}</td><td>{r.station_id}</td>
              <td className="small">{r.username ?? '—'}</td>
              <td className="small">
                {r.blocking.length > 0 && <span className="badge far">Chặn nhận ca</span>}
                {r.blocking.concat(r.warnings).map((w: string) => <div key={w}>{w}</div>)}
                {!r.blocking.length && !r.warnings.length && <span className="muted">Đủ</span>}
              </td>
              <td className="right"><button className="ghost small" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Đóng' : 'Hồ sơ'}</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {open && <StaffDetail key={open} id={open} meta={meta} canEdit={canEdit} run={run} onChange={load} />}
    </div>
  );
}

function StaffDetail({ id, meta, canEdit, run, onChange }: Ctx & { id: string; onChange: () => void }) {
  const [stations] = useStations();
  const [s, setS] = useState<any>(null);
  const [doc, setDoc] = useState({ kind: 'gphn', number: '', issuer: '', issuedOn: '', expiresOn: '' });
  const [tr, setTr] = useState({ course: '', kind: 'cme', hours: '', completedOn: vnDate(), provider: '' });
  const load = () => api('GET', `/api/hr/staff/${id}`).then(setS);
  useEffect(() => { load().catch(() => {}); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const save = (patch: Record<string, unknown>) => run(async () => { await api('PATCH', `/api/hr/staff/${id}`, patch); await load(); onChange(); }, 'Đã lưu hồ sơ.');
  return (
    <div className="panel col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{s.code} · {s.full_name}</h3>
        {s.blocking.length > 0 && <div className="alert red small">Không nhận ca trên xe được: {s.blocking.join('; ')}</div>}
      </div>
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid4">
          <label className="field">Chức danh<input defaultValue={s.title ?? ''} onBlur={(e) => e.target.value !== (s.title ?? '') && save({ title: e.target.value || null })} /></label>
          <label className="field">Khoa/phòng<input defaultValue={s.department ?? ''} onBlur={(e) => e.target.value !== (s.department ?? '') && save({ department: e.target.value || null })} /></label>
          <label className="field">Điểm<select value={s.station_id ?? ''} onChange={(e) => save({ stationId: e.target.value || null })}><option value="">—</option>{stations.map((x) => <option key={x.id} value={x.id}>{x.id}</option>)}</select></label>
          <label className="field">Trạng thái<select value={s.status} onChange={(e) => { if (e.target.value !== 'nghi_viec' || confirm('Nghỉ việc sẽ khóa tài khoản đăng nhập. Tiếp tục?')) save({ status: e.target.value }); }}>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Điện thoại<input defaultValue={s.phone ?? ''} onBlur={(e) => e.target.value !== (s.phone ?? '') && save({ phone: e.target.value || null })} /></label>
          <label className="field">Ngày vào làm<input type="date" defaultValue={s.hire_date ?? ''} onBlur={(e) => e.target.value !== (s.hire_date ?? '') && save({ hireDate: e.target.value || null })} /></label>
          <label className="field">Loại hợp đồng<select value={s.contract_type ?? ''} onChange={(e) => save({ contractType: e.target.value || null })}><option value="">—</option>{Object.entries(CONTRACT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Hết hạn hợp đồng<input type="date" defaultValue={s.contract_end ?? ''} onBlur={(e) => e.target.value !== (s.contract_end ?? '') && save({ contractEnd: e.target.value || null })} /></label>
        </div>
      </fieldset>
      <div className="grid2">
        <div className="col">
          <h4 style={{ margin: 0 }}>Giấy tờ hành nghề {s.required.length > 0 && <span className="small muted">bắt buộc: {s.required.map((k: string) => meta.docKinds[k]).join(', ')}</span>}</h4>
          <table><tbody>{s.docs.map((d: any) => (
            <tr key={d.id}>
              <td>{meta.docKinds[d.kind]}<div className="small mono">{d.number}</div></td>
              <td className="small">{d.expires_on ? `hết hạn ${d.expires_on}` : 'không thời hạn'}</td>
              <td>{d.suspended ? <span className="badge far">Đình chỉ</span> : d.expired ? <span className="badge far">Hết hạn</span> : <span className="badge">Còn hiệu lực</span>}</td>
              <td className="right">{canEdit && <button className="ghost small" onClick={() => run(async () => { await api('PATCH', `/api/hr/docs/${d.id}`, { suspended: !d.suspended }); await load(); onChange(); })}>{d.suspended ? 'Bỏ đình chỉ' : 'Đình chỉ'}</button>}</td>
            </tr>))}</tbody></table>
          {canEdit && (
            <div className="grid3">
              <select value={doc.kind} onChange={(e) => setDoc({ ...doc, kind: e.target.value })}>{Object.entries(meta.docKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <input placeholder="Số" value={doc.number} onChange={(e) => setDoc({ ...doc, number: e.target.value })} />
              <input placeholder="Nơi cấp" value={doc.issuer} onChange={(e) => setDoc({ ...doc, issuer: e.target.value })} />
              <label className="small">Ngày cấp<input type="date" value={doc.issuedOn} onChange={(e) => setDoc({ ...doc, issuedOn: e.target.value })} /></label>
              <label className="small">Hết hạn<input type="date" value={doc.expiresOn} onChange={(e) => setDoc({ ...doc, expiresOn: e.target.value })} /></label>
              <button disabled={!doc.number.trim()} onClick={async () => {
                if (await run(() => api('POST', `/api/hr/staff/${id}/docs`, { ...doc, issuer: doc.issuer || null, issuedOn: doc.issuedOn || null, expiresOn: doc.expiresOn || null }), 'Đã thêm giấy tờ.')) {
                  setDoc({ ...doc, number: '', issuer: '', issuedOn: '', expiresOn: '' }); load(); onChange();
                }
              }}>Thêm giấy tờ</button>
            </div>
          )}
        </div>
        <div className="col">
          <h4 style={{ margin: 0 }}>Đào tạo {s.required.includes('gphn') && <span className="small muted">cập nhật kiến thức 5 năm: {s.cmeHours}/{meta.cmeRequiredHours} tiết</span>}</h4>
          <table><tbody>{s.trainings.map((t: any) => <tr key={t.id}><td>{t.course}<div className="small muted">{meta.trainingKinds[t.kind]}</div></td><td className="small">{t.hours} tiết</td><td className="small">{t.completed_on}</td></tr>)}</tbody></table>
          {canEdit && (
            <div className="grid3">
              <input placeholder="Khóa học" value={tr.course} onChange={(e) => setTr({ ...tr, course: e.target.value })} />
              <select value={tr.kind} onChange={(e) => setTr({ ...tr, kind: e.target.value })}>{Object.entries(meta.trainingKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <input type="number" placeholder="Số tiết" value={tr.hours} onChange={(e) => setTr({ ...tr, hours: e.target.value })} />
              <input type="date" value={tr.completedOn} onChange={(e) => setTr({ ...tr, completedOn: e.target.value })} />
              <input placeholder="Đơn vị đào tạo" value={tr.provider} onChange={(e) => setTr({ ...tr, provider: e.target.value })} />
              <button disabled={tr.course.trim().length < 2} onClick={async () => {
                if (await run(() => api('POST', `/api/hr/staff/${id}/trainings`, { ...tr, hours: Number(tr.hours || 0), provider: tr.provider || null }), 'Đã ghi đào tạo.')) {
                  setTr({ ...tr, course: '', hours: '', provider: '' }); load(); onChange();
                }
              }}>Ghi đào tạo</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExpiringTab({ meta }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api<any[]>('GET', '/api/hr/expiring').then(setRows).catch(() => {}); }, []);
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <div className="small muted">Giấy tờ đã hết hạn, bị đình chỉ hoặc hết hạn trong {meta.expiryWarnDays} ngày tới và chưa có bản mới. Giấy phép hành nghề, bằng lái hết hạn sẽ chặn nhận ca trên xe.</div>
      <table>
        <thead><tr><th>Nhân viên</th><th>Giấy tờ</th><th>Số</th><th>Hết hạn</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td><b>{r.full_name}</b><div className="small muted">{r.code} · {r.title} · {r.station_id}</div></td><td>{meta.docKinds[r.kind]}</td>
            <td className="mono small">{r.number}</td><td>{r.expires_on}</td>
            <td>{r.suspended ? <span className="badge far">Đình chỉ</span> : r.expired ? <span className="badge far">Đã hết hạn</span> : <span className="badge">Sắp hết hạn</span>}</td></tr>
        ))}</tbody>
      </table>
      {!rows.length && <div className="small muted">Không có giấy tờ nào cần xử lý.</div>}
    </div>
  );
}

function RosterTab({ meta, run }: Ctx) {
  const [stations] = useStations();
  const [from, setFrom] = useState(vnDate());
  const [rows, setRows] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [f, setF] = useState({ staffId: '', workDate: vnDate(), shift: 'ngay', stationId: '', vehicleId: '', note: '' });
  const [rest, setRest] = useState(false);
  const canRoster = ['hr', 'admin', 'supervisor'].includes(session.user?.role ?? '');
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(from + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); }), [from]);
  const load = () => api<any[]>('GET', `/api/hr/roster?from=${days[0]}&to=${days[6]}`).then(setRows);
  useEffect(() => { load().catch(() => {}); }, [days]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (canRoster) api<any[]>('GET', '/api/hr/staff?status=dang_lam').then(setStaff).catch(() => {}); }, [canRoster]);
  const add = async (override = false) => {
    setRest(false);
    try {
      await api('POST', '/api/hr/roster', { ...f, stationId: f.stationId || null, vehicleId: f.vehicleId || null, note: f.note || null, override });
      await run(async () => {}, 'Đã xếp ca.'); load();
    } catch (e: any) {
      if (e.body?.details?.code === 'REST') setRest(true);
      await run(() => Promise.reject(e));
    }
  };
  const byStaff = new Map<string, any[]>();
  for (const r of rows) byStaff.set(r.staff_id, [...(byStaff.get(r.staff_id) ?? []), r]);
  const SHORT: Record<string, string> = { ngay: 'N', dem: 'Đ', truc_24: '24', hanh_chinh: 'HC' };
  return (
    <div className="col">
      <div className="row">
        <button onClick={() => setFrom(days[0] && new Date(new Date(days[0]).getTime() - 7 * 86400_000).toISOString().slice(0, 10))}>← Tuần trước</button>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <button onClick={() => setFrom(new Date(new Date(days[6]).getTime() + 86400_000).toISOString().slice(0, 10))}>Tuần sau →</button>
        <span className="small muted">N: ca ngày, Đ: ca đêm, 24: trực 24 giờ, HC: hành chính</span>
      </div>
      {canRoster && (
        <div className="panel col">
          <div className="grid4">
            <label className="field">Nhân viên<select value={f.staffId} onChange={(e) => setF({ ...f, staffId: e.target.value })}><option value="">— Chọn —</option>
              {staff.map((s) => <option key={s.id} value={s.id} disabled={s.blocking.length > 0}>{s.full_name} ({s.title ?? ''}){s.blocking.length ? ' – giấy tờ hết hạn' : ''}</option>)}</select></label>
            <label className="field">Ngày<input type="date" value={f.workDate} onChange={(e) => setF({ ...f, workDate: e.target.value })} /></label>
            <label className="field">Ca<select value={f.shift} onChange={(e) => setF({ ...f, shift: e.target.value })}>{Object.entries(meta.shifts).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
            <label className="field">Điểm<select value={f.stationId} onChange={(e) => setF({ ...f, stationId: e.target.value })}><option value="">—</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
            <label className="field">Xe<input value={f.vehicleId} onChange={(e) => setF({ ...f, vehicleId: e.target.value.toUpperCase() })} placeholder="MD-ALS-01" /></label>
            <label className="field">Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            <div className="row"><button className="primary" disabled={!f.staffId} onClick={() => add()}>Xếp ca</button></div>
          </div>
          {rest && <div className="alert amber row">Người này vừa trực đêm/24 giờ hôm trước. Nếu bắt buộc phải xếp, ghi lý do vào ô Ghi chú rồi bấm
            <button className="danger small" disabled={!f.note.trim()} onClick={() => add(true)}>Vẫn xếp (ghi vết)</button></div>}
        </div>
      )}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Nhân viên</th>{days.map((d) => <th key={d}>{dm(d)}</th>)}</tr></thead>
          <tbody>{[...byStaff.entries()].map(([sid, list]) => (
            <tr key={sid}>
              <td><b>{list[0].full_name}</b><div className="small muted">{list[0].title}</div></td>
              {days.map((d) => <td key={d}>{list.filter((r) => r.work_date === d).map((r) => (
                <span key={r.id} className="badge" title={`${meta.shifts[r.shift].label}${r.vehicle_id ? ` · ${r.vehicle_id}` : ''}${r.note ? ` · ${r.note}` : ''}`}
                  onDoubleClick={() => canRoster && confirm('Xóa ca này?') && run(async () => { await api('DELETE', `/api/hr/roster/${r.id}`); await load(); })}>
                  {SHORT[r.shift]}{r.vehicle_id ? ` ${r.vehicle_id.replace('MD-', '')}` : ''}</span>))}</td>)}
            </tr>
          ))}</tbody>
        </table>
        {!rows.length && <div className="small muted">Tuần này chưa xếp lịch.</div>}
        {canRoster && rows.length > 0 && <div className="small muted">Bấm đúp vào một ca để xóa.</div>}
      </div>
    </div>
  );
}

function LeaveTab({ meta, run }: Ctx) {
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState('cho_duyet');
  const load = () => api<any[]>('GET', `/api/hr/leave${status ? `?status=${status}` : ''}`).then(setRows);
  useEffect(() => { load().catch(() => {}); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const decide = (id: string, approve: boolean) => run(async () => {
    const r = await api<{ rosterClash: any[] }>('POST', `/api/hr/leave/${id}/decide`, { approve });
    await load();
    if (r.rosterClash?.length) alert(`Đã duyệt. Người này đang có ${r.rosterClash.length} ca trong lịch trực những ngày nghỉ: xếp người thay ở thẻ Lịch trực.`);
  }, approve ? 'Đã duyệt đơn nghỉ.' : 'Đã từ chối.');
  return (
    <div className="panel col" style={{ overflowX: 'auto' }}>
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 200 }}>
        <option value="">Mọi trạng thái</option>{Object.entries(LSTATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <table>
        <thead><tr><th>Nhân viên</th><th>Loại</th><th>Từ</th><th>Đến</th><th>Lý do</th><th>Trạng thái</th><th /></tr></thead>
        <tbody>{rows.map((l) => (
          <tr key={l.id}><td><b>{l.full_name}</b><div className="small muted">{l.code} · {l.title}</div></td><td>{meta.leaveKinds[l.kind]}</td>
            <td>{l.from_date}</td><td>{l.to_date}</td><td className="small">{l.reason}</td>
            <td>{LSTATUS[l.status]}{l.decided_by_name && <div className="small muted">{l.decided_by_name}</div>}</td>
            <td className="right">{l.status === 'cho_duyet' && <><button className="primary small" onClick={() => decide(l.id, true)}>Duyệt</button> <button className="ghost small" onClick={() => decide(l.id, false)}>Từ chối</button></>}</td></tr>
        ))}</tbody>
      </table>
      {!rows.length && <div className="small muted">Không có đơn.</div>}
    </div>
  );
}

function TimesheetTab({ run }: Ctx) {
  const [month, setMonth] = useState(vnDate().slice(0, 7));
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api<any[]>('GET', `/api/hr/timesheet?month=${month}`).then(setRows).catch(() => {}); }, [month]);
  return (
    <div className="panel col" style={{ overflowX: 'auto' }}>
      <div className="row">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        <button onClick={() => run(() => download(`/api/hr/timesheet?month=${month}&format=csv`, `bang-cong-${month}.csv`))}>Tải bảng công (Excel/CSV)</button>
        <span className="small muted">Giờ trên xe lấy từ lúc kíp bắt đầu đến kết thúc ca trên máy tính bảng; nhân viên văn phòng chấm công bằng mã QR tại trạm (tab Chấm công QR) hoặc bấm tay ở trang Cá nhân.</span>
      </div>
      <table>
        <thead><tr><th>Mã</th><th>Họ tên</th><th>Ca theo lịch</th><th>Giờ theo lịch</th><th>Ca đêm/24h</th><th>Giờ trên xe</th><th>Giờ chấm công</th><th>Tổng thực tế</th><th>Ngày nghỉ</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td className="mono">{r.code}</td><td>{r.full_name}<div className="small muted">{r.title}</div></td><td>{r.shifts}</td><td>{r.planned_hours}</td>
            <td>{r.night_shifts}</td><td>{r.crew_hours}</td><td>{r.office_hours}</td>
            <td><b>{r.actual_hours}</b>{r.planned_hours > 0 && r.actual_hours < r.planned_hours * 0.9 && <span className="badge far" style={{ marginLeft: 4 }}>thiếu giờ</span>}</td><td>{r.leave_days}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/* ---------- Chấm công QR tại trạm ---------- */

const AFLAG: Record<string, string> = { khong_vi_tri: 'Không vị trí', sai_so_lon: 'Sai số lớn', ra_khac_tram: 'Ra trạm khác', thu_cong: 'Bấm tay' };
const hm = (d: string | null) => d ? new Date(d).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }) : '';

function QrAttendanceTab({ canEdit, run }: Ctx) {
  const [stations, setStations] = useState<any[]>([]);
  const [day, setDay] = useState(vnDate());
  const [station, setStation] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [log, setLog] = useState<any[]>([]);
  const [issued, setIssued] = useState<{ name: string; url: string } | null>(null);
  const loadStations = () => api<any[]>('GET', '/api/attendance/stations').then(setStations).catch(() => {});
  useEffect(() => { loadStations(); }, []);
  useEffect(() => {
    const q = new URLSearchParams({ date: day, ...(station ? { stationId: station } : {}), ...(flagged ? { flagged: '1' } : {}) });
    api<any[]>('GET', `/api/attendance/log?${q}`).then(setLog).catch(() => {});
  }, [day, station, flagged]);
  const issue = (s: any) => {
    if (s.configured && !confirm(`Cấp lại máy chấm công cho ${s.name}? Máy đang dùng sẽ ngừng hiện mã cho đến khi mở đường dẫn mới.`)) return;
    run(async () => {
      const r = await api<any>('POST', `/api/attendance/stations/${encodeURIComponent(s.id)}/kiosk`);
      setIssued({ name: r.name, url: window.location.origin + r.kioskPath });
      await loadStations();
    });
  };
  const patch = (s: any, body: object) => run(async () => { await api('PATCH', `/api/attendance/stations/${encodeURIComponent(s.id)}`, body); await loadStations(); }, 'Đã lưu.');
  const revoke = (s: any) => confirm(`Thu hồi máy chấm công của ${s.name}? Mã trên máy đó sẽ không còn được nhận.`)
    && run(async () => { await api('DELETE', `/api/attendance/stations/${encodeURIComponent(s.id)}/kiosk`); await loadStations(); }, 'Đã thu hồi.');
  return (
    <div className="col">
      <div className="panel col" style={{ overflowX: 'auto' }}>
        <h3 style={{ margin: 0 }}>Máy chấm công tại trạm</h3>
        <div className="small muted">Mỗi trạm đặt một máy tính bảng mở đường dẫn được cấp; máy hiện mã QR đổi mỗi 30 giây. Nhân viên quét bằng điện thoại đã đăng nhập, máy chủ kiểm tra mã còn hạn và vị trí trong bán kính trạm. Trạm và tọa độ do quản trị khai báo ở Quản trị.</div>
        {issued && (
          <div className="alert amber col">
            <div><b>Đường dẫn máy chấm công {issued.name}</b> (chỉ hiện một lần): mở trên máy tính bảng ở trạm. Không gửi đường dẫn này qua nhóm chat chung.</div>
            <div className="row"><input readOnly value={issued.url} style={{ flex: 1, minWidth: 240 }} onFocus={(e) => e.target.select()} />
              <button onClick={() => navigator.clipboard?.writeText(issued.url)}>Sao chép</button><button onClick={() => setIssued(null)}>Đã lưu, ẩn đi</button></div>
          </div>
        )}
        <table>
          <thead><tr><th>Trạm</th><th>Trạng thái</th><th>Bán kính (m)</th><th>Bắt buộc vị trí</th><th>Đang trong ca</th><th>Lượt vào hôm nay</th><th></th></tr></thead>
          <tbody>{stations.filter((s) => s.active).map((s) => (
            <tr key={s.id}>
              <td>{s.name}<div className="small muted mono">{s.id}</div></td>
              <td>{s.configured ? <span className="badge green">Đã cấp máy</span> : <span className="badge">Chưa cấp</span>}
                {s.updated_by_name && <div className="small muted">{s.updated_by_name}</div>}</td>
              <td>{s.configured && (canEdit
                ? <input type="number" min={50} max={5000} step={50} defaultValue={s.radius_m} style={{ width: 90 }}
                    onBlur={(e) => Number(e.target.value) !== s.radius_m && patch(s, { radiusM: Number(e.target.value) })} />
                : s.radius_m)}</td>
              <td>{s.configured && <input type="checkbox" checked={s.require_gps} disabled={!canEdit} onChange={(e) => patch(s, { requireGps: e.target.checked })} />}</td>
              <td>{s.present}</td><td>{s.today}</td>
              <td>{canEdit && <div className="row">
                <button onClick={() => issue(s)}>{s.configured ? 'Cấp lại' : 'Cấp máy chấm công'}</button>
                {s.configured && <button onClick={() => revoke(s)}>Thu hồi</button>}
              </div>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="panel col" style={{ overflowX: 'auto' }}>
        <div className="row">
          <h3 style={{ margin: 0 }}>Nhật ký chấm công</h3>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          <select value={station} onChange={(e) => setStation(e.target.value)}>
            <option value="">Mọi trạm</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <label className="row small"><input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} /> Chỉ lượt cần xem lại</label>
        </div>
        <table>
          <thead><tr><th>Nhân viên</th><th>Vào</th><th>Ra</th><th>Giờ</th><th>Cần xem lại</th></tr></thead>
          <tbody>{log.map((r) => (
            <tr key={r.id}>
              <td>{r.full_name}<div className="small muted">{r.code} · {r.title}</div></td>
              <td><b>{hm(r.check_in)}</b> <span className="small muted">{r.source === 'qr' ? `QR ${r.station_name ?? ''}${r.in_distance_m != null ? ` · ${r.in_distance_m} m` : ''}` : 'Bấm tay'}</span></td>
              <td>{r.check_out ? <><b>{hm(r.check_out)}</b> <span className="small muted">{r.source_out === 'qr' ? `QR ${r.out_station_name ?? ''}${r.out_distance_m != null ? ` · ${r.out_distance_m} m` : ''}` : 'Bấm tay'}</span></> : <span className="badge green">Đang trong ca</span>}</td>
              <td>{r.hours}</td>
              <td>{r.flags.map((f: string) => <span key={f} className="badge far" style={{ marginRight: 4 }}>{AFLAG[f] ?? f}</span>)}</td>
            </tr>
          ))}</tbody>
        </table>
        {!log.length && <div className="muted">Không có lượt chấm công.</div>}
      </div>
    </div>
  );
}
