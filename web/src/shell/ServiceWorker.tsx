'use client';
import { useEffect } from 'react';

/** Đăng ký service worker để ứng dụng kíp mở được khi mất mạng (dữ liệu ePCR nằm trong IndexedDB) */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => { /* trình duyệt không hỗ trợ */ });
  }, []);
  return null;
}
