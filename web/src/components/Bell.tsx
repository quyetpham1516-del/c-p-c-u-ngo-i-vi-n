'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, fmtTime } from '../api';

interface Reminder { key: string; level: 'red' | 'amber' | 'info'; title: string; body?: string; link: string }
interface Message { id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null }
interface Resp { reminders: Reminder[]; messages: Message[]; count: number; urgent: boolean }

/**
 * Nút chuông trên thanh đầu trang: đỏ khi còn việc quên làm (chưa làm bệnh án, chưa ký phiếu, chưa bù cơ số...)
 * hoặc có tin chưa đọc. Hỏi lại mỗi phút và mỗi lần chuyển trang.
 */
export function Bell({ path }: { path: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const load = () => api<Resp>('GET', '/api/notifications').then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = window.setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [path]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const read = async (m: Message) => { if (!m.read_at) { await api('POST', `/api/notifications/${m.id}/read`).catch(() => {}); load(); } };
  const n = data?.count ?? 0;
  return (
    <div className="bell" ref={box}>
      <button className={`ghost bell-btn ${data?.urgent ? 'urgent' : ''}`} onClick={() => setOpen(!open)} title="Thông báo, việc cần làm" aria-label={`Thông báo: ${n}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
        {n > 0 && <span className="bell-count">{n > 99 ? '99+' : n}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>Việc cần làm</b>
            {data?.messages.some((m) => !m.read_at) && <button className="ghost small" onClick={async () => { await api('POST', '/api/notifications/read-all'); load(); }}>Đã đọc hết tin</button>}
          </div>
          {!data?.reminders.length && <div className="small muted">Không còn việc nào bị quên.</div>}
          {data?.reminders.map((r) => (
            <Link key={r.key} href={r.link} className={`bell-item ${r.level}`} onClick={() => setOpen(false)}>
              <div>{r.title}</div>{r.body && <div className="small muted">{r.body}</div>}
            </Link>
          ))}
          {!!data?.messages.length && <b style={{ marginTop: 8 }}>Tin</b>}
          {data?.messages.map((m) => (
            <Link key={m.id} href={m.link ?? '#'} className={`bell-item ${m.read_at ? 'read' : 'info'}`} onClick={() => { read(m); setOpen(false); }}>
              <div>{!m.read_at && '● '}{m.title}</div>
              {m.body && <div className="small muted">{m.body}</div>}
              <div className="small muted">{fmtTime(m.created_at)}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
