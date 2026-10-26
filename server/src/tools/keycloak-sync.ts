import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Dựng Keycloak cho Medone: realm "medone", client "medone" (bí mật, PKCE S256), tài khoản Keycloak cho từng người dùng Medone đang hoạt động
 * (tên đăng nhập trùng nhau, bắt đổi mật khẩu lần đầu), khóa tài khoản Keycloak của người đã nghỉ. Ghi biến MEDONE_OIDC_* vào .env.
 * Chạy lại được nhiều lần: chỉ thêm cái còn thiếu. Không in mật khẩu hay client secret ra màn hình.
 *
 *   MEDONE_PUBLIC_URL=https://192.168.1.54:3443 KC_BOOTSTRAP_ADMIN_PASSWORD=... npm run keycloak:sync
 *   tùy chọn: MEDONE_KEYCLOAK_URL (mặc định http://127.0.0.1:8180/auth), KC_BOOTSTRAP_ADMIN_USERNAME (mặc định admin),
 *             MEDONE_KEYCLOAK_INITIAL_PASSWORD (mật khẩu tạm cho tài khoản mới; không đặt thì quản trị đặt từng người trên Keycloak)
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const REALM = 'medone';
const CLIENT = 'medone';

export interface SyncOptions {
  kcUrl: string; adminUser: string; adminPassword: string; publicUrl: string; initialPassword: string | null;
  users: { username: string; full_name: string; active: boolean }[];
}

async function kc(base: string, token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok && r.status !== 404) throw new Error(`Keycloak ${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

export async function syncKeycloak(o: SyncOptions) {
  const base = o.kcUrl.replace(/\/$/, '');
  const pub = o.publicUrl.replace(/\/$/, '');
  const tr = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: o.adminUser, password: o.adminPassword }),
  });
  if (!tr.ok) throw new Error(`Không đăng nhập được quản trị Keycloak (${tr.status})`);
  const token = (await tr.json()).access_token as string;
  const api = (m: string, p: string, b?: unknown) => kc(base, token, m, `/admin/realms${p}`, b);
  const report = { realmCreated: false, clientCreated: false, usersCreated: 0, usersDisabled: 0, usersExisting: 0 };

  if ((await api('GET', `/${REALM}`)).status === 404) {
    await api('POST', '', {
      realm: REALM, enabled: true, displayName: 'Medone', loginWithEmailAllowed: false, duplicateEmailsAllowed: true,
      internationalizationEnabled: true, supportedLocales: ['vi', 'en'], defaultLocale: 'vi',
      bruteForceProtected: true, failureFactor: 5, passwordPolicy: 'length(10) and notUsername',
    });
    report.realmCreated = true;
  }

  // Keycloak 26 mặc định bắt nhập email, họ: nhân viên trực không nhất thiết có email công việc nên bỏ bắt buộc
  const profile = (await api('GET', `/${REALM}/users/profile`)).json;
  let changed = false;
  for (const a of profile.attributes ?? []) {
    if (['email', 'lastName'].includes(a.name) && a.required) { delete a.required; changed = true; }
  }
  if (changed) await api('PUT', `/${REALM}/users/profile`, profile);

  const redirect = `${pub}/dang-nhap`;
  const found = (await api('GET', `/${REALM}/clients?clientId=${CLIENT}`)).json as any[];
  let clientUuid: string;
  if (!found.length) {
    await api('POST', `/${REALM}/clients`, {
      clientId: CLIENT, name: 'Medone', protocol: 'openid-connect', publicClient: false, standardFlowEnabled: true,
      directAccessGrantsEnabled: false, implicitFlowEnabled: false, serviceAccountsEnabled: false,
      redirectUris: [redirect], webOrigins: [pub],
      attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': `${pub}/*` },
    });
    clientUuid = ((await api('GET', `/${REALM}/clients?clientId=${CLIENT}`)).json as any[])[0].id;
    report.clientCreated = true;
  } else {
    const c = found[0]; clientUuid = c.id;
    // Địa chỉ web đổi (IP mới): thêm địa chỉ chuyển hướng mới, giữ địa chỉ cũ
    if (!c.redirectUris?.includes(redirect)) {
      await api('PUT', `/${REALM}/clients/${clientUuid}`, { ...c, redirectUris: [...(c.redirectUris ?? []), redirect], webOrigins: [...new Set([...(c.webOrigins ?? []), pub])] });
    }
  }
  const secret = (await api('GET', `/${REALM}/clients/${clientUuid}/client-secret`)).json.value as string;

  for (const u of o.users) {
    const name = u.username.toLowerCase();
    const ex = ((await api('GET', `/${REALM}/users?username=${encodeURIComponent(name)}&exact=true`)).json as any[])[0];
    if (!ex) {
      if (!u.active) continue;
      await api('POST', `/${REALM}/users`, {
        username: name, enabled: true, firstName: u.full_name, emailVerified: false,
        requiredActions: ['UPDATE_PASSWORD'],
        credentials: o.initialPassword ? [{ type: 'password', value: o.initialPassword, temporary: true }] : [],
      });
      report.usersCreated++;
    } else if (!u.active && ex.enabled) {
      await api('PUT', `/${REALM}/users/${ex.id}`, { ...ex, enabled: false });
      report.usersDisabled++;
    } else report.usersExisting++;
  }
  return { ...report, secret, issuer: `${pub}/auth/realms/${REALM}`, discovery: `${base}/realms/${REALM}`, redirect };
}

/** Đặt (hoặc thay) biến trong .env, giữ nguyên phần còn lại */
export function setEnvVars(text: string, vars: Record<string, string>): string {
  let out = text;
  const add: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    if (re.test(out)) out = out.replace(re, `${k}=${v}`);
    else add.push(`${k}=${v}`);
  }
  if (add.length) out = `${out.replace(/\n*$/, '\n')}\n# Đăng nhập một lần (npm run keycloak:sync)\n${add.join('\n')}\n`;
  return out;
}

async function main() {
  const publicUrl = process.env.MEDONE_PUBLIC_URL?.trim();
  const adminPassword = process.env.KC_BOOTSTRAP_ADMIN_PASSWORD;
  if (!publicUrl || !/^https?:\/\/[\w.:-]+$/.test(publicUrl)) throw new Error('Đặt MEDONE_PUBLIC_URL, ví dụ https://192.168.1.54:3443 (địa chỉ mọi người mở Medone)');
  if (!adminPassword) throw new Error('Đặt KC_BOOTSTRAP_ADMIN_PASSWORD (mật khẩu quản trị Keycloak)');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const users = (await pool.query('SELECT username, full_name, active FROM users ORDER BY username')).rows;
  await pool.end();
  const kcUrl = process.env.MEDONE_KEYCLOAK_URL?.trim() || 'http://127.0.0.1:8180/auth';
  const r = await syncKeycloak({
    kcUrl, adminUser: process.env.KC_BOOTSTRAP_ADMIN_USERNAME?.trim() || 'admin', adminPassword, publicUrl,
    initialPassword: process.env.MEDONE_KEYCLOAK_INITIAL_PASSWORD || null, users,
  });
  const port = new URL(kcUrl).port || '80';
  writeFileSync(envFile, setEnvVars(existsSync(envFile) ? readFileSync(envFile, 'utf8') : '', {
    MEDONE_OIDC_ISSUER: r.issuer, MEDONE_OIDC_DISCOVERY_URL: r.discovery, MEDONE_OIDC_CLIENT_ID: CLIENT,
    MEDONE_OIDC_CLIENT_SECRET: r.secret, MEDONE_OIDC_REDIRECT_URI: r.redirect, MEDONE_KEYCLOAK_PORT: port,
  }), { mode: 0o600 });
  console.log(`Realm ${REALM}: ${r.realmCreated ? 'mới tạo' : 'đã có'}; client ${CLIENT}: ${r.clientCreated ? 'mới tạo' : 'đã có'}`);
  console.log(`Tài khoản Keycloak: tạo mới ${r.usersCreated}, đã có ${r.usersExisting}, khóa ${r.usersDisabled} (người đã nghỉ trong Medone)`);
  console.log(`Đã ghi vào .env: MEDONE_OIDC_ISSUER=${r.issuer}, MEDONE_OIDC_DISCOVERY_URL, MEDONE_OIDC_CLIENT_ID, MEDONE_OIDC_CLIENT_SECRET (không in), MEDONE_OIDC_REDIRECT_URI, MEDONE_KEYCLOAK_PORT=${port}`);
  console.log('Khởi động lại API và cổng HTTPS để nhận.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
