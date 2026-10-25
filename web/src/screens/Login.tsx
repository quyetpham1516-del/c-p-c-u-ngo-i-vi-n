import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, homeFor, session, type User } from '../api';
import { StarOfLife } from '../Logo';

type LoginResult = { token?: string; user?: User; mfaRequired?: boolean; challenge?: string; mfaSetupRequired?: boolean; recoveryLeft?: number };

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const [sso, setSso] = useState<{ enabled: boolean; label?: string }>({ enabled: false });

  // Đăng nhập một lần: máy chủ SSO chuyển về trang này kèm code và state
  useEffect(() => {
    api('GET', '/api/auth/sso').then(setSso).catch(() => {});
    const q = new URLSearchParams(window.location.search);
    const back = q.get('code') && q.get('state');
    const idpError = q.get('error');
    if (!back && !idpError) return;
    window.history.replaceState(null, '', window.location.pathname);
    if (idpError) { setError(`Máy chủ đăng nhập một lần báo lỗi: ${q.get('error_description') ?? idpError}`); return; }
    setBusy(true);
    api<LoginResult>('POST', '/api/auth/sso/callback', { code: q.get('code'), state: q.get('state') })
      .then((r) => { if (r.mfaRequired) setChallenge(r.challenge!); else done(r); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startSso = async () => {
    setBusy(true); setError('');
    try {
      const next = new URLSearchParams(window.location.search).get('next');
      try { if (next) sessionStorage.setItem('medone.sso.next', next); else sessionStorage.removeItem('medone.sso.next'); } catch { /* bỏ qua */ }
      window.location.href = (await api<{ url: string }>('POST', '/api/auth/sso/start')).url;
    } catch (e) {
      setError((e as Error).message); setBusy(false);
    }
  };

  const done = (r: LoginResult) => {
    session.set(r.token!, r.user!);
    if (r.mfaSetupRequired) return router.push('/bao-mat');
    if (r.recoveryLeft != null) alert(`Đã dùng một mã dự phòng, còn ${r.recoveryLeft} mã. Vào trang Bảo mật để tạo bộ mã mới nếu sắp hết.`);
    let next = new URLSearchParams(window.location.search).get('next');
    try { next = next ?? sessionStorage.getItem('medone.sso.next'); sessionStorage.removeItem('medone.sso.next'); } catch { /* bỏ qua */ }
    router.push(next && next.startsWith('/') && !next.startsWith('//') ? next : homeFor(r.user!.role));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (challenge) {
        done(await api<LoginResult>('POST', '/api/auth/mfa', { challenge, code }));
      } else {
        const r = await api<LoginResult>('POST', '/api/auth/login', { username, password });
        if (r.mfaRequired) { setChallenge(r.challenge!); setPassword(''); } else done(r);
      }
    } catch (err) {
      setError((err as Error).message);
      if (challenge && /đăng nhập lại|Hết thời gian/i.test((err as Error).message)) { setChallenge(''); setCode(''); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="panel col" onSubmit={submit}>
        <div className="row" style={{ gap: 12, marginBottom: 8 }}>
          <StarOfLife size={64} />
          <div>
            <div className="brand-name" style={{ fontSize: 28, fontWeight: 800 }}>Medone</div>
            <div className="muted small">Dịch vụ Chuyển viện – Cấp cứu ngoại viện</div>
          </div>
        </div>
        {!challenge ? (
          <>
            <label className="field">Tên đăng nhập
              <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="field">Mật khẩu
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <div className="alert blue small">
              {useRecovery ? 'Nhập một mã dự phòng (dạng XXXX-XXXX). Mỗi mã chỉ dùng được một lần.'
                : 'Mở ứng dụng xác thực trên điện thoại và nhập mã 6 số của MedOne EOC.'}
            </div>
            <label className="field">{useRecovery ? 'Mã dự phòng' : 'Mã 6 số'}
              <input autoFocus autoComplete="one-time-code" inputMode={useRecovery ? 'text' : 'numeric'} className="mono" style={{ fontSize: 22, letterSpacing: 4 }}
                maxLength={useRecovery ? 12 : 6} value={code} onChange={(e) => setCode(useRecovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ''))} />
            </label>
            <div className="row">
              <button type="button" className="ghost small" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>
                {useRecovery ? 'Dùng mã 6 số' : 'Mất điện thoại? Dùng mã dự phòng'}
              </button>
              <button type="button" className="ghost small" onClick={() => { setChallenge(''); setCode(''); setError(''); }}>Quay lại</button>
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <button className="primary big" disabled={busy || (challenge ? code.length < 6 : !username || !password)}>
          {challenge ? 'Xác nhận' : 'Đăng nhập'}
        </button>
        {sso.enabled && !challenge && (
          <>
            <div className="muted small" style={{ textAlign: 'center' }}>hoặc</div>
            <button type="button" className="big" disabled={busy} onClick={startSso}>{sso.label}</button>
          </>
        )}
      </form>
    </div>
  );
}
