import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let dpv: Client, crew: Client, qa: Client, ksnk: Client, giamdoc: Client, sup: Client, dd: Client;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [dpv, crew, qa, ksnk, giamdoc, sup, dd] = await Promise.all(['dpv06', 'bs.als', 'qlcl', 'ksnk', 'giamdoc', 'truongca', 'dd.als'].map((u) => login(app, u)));
  await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];

async function dispatched() {
  const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0901234567' });
  await dpv('PATCH', `/api/incidents/${inc.id}`, { address: 'Hiện trường', lat: 10.78, lng: 106.70, callbackPhone: '0901234567' });
  await dpv('PUT', `/api/incidents/${inc.id}/triage`, { answers: { conscious: 'yes', breathing: 'difficult', age_group: 'adult' }, group: 'kho_tho' });
  await dpv('POST', `/api/incidents/${inc.id}/confirm`, { priority: 'P1', vehicleType: 'ALS', lights: true, overrideReason: 'kiểm thử' });
  expect((await dpv('POST', `/api/incidents/${inc.id}/assign`, { vehicleId: 'MD-ALS-01' })).http).toBe(200);
  return inc.id as string;
}

describe('kiểm soát nhiễm khuẩn', () => {
  it('ca thường: xe về sẵn sàng được, tự có phiếu khử khuẩn thường quy chờ làm; đóng ca thì xếp tin nhắn khảo sát', async () => {
    const id = await dispatched();
    for (const s of ['S4', 'S5', 'S6', 'S7']) expect((await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: s })).http).toBe(200);
    expect((await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: 'S1' })).http).toBe(200);
    const d = await one('SELECT * FROM disinfections WHERE incident_id = $1', [id]);
    expect(d.status).toBe('cho_lam');
    expect(d.required_level).toBe('thuong_quy');
    const sms = await one(`SELECT * FROM message_outbox WHERE purpose = 'khao_sat' ORDER BY id DESC LIMIT 1`);
    expect(sms.to_phone).toBe('0901234567');
    expect(sms.body).toMatch(/khao-sat\//);
  });

  it('ca nghi lây qua không khí: xe không về sẵn sàng khi chưa ký phiếu khử khuẩn toàn diện đủ bước', async () => {
    const id = await dispatched();
    await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: 'S4' });
    expect((await crew('POST', '/api/crew/infection', { risk: 'khong_khi' })).http).toBe(200);
    await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: 'S8' });
    const blocked = await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: 'S1' });
    expect(blocked.http).toBe(409);
    expect(blocked.details.code).toBe('DISINFECTION');
    const low = await crew('POST', '/api/ipc/disinfections', { vehicleId: 'MD-ALS-01', incidentId: id, level: 'tang_cuong', checklist: {}, chemical: 'Cloramin B' });
    expect(low.http).toBe(409);
    const meta = await crew('GET', '/api/ipc/meta');
    const all = Object.fromEntries(Object.values(meta.steps).flat().map(([k]: any) => [k, true]));
    const partial = await crew('POST', '/api/ipc/disinfections', { vehicleId: 'MD-ALS-01', incidentId: id, level: 'toan_dien', checklist: { be_mat: true }, chemical: 'Cloramin B' });
    expect(partial.http).toBe(422);
    const ok = await crew('POST', '/api/ipc/disinfections', { vehicleId: 'MD-ALS-01', incidentId: id, level: 'toan_dien', checklist: all, chemical: 'Cloramin B', concentration: '0,5%', contactMinutes: 30 });
    expect(ok.status).toBe('da_ky');
    expect((await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: 'S1' })).http).toBe(200);
  });

  it('vệ sinh tay, phơi nhiễm bảo mật, tiêm chủng, chất thải', async () => {
    const staff = (await ksnk('GET', '/api/staff')).data;
    const bs = staff.find((u: any) => u.full_name === 'BS Kíp ALS');
    await ksnk('POST', '/api/ipc/hand-hygiene', { stationId: 'TS', staffId: bs.id, moment: 'truoc_tiep_xuc', compliant: true, method: 'chua_con' });
    await ksnk('POST', '/api/ipc/hand-hygiene', { stationId: 'TS', staffGroup: 'Lái xe', moment: 'sau_moi_truong', compliant: false });
    const st = await ksnk('GET', '/api/ipc/hand-hygiene/stats');
    expect(st.total).toEqual({ n: 2, ok: 1 });

    const ex = await crew('POST', '/api/ipc/exposures', { occurredAt: new Date().toISOString(), kind: 'kim_dam', description: 'Kim đâm khi đậy nắp kim sau tiêm' });
    expect(ex.http).toBe(200);
    expect((await dd('GET', '/api/ipc/exposures')).data.length).toBe(0);
    expect((await crew('GET', '/api/ipc/exposures')).data.length).toBe(1);
    expect((await qa('GET', '/api/ipc/exposures')).data.length).toBe(0);
    const up = await ksnk('PATCH', `/api/ipc/exposures/${ex.id}`, { pepStarted: true, followup: { on: '2026-11-01', test: 'Anti-HIV', result: 'Âm tính' } });
    expect(up.followups.length).toBe(1);
    expect((await qa('PATCH', `/api/ipc/exposures/${ex.id}`, { close: true })).http).toBe(403);

    expect((await ksnk('POST', '/api/ipc/vaccinations', { staffId: bs.id, vaccine: 'Viêm gan B', dose: 'Mũi 3', givenOn: '2025-01-10', nextDue: '2026-01-10' })).http).toBe(200);
    expect((await ksnk('GET', '/api/ipc/summary')).vaccinesDue.length).toBe(1);
    expect((await crew('POST', '/api/ipc/waste', { stationId: 'TS', onDate: '2026-10-24', kind: 'lay_nhiem', kg: 3.5 })).http).toBe(200);
    expect((await ksnk('GET', '/api/ipc/waste')).summary[0].kg).toBe(3.5);
  });
});

describe('sự cố y khoa, hành động khắc phục', () => {
  it('báo ẩn danh không lưu người báo, kể cả trong nhật ký', async () => {
    const r = await dd('POST', '/api/quality/events', {
      occurredAt: new Date().toISOString(), anonymous: true, category: 'thuoc', description: 'Nhầm ống thuốc khi rút, phát hiện trước khi tiêm', severity: 'NC0',
    });
    expect(r.code).toMatch(/^SC-/);
    const ev = await one('SELECT reporter_id FROM adverse_events WHERE id = $1', [r.id]);
    expect(ev.reporter_id).toBeNull();
    const a = await one(`SELECT actor_id FROM audit_events WHERE action = 'quality.event_reported' AND entity_id = $1`, [r.id]);
    expect(a.actor_id).toBeNull();
    expect((await dd('GET', '/api/quality/my-events')).data.length).toBe(0);
    expect((await dd('GET', '/api/quality/events')).http).toBe(403);
  });

  it('sự cố nghiêm trọng: phân tích nguyên nhân, hành động khắc phục xong, báo cơ quan quản lý, ban giám đốc (không phải người xử lý) mới đóng', async () => {
    const r = await crew('POST', '/api/quality/events', {
      occurredAt: new Date().toISOString(), category: 'tai_nan', description: 'Người bệnh té khỏi cáng khi chuyển lên xe', severity: 'NC2', patientAffected: true, vehicleId: 'MD-ALS-01',
    });
    const qlcl = (await qa('GET', '/api/staff')).data.find((u: any) => u.role === 'qa');
    await qa('PATCH', `/api/quality/events/${r.id}`, { severity: 'NC3', handlerId: qlcl.id });
    expect((await qa('PATCH', `/api/quality/events/${r.id}`, { status: 'da_phan_tich' })).http).toBe(400);
    await qa('PATCH', `/api/quality/events/${r.id}`, { status: 'da_phan_tich', rootCause: 'Không khóa bánh cáng; thiếu người hỗ trợ', factors: ['Quy trình', 'Thiết bị'] });
    const capa = await qa('POST', '/api/quality/capa', { eventId: r.id, description: 'Đào tạo lại quy trình chuyển người bệnh lên xe', ownerId: qlcl.id, dueDate: '2026-11-30' });
    expect((await qa('POST', `/api/quality/events/${r.id}/close`, { note: 'xong' })).http).toBe(409);
    expect((await qa('POST', `/api/quality/capa/${capa.id}/finish`, { status: 'xong', evidence: 'Danh sách ký đào tạo ngày 1/11' })).http).toBe(200);
    const noReport = await giamdoc('POST', `/api/quality/events/${r.id}/close`, { note: 'xong' });
    expect(noReport.error).toMatch(/cơ quan quản lý/);
    await qa('PATCH', `/api/quality/events/${r.id}`, { authorityReported: true });
    expect((await qa('POST', `/api/quality/events/${r.id}/close`, { note: 'xong' })).http).toBe(403);
    expect((await giamdoc('POST', `/api/quality/events/${r.id}/close`, { note: 'Đã khắc phục, theo dõi 3 tháng' })).http).toBe(200);
    const list = (await qa('GET', '/api/quality/events')).data;
    expect(list.find((e: any) => e.id === r.id).status).toBe('dong');
  });

  it('gợi ý sự cố từ dữ liệu: xe thiếu thiết bị vẫn được cho đi; tạo báo cáo từ gợi ý thì không gợi ý lại', async () => {
    await pool.query(`UPDATE equipment SET status = 'hong' WHERE serial = 'MAU-MD-ALS-01-01'`);
    const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000001' });
    await dpv('PATCH', `/api/incidents/${inc.id}`, { address: 'X', lat: 10.78, lng: 106.70 });
    await dpv('PUT', `/api/incidents/${inc.id}/triage`, { answers: { conscious: 'yes', breathing: 'difficult', age_group: 'adult' }, group: 'kho_tho' });
    await dpv('POST', `/api/incidents/${inc.id}/confirm`, { priority: 'P1', vehicleType: 'ALS', lights: true, overrideReason: 'kiểm thử' });
    expect((await sup('POST', `/api/incidents/${inc.id}/assign`, { vehicleId: 'MD-ALS-01', equipmentOverride: 'Mang AED từ trạm' })).http).toBe(200);
    const sug = (await qa('GET', '/api/quality/suggestions')).data;
    const s = sug.find((x: any) => x.ref.startsWith('xe-thieu-thiet-bi:'));
    expect(s.text).toMatch(/Mang AED từ trạm/);
    const ev = await qa('POST', '/api/quality/events', { occurredAt: s.at, category: s.category, description: s.text, severity: 'NC0', sourceRef: s.ref, incidentId: s.incident_id });
    expect(ev.http).toBe(200);
    expect((await qa('GET', '/api/quality/suggestions')).data.some((x: any) => x.ref === s.ref)).toBe(false);
  });
});

describe('khiếu nại, khảo sát hài lòng', () => {
  it('khiếu nại có hạn phản hồi 48 giờ (khẩn 24 giờ); phải phản hồi mới đóng', async () => {
    const code = (await one(`SELECT code FROM incidents ORDER BY created_at LIMIT 1`)).code;
    const c = await dpv('POST', '/api/quality/complaints', { channel: 'dien_thoai', complainant: 'Người nhà', phone: '0909', incidentCode: code, category: 'thoi_gian', content: 'Xe tới chậm', urgent: true });
    expect(c.code).toMatch(/^KN-/);
    expect(new Date(c.due_at).getTime() - new Date(c.received_at).getTime()).toBe(24 * 3600_000);
    expect((await qa('PATCH', `/api/quality/complaints/${c.id}`, { close: true })).http).toBe(409);
    await qa('PATCH', `/api/quality/complaints/${c.id}`, { response: 'Đã gọi xin lỗi, giải thích kẹt xe; rà soát điều phối' });
    const done = await qa('PATCH', `/api/quality/complaints/${c.id}`, { close: true, satisfied: true });
    expect(done.status).toBe('dong');
  });

  it('khảo sát công khai trả lời một lần; điểm thấp tự thành khiếu nại', async () => {
    const s = await one(`SELECT token FROM surveys ORDER BY created_at LIMIT 1`);
    const info = await app.inject({ method: 'GET', url: `/api/public/survey/${s.token}` });
    expect(info.json().incidentCode).toMatch(/^MD-/);
    const r = await app.inject({ method: 'POST', url: `/api/public/survey/${s.token}`, payload: { overall: 2, attitude: 1, comment: 'Nhân viên nói chuyện cộc' } });
    expect(r.json().followUp).toBe(true);
    const again = await app.inject({ method: 'POST', url: `/api/public/survey/${s.token}`, payload: { overall: 5 } });
    expect(again.statusCode).toBe(409);
    const k = (await qa('GET', '/api/quality/complaints')).data.find((x: any) => x.channel === 'khao_sat');
    expect(k.category).toBe('thai_do');
    const stats = await qa('GET', '/api/quality/surveys');
    expect(stats.stats.answered).toBe(1);
  });
});
