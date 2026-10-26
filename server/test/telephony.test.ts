import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { config } from '../src/config.js';
import { pbxKeyOk } from '../src/routes/telephony.js';
import { freshApp, login, token } from './helpers.js';

let app: FastifyInstance; let pool: pg.Pool;
let recDir = '';
let fakeAri: Server; let ariHits: string[] = []; let ariStatusCode = 200;
const KEY = { 'x-medone-telephony-key': config.telephonyKey };

/** Webhook của tổng đài: CURL() của Asterisk gửi dạng form-urlencoded */
const pbx = (url: string, form: Record<string, string>, headers: Record<string, string> = KEY) => app.inject({
  method: 'POST', url, payload: new URLSearchParams(form).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
});
const userId = async (username: string) => (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id as string;

beforeAll(async () => {
  recDir = mkdtempSync(join(tmpdir(), 'medone-ghi-am-'));
  process.env.MEDONE_RECORDINGS_DIR = recDir;
  // .env của máy chạy thử có thể đã có ARI thật: kiểm thử bắt đầu từ trạng thái chưa nối tổng đài
  for (const k of ['MEDONE_ARI_URL', 'MEDONE_ARI_USER', 'MEDONE_ARI_PASSWORD']) delete process.env[k];
  // ARI giả: nhận lệnh gọi ra, trả mã trạng thái tùy kịch bản
  fakeAri = createServer((req, res) => {
    ariHits.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith('/ari/asterisk/info')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ system: { version: '20.6.0' } })); }
    res.statusCode = req.method === 'POST' ? ariStatusCode : 404;
    res.end(req.method === 'POST' && ariStatusCode === 200 ? '{"id":"x"}' : '');
  });
  await new Promise<void>((r) => fakeAri.listen(0, '127.0.0.1', r));
  ({ app, pool } = await freshApp());
});
afterAll(async () => {
  for (const k of ['MEDONE_RECORDINGS_DIR', 'MEDONE_ARI_URL', 'MEDONE_ARI_USER', 'MEDONE_ARI_PASSWORD']) delete process.env[k];
  await app.close(); await pool.end(); fakeAri.close();
  rmSync(recDir, { recursive: true, force: true });
});

describe('khóa tổng đài', () => {
  it('so khớp đúng khóa, chấp nhận tiêu đề bị gửi lặp, từ chối sai khóa', () => {
    expect(pbxKeyOk(config.telephonyKey)).toBe(true);
    expect(pbxKeyOk(`${config.telephonyKey}, ${config.telephonyKey}`)).toBe(true);
    expect(pbxKeyOk('sai')).toBe(false);
    expect(pbxKeyOk(undefined)).toBe(false);
  });

  it('webhook không có khóa bị từ chối', async () => {
    expect((await pbx('/api/telephony/answered', { pbxId: 'x.1', ext: '101' }, {})).statusCode).toBe(401);
    expect((await pbx('/api/telephony/hangup', { pbxId: 'x.1' }, { 'x-medone-telephony-key': 'sai' })).statusCode).toBe(401);
  });
});

describe('máy lẻ', () => {
  it('quản trị gán máy lẻ cho điều phối viên; không gán cho vai trò ngoài EOC; mỗi người một máy', async () => {
    const admin = await login(app, 'admin');
    const dpv06 = await userId('dpv06');
    expect((await admin('PUT', '/api/telephony/extensions/101', { userId: dpv06, label: 'Bàn 1' })).http).toBe(200);
    expect((await admin('PUT', '/api/telephony/extensions/105', { userId: dpv06 })).http).toBe(200);
    const list = await admin('GET', '/api/telephony/extensions');
    expect(list.extensions.find((e: any) => e.ext === '101').user_id).toBeNull();
    expect(list.extensions.find((e: any) => e.ext === '105').user_id).toBe(dpv06);
    expect(list.status.configured).toBe(false);
    expect((await admin('PUT', '/api/telephony/extensions/101', { userId: dpv06 })).http).toBe(200);
    expect((await admin('DELETE', '/api/telephony/extensions/105')).http).toBe(200);
    expect((await admin('PUT', '/api/telephony/extensions/102', { userId: await userId('bs.als') })).http).toBe(422);
    expect((await admin('PUT', '/api/telephony/extensions/1', { userId: null })).http).toBe(400);
    expect((await (await login(app, 'dpv01'))('GET', '/api/telephony/extensions')).http).toBe(403);
    const me = await (await login(app, 'dpv06'))('GET', '/api/telephony/me');
    expect(me).toMatchObject({ ext: '101', canDial: false });
    const logged = await pool.query(`SELECT action FROM audit_events WHERE action LIKE 'telephony.extension%'`);
    expect(logged.rows.map((r) => r.action)).toContain('telephony.extension_removed');
  });
});

describe('cuộc gọi vào qua tổng đài', () => {
  it('chuông reo gửi lặp cùng mã thì không tạo trùng', async () => {
    const a = await pbx('/api/telephony/ring', { phone: '0901111111', line: '115', pbxId: '1700.11' });
    const b = await pbx('/api/telephony/ring', { phone: '0901111111', line: '115', pbxId: '1700.11' });
    expect(a.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
  });

  it('máy lẻ nhấc máy: tự mở ca cho người dùng máy đó (T0 = lúc chuông reo), gác máy lưu ghi âm và mã băm', async () => {
    const ring = (await pbx('/api/telephony/ring', { phone: '0902222222', pbxId: '1700.12' })).json();
    const ans = await pbx('/api/telephony/answered', { pbxId: '1700.12', ext: '101' });
    expect(ans.statusCode).toBe(200);
    const incidentId = ans.json().incidentId;
    expect(incidentId).toBeTruthy();
    const dpv = await login(app, 'dpv06');
    const inc = await dpv('GET', `/api/incidents/${incidentId}`);
    expect(inc.caller_phone ?? inc.callerPhone).toBe('0902222222');
    expect(new Date(inc.times.find((t: any) => t.code === 'T0').at).getTime()).toBe(new Date(ring.ringing_at).getTime());
    expect((await pbx('/api/telephony/answered', { pbxId: '1700.12', ext: '101' })).json().already).toBe(true);

    writeFileSync(join(recDir, '1700.12.wav'), Buffer.alloc(4000, 7));
    const hang = await pbx('/api/telephony/hangup', { pbxId: '1700.12', recording: '1700.12.wav', cause: '16' });
    expect(hang.json()).toMatchObject({ ok: true, state: 'ended', recorded: true });
    const row = (await pool.query('SELECT state, operator_id, extension, recording_bytes, recording_sha256, duration_s FROM calls WHERE id = $1', [ring.id])).rows[0];
    expect(row).toMatchObject({ state: 'ended', operator_id: await userId('dpv06'), extension: '101', recording_bytes: 4000 });
    expect(row.recording_sha256).toMatch(/^[0-9a-f]{64}$/);
    const acts = await pool.query(`SELECT action FROM audit_events WHERE entity_id = $1`, [ring.id]);
    expect(acts.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['call.answered_on_phone', 'call.recorded']));

    const calls = await dpv('GET', `/api/incidents/${incidentId}/calls`);
    expect(calls.data).toHaveLength(1);
    expect(calls.data[0]).toMatchObject({ direction: 'in', has_recording: true, extension: '101' });
  });

  it('máy lẻ chưa gán người: ghi nhận nhấc máy, không tự mở ca', async () => {
    await pbx('/api/telephony/ring', { phone: '0903333333', pbxId: '1700.13' });
    const r = (await pbx('/api/telephony/answered', { pbxId: '1700.13', ext: '109' })).json();
    expect(r.incidentId).toBeNull();
    expect(r.warning).toMatch(/109/);
  });

  it('gác máy khi chưa ai nhấc: bỏ dở, vào danh sách gọi lại; tệp ghi âm rỗng không tính', async () => {
    const ring = (await pbx('/api/telephony/ring', { phone: '0904444444', pbxId: '1700.14' })).json();
    writeFileSync(join(recDir, '1700.14.wav'), Buffer.alloc(44));
    const r = (await pbx('/api/telephony/hangup', { pbxId: '1700.14', recording: '1700.14.wav' })).json();
    expect(r).toMatchObject({ state: 'abandoned', recorded: false });
    const list = await (await login(app, 'dpv01'))('GET', '/api/calls?state=abandoned');
    expect(list.data.map((c: any) => c.id)).toContain(ring.id);
  });

  it('tên tệp ghi âm có đường dẫn bị bỏ qua', async () => {
    await pbx('/api/telephony/ring', { phone: '0905555555', pbxId: '1700.15' });
    const r = (await pbx('/api/telephony/hangup', { pbxId: '1700.15', recording: '../../etc/passwd.wav' })).json();
    expect(r.recorded).toBe(false);
  });
});

describe('nghe lại ghi âm', () => {
  let callId = '';
  beforeAll(async () => {
    callId = (await pool.query(`SELECT id FROM calls WHERE pbx_id = '1700.12'`)).rows[0].id;
  });

  it('trưởng ca nghe được, tua được (Range), mỗi lượt nghe ghi nhật ký', async () => {
    const auth = { authorization: `Bearer ${await token(app, 'truongca')}` };
    const full = await app.inject({ method: 'GET', url: `/api/calls/${callId}/recording`, headers: auth });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('audio/wav');
    expect(full.headers['x-recording-intact']).toBe('1');
    expect(full.rawPayload.length).toBe(4000);
    const part = await app.inject({ method: 'GET', url: `/api/calls/${callId}/recording`, headers: { ...auth, range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/4000');
    expect(part.rawPayload.length).toBe(100);
    expect((await app.inject({ method: 'GET', url: `/api/calls/${callId}/recording`, headers: { ...auth, range: 'bytes=9000-' } })).statusCode).toBe(416);
    const n = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'call.recording_played' AND entity_id = $1`, [callId]);
    expect(n.rows[0].n).toBe(3);
  });

  it('tệp bị sửa sau khi gác máy thì báo không còn nguyên', async () => {
    writeFileSync(join(recDir, '1700.12.wav'), Buffer.alloc(4000, 8));
    const res = await app.inject({ method: 'GET', url: `/api/calls/${callId}/recording`, headers: { authorization: `Bearer ${await token(app, 'qlcl')}` } });
    expect(res.headers['x-recording-intact']).toBe('0');
  });

  it('điều phối viên và kíp xe không nghe được', async () => {
    for (const u of ['dpv06', 'bs.als']) {
      const res = await app.inject({ method: 'GET', url: `/api/calls/${callId}/recording`, headers: { authorization: `Bearer ${await token(app, u)}` } });
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('gọi ra', () => {
  it('chưa nối ARI thì báo 503; chưa có máy lẻ thì 409', async () => {
    expect((await (await login(app, 'dpv06'))('POST', '/api/telephony/call', { phone: '0906666666' })).http).toBe(503);
    expect((await (await login(app, 'dpv07'))('POST', '/api/telephony/call', { phone: '0906666666' })).http).toBe(409);
  });

  it('có ARI: đổ chuông máy lẻ của mình, cuộc gọi ra ghi vào ca, đánh dấu đã gọi lại', async () => {
    const { port } = fakeAri.address() as AddressInfo;
    Object.assign(process.env, { MEDONE_ARI_URL: `http://127.0.0.1:${port}/ari`, MEDONE_ARI_USER: 'medone', MEDONE_ARI_PASSWORD: 'thu' });
    const dpv = await login(app, 'dpv06');
    expect(await dpv('GET', '/api/telephony/me')).toMatchObject({ canDial: true });
    const missed = (await pool.query(`SELECT id FROM calls WHERE pbx_id = '1700.14'`)).rows[0].id;
    const incidentId = (await pool.query(`SELECT incident_id FROM calls WHERE pbx_id = '1700.12'`)).rows[0].incident_id;
    ariHits = [];
    const r = await dpv('POST', '/api/telephony/call', { phone: '090 4444 444', incidentId, callbackOf: missed });
    expect(r.http).toBe(200);
    expect(ariHits[0]).toContain('POST /ari/channels?');
    const qs = new URLSearchParams(ariHits[0].split('?')[1]);
    expect(qs.get('endpoint')).toBe('PJSIP/101');
    expect(qs.get('extension')).toBe('0904444444');
    expect(qs.get('channelId')).toBe(r.id);
    const row = (await pool.query('SELECT direction, pbx_id, incident_id FROM calls WHERE id = $1', [r.id])).rows[0];
    expect(row).toMatchObject({ direction: 'out', pbx_id: r.id, incident_id: incidentId });
    expect((await pool.query('SELECT callback_done_at FROM calls WHERE id = $1', [missed])).rows[0].callback_done_at).not.toBeNull();
    // Cuộc gọi ra không lẫn vào hàng chờ cuộc gọi đến
    expect((await dpv('GET', '/api/calls?state=answered')).data.map((c: any) => c.id)).not.toContain(r.id);
    // Gác máy: webhook dùng mã kênh = mã cuộc gọi
    expect((await pbx('/api/telephony/hangup', { pbxId: r.id, cause: '16' })).json().state).toBe('ended');
  });

  it('máy lẻ chưa đăng nhập tổng đài: báo rõ, đóng cuộc gọi', async () => {
    ariStatusCode = 500;
    const r = await (await login(app, 'dpv06'))('POST', '/api/telephony/call', { phone: '0907777777' });
    expect(r.http).toBe(409);
    expect(r.error).toMatch(/chưa đăng nhập/);
    const row = (await pool.query(`SELECT state, hangup_cause FROM calls WHERE phone = '0907777777'`)).rows[0];
    expect(row).toMatchObject({ state: 'ended', hangup_cause: 'originate_failed' });
    ariStatusCode = 200;
  });

  it('trạng thái tổng đài', async () => {
    const s = await (await login(app, 'dpv06'))('GET', '/api/telephony/status');
    expect(s).toMatchObject({ configured: true, reachable: true, version: '20.6.0', recordingsDir: true });
  });
});

describe('bộ sinh cấu hình Asterisk', () => {
  it('máy lẻ, hàng chờ, ghi âm, webhook; vị trí gosub theo phiên bản', async () => {
    const { parseRange, renderConfig } = await import('../src/tools/asterisk-config.js');
    expect(parseRange('101-103,199')).toEqual(['101', '102', '103', '199']);
    expect(() => parseRange('1-2')).toThrow();
    const base = {
      dir: '/tmp/pbx', exts: ['101', '102'], testExt: null, api: 'http://127.0.0.1:8080', telephonyKey: 'k'.repeat(32),
      recordings: '/tmp/ghi-am', did115: '0281150', ariUser: 'medone', ariPassword: 'p'.repeat(24), secrets: { 101: 'a'.repeat(24), 102: 'b'.repeat(24) },
    };
    const c20 = renderConfig({ ...base, major: 20 });
    expect(c20['pjsip.conf']).toContain('[101]');
    expect(c20['queues.conf']).toContain('[dieu-phoi]');
    expect(c20['extensions.conf']).toContain('MixMonitor(');
    expect(c20['extensions.conf']).toContain('/api/telephony/answered');
    expect(c20['extensions.conf']).toContain('0281150');
    expect(c20['http.conf']).toContain('127.0.0.1');
    const gosub = (conf: string) => /Queue\(([^)]*)\)/.exec(conf)![1].split(',').findIndex((x) => x.includes('medone-nhac-may'));
    expect(gosub(c20['extensions.conf'])).toBe(7);
    expect(gosub(renderConfig({ ...base, major: 21 })['extensions.conf'])).toBe(6);
  });

  it('trung kế MobiFone: kiểu kết nối IP và kiểu đăng ký tài khoản, đổi số khi gọi ra', async () => {
    const { renderConfig, trunkFromEnv } = await import('../src/tools/asterisk-config.js');
    const base = {
      dir: '/tmp/pbx', exts: ['101'], testExt: null, api: 'http://127.0.0.1:8080', telephonyKey: 'k'.repeat(32),
      recordings: '/tmp/ghi-am', did115: null, ariUser: 'medone', ariPassword: 'p'.repeat(24), secrets: { 101: 'a'.repeat(24) }, major: 20,
    };
    expect(trunkFromEnv({})).toBeNull();
    expect(renderConfig({ ...base, trunk: null })['pjsip.conf']).toContain('MEDONE_TRUNK_HOST');

    const ip = trunkFromEnv({ MEDONE_TRUNK_HOST: '10.1.2.3', MEDONE_TRUNK_MATCH: '10.1.2.4, 10.1.2.0/28', MEDONE_TRUNK_CALLER_ID: '18001234' })!;
    const ci = renderConfig({ ...base, trunk: ip });
    expect(ci['pjsip.conf']).not.toContain('type=registration');
    expect(ci['pjsip.conf']).toMatch(/match=10\.1\.2\.3\nmatch=10\.1\.2\.4\nmatch=10\.1\.2\.0\/28/);
    expect(ci['pjsip.conf']).toContain('allow=alaw,ulaw');
    expect(ci['extensions.conf']).toContain('Set(CALLERID(num)=18001234)');
    expect(ci['extensions.conf']).toContain('Dial(PJSIP/${SO}@nha-mang,60)');

    const reg = trunkFromEnv({ MEDONE_TRUNK_HOST: 'sip.mobifone.example', MEDONE_TRUNK_MODE: 'dang-ky', MEDONE_TRUNK_USER: 'medone1800', MEDONE_TRUNK_PASSWORD: 'x'.repeat(20), MEDONE_TRUNK_DIAL_PREFIX: '84', MEDONE_TRUNK_STRIP_ZERO: '1' })!;
    const cr = renderConfig({ ...base, trunk: reg });
    expect(cr['pjsip.conf']).toContain('type=registration');
    expect(cr['pjsip.conf']).toContain('client_uri=sip:medone1800@sip.mobifone.example');
    expect(cr['extensions.conf']).toContain('Set(SO=${EXTEN:1})');
    expect(cr['extensions.conf']).toContain('Dial(PJSIP/84${SO}@nha-mang,60)');

    expect(() => trunkFromEnv({ MEDONE_TRUNK_HOST: 'a b' })).toThrow();
    expect(() => trunkFromEnv({ MEDONE_TRUNK_HOST: 'h', MEDONE_TRUNK_MODE: 'dang-ky' })).toThrow();
    expect(() => trunkFromEnv({ MEDONE_TRUNK_HOST: 'h', MEDONE_TRUNK_CALLER_ID: '1800;x' })).toThrow();
  });
});
