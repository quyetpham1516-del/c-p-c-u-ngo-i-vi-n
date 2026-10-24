import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;
let dpv: Awaited<ReturnType<typeof login>>;
let crew: Awaited<ReturnType<typeof login>>;
let bls: Awaited<ReturnType<typeof login>>;
let admin: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  dpv = await login(app, 'dpv06');
  crew = await login(app, 'bs.als');
  bls = await login(app, 'ys.bls');
  admin = await login(app, 'admin');
  await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' });
  await bls('POST', '/api/crew/shift', { vehicleId: 'MD-BLS-01', crewRole: 'Trưởng kíp' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

/** Tạo ca đã xác nhận mã ưu tiên tại tọa độ cho trước */
async function confirmedIncident(lat: number, lng: number, priority = 'P2') {
  const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000000' });
  await dpv('PATCH', `/api/incidents/${inc.id}`, { address: 'Hiện trường', lat, lng, callbackPhone: '0900000000' });
  await dpv('PUT', `/api/incidents/${inc.id}/triage`, { answers: { conscious: 'yes', breathing: 'difficult', age_group: 'adult' }, group: 'kho_tho' });
  const c = await dpv('POST', `/api/incidents/${inc.id}/confirm`, { priority, vehicleType: 'ALS', lights: true, overrideReason: 'kiểm thử' });
  expect(c.http).toBe(200);
  return inc.id as string;
}

describe('danh mục bệnh viện và ICD-10', () => {
  it('có sẵn danh sách cơ sở KCB TP.HCM kèm mã KCB và khoa nhận bệnh', async () => {
    const r = await crew('GET', '/api/hospitals');
    expect(r.data.length).toBeGreaterThan(160);
    const tn = r.data.find((h: any) => h.kcb_code === '79025');
    expect(tn.name).toBe('Bệnh viện Thống Nhất');
    expect(tn.departments.map((d: any) => d.name)).toContain('Khoa Cấp cứu');
    expect(r.data.find((h: any) => h.name === 'Bệnh viện Chợ Rẫy')).toBeTruthy();
  });

  it('gõ mã ICD ra tên bệnh, kể cả gõ thiếu dấu chấm hoặc mã có dấu †', async () => {
    expect((await crew('GET', '/api/icd10/I21.9')).name).toMatch(/Nhồi máu cơ tim cấp/);
    expect((await crew('GET', '/api/icd10/i219')).code).toBe('I21.9');
    expect((await crew('GET', '/api/icd10/E10.2')).code).toBe('E10.2†');
    expect((await crew('GET', '/api/icd10/Z99.99')).http).toBe(404);
    const s = await crew('GET', `/api/icd10?q=${encodeURIComponent('sốc tim')}`);
    expect(s.data.map((x: any) => x.code)).toContain('R57.0');
    expect((await crew('GET', '/api/icd10-stats')).total).toBeGreaterThan(12000);
  });
});

describe('giao xe: chỉ xe rảnh, tự báo xe gần nhất trong 5 km', () => {
  let nearId = '';

  it('ca gần trạm => tự giao xe ALS gần nhất, xe chuyển S3 (máy tính bảng của kíp đổ chuông)', async () => {
    nearId = await confirmedIncident(10.78, 106.70, 'P1');
    const r = await dpv('POST', `/api/incidents/${nearId}/auto-assign`, {});
    expect(r.assigned).toBe(true);
    expect(r.candidate.vehicleId).toBe('MD-ALS-01');
    expect(r.distanceKm).toBeLessThanOrEqual(5);
    const cur = await crew('GET', '/api/crew/current');
    expect(cur.incident.id).toBe(nearId);
    const a = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'assignment.auto'`);
    expect(a.rows[0].n).toBe(1);
  });

  it('xe đang bận thì không giao được nữa', async () => {
    const other = await confirmedIncident(10.781, 106.701);
    const r = await dpv('POST', `/api/incidents/${other}/assign`, { vehicleId: 'MD-ALS-01' });
    expect(r.http).toBe(409);
    expect(r.error).toMatch(/không sẵn sàng/);
  });

  it('xe rảnh gần nhất xa hơn 5 km => không tự giao, trả về xe đề xuất để điều phối xác nhận', async () => {
    const far = await confirmedIncident(10.97, 106.49);
    const r = await dpv('POST', `/api/incidents/${far}/auto-assign`, {});
    expect(r.assigned).toBe(false);
    expect(r.candidate.vehicleId).toBe('MD-BLS-01');
    expect(r.distanceKm).toBeGreaterThan(5);
    const s = await dpv('GET', `/api/incidents/${far}/suggest`);
    expect(s.limitKm).toBe(5);
    expect(s.suggestions[0].far).toBe(true);
    const noConfirm = await dpv('POST', `/api/incidents/${far}/assign`, { vehicleId: 'MD-BLS-01' });
    expect(noConfirm.http).toBe(409);
    expect(noConfirm.details.code).toBe('FAR');
    const ok = await dpv('POST', `/api/incidents/${far}/assign`, { vehicleId: 'MD-BLS-01', confirmFar: true });
    expect(ok.http).toBe(200);
  });

  it('hết xe rảnh phù hợp => báo không còn xe', async () => {
    const id = await confirmedIncident(10.79, 106.71);
    const r = await dpv('POST', `/api/incidents/${id}/auto-assign`, {});
    expect(r.http).toBe(409);
    expect(r.details.code).toBe('NO_VEHICLE');
  });

  it('báo trước bệnh viện lưu cả khoa nhận bệnh cho phiếu chuyển viện', async () => {
    await dpv('POST', `/api/incidents/${nearId}/prealert`, { hospital: 'Bệnh viện Chợ Rẫy', department: 'Khoa Cấp cứu' });
    const cur = await crew('GET', '/api/crew/current');
    expect(cur.incident.destination).toBe('Bệnh viện Chợ Rẫy');
    expect(cur.incident.destinationDepartment).toBe('Khoa Cấp cứu');
  });

  it('kho thuốc: xe thấy lô của trạm theo hạn dùng sớm trước; ký phiếu thì trừ kho đúng lô', async () => {
    const before = await crew('GET', '/api/stock/vehicle/MD-ALS-01');
    const adr = before.data.find((l: any) => /Adrenalin/i.test(l.drug_name));
    expect(adr.lot).toMatch(/^MAU-TS-/);
    const soon = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    expect((await crew('POST', '/api/stock/receive', { stationId: 'TS', drugId: adr.drug_id, lot: 'L1', expiry: soon, qty: 3 })).http).toBe(403);
    const lot = await admin('POST', '/api/stock/receive', { stationId: 'TS', drugId: adr.drug_id, lot: 'LO-2026-01', expiry: soon, qty: 3, supplier: 'Kho tổng' });
    expect(lot.http).toBe(200);
    const after = await crew('GET', '/api/stock/vehicle/MD-ALS-01');
    const first = after.data.find((l: any) => l.drug_id === adr.drug_id);
    expect(first.lot).toBe('LO-2026-01');

    const p = await crew('POST', '/api/patients', { idType: 'CCCD', idNumber: '079200000001', fullName: 'Trần Thị Kho', birthYear: 1970, sex: 'F' });
    const tid = randomUUID();
    const at = new Date().toISOString();
    const epcr = {
      chiefComplaint: 'Khó thở', vitals: [{ at, hr: 100 }], diagnosis: { text: 'Sốc tim', icd10: 'R57.0' },
      disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', department: 'Khoa Cấp cứu', receiverName: 'BS Nhận', handoverAt: at },
      payer: 'BHYT',
      medications: [{ at, name: first.drug_name, drugId: first.drug_id, lotId: first.id, lot: first.lot, expiry: first.expiry, qty: 2, dose: '1 mg', route: 'TM' }],
    };
    expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId: nearId, vehicleId: 'MD-ALS-01', patientId: p.id, baseVersion: 0, epcr })).http).toBe(200);
    expect((await crew('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
    const q = await pool.query('SELECT qty FROM stock_lots WHERE id = $1', [first.id]);
    expect(Number(q.rows[0].qty)).toBe(1);

    // Lô chỉ còn 1, phiếu khác dùng 2 => không ký được, kho không đổi
    const t2 = randomUUID();
    await crew('PUT', `/api/transfers/${t2}`, { incidentId: nearId, vehicleId: 'MD-ALS-01', patientId: p.id, baseVersion: 0, epcr });
    const s2 = await crew('POST', `/api/transfers/${t2}/sign`);
    expect(s2.http).toBe(409);
    expect(s2.error).toMatch(/chỉ còn 1/);
    expect(Number((await pool.query('SELECT qty FROM stock_lots WHERE id = $1', [first.id])).rows[0].qty)).toBe(1);
  });
});
