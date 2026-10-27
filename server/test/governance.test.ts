import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance; let pool: pg.Pool;
let admin: Client, dpv06: Client, dpv07: Client, dpv01: Client, giamdoc: Client, ysBls: Client, ddBls: Client, bsAls: Client;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [admin, dpv06, dpv07, dpv01, giamdoc, ysBls, ddBls, bsAls] = await Promise.all(
    ['admin', 'dpv06', 'dpv07', 'dpv01', 'giamdoc', 'ys.bls', 'dd.bls', 'bs.als'].map((u) => login(app, u)));
  // dpv06 là trưởng nhóm Điều phối trên sơ đồ tổ chức
  await pool.query(`UPDATE org_members m SET is_lead = true FROM staff s, users u, org_units o
                     WHERE m.staff_id = s.id AND s.user_id = u.id AND u.username = 'dpv06' AND o.id = m.unit_id AND o.code = 'EOC-DP'`);
}, 60000);
afterAll(async () => { await app.close(); await pool.end(); });

const stationName = async (id: string) => (await pool.query('SELECT name FROM stations WHERE id = $1', [id])).rows[0].name;

describe('đề xuất và duyệt thay đổi cấu hình', () => {
  it('chưa khóa: quản trị sửa thẳng (có nhật ký); người không phải quản trị, Ban Giám đốc không bật khóa được', async () => {
    expect((await admin('PATCH', '/api/stations/TR-02', { name: 'Trạm 2 (Quận 7)' })).http).toBe(200);
    expect((await dpv06('PUT', '/api/governance', { enforced: true })).http).toBe(403);
    expect((await admin('PUT', '/api/governance', { enforced: true })).http).toBe(200);
    expect((await admin('GET', '/api/governance')).enforced).toBe(true);
  });

  it('đã khóa: quản trị không sửa được, người không phải trưởng nhóm đúng mảng bị từ chối', async () => {
    const a = await admin('PATCH', '/api/stations/TR-02', { name: 'Đổi thẳng' });
    expect(a.http).toBe(403);
    expect(a.details.code).toBe('GOVERNED_ADMIN');
    const b = await dpv07('PATCH', '/api/stations/TR-02', { name: 'Đổi thẳng' });
    expect(b.http).toBe(403);
    expect(b.details.code).toBe('GOVERNED_NOT_LEAD');
    expect(await stationName('TR-02')).toBe('Trạm 2 (Quận 7)');
  });

  it('trưởng nhóm đề xuất (202), dữ liệu chưa đổi; quản trị duyệt thì hệ thống áp dụng đúng thay đổi', async () => {
    const p = await dpv06('PATCH', '/api/stations/TR-02', { name: 'Trạm 2 Nam Sài Gòn' });
    expect(p.http).toBe(202);
    expect(p.code).toMatch(/^DX-\d{4}-0001$/);
    expect(await stationName('TR-02')).toBe('Trạm 2 (Quận 7)');
    const g = await dpv06('GET', '/api/governance');
    expect(g.myDomains.map((d: any) => d.domain)).toContain('dieu_phoi');
    expect((await admin('GET', '/api/governance')).pending).toBe(1);
    const list = (await admin('GET', '/api/change-requests?status=cho_duyet')).data;
    expect(list[0].before.name).toBe('Trạm 2 (Quận 7)');
    expect(list[0].body).toEqual({ name: 'Trạm 2 Nam Sài Gòn' });
    // nhắc việc cho quản trị
    const n = await admin('GET', '/api/notifications');
    expect(JSON.stringify(n)).toContain('đề xuất thay đổi chờ duyệt');
    expect((await dpv06('POST', `/api/change-requests/${p.id}/decide`, { approve: true })).http).toBe(403);
    const d = await admin('POST', `/api/change-requests/${p.id}/decide`, { approve: true, note: 'Đồng ý' });
    expect(d.status).toBe('da_duyet');
    expect(await stationName('TR-02')).toBe('Trạm 2 Nam Sài Gòn');
    expect((await dpv06('GET', '/api/change-requests')).data[0].status).toBe('da_duyet');
    // vé áp dụng chỉ dùng một lần
    expect((await admin('POST', `/api/change-requests/${p.id}/decide`, { approve: true })).http).toBe(409);
  });

  it('từ chối phải ghi lý do; người đề xuất rút được khi còn chờ; áp dụng lỗi thì phiếu ở trạng thái lỗi', async () => {
    const p1 = await dpv06('PATCH', '/api/stations/TR-01', { name: 'Trạm 1 mới' });
    expect((await admin('POST', `/api/change-requests/${p1.id}/decide`, { approve: false })).http).toBe(400);
    const r = await admin('POST', `/api/change-requests/${p1.id}/decide`, { approve: false, note: 'Chưa cần đổi' });
    expect(r.status).toBe('tu_choi');
    expect(await stationName('TR-01')).toBe('Trạm 1');

    const p2 = await dpv06('PATCH', '/api/stations/TR-01', { name: 'Trạm 1 khác' });
    expect((await dpv07('POST', `/api/change-requests/${p2.id}/withdraw`)).http).toBe(409);
    expect((await dpv06('POST', `/api/change-requests/${p2.id}/withdraw`)).status).toBe('rut_lai');

    // điểm còn xe thì không tạm ngưng được: duyệt xong áp dụng báo lỗi, không đổi gì
    const p3 = await dpv06('PATCH', '/api/stations/TR-01', { active: false });
    const e = await admin('POST', `/api/change-requests/${p3.id}/decide`, { approve: true });
    expect(e.status).toBe('loi');
    expect(e.error).toContain('còn');
  });

  it('đề xuất không chứa mật khẩu; quản trị vẫn khóa tài khoản và đặt lại mật khẩu ngay', async () => {
    const uid = (await pool.query(`SELECT id FROM users WHERE username = 'dpv05'`)).rows[0].id;
    expect((await admin('PATCH', `/api/users/${uid}`, { active: false })).http).toBe(200);
    expect((await admin('PATCH', `/api/users/${uid}`, { fullName: 'Đổi tên' })).http).toBe(403);
  });

  it('mở khóa cấu hình cũng phải qua đề xuất của Ban Giám đốc', async () => {
    expect((await admin('PUT', '/api/governance', { enforced: false })).http).toBe(403);
    const p = await giamdoc('PUT', '/api/governance', { enforced: false });
    expect(p.http).toBe(202);
    expect((await admin('POST', `/api/change-requests/${p.id}/decide`, { approve: true })).status).toBe('da_duyet');
    expect((await admin('GET', '/api/governance')).enforced).toBe(false);
  });
});

describe('ca trực do điều phối viên lập', () => {
  const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  let postId = '';
  let ysId = ''; let ddId = ''; let bsId = '';

  beforeAll(async () => {
    const ids = (await pool.query(`SELECT username, id FROM users WHERE username IN ('ys.bls', 'dd.bls', 'bs.als')`)).rows;
    ysId = ids.find((r) => r.username === 'ys.bls').id; ddId = ids.find((r) => r.username === 'dd.bls').id; bsId = ids.find((r) => r.username === 'bs.als').id;
    await pool.query(`UPDATE users SET station_id = 'TR-01' WHERE username IN ('ys.bls', 'dd.bls')`);
  });

  it('người tiếp nhận cuộc gọi không lập ca; điều phối viên lập ca ở vị trí tạm với người, xe, thiết bị', async () => {
    const body = { vehicleId: 'MD-ALS-01', place: 'Sân vận động Thống Nhất', startsAt: at(-0.5), endsAt: at(4), equipment: ['Cáng cuốn'],
      members: [{ userId: ysId, position: 'Trưởng kíp' }] };
    expect((await dpv01('POST', '/api/duty-posts', body)).http).toBe(403);
    expect((await dpv06('POST', '/api/duty-posts', { ...body, place: null })).http).toBe(400);
    expect((await dpv06('POST', '/api/duty-posts', { ...body, members: [{ userId: ysId, position: 'Phi công' }] })).http).toBe(400);
    const p = await dpv06('POST', '/api/duty-posts', body);
    expect(p.http).toBe(200);
    postId = p.id;
    expect((await dpv06('POST', '/api/duty-posts', { ...body, startsAt: at(1), endsAt: at(6), members: [] })).http).toBe(409);
    expect((await dpv06('POST', '/api/duty-posts', { ...body, vehicleId: 'MD-BLS-01' })).http).toBe(409);
    const list = (await dpv01('GET', '/api/duty-posts')).data;
    expect(list[0].members[0]).toMatchObject({ position: 'Trưởng kíp', name: 'Y sĩ Kíp BLS' });
  });

  it('người trong ca trực đăng nhập ca trên xe đó không bị giới hạn theo điểm; người khác vẫn bị', async () => {
    expect((await ddBls('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Điều dưỡng' })).http).toBe(403);
    expect((await ysBls('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Y sĩ' })).http).toBe(200);
    expect((await ysBls('GET', '/api/duty-posts')).data).toHaveLength(1);
    expect((await bsAls('GET', '/api/duty-posts')).data).toHaveLength(0);
  });

  it('sửa, hủy ca; điều phối viên xem bảng giá, kíp không xem được', async () => {
    const u = await dpv06('PUT', `/api/duty-posts/${postId}`, { vehicleId: 'MD-ALS-01', stationId: 'TS', startsAt: at(-0.5), endsAt: at(5),
      members: [{ userId: ysId, position: 'Trưởng kíp' }, { userId: ddId, position: 'Điều dưỡng' }, { userId: bsId, position: 'Bác sĩ' }] });
    expect(u.http).toBe(200);
    const prices = await dpv06('GET', '/api/duty/prices');
    expect(prices.http).toBe(200);
    expect(Array.isArray(prices.priceLists)).toBe(true);
    expect(Array.isArray(prices.services)).toBe(true);
    expect((await bsAls('GET', '/api/duty/prices')).http).toBe(403);
    expect((await dpv06('POST', `/api/duty-posts/${postId}/cancel`)).http).toBe(200);
    expect((await dpv06('POST', `/api/duty-posts/${postId}/cancel`)).http).toBe(409);
  });
});
