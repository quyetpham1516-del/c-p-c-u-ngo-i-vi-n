import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance; let pool: pg.Pool;
let crew: Client, dpv: Client;
let oldId = '';

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [crew, dpv] = await Promise.all(['bs.als', 'dpv06'].map((u) => login(app, u)));
  await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Bác sĩ' });
  oldId = (await crew('POST', '/api/patients', { idType: 'CCCD', idNumber: '079300001111', fullName: 'Trần Văn Cũ', sex: 'U', phone: '0909 123 456' })).id;
}, 60000);
afterAll(async () => { await app.close(); await pool.end(); });

describe('lập bệnh án từ phiếu chuyển viện', () => {
  it('dò trùng theo CCCD, theo số điện thoại (bỏ khoảng trắng, +84), theo họ tên và năm sinh', async () => {
    const byId = await crew('POST', '/api/patients/match', { idType: 'CCCD', idNumber: '079300001111' });
    expect(byId.matches).toHaveLength(1);
    expect(byId.matches[0]).toMatchObject({ id: oldId, reasons: ['cccd'] });
    expect(byId.matches[0].id_enc).toBeUndefined();
    const byPhone = await crew('POST', '/api/patients/match', { phone: '+84909123456' });
    expect(byPhone.matches[0]).toMatchObject({ id: oldId, reasons: ['phone'] });
    expect((await crew('POST', '/api/patients/match', { phone: '0911000000', idType: 'CCCD', idNumber: '079300002222' })).matches).toHaveLength(0);
  });

  it('ký phiếu thì thông tin trên phiếu vào bệnh án: điền chỗ trống, thêm dị ứng, tiền sử; không ghi đè', async () => {
    const at = new Date().toISOString();
    const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0909123456' });
    const epcr = {
      patient: { fullName: 'Tên khác', birthYear: 1960, sex: 'M', phone: '0909123456' },
      chiefComplaint: 'Đau ngực', vitals: [{ at, hr: 90, sbp: 130 }], diagnosis: { text: 'Đau thắt ngực' }, payer: 'THU_PHI',
      sample: { allergy: true, allergies: 'Penicillin', pastHistory: 'Tăng huyết áp', medications: 'Amlodipin 5 mg' },
      disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', receiverName: 'BS Nhận', handoverAt: at },
    };
    const tid = randomUUID();
    expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId: inc.id, vehicleId: 'MD-ALS-01', patientId: oldId, baseVersion: 0, epcr })).http).toBe(200);
    expect((await crew('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
    const p = await crew('GET', `/api/patients/${oldId}`);
    expect(p.full_name ?? p.patient?.full_name).toBe('Trần Văn Cũ');
    const row = (await pool.query('SELECT birth_year, sex, phone, shared FROM patients WHERE id = $1', [oldId])).rows[0];
    expect(row).toMatchObject({ birth_year: 1960, sex: 'M', phone: '0909 123 456' });
    expect(row.shared).toMatchObject({ allergies: 'Penicillin', history: 'Tăng huyết áp', medications: 'Amlodipin 5 mg' });
  });
});
