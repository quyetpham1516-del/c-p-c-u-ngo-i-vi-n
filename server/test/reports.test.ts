import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login, token } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let dpv: Client, crew: Client, qa: Client, giamdoc: Client, ketoan: Client, nhansu: Client;
const vnDate = (d = 0) => new Date(Date.now() + 7 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const range = `from=${vnDate(-1)}&to=${vnDate(1)}`;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [dpv, crew, qa, giamdoc, ketoan, nhansu] = await Promise.all(['dpv06', 'bs.als', 'qlcl', 'giamdoc', 'ketoan', 'nhansu'].map((u) => login(app, u)));
  await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' });
  // Một ca P1 đủ mốc, có phiếu ký 20 km và thu tiền, một phiếu chi nhiên liệu cho xe
  const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0901111222' });
  await dpv('PATCH', `/api/incidents/${inc.id}`, { address: 'Hiện trường', lat: 10.78, lng: 106.70, callbackPhone: '0901111222' });
  await dpv('PUT', `/api/incidents/${inc.id}/triage`, { answers: { conscious: 'yes', breathing: 'difficult', age_group: 'adult' }, group: 'kho_tho' });
  await dpv('POST', `/api/incidents/${inc.id}/confirm`, { priority: 'P1', vehicleType: 'ALS', lights: true, overrideReason: 'kiểm thử' });
  await dpv('POST', `/api/incidents/${inc.id}/assign`, { vehicleId: 'MD-ALS-01' });
  for (const s of ['S4', 'S5', 'S6', 'S7']) await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: s });
  const pat = await crew('POST', '/api/patients', { idType: 'UNKNOWN', fullName: 'Người bệnh báo cáo', birthYear: 1950, sex: 'F' });
  const tid = randomUUID();
  const at = new Date().toISOString();
  await crew('PUT', `/api/transfers/${tid}`, { incidentId: inc.id, vehicleId: 'MD-ALS-01', patientId: pat.id, baseVersion: 0, epcr: {
    chiefComplaint: 'Khó thở', vitals: [{ at, hr: 110 }], diagnosis: { text: 'Suy hô hấp', icd10: 'J96.0' }, payer: 'THU_PHI',
    disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', department: 'Khoa Cấp cứu', receiverName: 'BS Nhận', handoverAt: at, distanceKm: 20 },
  } });
  expect((await crew('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
  const c = (await pool.query('SELECT id, total FROM charges WHERE transfer_id = $1', [tid])).rows[0];
  await ketoan('POST', `/api/finance/charges/${c.id}/payments`, { amount: Number(c.total), method: 'tien_mat' });
  await ketoan('POST', '/api/finance/expenses', { category: 'nhien_lieu', amount: 500_000, spentOn: vnDate(), method: 'tien_mat', vehicleId: 'MD-ALS-01' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('báo cáo', () => {
  it('vận hành: đếm ca theo mức, thời gian đáp ứng P1 và giờ làm nhiệm vụ của xe', async () => {
    const r = await giamdoc('GET', `/api/reports/operations?${range}`);
    expect(r.totals.total).toBe(1);
    expect(r.totals.served).toBe(1);
    const p1 = r.intervals.find((x: any) => x.priority === 'P1');
    expect(p1.n).toBe(1);
    expect(p1.response_n).toBe(1);
    expect(p1.response_on_target).toBe(1);
    expect(p1.dispatch_median).toBeGreaterThanOrEqual(0);
    const als = r.fleet.find((f: any) => f.vehicle_id === 'MD-ALS-01');
    expect(als.missions).toBe(1);
    expect(als.busy_h).toBeGreaterThanOrEqual(0);
    expect((await ketoan('GET', `/api/reports/operations?${range}`)).http).toBe(403);
    expect((await giamdoc('GET', `/api/reports/operations?from=${vnDate(1)}&to=${vnDate(-1)}`)).http).toBe(400);
  });

  it('chuyên môn và chất lượng: chẩn đoán có tên bệnh theo ICD-10, sự cố trên 1000 ca', async () => {
    const c = await qa('GET', `/api/reports/clinical?${range}`);
    expect(c.totals.signed).toBe(1);
    expect(c.diagnoses[0].icd10).toBe('J96.0');
    expect(c.diagnoses[0].name).toMatch(/hô hấp/i);
    expect(c.hospitals[0].hospital).toBe('Bệnh viện Chợ Rẫy');
    await crew('POST', '/api/quality/events', { occurredAt: new Date().toISOString(), category: 'thuoc', severity: 'NC1', description: 'Nhầm ống thuốc, phát hiện kịp', anonymous: true });
    const q = await qa('GET', `/api/reports/quality?${range}`);
    expect(q.served).toBe(1);
    expect(q.eventTotal).toBe(1);
    expect(q.eventsPer1000).toBe(1000);
    expect(q.disinfection.n).toBeGreaterThanOrEqual(0);
  });

  it('tài chính: doanh thu, đã thu, chi phí và chênh lệch theo xe; xuất CSV', async () => {
    const f = await ketoan('GET', `/api/reports/financial?${range}`);
    const als = f.byVehicle.find((v: any) => v.vehicle_id === 'MD-ALS-01');
    expect(als.trips).toBe(1);
    expect(als.expenses).toBe(500_000);
    expect(als.margin).toBe(als.revenue - 500_000);
    expect(f.totals.collected).toBe(als.revenue);
    expect((await qa('GET', `/api/reports/financial?${range}`)).http).toBe(403);
    const csv = await app.inject({ method: 'GET', url: `/api/reports/financial?${range}&format=csv`, headers: { authorization: `Bearer ${await token(app, 'ketoan')}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('Theo xe');
    expect(csv.body).toContain('MD-ALS-01');
  });

  it('nhật ký thao tác: lọc theo hành động, chuỗi băm toàn vẹn', async () => {
    const rows = (await giamdoc('GET', `/api/reports/audit?${range}&action=finance`)).data;
    expect(rows.some((r: any) => r.action === 'finance.payment')).toBe(true);
    const v = await giamdoc('GET', `/api/reports/audit/verify?${range}`);
    expect(v.ok).toBe(true);
    expect(v.events).toBeGreaterThan(5);
    expect((await nhansu('GET', `/api/reports/audit?${range}`)).http).toBe(403);
  });

  it('kiểm soát tài liệu: người soạn không tự ban hành; ban hành bản mới thì bản cũ hết hiệu lực', async () => {
    const v1 = await qa('POST', '/api/documents', { code: 'QT-DP-01', title: 'Quy trình tiếp nhận cuộc gọi và điều phối', kind: 'quy_trinh', version: '1.0', ownerUnit: 'Trung tâm điều phối' });
    expect(v1.http).toBe(200);
    expect((await crew('POST', '/api/documents', { code: 'X', title: 'Không được', kind: 'khac', version: '1' })).http).toBe(403);
    expect((await crew('GET', '/api/documents')).data.length).toBe(0);
    expect((await giamdoc('POST', `/api/documents/${v1.id}/approve`, { effectiveOn: vnDate() })).status).toBe('hieu_luc');
    const v2 = await giamdoc('POST', '/api/documents', { code: 'QT-DP-01', title: 'Quy trình tiếp nhận cuộc gọi và điều phối', kind: 'quy_trinh', version: '1.1', changeNote: 'Thêm bước gọi lại' });
    expect((await giamdoc('POST', `/api/documents/${v2.id}/approve`, { effectiveOn: vnDate() })).http).toBe(403);
    const admin = await login(app, 'admin');
    expect((await admin('POST', `/api/documents/${v2.id}/approve`, { effectiveOn: vnDate() })).status).toBe('hieu_luc');
    const list = (await crew('GET', '/api/documents')).data;
    expect(list.length).toBe(1);
    expect(list[0].version).toBe('1.1');
    expect((await qa('GET', '/api/documents?all=1')).data.find((d: any) => d.version === '1.0').status).toBe('het_hieu_luc');
  });
});
