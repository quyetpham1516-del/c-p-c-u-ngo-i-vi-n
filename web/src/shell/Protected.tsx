'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { session } from '../api';
import { Layout } from '../components/Layout';

/** Chỉ hiện nội dung khi đã đăng nhập; quyền thật sự vẫn do backend kiểm tra trên từng API */
export function Protected({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (session.token) setOk(true);
    else router.replace('/dang-nhap');
  }, [router]);
  if (!ok) return null;
  return <Layout>{children}</Layout>;
}
