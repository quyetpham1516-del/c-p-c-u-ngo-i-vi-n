import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HTTPS trong mạng nội bộ, để điện thoại kíp được trình duyệt cho lấy GPS (định vị chỉ chạy ở trang https).
 *   npm run https:cert   tạo một CA nội bộ của trung tâm và chứng chỉ cho tên máy chủ .local, localhost và các IP mạng nội bộ
 *   npm run start:https  cổng HTTPS gom web (Next.js) và API (Fastify) về một địa chỉ: /api và /ws chuyển sang API, còn lại sang web;
 *                        kèm một cổng http nhỏ phát trang hướng dẫn và tệp CA để cài lên điện thoại.
 * Khóa riêng nằm trong MEDONE_CERT_DIR (mặc định thư mục certs ở gốc dự án, không đưa lên git), chỉ chủ máy đọc được.
 * Mỗi điện thoại cài và tin CA một lần; tạo lại chứng chỉ máy chủ (khi đổi tên máy, đổi IP) không cần cài lại CA.
 * Máy chủ nhận IP động (DHCP): cổng HTTPS tự kiểm tra mỗi phút, IP mới chưa có trong chứng chỉ thì tự cấp lại chứng chỉ máy chủ
 * từ CA sẵn có và nạp ngay, không cần khởi động lại, điện thoại không phải cài lại gì.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const DIR = process.env.MEDONE_CERT_DIR || join(ROOT, 'certs');
const HTTPS_PORT = Number(process.env.MEDONE_HTTPS_PORT || 3443);
const HELP_PORT = Number(process.env.MEDONE_HTTPS_HELP_PORT || 3080);
const WEB_PORT = Number(process.env.MEDONE_WEB_PORT || 3000);
const API_PORT = Number(process.env.PORT || 8080);
/** Keycloak (đăng nhập một lần) chạy với KC_HTTP_RELATIVE_PATH=/auth: đi chung cổng HTTPS để máy trạm, máy tính bảng không phải tin thêm chứng chỉ */
const KEYCLOAK_PORT = Number(process.env.MEDONE_KEYCLOAK_PORT || 0);
const CA_NAME = 'Medone CA noi bo';
/** iOS chỉ chấp nhận chứng chỉ máy chủ tối đa 825 ngày */
const SERVER_DAYS = 825;

const file = (n: string) => join(DIR, n);

/** Tên .local của máy (mDNS) */
export function localName(): string {
  const h = hostname().toLowerCase();
  return h.includes('.') ? h : `${h}.local`;
}

/** IPv4 mạng nội bộ của máy */
export function lanIps(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
}

function openssl(args: string[]) {
  const r = spawnSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error) throw new Error(`Không chạy được openssl: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`openssl ${args[0]} lỗi: ${r.stderr.toString().trim().slice(0, 500)}`);
}

export function makeCerts(extraNames: string[] = []) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(file('ca.key')) || !existsSync(file('ca.crt'))) {
    openssl(['genrsa', '-out', file('ca.key'), '2048']);
    openssl(['req', '-x509', '-new', '-key', file('ca.key'), '-sha256', '-days', '3650', '-subj', `/CN=${CA_NAME}/O=Medone`, '-out', file('ca.crt')]);
    console.log('Đã tạo CA nội bộ mới: mọi điện thoại cần cài tệp ca.crt một lần');
  }
  const dns = [...new Set([localName(), 'localhost', ...extraNames])];
  const ips = [...new Set(['127.0.0.1', ...lanIps()])];
  const san = [...dns.map((d) => `DNS:${d}`), ...ips.map((i) => `IP:${i}`)].join(',');
  writeFileSync(file('server.ext'), [
    'basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth', `subjectAltName=${san}`, '',
  ].join('\n'));
  openssl(['genrsa', '-out', file('server.key'), '2048']);
  openssl(['req', '-new', '-key', file('server.key'), '-subj', `/CN=${localName()}/O=Medone`, '-out', file('server.csr')]);
  openssl(['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-CAcreateserial',
    '-days', String(SERVER_DAYS), '-sha256', '-extfile', file('server.ext'), '-out', file('server.crt')]);
  for (const k of ['ca.key', 'server.key']) chmodSync(file(k), 0o600);
  console.log(`Đã tạo chứng chỉ máy chủ cho: ${[...dns, ...ips].join(', ')} (hạn ${SERVER_DAYS} ngày)`);
  return { dns, ips };
}

/** Các IP đang có trong chứng chỉ máy chủ (đọc từ tệp server.ext lúc tạo) */
export function certIps(): string[] {
  try {
    const m = /subjectAltName=(.*)/.exec(readFileSync(file('server.ext'), 'utf8'));
    return m ? m[1].split(',').filter((x) => x.startsWith('IP:')).map((x) => x.slice(3).trim()) : [];
  } catch { return []; }
}

/** IP mạng nội bộ hiện có nhưng chứng chỉ chưa có */
export const missingIps = (have: string[], now = lanIps()) => now.filter((ip) => !have.includes(ip));

/** Chọn đích: API cho /api và /ws, Keycloak cho /auth (khi bật), web cho phần còn lại */
export const targetPort = (url = '/') => (/^\/(api|ws)(\/|\?|$)/.test(url) ? API_PORT
  : KEYCLOAK_PORT && /^\/auth(\/|\?|$)/.test(url) ? KEYCLOAK_PORT : WEB_PORT);

function forwardedHeaders(req: IncomingMessage) {
  const prior = req.headers['x-forwarded-for'];
  return {
    ...req.headers,
    'x-forwarded-for': [prior, req.socket.remoteAddress].filter(Boolean).join(', '),
    'x-forwarded-proto': 'https',
    'x-forwarded-host': req.headers.host ?? '',
  };
}

const help = (httpsUrl: string, ips: string[]) => `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Medone: cài chứng chỉ</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;line-height:1.5}
a.btn{display:inline-block;padding:12px 16px;border-radius:8px;background:#d0201b;color:#fff;text-decoration:none;margin:4px 0}li{margin:6px 0}</style></head><body>
<h2>Medone: cài chứng chỉ để dùng HTTPS</h2>
<p>Mỗi điện thoại hoặc máy tính bảng làm <b>một lần</b>. Sau đó luôn mở Medone bằng địa chỉ HTTPS ở cuối trang; ứng dụng kíp mới gửi được vị trí GPS.</p>
<p><a class="btn" href="/medone-ca.crt">Tải chứng chỉ Medone</a></p>
<h3>iPhone, iPad</h3><ol><li>Mở trang này bằng Safari, bấm "Tải chứng chỉ Medone", chọn Cho phép.</li>
<li>Cài đặt → Đã tải hồ sơ về → Cài đặt (nhập mật mã máy).</li>
<li>Cài đặt → Cài đặt chung → Giới thiệu → Cài đặt tin cậy chứng nhận → bật "${CA_NAME}".</li></ol>
<h3>Android</h3><ol><li>Bấm "Tải chứng chỉ Medone".</li>
<li>Cài đặt → Bảo mật → Mã hóa và thông tin xác thực → Cài đặt chứng chỉ → Chứng chỉ CA → chọn tệp medone-ca.crt vừa tải.</li></ol>
<h3>Máy Mac, Windows</h3><ol><li>Mac: mở tệp, thêm vào Keychain "Hệ thống", mở mục chứng chỉ, chọn Tin cậy luôn luôn.</li>
<li>Windows: mở tệp → Cài đặt chứng chỉ → Máy cục bộ → Trusted Root Certification Authorities.</li></ol>
<p>Xong thì mở: <a class="btn" href="${httpsUrl}">${httpsUrl}</a></p>
${ips.length ? `<p>Điện thoại không mở được tên ".local" (một số máy Android): dùng địa chỉ IP ${ips.map((ip) => `<a href="https://${ip}:${HTTPS_PORT}">https://${ip}:${HTTPS_PORT}</a>`).join(', ')}.
Địa chỉ IP có thể đổi khi máy chủ khởi động lại hoặc đổi mạng: nhờ người quản lý đặt IP cố định cho máy chủ trên bộ phát Wi-Fi (DHCP Reservation).</p>` : ''}
<p style="color:#666;font-size:14px">Chứng chỉ này chỉ dùng trong mạng nội bộ của trung tâm. Khi đăng nhập ở địa chỉ mới, cần đăng nhập lại một lần.</p></body></html>`;

export function serve() {
  if (!existsSync(file('server.crt')) || !existsSync(file('server.key'))) throw new Error('Chưa có chứng chỉ: chạy npm run https:cert trước');
  const tls = { key: readFileSync(file('server.key')), cert: readFileSync(file('server.crt')) };
  const ca = readFileSync(file('ca.crt'));

  const server = createHttpsServer(tls, (req, res) => {
    const up = request({ host: '127.0.0.1', port: targetPort(req.url), method: req.method, path: req.url, headers: forwardedHeaders(req) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Medone chưa sẵn sàng, thử lại sau vài giây'); });
    req.pipe(up);
  });

  // WebSocket (bảng đội xe, ứng dụng kíp): nối thẳng hai đầu sau khi chuyển tiếp yêu cầu nâng cấp
  server.on('upgrade', (req, socket, head) => {
    const up = connect(targetPort(req.url), '127.0.0.1', () => {
      const headers = forwardedHeaders(req);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v == null ? [] : [`${k}: ${v}`]))];
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    const close = () => { up.destroy(); socket.destroy(); };
    up.on('error', close); socket.on('error', close);
  });

  const httpsUrl = `https://${localName()}:${HTTPS_PORT}`;
  const helpServer = createHttpServer((req, res) => {
    if (req.url === '/medone-ca.crt') {
      res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="medone-ca.crt"' });
      return res.end(ca);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(help(httpsUrl, lanIps()));
  });

  // IP đổi (DHCP): cấp lại chứng chỉ máy chủ từ CA sẵn có và nạp ngay cho các kết nối mới
  const refresh = () => {
    const add = missingIps(certIps());
    if (!add.length || !existsSync(file('ca.key'))) return;
    try {
      makeCerts();
      server.setSecureContext({ key: readFileSync(file('server.key')), cert: readFileSync(file('server.crt')) });
      console.log(`IP mới ${add.join(', ')}: đã cấp lại và nạp chứng chỉ máy chủ`);
    } catch (e) {
      console.error(`Không cấp lại được chứng chỉ cho IP mới: ${(e as Error).message}`);
    }
  };
  refresh();
  const timer = setInterval(refresh, 60_000);
  timer.unref();

  server.listen(HTTPS_PORT, () => console.log(`HTTPS: ${httpsUrl} (web cổng ${WEB_PORT}, API cổng ${API_PORT})`));
  helpServer.listen(HELP_PORT, () => console.log(`Hướng dẫn cài chứng chỉ: http://${localName()}:${HELP_PORT}`));
  server.on('close', () => clearInterval(timer));
  return { server, helpServer };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] === 'cert') makeCerts(process.argv.slice(3));
    else serve();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
