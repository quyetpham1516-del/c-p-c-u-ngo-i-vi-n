import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { sendPending } from '../src/sms.js';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let dpv: Client, crew: Client, tongdai: Client;
let incId = '';
const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
const pub = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as any, remoteAddress: '10.0.0.9' });
const tokenOf = (url: string) => new URL(url).searchParams.get('m')!;
const BASE = 'https://ronas-macbook-air-3.local:3443';

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [dpv, crew] = await Promise.all(['dpv06', 'bs.als'].map((u) => login(app, u)));
  const ct = await one(`SELECT username FROM users WHERE role = 'calltaker' LIMIT 1`);
  tongdai = await login(app, ct.username);
  expect((await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Bác sĩ' })).http).toBe(200);
  await pool.query(`INSERT INTO hospitals(name, lat, lng, phone) VALUES ('Bệnh viện Thử Liên Thông', 10.7626, 106.6602, '02838000000') ON CONFLICT (name) DO NOTHING`);
  const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000003' });
  incId = inc.id;
  await pool.query(`UPDATE incidents SET lat = 10.80, lng = 106.66, status = 'dispatched', chief_complaint = 'Đau ngực' WHERE id = $1`, [incId]);
  const u = await one(`SELECT id FROM users WHERE username = 'dpv06'`);
  await pool.query(`INSERT INTO assignments(incident_id, vehicle_id, assigned_by) VALUES ($1, 'MD-ALS-01', $2)`, [incId, u.id]);
  await pool.query(`UPDATE vehicles SET lat = 10.7769, lng = 106.7009, location_at = now() WHERE id = 'MD-ALS-01'`);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('đường dẫn cho người nhà', () => {
  let url = '';
  it('tổng đài tạo và gửi tin; trang công khai chỉ có xe và giờ dự kiến, không có bệnh án', async () => {
    const r = await tongdai('POST', `/api/incidents/${incId}/share`, { kind: 'nguoi_nha', baseUrl: BASE, phone: '0900 000 003' });
    expect(r.http).toBe(200);
    expect(r.url).toMatch(/^https:\/\/ronas-macbook-air-3\.local:3443\/theo-doi\?m=[\w-]{24}$/);
    url = r.url;
    const sms = await one(`SELECT * FROM message_outbox WHERE purpose = 'theo_doi_xe'`);
    expect(sms.to_phone).toBe('0900000003');
    expect(sms.body).toContain(url);
    const row = await one('SELECT token_hash FROM share_links');
    expect(row.token_hash).not.toContain(tokenOf(url));
    const v = (await pub('GET', `/api/public/share/${tokenOf(url)}`)).json();
    expect(v).toMatchObject({ kind: 'nguoi_nha', ended: false, stage: 'dang_toi', vehicle: { plate: '51B-001.01', type: 'ALS' } });
    expect(v.eta.km).toBeGreaterThan(3);
    expect(v.eta.minutes).toBeGreaterThan(5);
    expect(JSON.stringify(v)).not.toMatch(/Đau ngực|0900000003/);
  });

  it('tổng đài không gửi được báo trước bệnh viện; mã sai hoặc đã thu hồi thì 404', async () => {
    expect((await tongdai('POST', `/api/incidents/${incId}/share`, { kind: 'benh_vien', baseUrl: BASE, hospital: 'Bệnh viện Thử Liên Thông' })).http).toBe(403);
    expect((await tongdai('POST', `/api/incidents/${incId}/share`, { kind: 'nguoi_nha', baseUrl: 'javascript:alert(1)' })).http).toBe(400);
    expect((await pub('GET', '/api/public/share/' + 'x'.repeat(24))).statusCode).toBe(404);
    const list = await dpv('GET', `/api/incidents/${incId}/shares`);
    expect((await dpv('POST', `/api/shares/${list.data[0].id}/revoke`)).http).toBe(200);
    expect((await pub('GET', `/api/public/share/${tokenOf(url)}`)).statusCode).toBe(404);
  });
});

describe('báo trước bệnh viện nhận', () => {
  let token = '';
  it('cần chọn bệnh viện; sau báo trước thì gửi được, có sinh hiệu mới nhất và giờ dự kiến tới', async () => {
    expect((await dpv('POST', `/api/incidents/${incId}/share`, { kind: 'benh_vien', baseUrl: BASE })).http).toBe(422);
    expect((await dpv('POST', `/api/incidents/${incId}/prealert`, { hospital: 'Bệnh viện Thử Liên Thông', department: 'Khoa Cấp cứu' })).http).toBe(200);
    const patient = await crew('POST', '/api/patients', { idType: 'CCCD', idNumber: '079300005678', fullName: 'Lê Văn Tâm', birthYear: 1960, sex: 'M' });
    const epcr = { chiefComplaint: 'Đau ngực trái 30 phút', diagnosis: { text: 'Nghi nhồi máu cơ tim' },
      vitals: [{ at: new Date(Date.now() - 600_000).toISOString(), hr: 120 }, { at: new Date().toISOString(), hr: 104, sbp: 90, dbp: 60, spo2: 94 }] };
    expect((await crew('PUT', `/api/transfers/${randomUUID()}`, { incidentId: incId, vehicleId: 'MD-ALS-01', patientId: patient.id, baseVersion: 0, epcr })).http).toBe(200);
    // Chưa rời hiện trường (ca không phải P1): chưa gửi thông tin cho bệnh viện
    expect((await dpv('POST', `/api/incidents/${incId}/share`, { kind: 'benh_vien', baseUrl: BASE })).http).toBe(409);
    await pool.query(`UPDATE incidents SET status = 'transporting' WHERE id = $1`, [incId]);
    await pool.query(`UPDATE vehicles SET status = 'S6' WHERE id = 'MD-ALS-01'`);
    const r = await dpv('POST', `/api/incidents/${incId}/share`, { kind: 'benh_vien', baseUrl: BASE, phone: '02838000000' });
    expect(r.url).toMatch(/\/bv\?m=/);
    token = tokenOf(r.url);
    const v = (await pub('GET', `/api/public/share/${token}`)).json();
    expect(v).toMatchObject({
      kind: 'benh_vien', hospital: 'Bệnh viện Thử Liên Thông', department: 'Khoa Cấp cứu', status: 'transporting',
      patient: { initials: 'L.V.T.', sex: 'M' }, chiefComplaint: 'Đau ngực trái 30 phút', diagnosis: 'Nghi nhồi máu cơ tim',
      vitals: { hr: 104, sbp: 90, dbp: 60, spo2: 94 }, response: null,
    });
    expect(v.patient.age).toBeGreaterThan(60);
    expect(v.eta.minutes).toBeGreaterThan(0);
    expect(JSON.stringify(v)).not.toContain('Lê Văn Tâm');
  });

  it('bệnh viện báo không nhận được phải ghi lý do; điều phối thấy phản hồi và lưu vết', async () => {
    expect((await pub('POST', `/api/public/share/${token}/respond`, { response: 'khong_nhan', name: 'BS Trực' })).statusCode).toBe(400);
    const r = await pub('POST', `/api/public/share/${token}/respond`, { response: 'khong_nhan', name: 'BS Trực', note: 'Hết giường hồi sức' });
    expect(r.statusCode).toBe(200);
    expect(r.json().response).toMatchObject({ value: 'khong_nhan', by: 'BS Trực' });
    const list = await dpv('GET', `/api/incidents/${incId}/shares`);
    expect(list.data[0]).toMatchObject({ kind: 'benh_vien', response: 'khong_nhan', response_note: 'Hết giường hồi sức', active: true, sms_status: 'cho_gui' });
    expect((await one(`SELECT actor_name FROM audit_events WHERE action = 'hospital.prealert_declined'`)).actor_name).toBe('BS Trực (Bệnh viện Thử Liên Thông)');
  });

  it('ca kết thúc thì trang chỉ báo đã kết thúc', async () => {
    await pool.query(`UPDATE incidents SET status = 'closed' WHERE id = $1`, [incId]);
    expect((await pub('GET', `/api/public/share/${token}`)).json()).toMatchObject({ ended: true });
    expect((await dpv('POST', `/api/incidents/${incId}/share`, { kind: 'nguoi_nha', baseUrl: BASE })).http).toBe(409);
  });
});

describe('cổng SMS', () => {
  it('không cấu hình thì không gửi; có cấu hình thì gửi kèm mã truy cập, lỗi thử lại 3 lần rồi báo lỗi', async () => {
    expect(await sendPending(pool, null)).toEqual({ sent: 0, failed: 0 });
    const calls: any[] = [];
    const ok = vi.fn(async (url: string, init: any) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); });
    const r = await sendPending(pool, { url: 'https://sms.example/send', token: 'khoa-thu' }, ok as any);
    expect(r).toEqual({ sent: 2, failed: 0 });
    expect(calls[0].init.headers.authorization).toBe('Bearer khoa-thu');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ to: '0900000003', purpose: 'theo_doi_xe' });
    await pool.query(`INSERT INTO message_outbox(to_phone, body, purpose) VALUES ('0900000009', 'thu', 'thu')`);
    const bad = vi.fn(async () => new Response('', { status: 500 }));
    for (let i = 0; i < 3; i++) await sendPending(pool, { url: 'https://sms.example/send', token: null }, bad as any);
    expect(await one(`SELECT status, attempts, error FROM message_outbox WHERE to_phone = '0900000009'`)).toEqual({ status: 'loi', attempts: 3, error: 'HTTP 500' });
  });
});
