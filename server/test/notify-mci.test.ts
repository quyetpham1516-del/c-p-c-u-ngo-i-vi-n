import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance; let pool: pg.Pool;
let crew: Client, dpv: Client, ct: Client, tc: Client, duoc: Client;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [crew, dpv, ct, tc, duoc] = await Promise.all(['bs.als', 'dpv06', 'dpv01', 'truongca', 'duoc'].map((u) => login(app, u)));
  await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Bác sĩ' });
}, 60000);
afterAll(async () => { await app.close(); await pool.end(); });

describe('báo nhanh hiện trường nhiều nạn nhân', () => {
  it('báo lần đầu kích hoạt đông nạn nhân, ghi chỉ huy hiện trường, điều phối nhận thông báo; nhiều ca nặng thì nâng mức', async () => {
    const inc = await ct('POST', '/api/incidents', { source: '1800', callerPhone: '0900000111' });
    expect((await ct('POST', `/api/ops/mci/${inc.id}/scene-report`, { red: 1, yellow: 1, green: 6, black: 0, commanderPresent: true })).http).toBe(400);
    const r = await ct('POST', `/api/ops/mci/${inc.id}/scene-report`, {
      red: 1, yellow: 2, green: 6, black: 0, commanderPresent: true, commanderName: 'Thiếu tá Nguyễn Văn An', commanderUnit: 'CSGT', commanderPhone: '0912000111', resourcesNeeded: '2 xe',
    });
    expect(r).toMatchObject({ http: 200, activated: true, level: 1 });
    const board = await tc('GET', `/api/ops/mci/${inc.id}`);
    expect(board.incident.mci_declared_at).toBeTruthy();
    expect(board.incident.mci_roles.chi_huy).toContain('Nguyễn Văn An');
    expect(board.reports[0]).toMatchObject({ red: 1, yellow: 2, green: 6, commander_phone: '0912000111' });

    const n = await dpv('GET', '/api/notifications');
    expect(n.messages[0].title).toContain('Kích hoạt đông nạn nhân');
    expect(n.reminders.some((x: any) => x.key === 'mci')).toBe(true);
    expect(n.urgent).toBe(true);

    const r2 = await dpv('POST', `/api/ops/mci/${inc.id}/scene-report`, { red: 3, yellow: 3, green: 10, black: 1, commanderPresent: false });
    expect(r2).toMatchObject({ activated: false, level: 2 });
    expect((await crew('POST', `/api/ops/mci/${inc.id}/scene-report`, { red: 0, yellow: 0, green: 0, black: 0, commanderPresent: false })).http).toBe(403);

    expect((await dpv('POST', '/api/notifications/read-all')).http).toBe(200);
    expect((await dpv('GET', '/api/notifications')).messages.every((m: any) => m.read_at)).toBe(true);
  });
});

describe('nút chuông nhắc việc', () => {
  it('kíp có phiếu chưa làm bệnh án thì được nhắc; gắn bệnh án xong thì hết nhắc', async () => {
    const inc = await ct('POST', '/api/incidents', { source: '1800', callerPhone: '0900000222' });
    const tid = randomUUID();
    expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId: inc.id, vehicleId: 'MD-ALS-01', baseVersion: 0, epcr: { chiefComplaint: 'Ngã' } })).http).toBe(200);
    let n = await crew('GET', '/api/notifications');
    expect(n.reminders.find((x: any) => x.key === `ba:${tid}`)).toMatchObject({ level: 'red', link: '/kip' });
    const p = await crew('POST', '/api/patients', { idType: 'UNKNOWN', fullName: 'Chưa rõ – Nam', force: true });
    expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId: inc.id, vehicleId: 'MD-ALS-01', patientId: p.id, baseVersion: 1, epcr: { chiefComplaint: 'Ngã' } })).http).toBe(200);
    n = await crew('GET', '/api/notifications');
    expect(n.reminders.some((x: any) => x.key === `ba:${tid}`)).toBe(false);
  });

  it('xe đang ở trạm mà thiếu cơ số thì nhắc kíp bù; dược sĩ thấy xe thiếu cơ số', async () => {
    await pool.query(`UPDATE stock_lots SET qty = 0 WHERE vehicle_id = 'MD-ALS-01' AND drug_id = (SELECT id FROM drugs WHERE name = 'Bơm tiêm 5 ml')`);
    await pool.query(`UPDATE vehicles SET status = 'S1' WHERE id = 'MD-ALS-01'`);
    const n = await crew('GET', '/api/notifications');
    expect(n.reminders.find((x: any) => x.key === 'par:MD-ALS-01')?.title).toMatch(/thiếu \d+ mặt hàng/);
    const d = await duoc('GET', '/api/notifications');
    expect(d.reminders.some((x: any) => x.key === 'stock:vehicles')).toBe(true);
  });
});
