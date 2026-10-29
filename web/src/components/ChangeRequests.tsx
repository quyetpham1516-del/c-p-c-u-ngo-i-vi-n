'use client';
import { Fragment, useEffect, useState } from 'react';
import { api, fmtDateTime, session } from '../api';
import { useHashRecord } from '../hashNav';

export const CR_STATUS: Record<string, [string, string]> = {
  cho_duyet: ['Chờ duyệt', 'amber'], dang_ap_dung: ['Đang áp dụng', 'amber'], da_duyet: ['Đã duyệt, đã áp dụng', 'green'],
  tu_choi: ['Từ chối', 'red'], rut_lai: ['Đã rút', ''], loi: ['Duyệt nhưng áp dụng lỗi', 'red'],
};

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const show = (v: unknown) => v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** So giá trị hiện tại lúc đề xuất với giá trị đề xuất, theo từng trường */
function Diff({ before, body }: { before: any; body: any }) {
  if (body && Array.isArray(body.rows)) {
    const cols = Object.keys(body.rows[0] ?? {}).filter((k) => k !== '_action');
    return (
      <div style={{ overflowX: 'auto', maxHeight: 360 }}>
        <div className="small">{body.rows.length} dòng nạp từ Excel</div>
        <table className="small">
          <thead><tr><th />{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{body.rows.map((r: any, i: number) => (
            <tr key={i}><td>{r._action === 'them' ? 'Thêm' : r._action === 'sua' ? 'Sửa' : ''}</td>{cols.map((c) => <td key={c}>{show(r[c])}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{show(body)}</pre>;
  const keys = Object.keys(body);
  if (!keys.length) return <span className="small muted">Không có nội dung</span>;
  return (
    <table className="small">
      <thead><tr><th>Trường</th>{before && <th>Hiện tại</th>}<th>Đề xuất</th></tr></thead>
      <tbody>{keys.map((k) => {
        const old = before ? (before[snake(k)] ?? before[k]) : undefined;
        const changed = before && show(old) !== show(body[k]);
        return (
          <tr key={k}><td className="mono">{k}</td>{before && <td className="muted">{show(old)}</td>}
            <td style={changed ? { fontWeight: 600 } : undefined}>{show(body[k])}</td></tr>
        );
      })}</tbody>
    </table>
  );
}

/**
 * Phiếu đề xuất thay đổi danh mục, cấu hình. Quản trị: duyệt hoặc từ chối, bật khóa cấu hình.
 * Người khác: xem phiếu của mình, ghi lý do, rút khi còn chờ.
 */
export function ChangeRequests({ mine = false }: { mine?: boolean }) {
  const role = session.user?.role ?? '';
  const isAdmin = role === 'admin' && !mine;
  const [gov, setGov] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState(mine ? '' : 'cho_duyet');
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => Promise.all([
    api('GET', '/api/governance').then(setGov),
    api<any[]>('GET', `/api/change-requests${status ? `?status=${status}` : ''}`).then((r) => setRows(mine ? r.filter((x) => x.proposed_by === session.user?.id) : r)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bấm thông báo một đề xuất: hiện mọi trạng thái để chắc thấy phiếu đó, rồi mở ra
  useHashRecord('de-xuat', (id) => { setStatus(''); setOpen(id); });

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); setNote(''); await load(); } catch (e) { setError((e as Error).message); }
  };
  if (!gov) return null;
  if (mine && !gov.myDomains.length && !rows.length) return null;

  return (
    <div className="panel" id="de-xuat">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{mine ? 'Đề xuất thay đổi của tôi' : 'Đề xuất thay đổi danh mục, cấu hình'}
          {isAdmin && gov.pending > 0 && <span className="badge amber" style={{ marginLeft: 8 }}>{gov.pending} chờ duyệt</span>}</h3>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Mọi trạng thái</option>
          {Object.entries(CR_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {mine && gov.myDomains.length > 0 && (
        <div className="small muted">Bạn là trưởng nhóm: {gov.myDomains.map((d: any) => `${d.label} (${d.unitName})`).join(', ')}.
          {gov.enforced ? ' Thay đổi bạn gửi ở các màn hình sẽ thành đề xuất chờ quản trị duyệt.' : ' Cấu hình chưa khóa nên quản trị đang nhập thẳng.'}
          {' '}Sửa hàng loạt bằng Excel ở <a href="/file-mau">File mẫu</a>.</div>
      )}
      {isAdmin && (
        <div className={`alert ${gov.enforced ? 'green' : 'amber'} small`} style={{ marginTop: 8 }}>
          {gov.enforced
            ? <>Đã khóa cấu hình{gov.settings?.enforced_by_name && ` (${gov.settings.enforced_by_name}, ${fmtDateTime(gov.settings.enforced_at)})`}: trưởng nhóm đề xuất, quản trị chỉ duyệt hoặc từ chối.
              Quản trị vẫn khóa tài khoản, đặt lại mật khẩu ngay. Mở khóa phải do Ban Giám đốc đề xuất.</>
            : <>Chưa khóa cấu hình: quản trị đang nhập thẳng (có nhật ký). Khi dựng xong danh mục, bấm khóa để mọi thay đổi đi qua đề xuất của trưởng nhóm.
              <button style={{ marginLeft: 8 }} onClick={() => confirm('Khóa cấu hình? Sau khi khóa, quản trị không sửa thẳng danh mục, cấu hình nữa.')
                && run(() => api('PUT', '/api/governance', { enforced: true }), 'Đã khóa cấu hình')}>Khóa cấu hình</button></>}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {msg && <div className="alert green">{msg}</div>}
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table>
          <thead><tr><th>Mã</th><th>Thay đổi</th><th>Mảng</th>{!mine && <th>Người đề xuất</th>}<th>Gửi lúc</th><th>Trạng thái</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <Fragment key={c.id}>
                <tr id={`de-xuat-${c.id}`} onClick={() => setOpen(open === c.id ? null : c.id)} style={{ cursor: 'pointer' }}>
                  <td className="mono">{c.code}</td>
                  <td>{c.label}<div className="small muted mono">{c.method} {c.url}</div></td>
                  <td className="small">{c.domainLabel}</td>
                  {!mine && <td className="small">{c.proposed_by_name}{c.unit_name && <div className="muted">{c.unit_name}</div>}</td>}
                  <td className="small">{fmtDateTime(c.proposed_at)}</td>
                  <td><span className={`badge ${CR_STATUS[c.status]?.[1] ?? ''}`}>{CR_STATUS[c.status]?.[0] ?? c.status}</span></td>
                </tr>
                {open === c.id && (
                  <tr><td colSpan={mine ? 5 : 6} style={{ background: 'var(--panel-2)' }}>
                    <div className="col" style={{ gap: 6 }}>
                      <div className="small"><b>Lý do:</b> {c.reason || <span className="muted">Chưa ghi</span>}</div>
                      <Diff before={c.before} body={c.body} />
                      {c.decided_by_name && <div className="small">{c.decided_by_name} · {fmtDateTime(c.decided_at)}{c.decision_note && `: ${c.decision_note}`}</div>}
                      {c.error && <div className="error small">{c.error}</div>}
                      {c.status === 'cho_duyet' && isAdmin && c.proposed_by !== session.user?.id && (
                        <div className="row" style={{ flexWrap: 'wrap' }}>
                          <input placeholder="Ghi chú (bắt buộc khi từ chối)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 260 }} />
                          <button onClick={() => run(() => api('POST', `/api/change-requests/${c.id}/decide`, { approve: true, note: note || undefined }), `Đã duyệt ${c.code}`)}>Duyệt và áp dụng</button>
                          <button className="danger" disabled={!note.trim()} onClick={() => run(() => api('POST', `/api/change-requests/${c.id}/decide`, { approve: false, note }), `Đã từ chối ${c.code}`)}>Từ chối</button>
                        </div>
                      )}
                      {c.status === 'cho_duyet' && c.proposed_by === session.user?.id && (
                        <div className="row" style={{ flexWrap: 'wrap' }}>
                          <input placeholder="Lý do đề xuất" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 260 }} />
                          <button disabled={!note.trim()} onClick={() => run(() => api('PATCH', `/api/change-requests/${c.id}`, { reason: note }), 'Đã lưu lý do')}>Lưu lý do</button>
                          <button className="ghost" onClick={() => run(() => api('POST', `/api/change-requests/${c.id}/withdraw`), `Đã rút ${c.code}`)}>Rút đề xuất</button>
                        </div>
                      )}
                    </div>
                  </td></tr>
                )}
              </Fragment>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">Không có đề xuất nào.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
