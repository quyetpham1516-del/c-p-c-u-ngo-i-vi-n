import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { DOMAIN, dueOn, periodRange, unitMetrics } from '../src/org.js';
import { freshApp, login } from './helpers.js';

describe('kỳ báo cáo', () => {
  it('tuần từ thứ Hai đến Chủ nhật; tháng đủ ngày; hạn nộp', () => {
    expect(periodRange('tuan', '2026-10-25')).toEqual({ start: '2026-10-19', end: '2026-10-25' });
    expect(periodRange('tuan', '2026-10-19')).toEqual({ start: '2026-10-19', end: '2026-10-25' });
    expect(periodRange('thang', '2024-02-10')).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    expect(periodRange('ngay', '2026-10-25')).toEqual({ start: '2026-10-25', end: '2026-10-25' });
    expect(dueOn('tuan', '2026-10-25')).toBe('2026-10-27');
    expect(dueOn('thang', '2026-10-31')).toBe('2026-11-05');
  });
});

describe('trưởng nhóm và báo cáo theo cấp', () => {
  let app: FastifyInstance; let pool: pg.Pool;
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  let units: any[] = [];
  const unit = (code: string) => units.find((u) => u.code === code);
  const staffOf = (code: string, name: string) => unit(code).members.find((m: any) => m.full_name === name).staff_id;

  beforeAll(async () => {
    ({ app, pool } = await freshApp());
    const hr = await login(app, 'nhansu');
    units = (await hr('GET', '/api/org/units')).data;
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  it('sơ đồ mặc định: nhân viên xếp theo vai trò, Ban Giám đốc là trưởng nhóm của mình', () => {
    expect(unit('BGD').parent_id).toBeNull();
    expect(unit('EOC-DP').parent_id).toBe(unit('EOC').id);
    expect(unit('EOC-DP').members.map((m: any) => m.full_name)).toContain('Điều phối viên 6');
    expect(unit('EOC-TN').members).toHaveLength(5);
    expect(unit('BGD').members.find((m: any) => m.full_name === 'Ban Giám đốc').is_lead).toBe(true);
  });

  it('số liệu tự lấy chạy được cho mọi loại bộ phận', async () => {
    for (const domain of Object.keys(DOMAIN)) {
      const m = await unitMetrics(pool, { id: unit('BGD').id, domain, station_id: domain === 'kho' ? 'TR-01' : null }, '2026-10-01', '2026-10-31');
      expect(m.thanh_vien, domain).toBe(1);
    }
    const kho = await unitMetrics(pool, { id: unit('HC-KHO').id, domain: 'kho', station_id: null }, today, today);
    expect(kho.lo_da_het_han).toBe(0);
  });

  it('chỉ quản trị, Ban Giám đốc, nhân sự sửa sơ đồ; không tạo vòng lặp cấp trên', async () => {
    const hr = await login(app, 'nhansu');
    const dpv = await login(app, 'dpv06');
    expect((await dpv('POST', '/api/org/units', { code: 'X', name: 'Nhóm X', parentId: null, domain: 'khac' })).http).toBe(403);
    const c = await hr('POST', '/api/org/units', { code: 'cm-tr01', name: 'Kíp trạm 1', parentId: unit('CM').id, domain: 'kip', stationId: 'TR-01' });
    expect(c.http).toBe(200);
    expect(c.code).toBe('CM-TR01');
    expect((await hr('PATCH', `/api/org/units/${unit('CM').id}`, { parentId: c.id })).http).toBe(422);
    expect((await hr('PATCH', `/api/org/units/${unit('CM').id}`, { active: false })).http).toBe(409);
    expect((await hr('PATCH', `/api/org/units/${c.id}`, { name: 'Kíp trạm số 1' })).name).toBe('Kíp trạm số 1');
    expect((await hr('PUT', `/api/org/units/${c.id}/members/${staffOf('CM', 'BS Kíp ALS')}`, { isLead: true })).http).toBe(200);
    expect((await hr('DELETE', `/api/org/units/${c.id}/members/${staffOf('CM', 'BS Kíp ALS')}`)).http).toBe(200);
    expect((await hr('PATCH', `/api/org/units/${c.id}`, { active: false })).active).toBe(false);
  });

  it('trưởng nhóm lập, nộp; cấp trên trả lại, duyệt; tổng hợp lên Ban Giám đốc', async () => {
    const hr = await login(app, 'nhansu');
    await hr('PUT', `/api/org/units/${unit('EOC-DP').id}/members/${staffOf('EOC-DP', 'Điều phối viên 6')}`, { isLead: true });
    await hr('PUT', `/api/org/units/${unit('EOC').id}/members/${staffOf('EOC', 'Trưởng ca EOC')}`, { isLead: true });

    const lead = await login(app, 'dpv06');
    const member = await login(app, 'dpv07');
    const boss = await login(app, 'truongca');
    const gd = await login(app, 'giamdoc');

    expect((await lead('GET', '/api/org/me')).leadUnits.map((u: any) => u.code)).toEqual(['EOC-DP']);
    expect((await member('GET', '/api/org/me')).hasReports).toBe(false);
    expect((await member('POST', '/api/org/reports', { unitId: unit('EOC-DP').id, period: 'tuan', date: today })).http).toBe(403);

    const r = await lead('POST', '/api/org/reports', { unitId: unit('EOC-DP').id, period: 'tuan', date: today });
    expect(r.http).toBe(200);
    expect(r.status).toBe('nhap');
    expect(r.metrics.thanh_vien).toBe(5);
    expect(r.metrics).toHaveProperty('so_ca');
    expect(r.canEdit).toBe(true);
    // Mở lại cùng kỳ trả về đúng báo cáo đó
    expect((await lead('POST', '/api/org/reports', { unitId: unit('EOC-DP').id, period: 'tuan', date: today })).id).toBe(r.id);
    expect((await member('GET', `/api/org/reports/${r.id}`)).http).toBe(403);

    expect((await lead('POST', `/api/org/reports/${r.id}/submit`)).http).toBe(422);
    await lead('PUT', `/api/org/reports/${r.id}`, { summary: 'Tuần ổn định, không có ca chậm giao xe', issues: 'Thiếu một điều phối viên ca đêm' });
    const s = await lead('POST', `/api/org/reports/${r.id}/submit`);
    expect(s.status).toBe('da_nop');
    expect(s.canEdit).toBe(false);
    expect((await lead('PUT', `/api/org/reports/${r.id}`, { summary: 'sửa sau khi nộp' })).http).toBe(409);
    expect((await lead('POST', `/api/org/reports/${r.id}/review`, { decision: 'duyet' })).http).toBe(403);
    expect((await member('POST', `/api/org/reports/${r.id}/review`, { decision: 'duyet' })).http).toBe(403);

    const dash = await boss('GET', '/api/org/dashboard?period=tuan');
    expect(dash.units.map((u: any) => u.code)).toEqual(expect.arrayContaining(['EOC', 'EOC-TN', 'EOC-DP']));
    expect(dash.units.find((u: any) => u.code === 'BGD')).toBeUndefined();
    expect(dash.units.find((u: any) => u.code === 'EOC-DP').status).toBe('da_nop');
    expect(dash.units.find((u: any) => u.code === 'EOC-TN').status).toBe('chua_lam');

    const seen = await boss('GET', `/api/org/reports/${r.id}`);
    expect(seen.canReview).toBe(true);
    expect((await boss('POST', `/api/org/reports/${r.id}/review`, { decision: 'tra_lai' })).http).toBe(400);
    expect((await boss('POST', `/api/org/reports/${r.id}/review`, { decision: 'tra_lai', note: 'Bổ sung số ca chậm' })).status).toBe('tra_lai');
    await lead('PUT', `/api/org/reports/${r.id}`, { summary: 'Tuần ổn định; 0 ca giao xe quá 2 phút', issues: 'Thiếu một điều phối viên ca đêm' });
    await lead('POST', `/api/org/reports/${r.id}/submit`);
    const ok = await boss('POST', `/api/org/reports/${r.id}/review`, { decision: 'duyet' });
    expect(ok.status).toBe('da_duyet');
    expect(ok.events.map((e: any) => e.action)).toEqual(['tao', 'nop', 'tra_lai', 'nop', 'duyet']);

    // Trưởng EOC lập báo cáo của mình, kèm tóm tắt nhóm con
    const up = await boss('POST', '/api/org/reports', { unitId: unit('EOC').id, period: 'tuan', date: today });
    const dp = up.children.find((c: any) => c.code === 'EOC-DP');
    expect(dp.status).toBe('da_duyet');
    expect(dp.summary).toContain('0 ca giao xe');
    expect(up.children.find((c: any) => c.code === 'EOC-TN').status).toBe('chua_lam');
    await boss('PUT', `/api/org/reports/${up.id}`, { summary: 'EOC tuần này: nhóm điều phối đạt, nhóm tiếp nhận chưa nộp' });
    expect((await boss('POST', `/api/org/reports/${up.id}/submit`)).status).toBe('da_nop');
    expect((await lead('GET', `/api/org/reports/${up.id}`)).http).toBe(403);
    expect((await gd('POST', `/api/org/reports/${up.id}/review`, { decision: 'duyet' })).status).toBe('da_duyet');

    // Ban Giám đốc là cấp cao nhất: nộp là hoàn tất
    const top = await gd('POST', '/api/org/reports', { unitId: unit('BGD').id, period: 'tuan', date: today });
    expect(top.children.find((c: any) => c.code === 'EOC').summary).toContain('nhóm điều phối đạt');
    await gd('PUT', `/api/org/reports/${top.id}`, { summary: 'Tổng hợp tuần toàn trung tâm' });
    expect((await gd('POST', `/api/org/reports/${top.id}/submit`)).status).toBe('da_duyet');
    expect((await gd('GET', '/api/org/dashboard?period=tuan')).units.length).toBeGreaterThan(10);

    const trail = await pool.query(`SELECT action FROM audit_events WHERE action LIKE 'org.%' ORDER BY id`);
    expect(trail.rows.map((x) => x.action)).toEqual(expect.arrayContaining(['org.lead_set', 'org.report_submitted', 'org.report_returned', 'org.report_approved']));
  });
});
