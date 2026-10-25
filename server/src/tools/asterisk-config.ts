import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sinh bộ cấu hình Asterisk cho Medone: máy lẻ của điều phối viên, hàng chờ "dieu-phoi", ghi âm MixMonitor,
 * webhook báo cuộc gọi về máy chủ, ARI để gọi ra. Mật khẩu máy lẻ và ARI sinh ngẫu nhiên, ghi vào thư mục
 * generated (không đưa lên Git) và .env; không in mật khẩu ra màn hình.
 *
 *   npm run asterisk:config -- --may-le=101-110 [--api=http://127.0.0.1:8080] [--ghi-am=/duong/dan] [--duong-115=<số DID>] [--may-thu=199]
 *   asterisk -C <thư mục generated>/asterisk.conf -f    (chạy thử ở chế độ nền trước)
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const arg = (name: string, fallback: string) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
};

export function parseRange(spec: string): string[] {
  const out: string[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{2,6})(?:-(\d{2,6}))?$/.exec(part);
    if (!m) throw new Error(`Máy lẻ không hợp lệ: ${part}`);
    const a = Number(m[1]); const b = Number(m[2] ?? m[1]);
    if (b < a || b - a > 200) throw new Error(`Khoảng máy lẻ không hợp lệ: ${part}`);
    for (let i = a; i <= b; i++) out.push(String(i).padStart(m[1].length, '0'));
  }
  return out;
}

const pw = () => randomBytes(18).toString('base64url');

/** Đọc lại mật khẩu đã sinh lần trước để chạy lại không đổi mật khẩu điện thoại đã cài */
function loadSecrets(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^(\S+)\s+(\S+)$/.exec(line.trim());
    if (m && !line.startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

export interface PbxOptions {
  dir: string; exts: string[]; testExt: string | null; api: string; telephonyKey: string; recordings: string;
  did115: string | null; ariUser: string; ariPassword: string; secrets: Record<string, string>;
  /** Phiên bản Asterisk: từ bản 21 Queue() bỏ tham số macro, vị trí tham số gosub đổi */
  major: number;
}

export function renderConfig(o: PbxOptions): Record<string, string> {
  const all = [...o.exts, ...(o.testExt ? [o.testExt] : [])];
  const endpoint = (e: string, context: string) => `
[${e}]
type=endpoint
context=${context}
disallow=all
allow=g722,alaw,ulaw
auth=${e}-auth
aors=${e}
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
callerid=${e === o.testExt ? 'May thu' : `May le ${e}`} <${e}>

[${e}-auth]
type=auth
auth_type=userpass
username=${e}
password=${o.secrets[e]}

[${e}]
type=aor
max_contacts=2
remove_existing=yes
qualify_frequency=30
`;
  const curl = (path: string, data: string) =>
    ` same => n,Set(KQ=\${CURL(\${MEDONE_API}${path},${data})})`;
  // Đặt khóa webhook một lần cho mỗi kênh (đặt lại sẽ gửi trùng tiêu đề)
  const key = ' same => n,Set(CURLOPT(httpheader)=X-Medone-Telephony-Key: ${MEDONE_KEY})';
  return {
    'asterisk.conf': `; Sinh bởi npm run asterisk:config. Chạy: asterisk -C ${o.dir}/asterisk.conf
[directories]
astetcdir => ${o.dir}
astrundir => ${o.dir}/run
astlogdir => ${o.dir}/log
astspooldir => ${o.dir}/spool
astdbdir => ${o.dir}/db

[options]
verbose = 3
`,
    'modules.conf': `[modules]
autoload=yes
noload => chan_sip.so
noload => res_hep.so
noload => res_hep_pjsip.so
noload => res_hep_rtcp.so
noload => cdr_radius.so
noload => cel_radius.so
noload => res_phoneprov.so
noload => res_pjsip_phoneprov_provider.so
`,
    'logger.conf': `[general]
[logfiles]
console => notice,warning,error
messages.log => notice,warning,error
`,
    'pjsip.conf': `; Máy lẻ điều phối: ${o.exts.join(', ')}${o.testExt ? `; máy thử (gọi 1800 để giả lập người báo): ${o.testExt}` : ''}
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
${o.exts.map((e) => endpoint(e, 'medone-noi-bo')).join('')}${o.testExt ? endpoint(o.testExt, 'medone-noi-bo') : ''}
; Trung kế nhà mạng/nhà cung cấp (đường 1800 và đường nóng từ 115): bỏ dấu ; và điền thông tin nhà cung cấp cấp
; [nha-mang]
; type=registration
; server_uri=sip:sip.nha-cung-cap.vn
; client_uri=sip:TAI_KHOAN@sip.nha-cung-cap.vn
; outbound_auth=nha-mang-auth
; [nha-mang-auth]
; type=auth
; auth_type=userpass
; username=TAI_KHOAN
; password=MAT_KHAU_NHA_CUNG_CAP
; [nha-mang]
; type=aor
; contact=sip:sip.nha-cung-cap.vn
; [nha-mang]
; type=endpoint
; context=medone-vao
; disallow=all
; allow=alaw,ulaw
; outbound_auth=nha-mang-auth
; aors=nha-mang
; [nha-mang]
; type=identify
; endpoint=nha-mang
; match=sip.nha-cung-cap.vn
`,
    'queues.conf': `[general]
persistentmembers=no

[dieu-phoi]
strategy=rrmemory
timeout=15
retry=1
wrapuptime=5
ringinuse=no
joinempty=yes
leavewhenempty=no
announce-frequency=0
${o.exts.map((e) => `member => PJSIP/${e}`).join('\n')}
`,
    'extensions.conf': `[general]
static=yes
writeprotect=yes

[globals]
MEDONE_API=${o.api}
MEDONE_KEY=${o.telephonyKey}
REC_DIR=${o.recordings}
DID_115=${o.did115 ?? ''}

; Cuộc gọi từ trung kế nhà mạng: số gọi tới là DID_115 thì là đường nóng từ 115, còn lại là đường 1800
[medone-vao]
exten => _X.,1,Set(__LINE=\${IF($["\${EXTEN}" = "\${DID_115}"]?115:1800)})
 same => n,Goto(medone-hang-cho,s,1)

; Hàng chờ: báo phần mềm có cuộc gọi, ghi âm từ lúc nối máy, đổ chuông các máy lẻ điều phối
[medone-hang-cho]
exten => s,1,NoOp(Cuoc goi \${CALLERID(num)} duong \${LINE})
 same => n,Set(__MEDONE_CALL=\${UNIQUEID})
 same => n,Set(__REC=\${UNIQUEID}.wav)
 same => n,Set(CHANNEL(hangup_handler_push)=medone-gac-may,s,1)
${key}
${curl('/api/telephony/ring', 'phone=${URIENCODE(${CALLERID(num)})}&line=${LINE}&pbxId=${UNIQUEID}')}
 same => n,Answer()
 same => n,MixMonitor(\${REC_DIR}/\${REC},b)
 same => n,Queue(dieu-phoi,t,,,3600,${o.major >= 21 ? '' : ','},medone-nhac-may)
 same => n,Hangup()

; Chạy trên kênh của máy lẻ vừa nhấc máy: báo phần mềm ai nhận để mở ca trên màn hình người đó
[medone-nhac-may]
exten => s,1,Set(EXT=\${CHANNEL(endpoint)})
 same => n,Set(T=\${CHANNEL(name)})
 same => n,Set(T=\${CUT(T,/,2)})
 same => n,ExecIf($["\${EXT}" = ""]?Set(EXT=\${CUT(T,@,1)}))
 same => n,NoOp(May le \${EXT} nhan \${MEDONE_CALL})
${key}
${curl('/api/telephony/answered', 'pbxId=${MEDONE_CALL}&ext=${EXT}')}
 same => n,Return()

; Gác máy: phần mềm đánh dấu bỏ dở (chưa ai nhấc) hoặc kết thúc, lưu tên tệp ghi âm
[medone-gac-may]
exten => s,1,NoOp(Gac may \${UNIQUEID})
${curl('/api/telephony/hangup', 'pbxId=${UNIQUEID}&recording=${REC}&cause=${HANGUPCAUSE}')}
 same => n,Return()

; Gọi ra từ phần mềm (ARI): kênh máy lẻ đã nhấc máy, ghi âm rồi quay số người báo
[medone-goi-ra]
exten => _X.,1,Set(REC=\${UNIQUEID}.wav)
 same => n,Set(CHANNEL(hangup_handler_push)=medone-gac-may,s,1)
${key}
 same => n,MixMonitor(\${REC_DIR}/\${REC},b)
 same => n,GotoIf($[\${LEN(\${EXTEN})} <= 6]?noi-bo)
 same => n,Dial(PJSIP/\${EXTEN}@nha-mang,60)
 same => n,Hangup()
 same => n(noi-bo),Dial(PJSIP/\${EXTEN},60)
 same => n,Hangup()

; Máy lẻ gọi nhau; gọi 1800 để giả lập người báo vào hàng chờ (chạy thử khi chưa có trung kế)
[medone-noi-bo]
exten => _X.,1,GotoIf($["\${EXTEN}" = "1800"]?gia-lap)
 same => n,Dial(PJSIP/\${EXTEN},30)
 same => n,Hangup()
 same => n(gia-lap),Set(__LINE=1800)
 same => n,Goto(medone-hang-cho,s,1)
`,
    'http.conf': `[general]
enabled=yes
bindaddr=127.0.0.1
bindport=8088
`,
    'ari.conf': `[general]
enabled=yes

[${o.ariUser}]
type=user
read_only=no
password=${o.ariPassword}
`,
    'musiconhold.conf': `[default]
mode=files
directory=moh
`,
    'rtp.conf': `[general]
rtpstart=10000
rtpend=10200
`,
  };
}

/** Đọc phiên bản Asterisk đã cài (asterisk -V); không có thì lấy theo --asterisk= hoặc 20 */
function asteriskMajor(): number {
  const given = Number(arg('asterisk', ''));
  if (given) return given;
  try {
    const m = /Asterisk (\d+)/.exec(execFileSync('asterisk', ['-V'], { encoding: 'utf8' }));
    if (m) return Number(m[1]);
  } catch { /* chưa cài trên máy này */ }
  return 20;
}

function main() {
  const dir = resolve(arg('thu-muc', resolve(root, 'deploy/asterisk/generated')));
  const exts = parseRange(arg('may-le', '101-110'));
  const testExt = arg('may-thu', '199') || null;
  const recordings = resolve(arg('ghi-am', process.env.MEDONE_RECORDINGS_DIR || resolve(root, 'data/ghi-am')));
  const telephonyKey = process.env.MEDONE_TELEPHONY_KEY;
  if (!telephonyKey) throw new Error('Chưa có MEDONE_TELEPHONY_KEY: chạy npm run setup trước');
  for (const d of [dir, `${dir}/run`, `${dir}/log`, `${dir}/spool`, `${dir}/db`, recordings]) mkdirSync(d, { recursive: true });

  const secretFile = `${dir}/may-le.txt`;
  const secrets = loadSecrets(secretFile);
  for (const e of [...exts, ...(testExt ? [testExt] : [])]) secrets[e] ??= pw();
  writeFileSync(secretFile, `# Mật khẩu máy lẻ SIP (tài khoản = số máy lẻ). Chỉ cấp cho người cài điện thoại; không đưa lên Git.\n${Object.entries(secrets).map(([k, v]) => `${k} ${v}`).join('\n')}\n`, { mode: 0o600 });
  chmodSync(secretFile, 0o600);

  // Tài khoản ARI cho máy chủ gọi ra: sinh một lần, lưu vào .env
  const add: string[] = [];
  const ariUser = process.env.MEDONE_ARI_USER || 'medone';
  const ariPassword = process.env.MEDONE_ARI_PASSWORD || pw();
  if (!process.env.MEDONE_ARI_URL) add.push('MEDONE_ARI_URL=http://127.0.0.1:8088/ari');
  if (!process.env.MEDONE_ARI_USER) add.push(`MEDONE_ARI_USER=${ariUser}`);
  if (!process.env.MEDONE_ARI_PASSWORD) add.push(`MEDONE_ARI_PASSWORD=${ariPassword}`);
  if (!process.env.MEDONE_RECORDINGS_DIR) add.push(`MEDONE_RECORDINGS_DIR=${recordings}`);
  if (add.length && existsSync(envFile)) appendFileSync(envFile, `\n# Tổng đài Asterisk (npm run asterisk:config)\n${add.join('\n')}\n`);

  const files = renderConfig({
    dir, exts, testExt, api: arg('api', `http://127.0.0.1:${process.env.PORT || 8080}`), telephonyKey, recordings,
    did115: arg('duong-115', '') || null, ariUser, ariPassword, secrets, major: asteriskMajor(),
  });
  for (const [name, body] of Object.entries(files)) writeFileSync(`${dir}/${name}`, body, { mode: 0o600 });
  console.log(`Đã sinh cấu hình Asterisk ở ${dir}`);
  console.log(`Máy lẻ điều phối: ${exts.join(', ')}${testExt ? `; máy thử ${testExt} (gọi 1800 để giả lập cuộc gọi đến)` : ''}`);
  console.log(`Mật khẩu máy lẻ: tệp ${secretFile} (không in ra đây)`);
  console.log(`Ghi âm lưu ở: ${recordings}`);
  if (add.length) console.log(`Đã thêm vào .env: ${add.map((x) => x.split('=')[0]).join(', ')}. Khởi động lại máy chủ Medone để nhận.`);
  console.log(`Chạy tổng đài: asterisk -C ${dir}/asterisk.conf`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
