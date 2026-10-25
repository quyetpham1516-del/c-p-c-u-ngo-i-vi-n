'use client';
import { useEffect, useState } from 'react';
import { api, API_BASE, ROLE_LABEL, session, type Role } from '../api';

const PROVIDER: Record<string, string> = { noi_bo: 'CA nội bộ Medone' };
const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString('vi-VN') : '—');
const dt = (s?: string | null) => (s ? new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Một dòng trạng thái chữ ký số của phiếu (dùng trên phiếu in và trang tra cứu) */
export function DigitalSignatureLine({ s, signer }: { s: any; signer?: string }) {
  if (!s) return null;
  const who = signer ?? s.signer ?? s.signerName;
  return (
    <div className={`alert ${s.valid ? 'green' : 'red'}`} style={{ margin: '4px 0' }}>
      <b>{s.valid ? 'Chữ ký số hợp lệ' : 'Chữ ký số KHÔNG hợp lệ'}</b>
      {' '}· {who ? `${who} · ` : ''}{dt(s.signedAt)}{s.purpose === 'bo_sung' ? ' · ký bản bổ sung' : ''}
      {' '}· {PROVIDER[s.provider] ?? s.provider} · số chứng thư <span className="mono">{String(s.certSerial ?? '').slice(0, 12)}</span>
      {s.revokedLater && <span> · chứng thư đã thu hồi sau lúc ký (chữ ký vẫn có giá trị)</span>}
      {s.problems?.length > 0 && <div>{s.problems.join('; ')}</div>}
    </div>
  );
}

/** Quản trị chữ ký số nội bộ: tải chứng thư CA, xem chứng thư từng người, thu hồi */
export function PkiAdmin() {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const load = () => api('GET', '/api/pki').then(setD).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const revoke = async (c: any) => {
    const reason = prompt(`Lý do thu hồi chứng thư của ${c.full_name} (nghỉ việc, mất máy, lộ mật khẩu…)`);
    if (!reason) return;
    setError('');
    try { await api('POST', `/api/pki/certs/${c.id}/revoke`, { reason }); await load(); } catch (e) { setError((e as Error).message); }
  };
  if (!d) return error ? <div className="panel error">{error}</div> : null;
  const isAdmin = session.user?.role === 'admin';
  return (
    <div className="panel col">
      <h3 style={{ margin: 0 }}>Chữ ký số nội bộ</h3>
      <div className="small">
        CA gốc: <b>{d.ca.subject}</b>, hết hạn {day(d.ca.notAfter)}. Đang ký bằng: <b>{d.providers.find((p: any) => p.id === d.provider)?.label ?? d.provider}</b>.
        {' '}<a href={`${API_BASE}/api/pki/ca.pem`}>Tải chứng thư CA</a> để bệnh viện hoặc đơn vị đối chiếu nhập vào phần mềm kiểm tra chữ ký.
      </div>
      <div className="small muted mono" style={{ wordBreak: 'break-all' }}>SHA-256: {d.ca.fingerprint256}</div>
      <div className="small muted">Chứng thư được cấp tự động khi một người ký phiếu lần đầu, hiệu lực 1 năm. Giá trị pháp lý: trong nội bộ và với đơn vị đã thỏa thuận; giai đoạn sau sẽ chuyển sang CA công cộng (MobiFone CA).</div>
      {error && <div className="error">{error}</div>}
      <table className="small">
        <thead><tr><th>Người ký</th><th>Số chứng thư</th><th>Hiệu lực</th><th>Số lần ký</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody>
          {d.certs.map((c: any) => (
            <tr key={c.id}>
              <td>{c.full_name} <span className="muted">({ROLE_LABEL[c.role as Role] ?? c.role})</span></td>
              <td className="mono">{c.serial.slice(0, 12)}</td>
              <td>{day(c.not_before)} – {day(c.not_after)}</td>
              <td>{c.signatures}</td>
              <td>{c.revoked_at ? <span className="badge red">Thu hồi {day(c.revoked_at)}: {c.revoke_reason}</span> : <span className="badge green">Còn hiệu lực</span>}</td>
              <td>{isAdmin && !c.revoked_at && <button className="ghost small" onClick={() => revoke(c)}>Thu hồi</button>}</td>
            </tr>
          ))}
          {d.certs.length === 0 && <tr><td colSpan={6} className="muted">Chưa ai ký phiếu.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
