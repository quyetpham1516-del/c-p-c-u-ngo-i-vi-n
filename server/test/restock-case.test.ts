import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance; let pool: pg.Pool;
let crew: Client, dpv: Client;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [crew, dpv] = await Promise.all(['bs.als', 'dpv06'].map((u) => login(app, u)));
  await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Bác sĩ' });
  // Bù đủ cơ số trước để so sánh
  await crew('POST', '/api/stock/vehicle/MD-ALS-01/restock', { witness: 'ĐD Kíp ALS' });
}, 60000);
afterAll(async () => { await app.close(); await pool.end(); });

const onVehicle = async (name: string) => (await crew('GET', '/api/stock/vehicle/MD-ALS-01/par')).items.find((i: any) => i.drug_name === name);

describe('trừ cơ số theo phiếu và danh sách bù sau ca', () => {
  it('ô gõ tên lấy được cả vật tư kèm số trên xe', async () => {
    const all = (await crew('GET', '/api/stock/vehicle/MD-ALS-01?all=1')).data as any[];
    const syringe = all.find((l) => l.drug_name === 'Bơm tiêm 5 ml' && l.place === 'xe');
    expect(syringe).toMatchObject({ kind: 'vat_tu' });
    expect(Number(syringe.qty)).toBeGreaterThan(0);
  });

  it('ký phiếu trừ vật tư trên xe; danh sách bù liệt kê từng thứ; xác nhận bù thì xe đủ lại, hết nhắc', async () => {
    const before = await onVehicle('Bơm tiêm 5 ml');
    const items = (await crew('GET', '/api/items')).data as any[];
    const syr = items.find((i) => i.name === 'Bơm tiêm 5 ml');
    const band = items.find((i) => i.name === 'Băng cá nhân');
    const at = new Date().toISOString();
    const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000333' });
    const patient = await crew('POST', '/api/patients', { idType: 'UNKNOWN', fullName: 'Chưa rõ – Nữ', force: true });
    const epcr = {
      chiefComplaint: 'Vết thương tay', vitals: [{ at, hr: 88, sbp: 120 }], diagnosis: { text: 'Vết thương phần mềm' }, payer: 'THU_PHI',
      disposition: { type: 'treated_released' },
      supplies: [{ at, name: syr.name, drugId: syr.id, qty: 3 }, { at, name: band.name, drugId: band.id, qty: 2 }],
    };
    const tid = randomUUID();
    expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId: inc.id, vehicleId: 'MD-ALS-01', patientId: patient.id, baseVersion: 0, epcr })).http).toBe(200);
    expect((await crew('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
    expect((await onVehicle('Bơm tiêm 5 ml')).on_vehicle).toBe(before.on_vehicle - 3);

    const list = await crew('GET', `/api/transfers/${tid}/restock`);
    expect(list.items.map((i: any) => [i.drug_name, i.used])).toEqual(expect.arrayContaining([['Bơm tiêm 5 ml', 3], ['Băng cá nhân', 2]]));
    expect((await crew('GET', '/api/stock/vehicle/MD-ALS-01/pending-restock')).data.map((r: any) => r.id)).toContain(tid);
    await pool.query(`UPDATE vehicles SET status = 'S1' WHERE id = 'MD-ALS-01'`);
    expect((await crew('GET', '/api/notifications')).reminders.some((r: any) => r.key === `restock:${tid}`)).toBe(true);

    const r = await crew('POST', `/api/transfers/${tid}/restock`, { witness: 'ĐD Kíp ALS' });
    expect(r.http).toBe(200);
    expect((await onVehicle('Bơm tiêm 5 ml')).on_vehicle).toBe(before.on_vehicle);
    expect((await crew('POST', `/api/transfers/${tid}/restock`, {})).http).toBe(409);
    expect((await crew('GET', '/api/notifications')).reminders.some((x: any) => x.key === `restock:${tid}`)).toBe(false);
  });
});
