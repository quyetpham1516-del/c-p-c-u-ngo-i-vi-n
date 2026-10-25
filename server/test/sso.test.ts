import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { resetSsoCache } from '../src/sso.js';
import { freshApp, login } from './helpers.js';

let app: FastifyInstance; let pool: pg.Pool;
let idp: Server; let issuer = '';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
/** Mã cấp cho từng lần đăng nhập: code -> người dùng + nonce + PKCE challenge */
const codes = new Map<string, { sub: string; username: string; nonce: string; challenge: string; tamper?: Partial<Record<string, any>>; key?: KeyObject; alg?: string }>();
let tokenRequests: { auth?: string; body: URLSearchParams }[] = [];

function jwt(claims: Record<string, any>, key: KeyObject = privateKey, alg = 'RS256') {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg, kid: 'k1', typ: 'JWT' }); const body = enc(claims);
  const sig = alg === 'none' ? '' : sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

beforeAll(async () => {
  idp = createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/realms/medone/.well-known/openid-configuration') {
      return res.end(JSON.stringify({
        issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/certs`,
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      }));
    }
    if (url.pathname === '/realms/medone/certs') {
      return res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] }));
    }
    if (url.pathname === '/realms/medone/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        tokenRequests.push({ auth: req.headers.authorization, body });
        const c = codes.get(body.get('code') ?? '');
        codes.delete(body.get('code') ?? '');
        const pkceOk = c && createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') === c.challenge;
        if (!c || !pkceOk) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Code not valid' })); }
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: issuer, aud: 'medone', azp: 'medone', sub: c.sub, preferred_username: c.username, nonce: c.nonce, iat: now, exp: now + 300, ...c.tamper };
        res.end(JSON.stringify({ access_token: 'x', token_type: 'Bearer', id_token: jwt(claims, c.key, c.alg) }));
      });
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/realms/medone`;
  ({ app, pool } = await freshApp());
});
afterAll(async () => {
  for (const k of ['MEDONE_OIDC_ISSUER', 'MEDONE_OIDC_CLIENT_ID', 'MEDONE_OIDC_CLIENT_SECRET', 'MEDONE_OIDC_LABEL']) delete process.env[k];
  await app.close(); await pool.end(); idp.close();
});
beforeEach(() => { resetSsoCache(); tokenRequests = []; });

const enable = () => Object.assign(process.env, { MEDONE_OIDC_ISSUER: issuer, MEDONE_OIDC_CLIENT_ID: 'medone', MEDONE_OIDC_CLIENT_SECRET: 'bi-mat-thu-nghiem', MEDONE_OIDC_LABEL: 'Đăng nhập bằng Keycloak' });
const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload as any });

/** Chạy trọn một lần đăng nhập: start -> (máy chủ SSO cấp code) -> callback */
async function ssoLogin(username: string, sub: string, opts: { tamper?: Record<string, any>; key?: KeyObject; alg?: string; replay?: boolean } = {}) {
  const start = await post('/api/auth/sso/start');
  expect(start.statusCode).toBe(200);
  const u = new URL(start.json().url);
  const code = `code-${Math.random().toString(36).slice(2)}`;
  codes.set(code, { sub, username, nonce: u.searchParams.get('nonce')!, challenge: u.searchParams.get('code_challenge')!, tamper: opts.tamper, key: opts.key, alg: opts.alg });
  const state = u.searchParams.get('state')!;
  const res = await post('/api/auth/sso/callback', { code, state });
  return { res, url: u, state };
}

describe('đăng nhập một lần (OIDC)', () => {
  it('tắt sẵn: không có nút, không bắt đầu được', async () => {
    delete process.env.MEDONE_OIDC_ISSUER;
    expect((await app.inject({ method: 'GET', url: '/api/auth/sso' })).json()).toEqual({ enabled: false });
    expect((await post('/api/auth/sso/start')).statusCode).toBe(404);
  });

  it('bật: địa chỉ đăng nhập có PKCE S256, state, nonce, đúng redirect_uri', async () => {
    enable();
    expect((await app.inject({ method: 'GET', url: '/api/auth/sso' })).json()).toEqual({ enabled: true, label: 'Đăng nhập bằng Keycloak' });
    const u = new URL((await post('/api/auth/sso/start')).json().url);
    expect(u.origin + u.pathname).toBe(`${issuer}/auth`);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('client_id')).toBe('medone');
    expect(u.searchParams.get('scope')).toContain('openid');
    expect(u.searchParams.get('redirect_uri')).toMatch(/\/dang-nhap$/);
    expect(u.searchParams.get('state')!.length).toBeGreaterThan(20);
    // Máy trực dùng chung: mặc định bắt nhập lại mật khẩu ở máy chủ SSO
    expect(u.searchParams.get('prompt')).toBe('login');
    process.env.MEDONE_OIDC_PROMPT = '-';
    expect(new URL((await post('/api/auth/sso/start')).json().url).searchParams.get('prompt')).toBeNull();
    delete process.env.MEDONE_OIDC_PROMPT;
  });

  it('lần đầu nối theo tên đăng nhập, cấp phiên; gửi client secret bằng Basic; ghi nhật ký', async () => {
    enable();
    const { res } = await ssoLogin('dpv06', 'kc-sub-dpv06');
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('dpv06');
    expect(tokenRequests[0].auth).toMatch(/^Basic /);
    expect(tokenRequests[0].body.get('client_secret')).toBeNull();
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${res.json().token}` } });
    expect(me.json().user.role).toBe('dispatcher');
    const u = (await pool.query(`SELECT sso_subject, sso_issuer FROM users WHERE username = 'dpv06'`)).rows[0];
    expect(u).toEqual({ sso_subject: 'kc-sub-dpv06', sso_issuer: issuer });
    const acts = (await pool.query(`SELECT action, data FROM audit_events WHERE entity_id = (SELECT id::text FROM users WHERE username = 'dpv06') ORDER BY id`)).rows;
    expect(acts.map((a) => a.action)).toEqual(expect.arrayContaining(['auth.sso_linked', 'auth.login']));
    expect(acts.find((a) => a.action === 'auth.login').data.sso).toBe(true);
  });

  it('lần sau nhận theo mã sub, kể cả khi tên trên máy chủ SSO đổi', async () => {
    enable();
    const { res } = await ssoLogin('ten-moi-tren-keycloak', 'kc-sub-dpv06');
    expect(res.json().user.username).toBe('dpv06');
  });

  it('không chiếm tài khoản đã nối với người khác; tài khoản không có trong Medone bị từ chối', async () => {
    enable();
    const a = await ssoLogin('dpv06', 'kc-sub-ke-gian');
    expect(a.res.statusCode).toBe(403);
    const b = await ssoLogin('nguoi-la', 'kc-sub-nguoi-la');
    expect(b.res.statusCode).toBe(403);
    expect(b.res.json().error).toContain('nguoi-la');
    const n = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.sso_rejected'`);
    expect(n.rows[0].n).toBe(2);
  });

  it('tài khoản bị khóa trong Medone không vào được bằng SSO', async () => {
    enable();
    await pool.query(`UPDATE users SET active = false WHERE username = 'dpv06'`);
    expect((await ssoLogin('dpv06', 'kc-sub-dpv06')).res.statusCode).toBe(403);
    await pool.query(`UPDATE users SET active = true WHERE username = 'dpv06'`);
  });

  it('state dùng một lần, sai state bị từ chối', async () => {
    enable();
    const { state } = await ssoLogin('dpv07', 'kc-sub-dpv07');
    expect((await post('/api/auth/sso/callback', { code: 'bat-ky', state })).statusCode).toBe(401);
    expect((await post('/api/auth/sso/callback', { code: 'bat-ky', state: 'state-khong-ton-tai-123' })).statusCode).toBe(401);
  });

  it('từ chối id_token sai chữ ký, alg none, sai audience, sai issuer, hết hạn, sai nonce', async () => {
    enable();
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, Parameters<typeof ssoLogin>[2]][] = [
      ['chữ ký', { key: other.privateKey }],
      ['alg none', { alg: 'none' }],
      ['audience', { tamper: { aud: 'ung-dung-khac', azp: 'ung-dung-khac' } }],
      ['issuer', { tamper: { iss: 'http://gia-mao' } }],
      ['hết hạn', { tamper: { exp: now - 600 } }],
      ['nonce', { tamper: { nonce: 'khac' } }],
    ];
    for (const [name, opts] of cases) {
      const { res } = await ssoLogin('dpv08', 'kc-sub-dpv08', opts);
      expect(res.statusCode, name).toBe(401);
    }
    expect((await pool.query(`SELECT sso_subject FROM users WHERE username = 'dpv08'`)).rows[0].sso_subject).toBeNull();
  });

  it('người đã cài xác thực hai lớp vẫn phải nhập mã sau SSO', async () => {
    enable();
    await pool.query(`UPDATE users SET totp_enabled_at = now() WHERE username = 'dpv09'`);
    const { res } = await ssoLogin('dpv09', 'kc-sub-dpv09');
    expect(res.json().mfaRequired).toBe(true);
    expect(res.json().token).toBeUndefined();
    await pool.query(`UPDATE users SET totp_enabled_at = NULL WHERE username = 'dpv09'`);
  });

  it('quản trị gỡ nối: lần sau nối lại theo tên', async () => {
    enable();
    const admin = await login(app, 'admin');
    const id = (await pool.query(`SELECT id FROM users WHERE username = 'dpv06'`)).rows[0].id;
    expect((await admin('GET', '/api/users')).data.find((u: any) => u.id === id).sso_linked_at).toBeTruthy();
    expect((await admin('POST', `/api/users/${id}/sso-unlink`)).http).toBe(200);
    expect((await (await login(app, 'dpv01'))('POST', `/api/users/${id}/sso-unlink`)).http).toBe(403);
    const { res } = await ssoLogin('dpv06', 'kc-sub-dpv06-moi');
    expect(res.statusCode).toBe(200);
  });

  it('máy chủ SSO trả issuer khác cấu hình thì không dùng', async () => {
    Object.assign(process.env, { MEDONE_OIDC_ISSUER: `${issuer}/`, MEDONE_OIDC_CLIENT_ID: 'medone' });
    expect((await post('/api/auth/sso/start')).statusCode).toBe(200);
    process.env.MEDONE_OIDC_ISSUER = issuer.replace('127.0.0.1', 'localhost');
    resetSsoCache();
    expect((await post('/api/auth/sso/start')).statusCode).toBe(502);
  });
});
