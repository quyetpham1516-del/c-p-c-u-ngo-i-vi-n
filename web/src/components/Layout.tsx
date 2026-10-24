import { NavLink, useNavigate } from 'react-router-dom';
import { ROLE_LABEL, session, type Role } from '../api';
import { Brand } from '../Logo';

const LINKS: { to: string; label: string; roles: Role[] }[] = [
  { to: '/eoc', label: 'Điều phối', roles: ['calltaker', 'dispatcher', 'supervisor', 'admin'] },
  { to: '/bang-xe', label: 'Bảng đội xe', roles: ['calltaker', 'dispatcher', 'supervisor', 'qa', 'admin'] },
  { to: '/kip', label: 'Ứng dụng kíp', roles: ['crew'] },
  { to: '/benh-an', label: 'Bệnh án', roles: ['crew', 'calltaker', 'dispatcher', 'supervisor', 'qa', 'admin'] },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const user = session.user;
  const nav = useNavigate();
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('medone.theme', next); } catch { /* bỏ qua */ }
  };
  return (
    <div className="app">
      <header className="topbar no-print">
        <Brand compact />
        <nav>
          {LINKS.filter((l) => user && l.roles.includes(user.role)).map((l) => (
            <NavLink key={l.to} to={l.to}>{l.label}</NavLink>
          ))}
        </nav>
        <button className="ghost" onClick={toggleTheme} title="Đổi nền sáng/tối">Sáng/Tối</button>
        <div className="who">
          <div><b>{user?.name}</b></div>
          <div>{user && ROLE_LABEL[user.role]}</div>
        </div>
        <button className="ghost" onClick={() => { session.clear(); nav('/dang-nhap'); }}>Đăng xuất</button>
      </header>
      <main>{children}</main>
    </div>
  );
}
