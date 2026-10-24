/**
 * Kiểm thử tải theo yêu cầu mục 12.4: 50 cuộc gọi đồng thời + 10 vị trí, thiết kế gấp đôi (100 cuộc gọi, 20 vị trí).
 * Chạy: npm run load -- [số cuộc gọi] [số vị trí]   (mặc định 100 và 20)
 * Dùng cơ sở dữ liệu riêng (LOAD_DATABASE_URL), xóa sạch mỗi lần chạy.
 */
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/crypto.js';
import { createPool } from '../src/db.js';
import { seed } from '../src/seed.js';

const CALLS = Number(process.argv[2] ?? 100);
const SEATS = Number(process.argv[3] ?? 20);
const PORT = 8090;
const BASE = `http://127.0.0.1:${PORT}`;
const url = process.env.LOAD_DATABASE_URL;
if (!url) throw new Error('Chưa đặt LOAD_DATABASE_URL (cơ sở dữ liệu riêng cho kiểm thử tải, sẽ bị xóa sạch)');
const loadPassword = randomBytes(12).toString('base64url');

const lat: Record<string, number[]> = {};
async function call(token: string, method: string, path: string, body?: unknown) {
  const t = performance.now();
  const res = await fetch(BASE + path, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const key = `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`;
  (lat[key] ??= []).push(performance.now() - t);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

async function main() {
  const pool = createPool(url);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed(pool, loadPassword);
  const pw = hashPassword(loadPassword);
  for (let i = 11; i <= SEATS; i++) {
    await pool.query(`INSERT INTO users(username, full_name, role, title, password_hash) VALUES ($1,$2,'dispatcher','ĐPV',$3)`, [`dpv${i}`, `Điều phối viên ${i}`, pw]);
  }
  const { app } = await buildApp(pool);
  await app.listen({ port: PORT, host: '127.0.0.1' });

  const login = async (u: string) => (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: loadPassword }) })).json()).token as string;
  const seats = await Promise.all(Array.from({ length: SEATS }, (_, i) => login(`dpv${String(i + 1).padStart(2, '0')}`)));
  // 10 vị trí đầu là call-taker/điều phối theo seed; vị trí 11–20 là điều phối viên
  const dispatcherTokens = seats.slice(5);

  // Kíp đăng nhập 4 xe 24/7 + xe dự phòng có kíp tạm
  const crewUsers = ['bs.als', 'ys.bls', 'bs.msu', 'dd.vc'];
  const crewVeh = ['MD-ALS-01', 'MD-BLS-01', 'MD-MSU-01', 'MD-DP-01'];
  for (let i = 0; i < crewUsers.length; i++) {
    const t = await login(crewUsers[i]);
    await call(t, 'POST', '/api/crew/shift', { vehicleId: crewVeh[i], crewRole: 'Trưởng kíp' });
  }

  // Mỗi vị trí mở một màn hình thời gian thực; đo độ trễ từ lúc máy chủ phát tới lúc màn hình nhận
  const fanout: number[] = [];
  let events = 0;
  const sockets = await Promise.all(seats.map((t) => new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${t}`);
    ws.on('message', (m) => {
      const e = JSON.parse(String(m));
      if (e.ts && e.type !== 'hello') { fanout.push(Date.now() - e.ts); events++; }
    });
    ws.on('open', () => resolve(ws));
  })));

  console.log(`\nKiểm thử: ${CALLS} cuộc gọi đổ vào cùng lúc, ${SEATS} vị trí, ${sockets.length} màn hình thời gian thực\n`);
  const t0 = performance.now();

  // 1) Đổ dồn cuộc gọi
  await Promise.all(Array.from({ length: CALLS }, (_, i) => call(seats[0], 'POST', '/api/telephony/ring', { phone: `09${String(10000000 + i)}`, line: i % 5 === 0 ? '115' : '1800' })));
  const rang = performance.now() - t0;

  // 2) Mỗi vị trí liên tục nhận cuộc gọi chờ và xử lý tới bước xác nhận
  const groups = ['dau_nguc', 'dot_quy', 'kho_tho', 'chan_thuong', 'dau_bung', 'co_giat'];
  let handled = 0;
  let conflicts = 0;
  const incidents: string[] = [];
  await Promise.all(seats.map(async (tok, seatIdx) => {
    for (;;) {
      const waiting = await call(tok, 'GET', '/api/calls?state=ringing');
      if (!waiting.json.length) return;
      const c = waiting.json[Math.floor(Math.random() * Math.min(waiting.json.length, 5))];
      const a = await call(tok, 'POST', `/api/calls/${c.id}/answer`, {});
      if (a.status === 409) { conflicts++; continue; }
      const id = a.json.id;
      const lat0 = 10.7 + Math.random() * 0.15;
      const lng0 = 106.6 + Math.random() * 0.15;
      await call(tok, 'PATCH', `/api/incidents/${id}`, { address: `Số ${seatIdx} đường thử`, callbackPhone: c.phone, lat: lat0, lng: lng0 });
      const g = groups[handled % groups.length];
      let answers: Record<string, string> = { conscious: 'yes' };
      await call(tok, 'PUT', `/api/incidents/${id}/triage`, { answers, group: null });
      answers = { ...answers, breathing: 'normal', age_group: 'adult' };
      await call(tok, 'PUT', `/api/incidents/${id}/triage`, { answers, group: g });
      const r = await call(tok, 'PUT', `/api/incidents/${id}/triage`, { answers: { ...answers, cp_severe: 'yes', st_face: 'yes', st_lkw: 'lt4h5', br_sentence: 'yes', tr_mechanism: 'yes', ab_shock: 'no', sz_ongoing: 'no' }, group: g });
      await call(tok, 'POST', `/api/incidents/${id}/confirm`, { priority: r.json.priority, vehicleType: r.json.vehicleType, lights: r.json.lights });
      await call(tok, 'GET', `/api/incidents/${id}`);
      await call(tok, 'GET', '/api/board');
      handled++;
      incidents.push(id);
    }
  }));
  const intakeMs = performance.now() - t0;

  // 3) Điều phối viên giao các xe còn rảnh cho những ca ưu tiên cao nhất
  let assigned = 0;
  for (const id of incidents.slice(0, 8)) {
    const s = await call(dispatcherTokens[0], 'GET', `/api/incidents/${id}/suggest`);
    const v = s.json.suggestions?.[0];
    if (!v) continue;
    const r = await call(dispatcherTokens[assigned % dispatcherTokens.length], 'POST', `/api/incidents/${id}/assign`, { vehicleId: v.vehicleId });
    if (r.status === 200) assigned++;
  }
  await new Promise((r) => setTimeout(r, 500));

  const open = await pool.query(`SELECT count(*)::int n FROM incidents WHERE status NOT IN ('closed','cancelled')`);
  const chainBad = await pool.query(`
    SELECT count(*)::int n FROM audit_events a
     WHERE a.prev_hash <> COALESCE((SELECT b.hash FROM audit_events b WHERE b.scope = a.scope AND b.id < a.id ORDER BY b.id DESC LIMIT 1), repeat('0', 64))`);
  const dupCodes = await pool.query('SELECT count(*) - count(DISTINCT code) AS n FROM incidents');

  console.log(`Đổ ${CALLS} cuộc gọi vào hàng chờ: ${rang.toFixed(0)} ms`);
  console.log(`Xử lý hết ${handled} cuộc gọi (nhận → địa chỉ → 3 lượt hỏi → xác nhận): ${(intakeMs / 1000).toFixed(1)} giây; tranh nhận trùng bị chặn: ${conflicts}`);
  console.log(`Ca đang mở: ${open.rows[0].n}; mã ca trùng: ${dupCodes.rows[0].n}; mắt xích băm sai: ${chainBad.rows[0].n}; xe đã giao: ${assigned}`);
  console.log(`\nĐộ trễ API (ms)            số lượt    p50     p95     max`);
  for (const [k, v] of Object.entries(lat).sort()) {
    console.log(`${k.padEnd(36)} ${String(v.length).padStart(5)} ${pct(v, 50).toFixed(0).padStart(7)} ${pct(v, 95).toFixed(0).padStart(7)} ${Math.max(...v).toFixed(0).padStart(7)}`);
  }
  const all = Object.values(lat).flat();
  console.log(`${'TẤT CẢ'.padEnd(36)} ${String(all.length).padStart(5)} ${pct(all, 50).toFixed(0).padStart(7)} ${pct(all, 95).toFixed(0).padStart(7)} ${Math.max(...all).toFixed(0).padStart(7)}`);
  console.log(`\nĐồng bộ màn hình: ${events} sự kiện tới ${sockets.length} màn hình; trễ p50 ${pct(fanout, 50)} ms, p95 ${pct(fanout, 95)} ms, max ${Math.max(...fanout)} ms (mục tiêu < 1000 ms)`);

  const ok = pct(fanout, 95) < 1000 && pct(all, 95) < 1000 && Number(dupCodes.rows[0].n) === 0 && chainBad.rows[0].n === 0 && handled === CALLS;
  console.log(ok ? '\nĐẠT' : '\nKHÔNG ĐẠT');
  sockets.forEach((s) => s.close());
  await app.close();
  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
