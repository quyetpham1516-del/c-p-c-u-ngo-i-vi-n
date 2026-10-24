import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, homeFor, session, type User } from '../api';
import { StarOfLife } from '../Logo';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string; user: User }>('POST', '/api/auth/login', { username, password });
      session.set(r.token, r.user);
      const next = new URLSearchParams(window.location.search).get('next');
      router.push(next && next.startsWith('/') && !next.startsWith('//') ? next : homeFor(r.user.role));
    } catch (err) {
      setError((err as Error).message);
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
        <label className="field">Tên đăng nhập
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">Mật khẩu
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary big" disabled={busy || !username || !password}>Đăng nhập</button>
      </form>
    </div>
  );
}
