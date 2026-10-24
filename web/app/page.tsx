'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { homeFor, session } from '../src/api';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(session.token ? homeFor(session.user?.role) : '/dang-nhap');
  }, [router]);
  return null;
}
