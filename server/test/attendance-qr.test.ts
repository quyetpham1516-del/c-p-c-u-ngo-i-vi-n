import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { makeToken, parseToken, QR_STEP_S, qrStep, verifyToken } from '../src/attendance.js';
import { decryptId } from '../src/crypto.js';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let nhansu: Client, crew: Client, dpv: Client;
let kioskPath = '';
const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
// Trạm 1: 10.8016, 106.6526. Khoảng 0,0009 độ vĩ ≈ 100 m
const AT_STATION = { lat: 10.8017, lng: 106.6527, accuracy: 15 };
const kiosk = (key: string, id = 'TR-01') => app.inject({ method: 'GET', url: `/api/attendance/kiosk/${id}`, headers: { 'x-kiosk-key': key } });
const keyOf = (path: string) => path.split('#k=')[1];
const back = (s: number) => pool.query(`UPDATE attendance SET check_in = check_in - make_interval(secs => $1), check_out = check_out - make_interval(secs => $1)`, [s]);

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [nhansu, crew, dpv] = await Promise.all(['nhansu', 'bs.als', 'dpv06'].map((u) => login(app, u)));
});

afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await pool.end();
});

describe('mã QR đổi theo thời gian', () => {
  it('chỉ nhận mã đúng khóa, trong khoảng 2 bước trước đến 1 bước sau', () => {
    const now = qrStep();
    const t = parseToken(makeToken('khoa-a', 'TR-01', now))!;
    expect(verifyToken('khoa-a', t, now)).toBe(true);
    expect(verifyToken('khoa-b', t, now)).toBe(false);
    expect(verifyToken('khoa-a', t, now + 2)).toBe(true);
    expect(verifyToken('khoa-a', t, now + 3)).toBe(false);
    expect(verifyToken('khoa-a', t, now - 1)).toBe(true);
    expect(verifyToken('khoa-a', t, now - 2)).toBe(false);
    expect(verifyToken('khoa-a', { ...t, stationId: 'TR-02' }, now)).toBe(false);
    expect(parseToken('TR-01.123.abc')).toBeNull();
  });
});

describe('máy chấm công tại trạm', () => {
  it('nhân sự cấp máy; khóa chỉ trả một lần, lưu dạng băm; người khác không cấp được', async () => {
    expect((await crew('POST', '/api/attendance/stations/TR-01/kiosk')).http).toBe(403);
    const r = await nhansu('POST', '/api/attendance/stations/TR-01/kiosk');
    expect(r.http).toBe(200);
    expect(r.kioskPath).toMatch(/^\/may-cham-cong\?tram=TR-01#k=[\w-]{32}$/);
    kioskPath = r.kioskPath;
    const row = await one('SELECT * FROM station_attendance WHERE station_id = $1', ['TR-01']);
    expect(row.kiosk_key_hash).not.toContain(keyOf(kioskPath));
    expect(decryptId(row.secret_enc)).toHaveLength(43);
    expect((await one(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'hr.kiosk_issued'`)).n).toBe(1);
  });

  it('máy lấy mã bằng khóa; sai khóa bị từ chối', async () => {
    expect((await kiosk('sai-khoa')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/attendance/kiosk/TR-01' })).statusCode).toBe(401);
    const res = await kiosk(keyOf(kioskPath));
    expect(res.statusCode).toBe(200);
    const k = res.json();
    expect(k.station).toEqual({ id: 'TR-01', name: 'Trạm 1' });
    expect(k.token).toMatch(/^TR-01\.\d+\.[\w-]{16}$/);
    expect(k.refreshInMs).toBeGreaterThan(0);
    expect(k.refreshInMs).toBeLessThanOrEqual(QR_STEP_S * 1000);
  });
});

describe('quét mã', () => {
  let token = '';
  beforeAll(async () => { token = (await kiosk(keyOf(kioskPath))).json().token; });

  it('từ chối mã giả, thiếu vị trí khi bắt buộc, ở xa trạm (có lưu vết)', async () => {
    expect((await crew('POST', '/api/attendance/scan', { token: token.slice(0, -2) + 'xx', ...AT_STATION })).details.code).toBe('BAD_TOKEN');
    const noGps = await crew('POST', '/api/attendance/scan', { token });
    expect([noGps.http, noGps.details.code]).toEqual([422, 'GPS_REQUIRED']);
    const far = await crew('POST', '/api/attendance/scan', { token, lat: 10.7769, lng: 106.7009, accuracy: 20 });
    expect(far.http).toBe(422);
    expect(far.details.code).toBe('TOO_FAR');
    expect(far.error).toMatch(/Trạm 1.*ngoài bán kính 300 m/);
    expect((await one(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'hr.qr_rejected'`)).n).toBe(2);
    expect((await one('SELECT count(*)::int AS n FROM attendance')).n).toBe(0);
  });

  it('vào ca bằng QR, quét lại ngay bị chặn, sau 2 phút thì ra ca', async () => {
    const a = await crew('POST', '/api/attendance/scan', { token, ...AT_STATION });
    expect(a).toMatchObject({ http: 200, checkedIn: true, station: { id: 'TR-01' }, flags: [] });
    expect(a.distance).toBeLessThan(30);
    const again = await crew('POST', '/api/attendance/scan', { token, ...AT_STATION });
    expect([again.http, again.details.code]).toEqual([409, 'REPEAT']);
    const me = await crew('GET', '/api/hr/me');
    expect(me.openStation).toBe('Trạm 1');
    await back(180);
    const b = await crew('POST', '/api/attendance/scan', { token, ...AT_STATION, accuracy: 250 });
    expect(b).toMatchObject({ http: 200, checkedIn: false, flags: ['sai_so_lon'] });
    const row = await one('SELECT * FROM attendance');
    expect(row).toMatchObject({ source: 'qr', source_out: 'qr', station_id: 'TR-01', out_station_id: 'TR-01', in_accuracy_m: 15 });
  });

  it('mã hết hạn sau khoảng một phút', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * QR_STEP_S * 1000 + 1000);
    const r = await dpv('POST', '/api/attendance/scan', { token, ...AT_STATION });
    vi.useRealTimers();
    expect(r.details.code).toBe('BAD_TOKEN');
  });

  it('ra ở trạm khác thì đánh dấu; không bắt buộc vị trí thì nhận nhưng đánh dấu', async () => {
    const t2 = await nhansu('POST', '/api/attendance/stations/TR-02/kiosk');
    expect((await nhansu('PATCH', '/api/attendance/stations/TR-02', { requireGps: false, radiusM: 20 })).http).toBe(400);
    expect((await nhansu('PATCH', '/api/attendance/stations/TR-02', { requireGps: false, radiusM: 500 }))).toMatchObject({ require_gps: false, radius_m: 500 });
    const tok2 = (await kiosk(keyOf(t2.kioskPath), 'TR-02')).json().token;
    const tok1 = (await kiosk(keyOf(kioskPath))).json().token;
    expect((await dpv('POST', '/api/attendance/scan', { token: tok1, ...AT_STATION })).checkedIn).toBe(true);
    await back(600);
    const out = await dpv('POST', '/api/attendance/scan', { token: tok2 });
    expect(out).toMatchObject({ checkedIn: false, station: { id: 'TR-02' }, distance: null });
    expect(out.flags.sort()).toEqual(['khong_vi_tri', 'ra_khac_tram']);
    const log = await nhansu('GET', '/api/attendance/log?flagged=1');
    expect(log.data.map((r: any) => r.out_station_name)).toContain('Trạm 2');
    expect((await crew('GET', '/api/attendance/log')).http).toBe(403);
  });

  it('máy hiện người vừa quét bằng tên rút gọn; cấp lại khóa thì máy cũ bị chặn; thu hồi thì mã không còn nhận', async () => {
    const k = (await kiosk(keyOf(kioskPath))).json();
    expect(k.recent.length).toBeGreaterThan(0);
    expect(k.recent[0]).toHaveProperty('kind');
    const re = await nhansu('POST', '/api/attendance/stations/TR-01/kiosk');
    expect(re.replaced).toBe(true);
    expect((await kiosk(keyOf(kioskPath))).statusCode).toBe(401);
    const fresh = (await kiosk(keyOf(re.kioskPath))).json().token;
    expect((await nhansu('DELETE', '/api/attendance/stations/TR-01/kiosk')).http).toBe(200);
    expect((await nhansu('POST', '/api/attendance/scan', { token: fresh, ...AT_STATION })).details.code).toBe('BAD_TOKEN');
    const st = await nhansu('GET', '/api/attendance/stations');
    expect(st.data.find((s: any) => s.id === 'TR-01').configured).toBe(false);
  });

  it('chấm công tay trên web được đánh dấu để đối chiếu', async () => {
    expect((await nhansu('POST', '/api/hr/attendance/check')).checkedIn).toBe(true);
    expect((await one(`SELECT flags FROM attendance WHERE source = 'web'`)).flags).toEqual(['thu_cong']);
  });
});
