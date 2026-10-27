'use client';
import { useEffect, useState } from 'react';

/**
 * Đi tới đúng mục khi bấm thông báo: đường dẫn mang phần "#..." (ví dụ /kho#phieu-linh-<id>).
 * Next.js đổi trang cùng đường dẫn không phát "hashchange", nên nơi đổi đường dẫn gọi announceHash().
 */
export const HASH_EVENT = 'medone:hash';
const readHash = () => (typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.slice(1)));

/** Hash hiện tại; tick tăng mỗi lần bấm lại, kể cả bấm lại cùng một thông báo */
export function useHash() {
  const [h, setH] = useState({ hash: '', tick: 0 });
  useEffect(() => {
    const on = () => setH((cur) => ({ hash: readHash(), tick: cur.tick + 1 }));
    on();
    window.addEventListener('hashchange', on);
    window.addEventListener(HASH_EVENT, on);
    return () => { window.removeEventListener('hashchange', on); window.removeEventListener(HASH_EVENT, on); };
  }, []);
  return h;
}

/** Mở bản ghi khi hash là `<prefix>-<id>` */
export function useHashRecord(prefix: string, open: (id: string) => void) {
  const { hash, tick } = useHash();
  useEffect(() => { if (hash.startsWith(`${prefix}-`)) open(hash.slice(prefix.length + 1)); }, [hash, tick]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Báo cho trang biết đường dẫn vừa đổi (gọi vài lần vì trang mới có thể chưa kịp dựng) */
export function announceHash() {
  for (const ms of [0, 200, 800]) window.setTimeout(() => window.dispatchEvent(new Event(HASH_EVENT)), ms);
}

/** Chờ mục có id trùng hash hiện ra (dữ liệu tải chậm) rồi cuộn tới và tô sáng vài giây */
export function HashFocus() {
  const { hash, tick } = useHash();
  useEffect(() => {
    if (!hash || hash.includes('=')) return;
    let n = 0;
    const t = window.setInterval(() => {
      const el = document.getElementById(hash);
      if (el) {
        window.clearInterval(t);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      } else if (++n > 40) window.clearInterval(t);
    }, 200);
    return () => window.clearInterval(t);
  }, [hash, tick]);
  return null;
}
