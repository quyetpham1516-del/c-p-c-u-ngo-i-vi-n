import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, get as httpGet, type Server } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'medone-cert-'));
const P = 40000 + Math.floor(Math.random() * 20000);
Object.assign(process.env, {
  MEDONE_CERT_DIR: dir, MEDONE_HTTPS_PORT: String(P), MEDONE_HTTPS_HELP_PORT: String(P + 1), MEDONE_WEB_PORT: String(P + 2), PORT: String(P + 3),
});

let web: Server; let api: Server; let mod: typeof import('../src/tools/https.js'); let proxy: { server: Server; helpServer: Server };

const fetchTls = (path: string, ca: Buffer, method = 'GET', body?: string) => new Promise<{ status: number; body: string; headers: any }>((resolve, reject) => {
  const r = request({ host: 'localhost', port: P, path, method, ca, headers: body ? { 'content-type': 'text/plain' } : {} }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode!, body: b, headers: res.headers }));
  });
  r.on('error', reject); r.end(body);
});

beforeAll(async () => {
  mod = await import('../src/tools/https.js');
  mod.makeCerts();
  web = createServer((req, res) => res.end(`web ${req.url}`));
  api = createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => res.end(JSON.stringify({ api: req.url, method: req.method, body: b, proto: req.headers['x-forwarded-proto'], fwd: req.headers['x-forwarded-for'] })));
  });
  const wss = new WebSocketServer({ server: api, path: '/ws' });
  wss.on('connection', (s, req) => s.on('message', (m) => s.send(`echo ${m} ${req.url}`)));
  await Promise.all([new Promise<void>((r) => web.listen(P + 2, r)), new Promise<void>((r) => api.listen(P + 3, r))]);
  proxy = mod.serve();
  await new Promise((r) => setTimeout(r, 200));
});

afterAll(() => {
  for (const s of [web, api, proxy?.server, proxy?.helpServer]) s?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('HTTPS nội bộ', () => {
  it('chứng chỉ máy chủ do CA nội bộ ký, có tên .local, localhost và IP; khóa chỉ chủ máy đọc', () => {
    const verify = execFileSync('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, 'server.crt')]).toString();
    expect(verify).toContain('OK');
    const text = execFileSync('openssl', ['x509', '-in', join(dir, 'server.crt'), '-noout', '-text']).toString();
    expect(text).toContain(`DNS:${mod.localName()}`);
    expect(text).toContain('DNS:localhost');
    expect(text).toContain('IP Address:127.0.0.1');
    expect(statSync(join(dir, 'server.key')).mode & 0o077).toBe(0);
    expect(statSync(join(dir, 'ca.key')).mode & 0o077).toBe(0);
  });

  it('tạo lại chứng chỉ máy chủ giữ nguyên CA (điện thoại không phải cài lại)', () => {
    const before = readFileSync(join(dir, 'ca.crt'), 'utf8');
    mod.makeCerts(['medone.test']);
    expect(readFileSync(join(dir, 'ca.crt'), 'utf8')).toBe(before);
    expect(execFileSync('openssl', ['x509', '-in', join(dir, 'server.crt'), '-noout', '-text']).toString()).toContain('DNS:medone.test');
  });

  it('chọn đích: /api và /ws sang API, còn lại sang web', () => {
    expect(mod.targetPort('/api/health')).toBe(P + 3);
    expect(mod.targetPort('/ws?token=x')).toBe(P + 3);
    expect(mod.targetPort('/kip')).toBe(P + 2);
    expect(mod.targetPort('/apix')).toBe(P + 2);
  });

  it('chuyển tiếp http qua TLS, giữ thân yêu cầu, báo x-forwarded-proto', async () => {
    const ca = readFileSync(join(dir, 'ca.crt'));
    expect((await fetchTls('/van-hanh', ca)).body).toBe('web /van-hanh');
    const r = await fetchTls('/api/auth/login', ca, 'POST', 'xin chào');
    const j = JSON.parse(r.body);
    expect(j).toMatchObject({ api: '/api/auth/login', method: 'POST', body: 'xin chào', proto: 'https' });
    expect(j.fwd).toBeTruthy();
  });

  it('WebSocket qua wss', async () => {
    const ca = readFileSync(join(dir, 'ca.crt'));
    const ws = new WebSocket(`wss://localhost:${P}/ws?token=abc`, { ca });
    const msg = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (m) => resolve(m.toString()));
      ws.on('error', reject);
    });
    ws.close();
    expect(msg).toBe('echo ping /ws?token=abc');
  });

  it('cổng http phát trang hướng dẫn và tệp CA', async () => {
    const get = (path: string) => new Promise<{ status: number; type: string; body: string }>((resolve) => httpGet({ host: 'localhost', port: P + 1, path }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body: b }));
    }));
    const page = await get('/');
    expect(page.body).toContain('Tải chứng chỉ Medone');
    expect(page.body).toContain(`https://${mod.localName()}:${P}`);
    const crt = await get('/medone-ca.crt');
    expect(crt.type).toBe('application/x-x509-ca-cert');
    expect(crt.body).toBe(readFileSync(join(dir, 'ca.crt'), 'utf8'));
    expect(crt.body).not.toContain('PRIVATE KEY');
  });
});
