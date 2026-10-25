'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ROLE_LABEL, session, type Role } from '../api';
import { Brand } from '../Logo';

const LINKS: { to: string; label: string; roles: Role[] }[] = [
  { to: '/eoc', label: 'Điều phối', roles: ['calltaker', 'dispatcher', 'supervisor', 'admin'] },
  { to: '/bang-xe', label: 'Bảng đội xe', roles: ['calltaker', 'dispatcher', 'supervisor', 'qa', 'admin'] },
  { to: '/kip', label: 'Ứng dụng kíp', roles: ['crew'] },
  { to: '/benh-an', label: 'Bệnh án', roles: ['crew', 'calltaker', 'dispatcher', 'supervisor', 'qa', 'admin'] },
  { to: '/kho', label: 'Kho thuốc', roles: ['dispatcher', 'supervisor', 'qa', 'admin', 'pharmacist', 'director'] },
  { to: '/thiet-bi', label: 'Thiết bị', roles: ['dispatcher', 'supervisor', 'qa', 'admin', 'technician', 'ipc', 'director'] },
  { to: '/chat-luong', label: 'Chất lượng', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/dao-tao', label: 'Đào tạo', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/bao-su-co', label: 'Báo sự cố', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/nhan-su', label: 'Nhân sự', roles: ['hr', 'admin', 'director'] },
  { to: '/tai-chinh', label: 'Tài chính', roles: ['accountant', 'director', 'admin'] },
  { to: '/bao-cao', label: 'Báo cáo', roles: ['director', 'admin', 'supervisor', 'qa', 'accountant'] },
  { to: '/bao-cao', label: 'Tài liệu', roles: ['calltaker', 'dispatcher', 'crew', 'pharmacist', 'technician', 'ipc', 'hr'] },
  { to: '/ca-nhan', label: 'Cá nhân', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/quan-tri', label: 'Quản trị', roles: ['admin'] },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const user = session.user;
  const router = useRouter();
  const path = usePathname();
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
            <Link key={l.label} href={l.to} className={path.startsWith(l.to) ? 'active' : undefined}>{l.label}</Link>
          ))}
        </nav>
        <button className="ghost" onClick={toggleTheme} title="Đổi nền sáng/tối">Sáng/Tối</button>
        <div className="who">
          <div><b>{user?.name}</b></div>
          <div>{user && ROLE_LABEL[user.role]}</div>
        </div>
        <button className="ghost" onClick={() => { session.clear(); router.push('/dang-nhap'); }}>Đăng xuất</button>
      </header>
      <main>{children}</main>
    </div>
  );
}
