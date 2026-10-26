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
  expect((await admin('POST', '/api/users', { username: 'bv.choray', fullName: 'BS Cấp cứu Chợ Rẫy', role: 'hospital', hospitalId, password: testPassword })).http).toBe(200);
  expect((await admin('POST', '/api/users', { username: 'bv.khac', fullName: 'BS Bệnh viện khác', role: 'hospital', hospitalId: otherId, password: testPassword })).http).toBe(200);
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

  it('nhật ký không ghi token trong đường dẫn', () => {
    expect(redactUrl('/ws?token=bimat.123')).toBe('/ws?token=***');
    expect(redactUrl('/api/x?a=1&token=abc&b=2')).toBe('/api/x?a=1&token=***&b=2');
  });
});
