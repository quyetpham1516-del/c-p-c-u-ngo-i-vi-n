'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ROLE_LABEL, session, type Role } from '../api';
import { Brand } from '../Logo';
import { SosBanner } from './Sos';

const LINKS: { to: string; label: string; roles: Role[] }[] = [
  { to: '/eoc', label: 'Điều phối', roles: ['calltaker', 'dispatcher', 'supervisor', 'admin'] },
  { to: '/bang-xe', label: 'Bảng đội xe', roles: ['calltaker', 'dispatcher', 'supervisor', 'qa', 'admin'] },
  { to: '/vung-phu', label: 'Vùng phủ', roles: ['dispatcher', 'supervisor', 'qa', 'admin', 'director'] },
  { to: '/kip', label: 'Ứng dụng kíp', roles: ['crew'] },
  { to: '/benh-an', label: 'Bệnh án', roles: ['crew', 'calltaker', 'dispatcher', 'supervisor', 'qa', 'admin'] },
  { to: '/kho', label: 'Kho thuốc', roles: ['dispatcher', 'supervisor', 'qa', 'admin', 'pharmacist', 'director'] },
  { to: '/hau-can', label: 'Hậu cần', roles: ['crew', 'dispatcher', 'supervisor', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/thiet-bi', label: 'Thiết bị', roles: ['dispatcher', 'supervisor', 'qa', 'admin', 'technician', 'ipc', 'director'] },
  { to: '/chat-luong', label: 'Chất lượng', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/dao-tao', label: 'Đào tạo', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/he-thong-chat-luong', label: 'Hệ thống CL', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/van-hanh', label: 'Vận hành', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'technician', 'accountant', 'director'] },
  { to: '/tuan-thu', label: 'Tuân thủ', roles: ['supervisor', 'qa', 'admin', 'technician', 'hr', 'director'] },
  { to: '/bao-su-co', label: 'Báo sự cố', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/nhan-su', label: 'Nhân sự', roles: ['hr', 'admin', 'director'] },
  { to: '/tai-chinh', label: 'Tài chính', roles: ['accountant', 'director', 'admin'] },
  { to: '/bang-luong', label: 'Bảng lương', roles: ['hr', 'accountant', 'director'] },
  { to: '/bo-phan', label: 'Bộ phận', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/bao-cao', label: 'Báo cáo', roles: ['director', 'admin', 'supervisor', 'qa', 'accountant'] },
  { to: '/bao-cao', label: 'Tài liệu', roles: ['calltaker', 'dispatcher', 'crew', 'pharmacist', 'technician', 'ipc', 'hr'] },
  { to: '/ca-nhan', label: 'Cá nhân', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/bao-mat', label: 'Bảo mật', roles: ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'] },
  { to: '/quan-tri', label: 'Quản trị', roles: ['admin'] },
];
const REVIEW_DECIDE: Role[] = ['supervisor', 'director', 'admin'];

/** Số mục hậu kiểm rút xe, hủy ca đang chờ trưởng ca xem (hỏi lại mỗi phút và mỗi lần chuyển trang, không mở thêm kết nối trực tiếp) */
function usePendingReviews(enabled: boolean, path: string) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const load = () => api<any[]>('GET', '/api/approvals/reviews?status=cho_xem').then((r) => setN(r.length)).catch(() => {});
    load();
    const t = window.setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [enabled, path]);
  return n;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const user = session.user;
  const router = useRouter();
  const path = usePathname();
  // Chưa cài xác thực hai lớp mà vai trò bắt buộc: chỉ hiện trang Bảo mật
  const setupOnly = !!user?.mfaSetup;
  const pending = usePendingReviews(!setupOnly && !!user && REVIEW_DECIDE.includes(user.role), path);
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
          {LINKS.filter((l) => user && l.roles.includes(user.role) && (!setupOnly || l.to === '/bao-mat')).map((l) => (
            <Link key={l.label} href={l.to === '/bao-mat' && pending ? '/bao-mat#hau-kiem' : l.to} className={path.startsWith(l.to) ? 'active' : undefined}>
              {l.label}{l.to === '/bao-mat' && pending > 0 && <span className="nav-count" title="Mục hậu kiểm chờ xem">{pending}</span>}
            </Link>
          ))}
        </nav>
        <button className="ghost" onClick={toggleTheme} title="Đổi nền sáng/tối">Sáng/Tối</button>
        <div className="who">
          <div><b>{user?.name}</b></div>
          <div>{user && ROLE_LABEL[user.role]}</div>
        </div>
        <button className="ghost" onClick={() => { session.clear(); router.push('/dang-nhap'); }}>Đăng xuất</button>
      </header>
      {!setupOnly && <SosBanner />}
      <main>{children}</main>
    </div>
  );
}
