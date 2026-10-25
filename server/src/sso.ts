import { constants, createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import { config } from './config.js';
import { one, type Queryable } from './db.js';
import { HttpError } from './domain.js';

/**
 * Đăng nhập một lần theo chuẩn OpenID Connect (luồng Authorization Code + PKCE).
 * Dùng được với Keycloak tự cài, Microsoft Entra ID, Google Workspace... Đọc cấu hình mỗi lần gọi để bật/tắt không cần sửa mã.
 */
export function ssoConfig() {
  const issuer = process.env.MEDONE_OIDC_ISSUER?.trim().replace(/\/$/, '');
  const clientId = process.env.MEDONE_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  return {
    issuer, clientId,
    clientSecret: process.env.MEDONE_OIDC_CLIENT_SECRET || null,
    redirectUri: process.env.MEDONE_OIDC_REDIRECT_URI?.trim() || `${config.webOrigins[0]}/dang-nhap`,
    label: process.env.MEDONE_OIDC_LABEL?.trim() || 'Đăng nhập một lần (SSO)',
    usernameClaim: process.env.MEDONE_OIDC_USERNAME_CLAIM?.trim() || 'preferred_username',
    // Máy trực dùng chung theo ca: mặc định bắt nhập lại mật khẩu ở máy chủ SSO mỗi lần, để người ca sau không vào nhầm phiên người ca trước.
    // Đặt MEDONE_OIDC_PROMPT=- nếu mỗi người dùng máy riêng và muốn đã đăng nhập SSO là vào thẳng.
    prompt: (process.env.MEDONE_OIDC_PROMPT ?? 'login').trim(),
  };
}
type Sso = NonNullable<ReturnType<typeof ssoConfig>>;

const b64url = (b: Buffer) => b.toString('base64url');
const STATE_TTL_MIN = 10;
const SKEW_S = 60;

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string; token_endpoint_auth_methods_supported?: string[] }
const discoveryCache = new Map<string, { at: number; d: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: any[] }>();

async function getJson(url: string, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new HttpError(502, 'Không kết nối được máy chủ đăng nhập một lần');
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* trả lỗi bên dưới */ }
  return { ok: res.ok, status: res.status, json };
}

export async function discovery(s: Sso): Promise<Discovery> {
  const c = discoveryCache.get(s.issuer);
  if (c && Date.now() - c.at < 3600_000) return c.d;
  const r = await getJson(`${s.issuer}/.well-known/openid-configuration`);
  if (!r.ok || !r.json?.authorization_endpoint) throw new HttpError(502, 'Máy chủ đăng nhập một lần trả cấu hình không hợp lệ');
  // Chống giả mạo: issuer trong tài liệu phải đúng địa chỉ đã cấu hình
  if (r.json.issuer.replace(/\/$/, '') !== s.issuer) throw new HttpError(502, 'Issuer của máy chủ đăng nhập một lần không khớp cấu hình');
  discoveryCache.set(s.issuer, { at: Date.now(), d: r.json });
  return r.json;
}

async function jwk(d: Discovery, kid: string | undefined, alg: string): Promise<KeyObject> {
  const pick = (keys: any[]) => keys.find((k) => (kid ? k.kid === kid : true) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === alg));
  let c = jwksCache.get(d.jwks_uri);
  let key = c && Date.now() - c.at < 3600_000 ? pick(c.keys) : undefined;
  if (!key) {
    // Máy chủ SSO đổi khóa: tải lại bộ khóa một lần
    const r = await getJson(d.jwks_uri);
    if (!r.ok || !Array.isArray(r.json?.keys)) throw new HttpError(502, 'Không tải được khóa của máy chủ đăng nhập một lần');
    c = { at: Date.now(), keys: r.json.keys };
    jwksCache.set(d.jwks_uri, c);
    key = pick(c.keys);
  }
  if (!key) throw new HttpError(401, 'Không tìm thấy khóa ký của mã đăng nhập');
  return createPublicKey({ key, format: 'jwk' });
}

const ALGS: Record<string, { hash: string; kind: 'rsa' | 'pss' | 'ec' }> = {
  RS256: { hash: 'sha256', kind: 'rsa' }, RS384: { hash: 'sha384', kind: 'rsa' }, RS512: { hash: 'sha512', kind: 'rsa' },
  PS256: { hash: 'sha256', kind: 'pss' }, PS384: { hash: 'sha384', kind: 'pss' }, PS512: { hash: 'sha512', kind: 'pss' },
  ES256: { hash: 'sha256', kind: 'ec' }, ES384: { hash: 'sha384', kind: 'ec' }, ES512: { hash: 'sha512', kind: 'ec' },
};

/** Kiểm tra id_token: chữ ký theo JWKS, issuer, audience, hạn dùng, nonce */
export async function verifyIdToken(s: Sso, d: Discovery, token: string, nonce: string): Promise<Record<string, any>> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Mã đăng nhập không hợp lệ');
  let header: any; let claims: any;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    throw new HttpError(401, 'Mã đăng nhập không hợp lệ');
  }
  const alg = ALGS[header.alg];
  // Không nhận "none" hay HS256 (khóa đối xứng): chỉ chữ ký khóa công khai
  if (!alg) throw new HttpError(401, `Thuật toán ký ${header.alg} không được chấp nhận`);
  const key = await jwk(d, header.kid, header.alg);
  const ok = verify(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), {
    key,
    ...(alg.kind === 'pss' ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : {}),
    ...(alg.kind === 'ec' ? { dsaEncoding: 'ieee-p1363' as const } : {}),
  }, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new HttpError(401, 'Chữ ký mã đăng nhập không đúng');
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (String(claims.iss).replace(/\/$/, '') !== s.issuer) throw new HttpError(401, 'Mã đăng nhập không do máy chủ đã cấu hình cấp');
  if (!aud.includes(s.clientId) || (aud.length > 1 && claims.azp && claims.azp !== s.clientId)) throw new HttpError(401, 'Mã đăng nhập không dành cho Medone');
  if (typeof claims.exp !== 'number' || claims.exp < now - SKEW_S) throw new HttpError(401, 'Mã đăng nhập đã hết hạn');
  if (typeof claims.iat === 'number' && claims.iat > now + SKEW_S) throw new HttpError(401, 'Giờ trên máy chủ đăng nhập một lần lệch quá nhiều');
  if (claims.nonce !== nonce) throw new HttpError(401, 'Mã đăng nhập không khớp phiên (nonce)');
  if (!claims.sub) throw new HttpError(401, 'Mã đăng nhập thiếu định danh người dùng');
  return claims;
}

/** Bắt đầu: tạo state, nonce, PKCE; trả địa chỉ trang đăng nhập của máy chủ SSO */
export async function startLogin(q: Queryable, s: Sso) {
  const d = await discovery(s);
  const state = b64url(randomBytes(24)); const nonce = b64url(randomBytes(24)); const verifier = b64url(randomBytes(48));
  await q.query(`DELETE FROM sso_states WHERE created_at < now() - make_interval(mins => $1)`, [STATE_TTL_MIN]);
  await q.query('INSERT INTO sso_states(state, nonce, verifier, redirect_uri) VALUES ($1,$2,$3,$4)', [state, nonce, verifier, s.redirectUri]);
  const qs = new URLSearchParams({
    response_type: 'code', client_id: s.clientId, redirect_uri: s.redirectUri, scope: 'openid profile email',
    state, nonce, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  });
  if (s.prompt && s.prompt !== '-') qs.set('prompt', s.prompt);
  return `${d.authorization_endpoint}?${qs}`;
}

/** Quay về: đổi mã lấy id_token (state dùng một lần), kiểm tra id_token */
export async function finishLogin(q: Queryable, s: Sso, code: string, state: string) {
  const st = await one(q, `DELETE FROM sso_states WHERE state = $1 RETURNING nonce, verifier, redirect_uri, created_at > now() - make_interval(mins => $2) AS fresh`, [state, STATE_TTL_MIN]);
  if (!st) throw new HttpError(401, 'Phiên đăng nhập một lần không hợp lệ hoặc đã dùng; bấm đăng nhập lại');
  if (!st.fresh) throw new HttpError(401, 'Phiên đăng nhập một lần đã quá 10 phút; bấm đăng nhập lại');
  const d = await discovery(s);
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: st.redirect_uri, client_id: s.clientId, code_verifier: st.verifier });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (s.clientSecret) {
    const methods = d.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (methods.includes('client_secret_basic')) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(s.clientId)}:${encodeURIComponent(s.clientSecret)}`).toString('base64')}`;
    } else form.set('client_secret', s.clientSecret);
  }
  const r = await getJson(d.token_endpoint, { method: 'POST', headers, body: form });
  if (!r.ok || !r.json?.id_token) {
    throw new HttpError(401, `Máy chủ đăng nhập một lần từ chối (${r.json?.error_description ?? r.json?.error ?? r.status})`);
  }
  return verifyIdToken(s, d, r.json.id_token, st.nonce);
}

/** Tìm tài khoản Medone cho người đăng nhập SSO: theo (issuer, sub) đã nối, nếu chưa nối thì theo tên đăng nhập */
export async function findSsoUser(q: Queryable, s: Sso, claims: Record<string, any>) {
  const linked = await one(q, 'SELECT * FROM users WHERE sso_issuer = $1 AND sso_subject = $2', [s.issuer, String(claims.sub)]);
  if (linked) return { user: linked.active ? linked : null, linkedNow: false, username: linked.username };
  const username = String(claims[s.usernameClaim] ?? '').trim().toLowerCase();
  if (!username) return { user: null, linkedNow: false, username: null };
  const u = await one(q, 'SELECT * FROM users WHERE username = $1 AND active', [username]);
  // Tài khoản đã nối với người khác trên máy chủ SSO thì không nối lại theo tên (chống chiếm tài khoản khi trùng tên)
  if (!u || u.sso_subject) return { user: null, linkedNow: false, username };
  await q.query('UPDATE users SET sso_issuer = $2, sso_subject = $3, sso_linked_at = now() WHERE id = $1', [u.id, s.issuer, String(claims.sub)]);
  return { user: u, linkedNow: true, username };
}

/** Để kiểm thử: xóa bộ nhớ đệm cấu hình và khóa */
export function resetSsoCache() { discoveryCache.clear(); jwksCache.clear(); }
