import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;
let ct: Awaited<ReturnType<typeof login>>;
let dpv: Awaited<ReturnType<typeof login>>;
let crew: Awaited<ReturnType<typeof login>>;
let qa: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  ct = await login(app, 'dpv01');
  dpv = await login(app, 'dpv06');
  crew = await login(app, 'bs.als');
  qa = await login(app, 'qlcl');
  await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('một ca cấp cứu từ cuộc gọi tới khi xe sẵn sàng trở lại', () => {
  let incidentId = '';
  const transferId = randomUUID();
  let patientId = '';

  it('cuộc gọi đến xếp hàng chờ, call-taker nhận => sinh Mã ca, T0 = giờ chuông reo', async () => {
    const call = await ct('POST', '/api/telephony/ring', { phone: '0909123456', line: '1800' });
    expect(call.state).toBe('ringing');
    const waiting = await ct('GET', '/api/calls?state=ringing');
    expect(waiting.data).toHaveLength(1);
    const inc = await ct('POST', `/api/calls/${call.id}/answer`, {});
    expect(inc.code).toMatch(/^MD-\d{6}-0001$/);
    expect(inc.source).toBe('1800');
    expect(inc.times.map((t: any) => t.code)).toEqual(['T0', 'T1']);
    expect(new Date(inc.times[0].at).getTime()).toBe(new Date(call.ringing_at).getTime());
    incidentId = inc.id;
  });

  it('hai người không nhận trùng một cuộc gọi', async () => {
    const call = await ct('POST', '/api/telephony/ring', { phone: '0911000000' });
    const [a, b] = await Promise.all([
      ct('POST', `/api/calls/${call.id}/answer`, {}),
      dpv('POST', `/api/calls/${call.id}/answer`, {}),
    ]);
    expect([a.http, b.http].sort()).toEqual([200, 409]);
  });

  it('chưa xác nhận thì không được giao xe', async () => {
    const r = await dpv('POST', `/api/incidents/${incidentId}/assign`, { vehicleId: 'MD-ALS-01' });
    expect(r.http).toBe(409);
    expect(r.error).toMatch(/Chưa xác nhận/);
  });

  it('địa chỉ + số gọi lại => T2; câu sống còn báo P1 ngừng tim', async () => {
    const p = await ct('PATCH', `/api/incidents/${incidentId}`, { address: '12 ngõ 34 Lê Lợi', lat: 10.78, lng: 106.70, callbackPhone: '0909123456' });
    expect(p.times.map((t: any) => t.code)).toContain('T2');
    const t = await ct('PUT', `/api/incidents/${incidentId}/triage`, { answers: { conscious: 'no', breathing: 'none' }, group: null });
    expect(t).toMatchObject({ priority: 'P1', earlyActivation: true, cardiacArrest: true });
  });

  it('đổi mã so với đề xuất mà không có lý do => từ chối', async () => {
    const r = await ct('POST', `/api/incidents/${incidentId}/confirm`, { priority: 'P2', vehicleType: 'ALS', lights: true });
    expect(r.http).toBe(400);
  });

  it('xác nhận P1 => T3, lưu cả mã máy và mã cuối, đưa thông báo 115 vào hàng gửi', async () => {
    const r = await ct('POST', `/api/incidents/${incidentId}/confirm`, { priority: 'P1', vehicleType: 'ALS', lights: true });
    expect(r.http).toBe(200);
    expect(r.final_priority).toBe('P1');
    expect(r.suggested_priority).toBe('P1');
    expect(r.times.map((t: any) => t.code)).toContain('T3');
    expect(r.outbox.map((o: any) => o.topic)).toContain('notify_115');
  });

  it('gợi ý xe: ALS đang trực gần nhất đứng đầu', async () => {
    const s = await dpv('GET', `/api/incidents/${incidentId}/suggest`);
    expect(s.suggestions[0].vehicleId).toBe('MD-ALS-01');
  });

  it('call-taker không có quyền giao xe, điều phối viên giao được => T4, xe S3', async () => {
    expect((await ct('POST', `/api/incidents/${incidentId}/assign`, { vehicleId: 'MD-ALS-01' })).http).toBe(403);
    const r = await dpv('POST', `/api/incidents/${incidentId}/assign`, { vehicleId: 'MD-ALS-01' });
    expect(r.http).toBe(200);
    expect(r.times.map((t: any) => t.code)).toContain('T4');
    const board = await dpv('GET', '/api/board');
    const als = board.vehicles.find((v: any) => v.id === 'MD-ALS-01');
    expect(als.status).toBe('S3');
    expect(als.incident.code).toBe(r.code);
    expect(als.incident.acknowledged).toBe(false);
  });

  it('kíp xác nhận, xuất phát, tới hiện trường, tới bên người bệnh => T5–T8', async () => {
    const cur = await crew('GET', '/api/crew/current');
    expect(cur.incident.id).toBe(incidentId);
    await crew('POST', '/api/crew/ack');
    await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: 'S4' });
    await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: 'S5' });
    await crew('POST', '/api/crew/milestone', { code: 'T8' });
    const d = await dpv('GET', `/api/incidents/${incidentId}`);
    expect(d.times.map((t: any) => t.code)).toEqual(expect.arrayContaining(['T5', 'T6', 'T7', 'T8']));
    expect(d.status).toBe('on_scene');
  });

  it('kíp không thao tác được xe khác', async () => {
    expect((await crew('POST', '/api/vehicles/MD-BLS-01/status', { status: 'S2' })).http).toBe(403);
  });

  it('bệnh án theo CCCD: tạo mới, chặn trùng, tìm theo CCCD, chỉ hiện 4 số cuối', async () => {
    const p = await crew('POST', '/api/patients', { idType: 'CCCD', idNumber: '079 123 456 789', fullName: 'Nguyễn Văn Bệnh', birthYear: 1960, sex: 'M' });
    expect(p.ba_number).toMatch(/^BA-\d{7}$/);
    expect(p.id_masked).toBe('••••6789');
    expect(p.id_enc).toBeUndefined();
    patientId = p.id;
    const dup = await crew('POST', '/api/patients', { idType: 'CCCD', idNumber: '079123456789' });
    expect(dup.http).toBe(409);
    const found = await crew('GET', '/api/patients/search?q=079123456789');
    expect(found.data.map((x: any) => x.id)).toEqual([patientId]);
    expect((await crew('GET', `/api/patients/${patientId}?reveal=1`)).http).toBe(403);
    expect((await qa('GET', `/api/patients/${patientId}?reveal=1`)).id_number).toBe('079123456789');
  });

  it('ePCR offline: gửi lại cùng UUID không tạo bản trùng; lệch phiên bản => 409', async () => {
    const epcr = { chiefComplaint: 'Ngừng tim', vitals: [{ at: new Date().toISOString(), hr: 0 }], interventions: [{ at: new Date().toISOString(), name: 'Sốc điện 200J' }] };
    const a = await crew('PUT', `/api/transfers/${transferId}`, { incidentId, vehicleId: 'MD-ALS-01', baseVersion: 0, epcr, deviceId: 'tab-01' });
    expect(a.transfer_number).toMatch(/^\d{4}-00001$/);
    const b = await crew('PUT', `/api/transfers/${transferId}`, { incidentId, vehicleId: 'MD-ALS-01', baseVersion: 1, epcr, deviceId: 'tab-01' });
    expect(b.version).toBe(2);
    const stale = await crew('PUT', `/api/transfers/${transferId}`, { incidentId, baseVersion: 1, epcr, deviceId: 'tab-01' });
    expect(stale.http).toBe(409);
    expect(stale.server.version).toBe(2);
    const n = await pool.query('SELECT count(*)::int AS n FROM transfers');
    expect(n.rows[0].n).toBe(1);
    const d = await dpv('GET', `/api/incidents/${incidentId}`);
    expect(d.times.map((t: any) => t.code)).toContain('T9');
  });

  it('ký phiếu: thiếu trường bắt buộc => 422; đủ => ký, T13 + T15', async () => {
    const miss = await crew('POST', `/api/transfers/${transferId}/sign`);
    expect(miss.http).toBe(409); // chưa gắn bệnh án
    const handoverAt = new Date().toISOString();
    const epcr = {
      chiefComplaint: 'Ngừng tim', vitals: [{ at: handoverAt, hr: 110, sbp: 95 }], diagnosis: { text: 'Ngừng tuần hoàn, có ROSC', icd10: 'I46.0' },
      disposition: { type: 'transported', hospital: 'BV X', receiverName: 'BS Nhận', handoverAt }, payer: 'BHYT',
    };
    await crew('PUT', `/api/transfers/${transferId}`, { patientId, baseVersion: 2, epcr });
    const ok = await crew('POST', `/api/transfers/${transferId}/sign`);
    expect(ok.http).toBe(200);
    const again = await crew('PUT', `/api/transfers/${transferId}`, { baseVersion: 3, epcr });
    expect(again.http).toBe(409);
    const amend = await crew('POST', `/api/transfers/${transferId}/amend`, { reason: 'Bổ sung số lô', epcr: { ...epcr, notes: 'x' } });
    expect(amend.http).toBe(200);
    const d = await dpv('GET', `/api/incidents/${incidentId}`);
    expect(d.times.map((t: any) => t.code)).toEqual(expect.arrayContaining(['T13', 'T15']));
  });

  it('nhiều lần cấp cứu => nhiều phiếu chuyển viện trên một bệnh án', async () => {
    const second = randomUUID();
    await crew('PUT', `/api/transfers/${second}`, { patientId, baseVersion: 0, epcr: { chiefComplaint: 'Khó thở' } });
    const p = await crew('GET', `/api/patients/${patientId}`);
    expect(p.transfers).toHaveLength(2);
  });

  it('xe sẵn sàng trở lại => T14, ca đóng, xe về S1', async () => {
    await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: 'S6' });
    await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: 'S7' });
    await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: 'S1' });
    const d = await dpv('GET', `/api/incidents/${incidentId}`);
    expect(d.status).toBe('closed');
    expect(d.times.map((t: any) => t.code)).toEqual(expect.arrayContaining(['T10', 'T12', 'T14']));
    const board = await dpv('GET', '/api/board');
    expect(board.vehicles.find((v: any) => v.id === 'MD-ALS-01').status).toBe('S1');
  });

  it('truy xuất: chuỗi băm còn nguyên; sửa thẳng cơ sở dữ liệu bị chặn', async () => {
    const t = await qa('GET', `/api/incidents/${incidentId}/trace`);
    expect(t.chain.ok).toBe(true);
    expect(t.events.length).toBeGreaterThan(15);
    expect(t.events.some((e: any) => e.action === 'triage.confirmed')).toBe(true);
    await expect(pool.query(`UPDATE audit_events SET action = 'x' WHERE scope = $1`, [`incident:${incidentId}`])).rejects.toThrow(/chỉ cho phép ghi thêm/);
    await expect(pool.query(`DELETE FROM audit_events`)).rejects.toThrow(/chỉ cho phép ghi thêm/);
  });

  it('phát hiện được khi ai đó tắt trigger để sửa nhật ký', async () => {
    await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
    await pool.query(`UPDATE audit_events SET data = '{"code":"T0"}' WHERE id = (SELECT min(id) FROM audit_events WHERE scope = $1)`, [`incident:${incidentId}`]);
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
    const t = await qa('GET', `/api/incidents/${incidentId}/trace`);
    expect(t.chain.ok).toBe(false);
  });
});

describe('ca từ 115, trùng ca, bệnh án tạm', () => {
  it('ca nhập tay từ đường nóng 115 ghi nguồn 115 và không báo ngược 115', async () => {
    const inc = await dpv('POST', '/api/incidents', { source: '115', sourceRef: '115-HCM-999' });
    expect(inc.source).toBe('115');
    await dpv('PATCH', `/api/incidents/${inc.id}`, { address: 'Ngã tư X', lat: 10.7001, lng: 106.6001, callbackPhone: '0901' });
    await dpv('PUT', `/api/incidents/${inc.id}/triage`, { answers: { conscious: 'yes', breathing: 'difficult', age_group: 'adult' }, group: 'kho_tho' });
    const c = await dpv('POST', `/api/incidents/${inc.id}/confirm`, { priority: 'P2', vehicleType: 'ALS', lights: true });
    expect(c.outbox).toHaveLength(0);
  });

  it('hai ca cùng vị trí trong 30 phút => cảnh báo có thể trùng', async () => {
    const a = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000001' });
    await dpv('PATCH', `/api/incidents/${a.id}`, { address: 'Cầu Y', lat: 10.75, lng: 106.65 });
    const b = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000002' });
    const r = await dpv('PATCH', `/api/incidents/${b.id}`, { address: 'Gần cầu Y', lat: 10.7505, lng: 106.6502 });
    expect(r.duplicates.map((d: any) => d.id)).toContain(a.id);
    const closed = await dpv('POST', `/api/incidents/${b.id}/close`, { status: 'cancelled', reason: 'Trùng ca', duplicateOf: a.id });
    expect(closed.status).toBe('cancelled');
  });

  it('bệnh án tạm cho người chưa rõ danh tính, gộp vào bệnh án thật rồi tách lại', async () => {
    const tmp = await crew('POST', '/api/patients', { idType: 'UNKNOWN', fullName: 'Chưa rõ – Nam – khoảng 40 tuổi', sex: 'M', force: true });
    expect(tmp.is_temporary).toBe(true);
    const real = await crew('POST', '/api/patients', { idType: 'CCCD', idNumber: '001099000111', fullName: 'Trần Văn Thật' });
    const t = randomUUID();
    await crew('PUT', `/api/transfers/${t}`, { patientId: tmp.id, baseVersion: 0, epcr: {} });
    expect((await crew('POST', `/api/patients/${tmp.id}/merge`, { intoId: real.id, reason: 'Có CCCD' })).http).toBe(403);
    expect((await qa('POST', `/api/patients/${tmp.id}/merge`, { intoId: real.id, reason: 'Người nhà mang CCCD tới' })).ok).toBe(true);
    const merged = await qa('GET', `/api/patients/${real.id}`);
    expect(merged.transfers.map((x: any) => x.id)).toContain(t);
    expect((await qa('POST', `/api/patients/merges/${merged.merges[0].id}/undo`, { reason: 'Gộp nhầm' })).ok).toBe(true);
    const back = await qa('GET', `/api/patients/${tmp.id}`);
    expect(back.transfers.map((x: any) => x.id)).toContain(t);
    expect(back.merged_into).toBeNull();
  });

  it('cuộc gọi bỏ dở vào danh sách gọi lại', async () => {
    const c = await ct('POST', '/api/telephony/ring', { phone: '0988777666' });
    const r = await app.inject({ method: 'POST', url: '/api/telephony/abandon', payload: { callId: c.id }, headers: { 'x-medone-telephony-key': 'dev-only-telephony-key' } });
    expect(r.json().ok).toBe(true);
    const list = await ct('GET', '/api/calls?state=abandoned');
    expect(list.data.map((x: any) => x.id)).toContain(c.id);
  });
});
