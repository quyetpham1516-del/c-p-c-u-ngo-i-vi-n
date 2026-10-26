import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance; let pool: pg.Pool;
let crew: Client, dpv: Client, admin: Client, duoc: Client;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [crew, dpv, admin, duoc] = await Promise.all(['bs.als', 'dpv06', 'admin', 'duoc'].map((u) => login(app, u)));
  await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Bác sĩ' });
}, 60000);
afterAll(async () => { await app.close(); await pool.end(); });

describe('tự tính tiền sau khi ký phiếu', () => {
  it('admin chỉnh giá dịch vụ; kíp không chỉnh được', async () => {
    const list = await admin('GET', '/api/finance/service-prices');
    const oxy = list.rows.find((r: any) => r.code === 'OXY');
    expect(oxy).toMatchObject({ care_key: 'o2Cannula', price: 50000 });
    expect((await admin('PATCH', `/api/finance/service-prices/${oxy.id}`, { price: 60000 })).http).toBe(200);
    expect((await crew('PATCH', `/api/finance/service-prices/${oxy.id}`, { price: 1 })).http).toBe(403);
    expect((await admin('POST', '/api/finance/service-prices', { code: 'NEP', name: 'Nẹp chân', unit: 'lần', price: 120000, careKey: 'splintLeg' })).http).toBe(200);
    expect((await admin('POST', '/api/finance/service-prices', { code: 'XX', name: 'Sai', unit: 'lần', price: 1, careKey: 'khong_co' })).http).toBe(400);
  });

  it('khoản thu gồm giá vận chuyển theo km, dịch vụ theo can thiệp, cận lâm sàng, vật tư tính riêng; kíp xem được số tiền', async () => {
    const items = (await duoc('GET', '/api/items')).data as any[];
    const cath = items.find((i) => i.name === 'Bơm tiêm 5 ml');
    expect((await duoc('PATCH', `/api/items/${cath.id}`, { billable: true, sellPrice: 5000 })).http).toBe(200);
    const at = new Date().toISOString();
    const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000444' });
    const patient = await crew('POST', '/api/patients', { idType: 'UNKNOWN', fullName: 'Chưa rõ – Nam', force: true });
    const epcr = {
      chiefComplaint: 'Khó thở', vitals: [{ at, hr: 100, sbp: 140 }], diagnosis: { text: 'Suy hô hấp' }, payer: 'THU_PHI',
      care: { o2Cannula: true, splintLeg: true },
      labs: [{ at, type: 'glucose', name: 'Đường huyết', value: '6.1', unit: 'mmol/L' }, { at, type: 'glucose', name: 'Đường huyết', value: '5.8', unit: 'mmol/L' }],
      supplies: [{ at, name: cath.name, drugId: cath.id, qty: 2 }],
      disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', receiverName: 'BS Nhận', handoverAt: at, distanceKm: 15 },
    };
    const tid = randomUUID();
    expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId: inc.id, vehicleId: 'MD-ALS-01', patientId: patient.id, baseVersion: 0, epcr })).http).toBe(200);
    expect((await crew('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
    const c = await crew('GET', `/api/transfers/${tid}/charge`);
    const label = (l: string) => c.lines.find((x: any) => x.label.startsWith(l));
    expect(c.km_source).toBe('khai');
    expect(label('Thở oxy')).toMatchObject({ qty: 1, amount: 60000 });
    expect(label('Nẹp chân')).toMatchObject({ amount: 120000 });
    expect(label('Đo đường huyết')).toMatchObject({ qty: 2, amount: 60000 });
    expect(label('Bơm tiêm 5 ml')).toMatchObject({ qty: 2, amount: 10000 });
    expect(label('Km tiếp theo')).toBeTruthy();
    expect(c.total).toBe(c.lines.reduce((s: number, l: any) => s + l.amount, 0) - c.discount + c.vat);
  });
});
