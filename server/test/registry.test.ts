import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { redactUrl } from '../src/http.js';
import { freshApp, login, testPassword } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance; let pool: pg.Pool;
let admin: Client, crew: Client, dpv: Client, qa: Client, bv: Client, bvKhac: Client;
let hospitalId = 0; let otherId = 0; let tid = ''; let caseId = '';

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [admin, crew, dpv, qa] = await Promise.all(['admin', 'bs.als', 'dpv06', 'qlcl'].map((u) => login(app, u)));
  const hs = (await pool.query(`SELECT id, name FROM hospitals WHERE name IN ('Bệnh viện Chợ Rẫy') OR id = (SELECT min(id) FROM hospitals WHERE name <> 'Bệnh viện Chợ Rẫy')`)).rows;
  hospitalId = hs.find((h) => h.name === 'Bệnh viện Chợ Rẫy').id;
  otherId = hs.find((h) => h.name !== 'Bệnh viện Chợ Rẫy').id;
  expect((await admin('POST', '/api/users', { username: 'bv.choray', fullName: 'BS Cấp cứu Chợ Rẫy', role: 'hospital', password: testPassword })).http).toBe(400);
  expect((await admin('POST', '/api/users', { username: 'bv.choray', fullName: 'BS Cấp cứu Chợ Rẫy', role: 'hospital', hospitalId, cccd: '079200000001', password: testPassword })).http).toBe(200);
  expect((await admin('POST', '/api/users', { username: 'bv.khac', fullName: 'BS Bệnh viện khác', role: 'hospital', hospitalId: otherId, cccd: '079200000002', password: testPassword })).http).toBe(200);
  [bv, bvKhac] = await Promise.all(['bv.choray', 'bv.khac'].map((u) => login(app, u)));
  await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Bác sĩ' });
}, 60000);
afterAll(async () => { await app.close(); await pool.end(); });

describe('biểu mẫu nghiên cứu và cổng bệnh viện', () => {
  it('admin bật, tắt từng biểu mẫu và chọn khoảng thời gian; người khác không đổi được', async () => {
    const s = await admin('GET', '/api/registry/settings');
    expect(s.data.map((r: any) => [r.code, r.enabled])).toEqual([['patos', false], ['stroke', false], ['utstein', true]]);
    expect((await qa('PUT', '/api/registry/settings/stroke', { enabled: true })).http).toBe(403);
    expect((await admin('PUT', '/api/registry/settings/stroke', { enabled: true, startOn: '2026-01-01', endOn: '2025-01-01' })).http).toBe(422);
    expect((await admin('PUT', '/api/registry/settings/stroke', { enabled: true, startOn: '2026-01-01' })).http).toBe(200);
    // PATOS bật nhưng hết hạn lấy số liệu: không lấy ca mới
    expect((await admin('PUT', '/api/registry/settings/patos', { enabled: true, endOn: '2026-01-31' })).http).toBe(200);
    const after = await admin('GET', '/api/registry/settings');
    expect(after.data.find((r: any) => r.code === 'stroke').collecting).toBe(true);
    expect(after.data.find((r: any) => r.code === 'patos').collecting).toBe(false);
  });

  it('ký phiếu đột quỵ chuyển tới bệnh viện: ca vào biểu mẫu, bệnh viện nhận được báo', async () => {
    const at = new Date().toISOString();
    const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0909000111' });
    const p = await crew('POST', '/api/patients', { idType: 'UNKNOWN', fullName: 'Nguyễn Văn Đột', sex: 'M' });
    tid = randomUUID();
    const epcr = {
      patient: { fullName: 'Nguyễn Văn Đột', age: 67, sex: 'M' }, chiefComplaint: 'Yếu nửa người', vitals: [{ at, hr: 88, sbp: 170 }],
      abcde: { fastF: true, fastA: true }, trauma: { present: true, types: ['Rách da'] }, diagnosis: { text: 'Theo dõi đột quỵ' }, payer: 'THU_PHI',
      disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', receiverName: 'BS Nhận', handoverAt: at },
    };
    expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId: inc.id, vehicleId: 'MD-ALS-01', patientId: p.id, baseVersion: 0, epcr })).http).toBe(200);
    expect((await crew('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
    const cases = await dpv('GET', `/api/registry/cases?transferId=${tid}`);
    expect(cases.data.map((c: any) => c.registry)).toEqual(['stroke']); // PATOS hết hạn, không vào
    caseId = cases.data[0].id;
    expect(cases.data[0]).toMatchObject({ hospital_id: hospitalId, status: 'cho_bo_sung', age: '67' });

    const n = await bv('GET', '/api/notifications');
    expect(n.messages[0]).toMatchObject({ kind: 'hospital_transfer', link: `/benh-vien?phieu=${tid}` });
    expect(n.reminders[0].key).toBe('reg:stroke');
    expect((await bvKhac('GET', '/api/notifications')).messages).toHaveLength(0);
  });

  it('tài khoản bệnh viện chỉ thấy phiếu, ca của bệnh viện mình; không vào được chức năng khác', async () => {
    const list = await bv('GET', '/api/hospital/transfers');
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ id: tid, full_name: 'Nguyễn Văn Đột', registries: [{ id: caseId, registry: 'stroke', status: 'cho_bo_sung' }] });
    expect((await bv('GET', `/api/transfers/${tid}`)).http).toBe(200);
    expect((await bvKhac('GET', `/api/transfers/${tid}`)).http).toBe(403);
    expect((await bvKhac('GET', `/api/registry/cases/${caseId}`)).http).toBe(403);
    expect((await bvKhac('GET', '/api/hospital/transfers')).data).toHaveLength(0);
    expect((await bv('GET', '/api/registry/cases')).data).toHaveLength(1);
    expect((await bvKhac('GET', '/api/registry/cases')).data).toHaveLength(0);
    for (const url of ['/api/incidents', '/api/patients/search?q=Nguy', '/api/stock', '/api/board', '/api/registry/settings', '/api/users']) {
      expect((await bv('GET', url)).http, url).toBe(403);
    }
  });

  it('bệnh viện điền phần trong viện; không sửa phần trước viện; đủ trường bắt buộc thì xong', async () => {
    expect((await bv('PUT', `/api/registry/cases/${caseId}`, { lastKnownWell: '2026-10-26T01:00' })).http).toBe(403);
    expect((await bv('PUT', `/api/registry/cases/${caseId}`, { nihss: 'mười' })).http).toBe(400);
    expect((await bv('PUT', `/api/registry/cases/${caseId}`, { strokeType: 'khong_co' })).http).toBe(400);
    const part = await bv('PUT', `/api/registry/cases/${caseId}`, { doorAt: '2026-10-26T08:10', strokeType: 'nhoi_mau', nihss: 9, thrombolysis: true });
    expect(part.status).toBe('dang_bo_sung');
    expect(part.missing).toContain('Lần cuối còn bình thường');
    // Bác sĩ hoặc điều phối của trung tâm bổ sung phần trước viện
    const done = await dpv('PUT', `/api/registry/cases/${caseId}`, { lastKnownWell: '2026-10-26T07:20', discharge: 'song', mrsDischarge: '2' });
    expect(done.status).toBe('du');
    expect(done.completed_at).toBeTruthy();
    expect((await bv('GET', '/api/notifications')).reminders).toHaveLength(0);
  });

  it('thêm ca bằng tay, xuất CSV không có họ tên', async () => {
    expect((await dpv('POST', '/api/registry/cases', { registry: 'stroke', transferId: tid })).http).toBe(409);
    expect((await dpv('POST', '/api/registry/cases', { registry: 'patos', transferId: tid })).http).toBe(200);
    expect((await crew('GET', '/api/registry/export?registry=stroke')).http).toBe(403);
    const r = await app.inject({ method: 'GET', url: '/api/registry/export?registry=stroke', headers: { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'qlcl', password: testPassword } })).json().token}` } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('nhoi_mau');
    expect(r.body).not.toContain('Nguyễn Văn Đột');
  });

  it('ca tự đến: khoa cấp cứu tạo phiếu đủ các phần, chặn trùng số hồ sơ, dùng chung danh sách và file xuất', async () => {
    const defs = await bv('GET', '/api/registry/defs');
    expect(defs.data.find((d: any) => d.code === 'utstein')).toMatchObject({ collecting: true });
    expect(defs.data.find((d: any) => d.code === 'patos').collecting).toBe(false);
    // Biểu mẫu không lấy số liệu thì không tạo được; nhân viên kíp không tạo được
    expect((await bv('POST', '/api/registry/walk-in', { registry: 'patos', hospitalRecordNo: 'CR-1' })).http).toBe(409);
    expect((await crew('POST', '/api/registry/walk-in', { registry: 'utstein', hospitalRecordNo: 'CR-1', hospitalId })).http).toBe(403);
    expect((await qa('POST', '/api/registry/walk-in', { registry: 'utstein', hospitalRecordNo: 'CR-1' })).http).toBe(400);

    const c = await bv('POST', '/api/registry/walk-in', { registry: 'utstein', hospitalRecordNo: 'CR-1', hospitalId: otherId,
      data: { age: 58, sex: 'M', arrivedAt: '2026-10-28T21:05', arrivalMode: 'gia_dinh', witnessed: 'co', bystanderCpr: 'khong' } });
    expect(c).toMatchObject({ source: 'tu_den', hospital_id: hospitalId, hospital_record_no: 'CR-1', transfer_id: null, created_by_name: 'BS Cấp cứu Chợ Rẫy', status: 'dang_bo_sung', age: '58' });
    expect(c.missing).toEqual(expect.arrayContaining(['Chẩn đoán tại khoa cấp cứu', 'Nhịp đầu tiên tại khoa cấp cứu', 'Còn tuần hoàn khi tới khoa cấp cứu']));
    expect((await bv('POST', '/api/registry/walk-in', { registry: 'utstein', hospitalRecordNo: 'CR-1' })).http).toBe(409);
    expect((await bvKhac('GET', `/api/registry/cases/${c.id}`)).http).toBe(403);
    // Ca tự đến: bệnh viện sửa được cả phần khi tới viện
    const done = await bv('PUT', `/api/registry/cases/${c.id}`, { diagnosis: 'Ngừng tuần hoàn ngoài viện', firstRhythmEd: 'vf', edRosc: 'co', edOutcome: 'tu_vong_cc' });
    expect(done.status).toBe('du');
    // Ca xe 115 không có phần tu_den
    expect((await dpv('PUT', `/api/registry/cases/${caseId}`, { arrivalMode: 'gia_dinh' })).http).toBe(403);

    const walk = await dpv('GET', '/api/registry/cases?source=tu_den');
    expect(walk.data.map((r: any) => r.id)).toEqual([c.id]);
    expect((await dpv('GET', '/api/registry/cases?source=xe_115')).data.every((r: any) => r.source === 'xe_115')).toBe(true);
    expect((await bv('GET', '/api/registry/cases')).data.map((r: any) => r.source).sort()).toEqual(['tu_den', 'xe_115', 'xe_115']);
    const r = await app.inject({ method: 'GET', url: '/api/registry/export?registry=utstein', headers: { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'qlcl', password: testPassword } })).json().token}` } });
    expect(r.body).toContain('Tự đến');
    expect(r.body).toContain('gia_dinh');
    expect(r.body).not.toContain('CR-1');
  });

  it('thống kê ca theo bệnh viện, người nhập; đặt đơn giá; đánh dấu đã trả mỗi ca một lần', async () => {
    expect((await crew('GET', '/api/registry/contributors')).http).toBe(403);
    let s = await qa('GET', '/api/registry/contributors?registry=utstein');
    const row = s.data.find((x: any) => x.source === 'tu_den');
    expect(row).toMatchObject({ hospital_id: hospitalId, full_name: 'BS Cấp cứu Chợ Rẫy', total: 1, complete: 1, unpaid: 1, rate: null, due: null });
    // Chưa đặt đơn giá: không đánh dấu trả được ca nào
    expect((await admin('POST', '/api/registry/payouts', { registry: 'utstein' })).cases).toBe(0);
    expect((await qa('POST', '/api/registry/payouts', {})).http).toBe(403);
    expect((await admin('PUT', '/api/registry/settings/utstein', { enabled: true, rateWalkIn: 200000, rateEms: 100000 })).http).toBe(200);
    // Sửa cài đặt mà không gửi đơn giá thì giữ nguyên
    expect((await admin('PUT', '/api/registry/settings/utstein', { enabled: true })).rate_walk_in).toBe('200000');
    s = await qa('GET', '/api/registry/contributors?registry=utstein');
    expect(s.data.find((x: any) => x.source === 'tu_den')).toMatchObject({ rate: 200000, due: 200000 });
    // Bệnh viện chỉ thấy số của bệnh viện mình
    expect((await bvKhac('GET', '/api/registry/contributors')).data).toHaveLength(0);
    expect((await bv('GET', '/api/registry/contributors')).data.length).toBeGreaterThan(0);
    expect(await admin('POST', '/api/registry/payouts', { registry: 'utstein' })).toMatchObject({ cases: 1, total: 200000 });
    expect((await admin('POST', '/api/registry/payouts', { registry: 'utstein' })).cases).toBe(0);
    expect((await qa('GET', '/api/registry/contributors?registry=utstein&source=tu_den')).data[0]).toMatchObject({ paid: 1, unpaid: 0, paid_amount: 200000, due: 0 });
    const id = (await bv('GET', '/api/registry/cases?source=tu_den')).data[0].id;
    expect((await bv('PUT', `/api/registry/cases/${id}`, { diagnosis: null })).http).toBe(409);
    const csv = await app.inject({ method: 'GET', url: '/api/registry/contributors?format=csv', headers: { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'qlcl', password: testPassword } })).json().token}` } });
    expect(csv.body).toContain('BS Cấp cứu Chợ Rẫy');
  });

  it('nhật ký không ghi token trong đường dẫn', () => {
    expect(redactUrl('/ws?token=bimat.123')).toBe('/ws?token=***');
    expect(redactUrl('/api/x?a=1&token=abc&b=2')).toBe('/api/x?a=1&token=***&b=2');
  });
});
