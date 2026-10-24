// Service worker tối giản: lưu sẵn vỏ ứng dụng để ứng dụng kíp mở được khi mất mạng.
// Tệp tĩnh của Next.js (/_next/static) có tên chứa mã băm nên lưu vĩnh viễn; trang thì ưu tiên mạng, mất mạng mới dùng bản lưu.
const CACHE = 'medone-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/_next/static/') || /\.(svg|png|woff2|webmanifest)$/.test(url.pathname)) {
    e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(req)) ?? fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return r;
    }).catch(async () => (await caches.match(req)) ?? (await caches.match('/kip')) ?? Response.error()));
  }
});
