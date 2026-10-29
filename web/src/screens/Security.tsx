'use client';
import { useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import { api, homeFor, ROLE_LABEL, session, useLive, type Role } from '../api';
import { useHash } from '../hashNav';

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
const ROLES = Object.keys(ROLE_LABEL) as Role[];
const POLICY_VIEW = ['admin', 'director'];
const LIMIT_EDIT = ['admin', 'director'];
const REVIEW_VIEW = ['supervisor', 'director', 'admin', 'qa'];
const REVIEW_DECIDE = ['supervisor', 'director', 'admin'];
const at = (s?: string | null) => (s ? new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const REVIEW_STATUS: Record<string, string> = { cho_xem: 'Chờ xem', dong_y: 'Đồng ý', khong_dong_y: 'Không đồng ý' };

/** Bảo mật: xác thực hai lớp của tôi, chính sách bắt buộc (quản trị), hạn mức phê duyệt, hậu kiểm rút xe và hủy ca */
export function Security() {
  const user = session.user;
  const role = user?.role ?? '';
  const setupOnly = !!user?.mfaSetup;
  const tabs = setupOnly ? ['Xác thực hai lớp'] : [
    'Xác thực hai lớp',
    ...(POLICY_VIEW.includes(role) ? ['Chính sách tài khoản'] : []),
    'Hạn mức phê duyệt',
    ...(REVIEW_VIEW.includes(role) ? ['Hậu kiểm'] : []),
  ];
  const [tab, setTab] = useState(tabs[0]);
  const { hash, tick } = useHash();
  useEffect(() => { if (hash === 'hau-kiem' && tabs.includes('Hậu kiểm')) setTab('Hậu kiểm'); }, [hash, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const run: Run = async (fn, ok) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Bảo mật <span className="small muted">đăng nhập hai lớp, hạn mức phê duyệt</span></h2>
      {setupOnly && <div className="panel amber">Vai trò <b>{ROLE_LABEL[role as Role]}</b> bắt buộc bật xác thực hai lớp. Cài xong là dùng phần mềm bình thường.</div>}
      <div className="tabs">{tabs.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); setMsg(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      {tab === 'Xác thực hai lớp' && <MyMfa run={run} />}
      {tab === 'Chính sách tài khoản' && <Policy run={run} />}
      {tab === 'Hạn mức phê duyệt' && <Limits run={run} />}
      {tab === 'Hậu kiểm' && <Reviews run={run} />}
    </div>
  );
}

/* ======================= Xác thực hai lớp của tôi ======================= */

function Qr({ text }: { text: string }) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return <span className="mfa-qr" dangerouslySetInnerHTML={{ __html: q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }} />;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="panel col">
      <h3 style={{ margin: 0 }}>Mã dự phòng</h3>
      <div className="small">Mỗi mã dùng được một lần khi không có điện thoại. In hoặc chép ra giấy, cất nơi an toàn. Mã chỉ hiện <b>một lần</b> này.</div>
      <div className="mfa-codes mono">{codes.map((c) => <span key={c}>{c}</span>)}</div>
      <div className="row no-print">
        <button onClick={() => window.print()}>In</button>
        <button onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>Chép</button>
        <button className="primary" onClick={onDone}>Tôi đã lưu mã</button>
      </div>
    </div>
  );
}

function MyMfa({ run }: { run: Run }) {
  const [st, setSt] = useState<any>(null);
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'' | 'recovery' | 'disable'>('');
  const [wasSetup] = useState(!!session.user?.mfaSetup);
  const load = () => api('GET', '/api/auth/mfa').then(setSt);
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st) return null;
  if (codes) {
    return <RecoveryCodes codes={codes} onDone={() => {
      setCodes(null);
      // Vừa cài xong vì bị bắt buộc: vào màn làm việc chính
      if (wasSetup && session.user) window.location.href = homeFor(session.user.role); else run(load);
    }} />;
  }
  if (!st.enabled) {
    return (
      <div className="panel col" style={{ maxWidth: 640 }}>
        <div>Trạng thái: <b>chưa bật</b>{st.required ? <span className="badge red" style={{ marginLeft: 8 }}>bắt buộc với vai trò của bạn</span> : <span className="badge" style={{ marginLeft: 8 }}>khuyến nghị</span>}</div>
        <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Cài ứng dụng xác thực trên điện thoại: Google Authenticator, Microsoft Authenticator hoặc ứng dụng tương tự (miễn phí).</li>
          <li>Nhập lại mật khẩu để tạo mã QR, rồi quét bằng ứng dụng.</li>
          <li>Nhập mã 6 số ứng dụng hiện ra để xác nhận. Từ lần sau, đăng nhập cần mật khẩu và mã 6 số.</li>
        </ol>
        {!setup ? (
          <div className="row">
            <input type="password" autoComplete="current-password" placeholder="Mật khẩu hiện tại" value={pw} onChange={(e) => setPw(e.target.value)} />
            <button className="primary" disabled={!pw} onClick={() => run(async () => { setSetup(await api('POST', '/api/auth/mfa/setup', { password: pw })); setPw(''); })}>Tạo mã QR</button>
          </div>
        ) : (
          <div className="col">
            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <Qr text={setup.uri} />
              <div className="col small" style={{ maxWidth: 320 }}>
                <div>Không quét được thì nhập khóa này vào ứng dụng (chọn loại "theo thời gian"):</div>
                <b className="mono" style={{ wordBreak: 'break-all' }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</b>
                <div className="muted">Không chụp màn hình hay gửi khóa này cho người khác.</div>
              </div>
            </div>
            <div className="row">
              <input inputMode="numeric" autoComplete="one-time-code" className="mono" maxLength={6} placeholder="Mã 6 số" value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <button className="primary" disabled={code.length !== 6} onClick={() => run(async () => {
                const r = await api<any>('POST', '/api/auth/mfa/enable', { code });
                session.set(r.token, r.user);
                setCode(''); setSetup(null); setCodes(r.recoveryCodes);
              }, 'Đã bật xác thực hai lớp')}>Xác nhận</button>
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="panel col" style={{ maxWidth: 640 }}>
      <div>Trạng thái: <b>đã bật</b> từ {at(st.enabledAt)}. Còn <b>{st.recoveryLeft}</b> mã dự phòng.</div>
      {st.recoveryLeft <= 3 && <div className="alert amber small">Sắp hết mã dự phòng: tạo bộ mã mới.</div>}
      <div className="row">
        <button onClick={() => setMode(mode === 'recovery' ? '' : 'recovery')}>Tạo bộ mã dự phòng mới</button>
        {!st.required && <button className="ghost" onClick={() => setMode(mode === 'disable' ? '' : 'disable')}>Tắt xác thực hai lớp</button>}
      </div>
      {st.required && <div className="small muted">Vai trò của bạn bắt buộc dùng xác thực hai lớp. Đổi hoặc mất điện thoại thì nhờ quản trị đặt lại rồi cài lại.</div>}
      {mode && (
        <div className="row">
          <input type="password" autoComplete="current-password" placeholder="Mật khẩu" value={pw} onChange={(e) => setPw(e.target.value)} />
          <input inputMode="numeric" className="mono" maxLength={6} placeholder="Mã 6 số" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          <button className="primary" disabled={!pw || code.length !== 6} onClick={() => run(async () => {
            if (mode === 'recovery') setCodes((await api<any>('POST', '/api/auth/mfa/recovery', { password: pw, code })).recoveryCodes);
            else { await api('POST', '/api/auth/mfa/disable', { password: pw, code }); await load(); }
            setPw(''); setCode(''); setMode('');
          }, mode === 'recovery' ? 'Đã tạo bộ mã mới, bộ cũ hết hiệu lực' : 'Đã tắt xác thực hai lớp')}>{mode === 'recovery' ? 'Tạo mã' : 'Tắt'}</button>
        </div>
      )}
    </div>
  );
}

/* ======================= Chính sách (quản trị) ======================= */

function Policy({ run }: { run: Run }) {
  const isAdmin = session.user?.role === 'admin';
  const [d, setD] = useState<any>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [enforce, setEnforce] = useState(false);
  const [reset, setReset] = useState<{ id: string; name: string; reason: string } | null>(null);
  const load = () => api<any>('GET', '/api/security/settings').then((x) => { setD(x); setRoles(x.settings.mfaRoles); setEnforce(x.settings.mfaEnforce); });
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  const pendingInRoles = d.users.filter((u: any) => roles.includes(u.role) && !u.totp_enabled_at).length;
  return (
    <div className="col">
      <div className="panel col">
        <h3 style={{ margin: 0 }}>Vai trò bắt buộc xác thực hai lớp</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {ROLES.map((r) => (
            <label key={r} className="row small">
              <input type="checkbox" disabled={!isAdmin} checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />
              {ROLE_LABEL[r]}
            </label>
          ))}
        </div>
        <label className="row">
          <input type="checkbox" disabled={!isAdmin} checked={enforce} onChange={(e) => setEnforce(e.target.checked)} />
          <b>Bắt buộc ngay</b> <span className="small muted">(người chưa cài sẽ chỉ vào được trang cài đặt sau khi đăng nhập)</span>
        </label>
        {enforce && pendingInRoles > 0 && <div className="alert amber small">{pendingInRoles} người trong các vai trò trên chưa cài. Nên báo họ cài trước khi bật.</div>}
        {isAdmin && <div><button className="primary" onClick={() => run(async () => { await api('PUT', '/api/security/settings', { mfaRoles: roles, mfaEnforce: enforce }); await load(); }, 'Đã lưu chính sách')}>Lưu</button></div>}
        <div className="small muted">Sửa lần cuối: {d.settings.updatedBy ?? '—'} · {at(d.settings.updatedAt)}</div>
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Tài khoản <span className="small muted">{d.missing} người thuộc vai trò bắt buộc chưa cài</span></h3>
        <table className="table">
          <thead><tr><th>Tài khoản</th><th>Vai trò</th><th>Hai lớp</th><th>Mã dự phòng</th><th>Đăng nhập gần nhất</th><th /></tr></thead>
          <tbody>
            {d.users.map((u: any) => (
              <tr key={u.id} className={d.settings.mfaRoles.includes(u.role) && !u.totp_enabled_at ? 'amber' : undefined}>
                <td>{u.full_name} <span className="muted small">{u.username}</span></td>
                <td>{ROLE_LABEL[u.role as Role]}</td>
                <td>{u.totp_enabled_at ? `Đã bật ${at(u.totp_enabled_at)}` : 'Chưa'}{u.locked ? <span className="badge red" style={{ marginLeft: 6 }}>đang khóa</span> : null}</td>
                <td>{u.totp_enabled_at ? u.recovery_left : ''}</td>
                <td>{at(u.last_login_at)}</td>
                <td>{isAdmin && (u.totp_enabled_at || u.locked) && u.id !== session.user?.id &&
                  <button className="ghost small" onClick={() => setReset({ id: u.id, name: u.full_name, reason: '' })}>Đặt lại</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {reset && (
          <div className="row">
            <span>Đặt lại xác thực hai lớp của <b>{reset.name}</b>:</span>
            <input className="grow" placeholder="Lý do (mất điện thoại, đổi máy...)" value={reset.reason} onChange={(e) => setReset({ ...reset, reason: e.target.value })} />
            <button className="primary" disabled={reset.reason.trim().length < 3} onClick={() => run(async () => {
              await api('POST', `/api/users/${reset.id}/mfa/reset`, { reason: reset.reason }); setReset(null); await load();
            }, 'Đã đặt lại: người đó đăng nhập bằng mật khẩu rồi cài lại')}>Đặt lại</button>
            <button className="ghost" onClick={() => setReset(null)}>Bỏ</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ======================= Hạn mức phê duyệt ======================= */

type LimitRow = { action: string; role: Role; maxValue: number | null };

function Limits({ run }: { run: Run }) {
  const canEdit = LIMIT_EDIT.includes(session.user?.role ?? '');
  const [actions, setActions] = useState<Record<string, { label: string; unit: string; hint: string }>>({});
  const [rows, setRows] = useState<LimitRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const load = () => api<any>('GET', '/api/approvals/limits').then((x) => {
    setActions(x.actions);
    setRows(x.limits.map((l: any) => ({ action: l.action, role: l.role, maxValue: l.max_value })));
    setDirty(false);
  });
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (i: number, v: Partial<LimitRow>) => { setRows(rows.map((r, j) => (j === i ? { ...r, ...v } : r))); setDirty(true); };
  return (
    <div className="col">
      {Object.entries(actions).map(([key, a]) => {
        const mine = rows.map((r, i) => ({ r, i })).filter((x) => x.r.action === key);
        const unused = ROLES.filter((r) => !mine.some((x) => x.r.role === r));
        return (
          <div key={key} className="panel col">
            <h3 style={{ margin: 0 }}>{a.label}</h3>
            <div className="small muted">{a.hint}</div>
            <table className="table">
              <thead><tr><th>Vai trò</th><th>Hạn mức ({a.unit})</th>{canEdit && <th />}</tr></thead>
              <tbody>
                {mine.map(({ r, i }) => (
                  <tr key={r.role}>
                    <td>{ROLE_LABEL[r.role]}</td>
                    <td>
                      {canEdit ? (
                        <div className="row">
                          <input type="number" min={0} step={key === 'mien_giam' ? 50000 : 1} disabled={r.maxValue === null} style={{ width: 160 }}
                            value={r.maxValue ?? ''} onChange={(e) => set(i, { maxValue: Math.max(0, Number(e.target.value) || 0) })} />
                          <label className="row small"><input type="checkbox" checked={r.maxValue === null} onChange={(e) => set(i, { maxValue: e.target.checked ? null : 0 })} /> không giới hạn</label>
                        </div>
                      ) : r.maxValue === null ? 'Không giới hạn' : r.maxValue.toLocaleString('vi-VN')}
                    </td>
                    {canEdit && <td><button className="ghost small" onClick={() => { setRows(rows.filter((_, j) => j !== i)); setDirty(true); }}>Bỏ</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {canEdit && unused.length > 0 && (
              <div className="row">
                <select defaultValue="" onChange={(e) => { if (e.target.value) { setRows([...rows, { action: key, role: e.target.value as Role, maxValue: 0 }]); setDirty(true); e.target.value = ''; } }}>
                  <option value="">+ Thêm vai trò…</option>
                  {unused.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </div>
            )}
          </div>
        );
      })}
      {canEdit && (
        <div className="row">
          <button className="primary" disabled={!dirty} onClick={() => run(async () => { await api('PUT', '/api/approvals/limits', { limits: rows }); await load(); }, 'Đã lưu hạn mức')}>Lưu hạn mức</button>
          {dirty && <button className="ghost" onClick={() => run(load)}>Hoàn tác</button>}
        </div>
      )}
      <div className="small muted">Hạn mức mặc định là bản nháp, Ban Giám đốc xem lại và chỉnh cho phù hợp quy chế tài chính của công ty.</div>
    </div>
  );
}

/* ======================= Hậu kiểm ======================= */

function Reviews({ run }: { run: Run }) {
  const canDecide = REVIEW_DECIDE.includes(session.user?.role ?? '');
  const [status, setStatus] = useState('cho_xem');
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState<{ id: string; agree: boolean; note: string } | null>(null);
  const load = () => api<any[]>('GET', `/api/approvals/reviews?status=${status}`).then(setRows);
  useEffect(() => { run(load); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive((e) => { if (e.type === 'approval' || e.type === 'incident') load().catch(() => {}); });
  const ACTION: Record<string, string> = { rut_xe: 'Rút xe', huy_ca: 'Hủy ca đã điều xe' };
  return (
    <div className="panel col">
      <div className="row">
        <span className="small muted grow">Rút xe và hủy ca đã điều xe vượt hạn mức trong ngày: việc đã làm ngay, trưởng ca xem lại có hợp lý không.</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="cho_xem">Chờ xem</option><option value="khong_dong_y">Không đồng ý</option><option value="dong_y">Đồng ý</option><option value="tat_ca">Tất cả</option>
        </select>
      </div>
      {!rows.length ? <div className="muted small">Không có mục nào.</div> : (
        <table className="table">
          <thead><tr><th>Lúc</th><th>Việc</th><th>Ca</th><th>Người làm</th><th>Lý do</th><th>Kết quả</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.status === 'khong_dong_y' ? 'amber' : undefined}>
                <td>{at(r.created_at)}</td>
                <td>{ACTION[r.action]}{r.vehicle_id ? ` ${r.vehicle_id}` : ''}{r.detail?.fromIncident ? <div className="small muted">từ ca {r.detail.fromIncident} ({r.detail.fromPriority})</div> : null}</td>
                <td>{r.incident_code ?? '—'}</td>
                <td>{r.created_by_name}<div className="small muted">lần {r.detail?.usedToday} trong ngày, hạn mức {r.detail?.limit ?? 0}</div></td>
                <td>{r.reason}</td>
                <td>{REVIEW_STATUS[r.status]}{r.decided_by_name ? <div className="small muted">{r.decided_by_name} {at(r.decided_at)}{r.note ? `: ${r.note}` : ''}</div> : null}</td>
                <td>{canDecide && r.status === 'cho_xem' && r.created_by !== session.user?.id && (
                  <div className="row">
                    <button className="small" onClick={() => setF({ id: r.id, agree: true, note: '' })}>Đồng ý</button>
                    <button className="small ghost" onClick={() => setF({ id: r.id, agree: false, note: '' })}>Không đồng ý</button>
                  </div>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {f && (
        <div className="row">
          <input className="grow" autoFocus placeholder={f.agree ? 'Ghi chú (không bắt buộc)' : 'Lý do không đồng ý, cần rút kinh nghiệm gì'} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <button className="primary" disabled={!f.agree && f.note.trim().length < 3} onClick={() => run(async () => {
            await api('POST', `/api/approvals/reviews/${f.id}/decide`, { agree: f.agree, note: f.note || null }); setF(null); await load();
          }, 'Đã ghi kết quả hậu kiểm')}>Lưu</button>
          <button className="ghost" onClick={() => setF(null)}>Bỏ</button>
        </div>
      )}
    </div>
  );
}
