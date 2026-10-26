import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance; let pool: pg.Pool;
let admin: Client, ys: Client, dpv: Client, qlcl: Client;
let patientId = '';

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [admin, ys, dpv, qlcl] = await Promise.all(['admin', 'ys.bls', 'dpv06', 'qlcl'].map((u) => login(app, u)));
  expect((await ys('POST', '/api/crew/shift', { vehicleId: 'MD-BLS-01', crewRole: 'Y sĩ' })).http).toBe(200);
  patientId = (await ys('POST', '/api/patients', { idType: 'CCCD', idNumber: '079300009876', fullName: 'Lê Thị Hoa', birthYear: 1965, sex: 'F' })).id;
}, 60000);
afterAll(async () => { await app.close(); await pool.end(); });

async function draft(extra: Record<string, unknown>) {
  const at = new Date().toISOString();
  const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000099' });
  const epcr = {
    chiefComplaint: 'Co giật', vitals: [{ at, hr: 110, sbp: 140, spo2: 94 }], diagnosis: { text: 'Động kinh' }, payer: 'THU_PHI',
    disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', receiverName: 'BS Nhận', handoverAt: at }, ...extra,
  };
  const tid = randomUUID();
  expect((await ys('PUT', `/api/transfers/${tid}`, { incidentId: inc.id, vehicleId: 'MD-BLS-01', patientId, baseVersion: 0, epcr })).http).toBe(200);
  return { tid, epcr, at };
}

describe('phạm vi thực hiện theo chức danh', () => {
  it('danh sách mẫu có thuốc và can thiệp chỉ bác sĩ tự làm; kíp đọc được để phiếu tự kiểm tra', async () => {
    const ctx = await ys('GET', '/api/scope/context');
    expect(ctx.rules.some((r: any) => r.label.startsWith('Midazolam') && r.allowed.includes('bac_si'))).toBe(true);
    expect(ctx.rules.find((r: any) => r.ref === 'ett').allowed).toEqual(['bac_si']);
    expect(ctx.crew).toHaveLength(1);
    expect(ctx.crew[0]).toMatchObject({ category: 'y_si', crew_role: 'Y sĩ' });
    expect(ctx.doctors.some((d: any) => d.full_name.includes('Bác sĩ') || d.full_name)).toBe(true);
  });

  it('y sĩ dùng midazolam, đặt NKQ: chưa ký được khi chưa ghi bác sĩ trao đổi; ghi đủ thì ký được', async () => {
    const at = new Date().toISOString();
    const { tid, epcr } = await draft({
      care: { ett: true, o2Cannula: true },
      medications: [{ at, name: 'Midazolam 5 mg/1 ml', dose: '5 mg', route: 'TM', lot: 'MZ1' }],
    });
    const r = await ys('POST', `/api/transfers/${tid}/sign`);
    expect(r.http).toBe(422);
    expect(r.details).toEqual(expect.arrayContaining(['Bác sĩ trao đổi cho: Đặt nội khí quản', 'Bác sĩ trao đổi cho: Midazolam 5 mg/1 ml']));
    expect(r.details.some((d: string) => d.includes('oxy'))).toBe(false);

    const ctx = await ys('GET', '/api/scope/context');
    const mz = ctx.rules.find((x: any) => x.label.startsWith('Midazolam'));
    const consults = [{ at, doctor: 'BS Trực điều hành', mode: 'dien_thoai', items: ['can_thiep:ett', `thuoc:${mz.ref}`] }];
    expect((await ys('PUT', `/api/transfers/${tid}`, { vehicleId: 'MD-BLS-01', patientId, baseVersion: 1, epcr: { ...epcr, consults } })).http).toBe(200);
    expect((await ys('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);

    const list = await qlcl('GET', '/api/scope/consults');
    expect(list.data.some((x: any) => x.id === tid && x.consult.doctor === 'BS Trực điều hành')).toBe(true);
  });

  it('admin cấp riêng cho người này thì không cần bác sĩ trao đổi; đổi nhóm chức danh có hiệu lực ngay', async () => {
    const people = await admin('GET', '/api/scope/people');
    const me = people.data.find((p: any) => p.username === 'ys.bls');
    expect(me.category).toBe('y_si');
    const rules = await admin('GET', '/api/scope/rules');
    const ett = rules.rules.find((x: any) => x.ref === 'ett');
    expect((await ys('POST', '/api/scope/grants', { userId: me.id, ruleId: ett.id })).http).toBe(403);
    const g = await admin('POST', '/api/scope/grants', { userId: me.id, ruleId: ett.id, note: 'Đã qua lớp đường thở nâng cao' });
    expect(g.http).toBe(200);
    const { tid } = await draft({ care: { ett: true } });
    expect((await ys('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
    expect((await admin('POST', `/api/scope/grants/${g.id}/revoke`)).http).toBe(200);

    // Admin cho phép y sĩ tự đặt NKQ cho cả nhóm
    expect((await admin('PATCH', `/api/scope/rules/${ett.id}`, { allowed: ['bac_si', 'y_si'] })).http).toBe(200);
    const d2 = await draft({ care: { ett: true } });
    expect((await ys('POST', `/api/transfers/${d2.tid}/sign`)).http).toBe(200);
    await admin('PATCH', `/api/scope/rules/${ett.id}`, { allowed: ['bac_si'] });

    // Đổi nhóm chức danh của người này thành bác sĩ
    expect((await admin('PATCH', `/api/users/${me.id}/scope`, { scopeCategory: 'bac_si' })).http).toBe(200);
    const d3 = await draft({ care: { ett: true } });
    expect((await ys('POST', `/api/transfers/${d3.tid}/sign`)).http).toBe(200);
    await admin('PATCH', `/api/users/${me.id}/scope`, { scopeCategory: null });
  });

  it('admin thêm thuốc vào danh sách giới hạn, kíp không sửa được', async () => {
    const rules = await admin('GET', '/api/scope/rules');
    const adr = rules.drugs.find((d: any) => d.name.startsWith('Adrenalin'));
    expect((await ys('POST', '/api/scope/rules', { kind: 'thuoc', ref: String(adr.id), allowed: ['bac_si'] })).http).toBe(403);
    const r = await admin('POST', '/api/scope/rules', { kind: 'thuoc', ref: String(adr.id), allowed: ['bac_si', 'cap_cuu_vien'] });
    expect(r).toMatchObject({ http: 200, label: adr.name });
    expect((await admin('POST', '/api/scope/rules', { kind: 'thuoc', ref: String(adr.id), allowed: [] })).http).toBe(409);
    expect((await admin('POST', '/api/scope/rules', { kind: 'can_thiep', ref: 'khong_co', allowed: [] })).http).toBe(400);
  });
});

describe('vai trò trong kíp do admin quy định', () => {
  it('người được quy định vai trò chỉ nhận ca với vai trò đó; vai trò ngoài danh mục bị từ chối', async () => {
    const people = await admin('GET', '/api/scope/people');
    const me = people.data.find((p: any) => p.username === 'ys.bls');
    expect((await admin('PATCH', `/api/users/${me.id}/scope`, { crewRoles: ['Y sĩ', 'Không có'] })).http).toBe(400);
    expect((await admin('PATCH', `/api/users/${me.id}/scope`, { crewRoles: ['Y sĩ'] })).http).toBe(200);
    expect((await ys('POST', '/api/crew/shift', { vehicleId: 'MD-BLS-01', crewRole: 'Trưởng kíp' })).http).toBe(403);
    expect((await ys('POST', '/api/crew/shift', { vehicleId: 'MD-BLS-01', crewRole: 'Phụ xe tự đặt' })).http).toBe(400);
    expect((await admin('POST', '/api/crew-roles', { name: 'Phụ xe' })).http).toBe(200);
    expect((await admin('PATCH', `/api/users/${me.id}/scope`, { crewRoles: ['Y sĩ', 'Phụ xe'] })).http).toBe(200);
    expect((await ys('POST', '/api/crew/shift', { vehicleId: 'MD-BLS-01', crewRole: 'Phụ xe' })).http).toBe(200);
    expect((await admin('PATCH', `/api/users/${me.id}/scope`, { crewRoles: null })).http).toBe(200);
  });
});

describe('cận lâm sàng có giờ', () => {
  it('danh mục admin chỉnh được; kết quả thiếu giờ hoặc giá trị thì chưa ký được', async () => {
    const types = (await ys('GET', '/api/lab-types')).data;
    expect(types[0]).toMatchObject({ code: 'glucose', unit: 'mmol/L' });
    expect((await admin('POST', '/api/lab-types', { code: 'crp', name: 'CRP nhanh', unit: 'mg/L', normalHigh: 5 })).http).toBe(200);
    expect((await admin('PATCH', '/api/lab-types/alcohol', { active: false })).http).toBe(200);
    const after = (await ys('GET', '/api/lab-types')).data.map((t: any) => t.code);
    expect(after).toContain('crp');
    expect(after).not.toContain('alcohol');

    const { tid, epcr, at } = await draft({ labs: [{ at: '', type: 'glucose', name: 'Đường huyết mao mạch', value: '2.1', unit: 'mmol/L' }] });
    const r = await ys('POST', `/api/transfers/${tid}/sign`);
    expect(r.http).toBe(422);
    expect(r.details).toContain('Cận lâm sàng Đường huyết mao mạch: ghi giờ và kết quả');
    const labs = [{ at, type: 'glucose', name: 'Đường huyết mao mạch', value: '2.1', unit: 'mmol/L' }];
    expect((await ys('PUT', `/api/transfers/${tid}`, { vehicleId: 'MD-BLS-01', patientId, baseVersion: 1, epcr: { ...epcr, labs } })).http).toBe(200);
    expect((await ys('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
  });
});
