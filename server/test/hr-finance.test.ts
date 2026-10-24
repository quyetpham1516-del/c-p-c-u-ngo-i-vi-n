import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login, token } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let dpv: Client, crew: Client, nhansu: Client, ketoan: Client, giamdoc: Client, kythuat: Client, sup: Client;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [dpv, crew, nhansu, ketoan, giamdoc, kythuat, sup] = await Promise.all(
    ['dpv06', 'bs.als', 'nhansu', 'ketoan', 'giamdoc', 'kythuat', 'truongca'].map((u) => login(app, u)));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
const vnDate = (offsetDays = 0) => new Date(Date.now() + 7 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
const staffOf = async (username: string) => (await one('SELECT s.id FROM staff s JOIN users u ON u.id = s.user_id WHERE u.username = $1', [username])).id as string;

describe('nhân sự', () => {
  it('mọi tài khoản có hồ sơ nhân viên; số GPHN cũ thành giấy tờ hành nghề', async () => {
    const r = await one('SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM staff)::int AS staff');
    expect(r.staff).toBe(r.users);
    const s = await nhansu('GET', `/api/hr/staff/${await staffOf('bs.als')}`);
    expect(s.code).toMatch(/^NV-\d{4}$/);
    expect(s.docs.find((d: any) => d.kind === 'gphn').number).toBe('GPHN-0001');
    expect(s.required).toEqual(['gphn']);
  });

  it('giấy phép hành nghề hết hạn thì kíp không nhận ca trên xe; cấp mới thì nhận được', async () => {
    const sid = await staffOf('bs.als');
    const doc = await one(`SELECT id FROM staff_docs WHERE staff_id = $1 AND kind = 'gphn'`, [sid]);
    expect((await nhansu('PATCH', `/api/hr/docs/${doc.id}`, { expiresOn: vnDate(-1) })).http).toBe(200);
    const blocked = await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' });
    expect(blocked.http).toBe(409);
    expect(blocked.details.code).toBe('LICENSE');
    const list = (await nhansu('GET', '/api/hr/expiring')).data;
    expect(list.some((d: any) => d.staff_id === sid && d.expired)).toBe(true);
    expect((await nhansu('POST', `/api/hr/staff/${sid}/docs`, { kind: 'gphn', number: 'GPHN-0001-M', issuedOn: vnDate(-10), expiresOn: vnDate(1800) })).http).toBe(200);
    const ok = await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' });
    expect(ok.http).toBe(200);
    expect(ok.warnings.some((w: string) => /kiến thức y khoa/.test(w))).toBe(true);
    expect((await crew('GET', '/api/hr/me')).staff.id).toBe(sid);
  });

  it('đình chỉ giấy phép cũng chặn nhận ca; người khác ngoài phòng Nhân sự không sửa được giấy tờ', async () => {
    const sid = await staffOf('dd.als');
    const doc = await one(`SELECT id FROM staff_docs WHERE staff_id = $1 AND kind = 'gphn'`, [sid]);
    expect((await ketoan('PATCH', `/api/hr/docs/${doc.id}`, { suspended: true })).http).toBe(403);
    expect((await nhansu('PATCH', `/api/hr/docs/${doc.id}`, { suspended: true })).http).toBe(200);
    const dd = await login(app, 'dd.als');
    const r = await dd('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Điều dưỡng' });
    expect(r.http).toBe(409);
    expect(r.error).toMatch(/đình chỉ/);
  });

  it('lịch trực: sau trực 24 giờ không xếp ca ngày liền sau trừ khi ghi lý do; nghỉ phép đã duyệt thì không xếp ca', async () => {
    const sid = await staffOf('ys.bls');
    const d1 = vnDate(3), d2 = vnDate(4), d5 = vnDate(7);
    expect((await nhansu('POST', '/api/hr/roster', { staffId: sid, workDate: d1, shift: 'truc_24', stationId: 'TR-01', vehicleId: 'MD-BLS-01' })).http).toBe(200);
    const rest = await nhansu('POST', '/api/hr/roster', { staffId: sid, workDate: d2, shift: 'ngay' });
    expect(rest.http).toBe(409);
    expect(rest.details.code).toBe('REST');
    expect((await nhansu('POST', '/api/hr/roster', { staffId: sid, workDate: d2, shift: 'ngay', override: true })).http).toBe(422);
    expect((await sup('POST', '/api/hr/roster', { staffId: sid, workDate: d2, shift: 'ngay', override: true, note: 'Thiếu người do dịch' })).http).toBe(200);
    expect((await nhansu('POST', '/api/hr/roster', { staffId: sid, workDate: d1, shift: 'ngay' })).http).toBe(409);

    const ys = await login(app, 'ys.bls');
    const leave = await ys('POST', '/api/hr/leave', { kind: 'phep_nam', fromDate: d5, toDate: d5, reason: 'Việc gia đình' });
    expect(leave.http).toBe(200);
    expect((await ys('POST', `/api/hr/leave/${leave.id}/decide`, { approve: true })).http).toBe(403);
    expect((await nhansu('POST', `/api/hr/leave/${leave.id}/decide`, { approve: true })).http).toBe(200);
    expect((await nhansu('POST', '/api/hr/roster', { staffId: sid, workDate: d5, shift: 'ngay' })).http).toBe(409);
  });

  it('nghỉ phép hôm nay đã duyệt thì không nhận ca; bảng công tháng xuất được CSV', async () => {
    const bs = await login(app, 'bs.msu');
    const l = await bs('POST', '/api/hr/leave', { kind: 'om', fromDate: vnDate(), toDate: vnDate() });
    await nhansu('POST', `/api/hr/leave/${l.id}/decide`, { approve: true });
    const r = await bs('POST', '/api/crew/shift', { vehicleId: 'MD-MSU-01', crewRole: 'Bác sĩ' });
    expect(r.http).toBe(409);
    expect(r.details.code).toBe('ON_LEAVE');

    const ts = (await nhansu('GET', `/api/hr/timesheet?month=${vnDate().slice(0, 7)}`)).data;
    expect(ts.find((x: any) => x.full_name === 'BS Kíp đột quỵ').leave_days).toBe(1);
    const csv = await app.inject({ method: 'GET', url: `/api/hr/timesheet?month=${vnDate().slice(0, 7)}&format=csv`, headers: { authorization: `Bearer ${await token(app, 'nhansu')}` } });
    expect(csv.body.startsWith('\uFEFFMã NV')).toBe(true);
    const check = await nhansu('POST', '/api/hr/attendance/check');
    expect(check.checkedIn).toBe(true);
    expect((await nhansu('POST', '/api/hr/attendance/check')).checkedIn).toBe(false);
  });
});

describe('tài chính', () => {
  let incidentId = '';
  let patientId = '';

  async function signed(epcrExtra: Record<string, unknown>) {
    const tid = randomUUID();
    const at = new Date().toISOString();
    const epcr = {
      chiefComplaint: 'Khó thở', vitals: [{ at, hr: 100 }], diagnosis: { text: 'Khó thở', icd10: 'R06.0' },
      disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', department: 'Khoa Cấp cứu', receiverName: 'BS Nhận', handoverAt: at },
      payer: 'THU_PHI', ...epcrExtra,
    };
    expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId, vehicleId: 'MD-ALS-01', patientId, baseVersion: 0, epcr })).http).toBe(200);
    expect((await crew('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
    return one('SELECT * FROM charges WHERE transfer_id = $1', [tid]);
  }

  beforeAll(async () => {
    const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000001' });
    incidentId = inc.id;
    patientId = (await crew('POST', '/api/patients', { idType: 'UNKNOWN', fullName: 'Người bệnh thu phí', birthYear: 1970, sex: 'F' })).id;
  });

  it('ký phiếu chuyển viện tự sinh khoản thu theo bảng giá loại xe và số km', async () => {
    const c = await signed({ disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', department: 'Khoa Cấp cứu', receiverName: 'BS Nhận', handoverAt: new Date().toISOString(), distanceKm: 25 } });
    expect(c.code).toMatch(/^KT-\d{4}-\d{5}$/);
    expect(c.payer_kind).toBe('THU_PHI');
    expect(c.payer_name).toBe('Người bệnh thu phí');
    expect(Number(c.total)).toBe(c.night ? 2_340_000 : 1_950_000);   // 1.500.000 mở cửa 10 km + 15 km × 30.000, đêm +20%
    expect(c.status).toBe('cho_thu');

    const over = await ketoan('POST', `/api/finance/charges/${c.id}/payments`, { amount: Number(c.total) + 1, method: 'tien_mat' });
    expect(over.http).toBe(409);
    expect((await ketoan('POST', `/api/finance/charges/${c.id}/payments`, { amount: 1_000_000, method: 'chuyen_khoan' })).http).toBe(422);
    expect((await crew('POST', `/api/finance/charges/${c.id}/payments`, { amount: 1_000_000, method: 'tien_mat' })).http).toBe(403);
    const p1 = await ketoan('POST', `/api/finance/charges/${c.id}/payments`, { amount: 1_000_000, method: 'tien_mat' });
    expect(p1.code).toMatch(/^PT-/);
    expect((await ketoan('GET', `/api/finance/charges/${c.id}`)).status).toBe('thu_mot_phan');
    await ketoan('POST', `/api/finance/charges/${c.id}/payments`, { amount: Number(c.total) - 1_000_000, method: 'chuyen_khoan', reference: 'FT2610' });
    expect((await ketoan('GET', `/api/finance/charges/${c.id}`)).status).toBe('da_thu');

    const inv = await ketoan('POST', '/api/finance/invoices', { chargeIds: [c.id] });
    expect(inv.http).toBe(200);
    expect(Number(inv.total)).toBe(Number(c.total));
    expect((await ketoan('POST', '/api/finance/invoices', { chargeIds: [c.id] })).http).toBe(409);
    expect((await ketoan('POST', `/api/finance/invoices/${inv.id}/issue`, { einvoiceNo: '0000123', einvoiceSymbol: '1C26TMD' })).status).toBe('da_phat_hanh');
    expect((await ketoan('PATCH', `/api/finance/charges/${c.id}`, { km: 30 })).http).toBe(409);

    const j = await ketoan('GET', `/api/finance/journal?from=${vnDate(-1)}&to=${vnDate(1)}`);
    expect(j.data.some((r: any) => r.docNo === c.code && r.debit === '131' && r.credit === '5113')).toBe(true);
    expect(j.data.some((r: any) => r.docNo === p1.code && r.debit === '1111' && r.credit === '131')).toBe(true);
    const csv = await app.inject({ method: 'GET', url: `/api/finance/journal?from=${vnDate(-1)}&to=${vnDate(1)}&format=csv`, headers: { authorization: `Bearer ${await token(app, 'ketoan')}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.startsWith('﻿Ngày hạch toán')).toBe(true);
  });

  it('thiếu số km thì chờ kế toán bổ sung; đối tượng miễn phí phải Ban Giám đốc duyệt', async () => {
    const c = await signed({});
    expect(c.status).toBe('thieu_thong_tin');
    expect((await ketoan('POST', `/api/finance/charges/${c.id}/payments`, { amount: 100_000, method: 'tien_mat' })).http).toBe(409);
    const u = await ketoan('PATCH', `/api/finance/charges/${c.id}`, { km: 8 });
    expect(u.status).toBe('cho_thu');
    expect(Number(u.total)).toBe(u.night ? 1_800_000 : 1_500_000);

    const m = await signed({ payer: 'MIEN', disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', department: 'Khoa Cấp cứu', receiverName: 'BS Nhận', handoverAt: new Date().toISOString(), distanceKm: 5 } });
    expect(m.payer_kind).toBe('MIEN');
    expect(m.waiver_status).toBe('cho_duyet');
    expect(m.status).toBe('cho_thu');
    expect((await ketoan('POST', `/api/finance/charges/${m.id}/waiver/decide`, { approve: true })).http).toBe(403);
    const d = await giamdoc('POST', `/api/finance/charges/${m.id}/waiver/decide`, { approve: true });
    expect(d.status).toBe('mien_giam');
    const j = (await ketoan('GET', `/api/finance/journal?from=${vnDate(-1)}&to=${vnDate(1)}`)).data;
    expect(j.some((r: any) => r.docNo === m.code && r.debit === '5213')).toBe(true);

    const ag = (await ketoan('GET', '/api/finance/receivables')).data;
    expect(ag.find((r: any) => r.payer === 'Khách lẻ').outstanding).toBeGreaterThan(0);
  });

  it('đề xuất chi: cấp 1 kế toán, từ ngưỡng 5 triệu thêm cấp 2 Ban Giám đốc; phiếu chi lớn phải gắn đề xuất và không vượt số duyệt', async () => {
    const p = await kythuat('POST', '/api/finance/proposals', { kind: 'sua_chua', title: 'Thay bình oxy xe ALS', amount: 8_000_000, vehicleId: 'MD-ALS-01' });
    expect(p.code).toMatch(/^DX-/);
    expect((await kythuat('POST', `/api/finance/proposals/${p.id}/decide`, { approve: true })).http).toBe(403);
    expect((await ketoan('POST', `/api/finance/proposals/${p.id}/decide`, { approve: false })).http).toBe(422);
    expect((await ketoan('POST', `/api/finance/proposals/${p.id}/decide`, { approve: true })).status).toBe('cho_duyet_2');
    expect((await ketoan('POST', `/api/finance/proposals/${p.id}/decide`, { approve: true })).http).toBe(403);
    expect((await giamdoc('POST', `/api/finance/proposals/${p.id}/decide`, { approve: true })).status).toBe('da_duyet');

    const base = { category: 'sua_chua_xe', spentOn: vnDate(), method: 'chuyen_khoan', payee: 'Garage Phú Mỹ', vehicleId: 'MD-ALS-01' };
    expect((await ketoan('POST', '/api/finance/expenses', { ...base, amount: 8_000_000 })).http).toBe(422);
    expect((await ketoan('POST', '/api/finance/expenses', { ...base, amount: 9_000_000, proposalId: p.id })).http).toBe(409);
    expect((await ketoan('POST', '/api/finance/expenses', { ...base, amount: 8_000_000, proposalId: p.id })).code).toMatch(/^PC-/);
    expect((await one('SELECT status FROM proposals WHERE id = $1', [p.id])).status).toBe('da_chi');

    const small = await kythuat('POST', '/api/finance/proposals', { kind: 'chi_phi', title: 'Mua găng tay bảo hộ', amount: 1_000_000 });
    expect((await ketoan('POST', `/api/finance/proposals/${small.id}/decide`, { approve: true })).status).toBe('da_duyet');
    expect((await ketoan('POST', '/api/finance/expenses', { category: 'nhien_lieu', amount: 600_000, spentOn: vnDate(), method: 'tien_mat', vehicleId: 'MD-ALS-01' })).http).toBe(200);
    const mine = (await kythuat('GET', '/api/finance/proposals')).data;
    expect(mine.length).toBe(2);
    const s = await giamdoc('GET', '/api/finance/summary');
    expect(s.expenses).toBe(8_600_000);
  });
});
