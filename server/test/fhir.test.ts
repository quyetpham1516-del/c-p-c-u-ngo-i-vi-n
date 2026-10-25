import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login, token } from './helpers.js';

let app: FastifyInstance; let pool: pg.Pool;
let tid = '';

/** Mọi tham chiếu trong Bundle phải trỏ tới một fullUrl có trong Bundle */
function refs(o: any, out: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((x) => refs(x, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) k === 'reference' ? out.push(v as string) : refs(v, out);
  return out;
}

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  const crew = await login(app, 'bs.als');
  expect((await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Bác sĩ' })).http).toBe(200);
  const dpv = await login(app, 'dpv06');
  const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000004' });
  const patient = await crew('POST', '/api/patients', { idType: 'CCCD', idNumber: '079300004321', fullName: 'Ngô Văn Bình', birthYear: 1970, sex: 'M' });
  const at = new Date().toISOString();
  const epcr = {
    chiefComplaint: 'Khó thở', sample: { allergy: true, allergies: 'Penicillin' },
    vitals: [{ at, hr: 100, sbp: 150, dbp: 90, spo2: 91, rr: 28, gcs: 15, rhythm: 'Nhịp nhanh xoang' }, { at: '10:05', hr: 92, spo2: 96 }],
    interventions: [{ at, name: 'Thở oxy qua mặt nạ 10 L/phút' }],
    medications: [{ at, name: 'Salbutamol', dose: '5 mg', route: 'Khí dung', lot: 'SB123', expiry: '2027-12' }],
    diagnosis: { text: 'Cơn hen phế quản cấp', icd10: 'J45.9', icdName: 'Hen, không đặc hiệu' }, payer: 'THU_PHI',
    disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', department: 'Khoa Cấp cứu', receiverName: 'BS Nhận', handoverAt: at, distanceKm: 8 },
  };
  tid = randomUUID();
  expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId: inc.id, vehicleId: 'MD-ALS-01', patientId: patient.id, baseVersion: 0, epcr })).http).toBe(200);
  expect((await crew('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('xuất FHIR R4', () => {
  it('Bundle document: Composition đứng đầu, tham chiếu đầy đủ, mã LOINC/ICD-10, số định danh che', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/transfers/${tid}/fhir`, headers: { authorization: `Bearer ${await token(app, 'bs.als')}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/fhir+json');
    expect(res.headers['content-disposition']).toContain('attachment');
    const b = res.json();
    expect(b.resourceType).toBe('Bundle');
    expect(b.type).toBe('document');
    expect(b.entry[0].resource.resourceType).toBe('Composition');
    expect(b.entry[0].resource.status).toBe('final');
    const urls = new Set(b.entry.map((e: any) => e.fullUrl));
    expect(urls.size).toBe(b.entry.length);
    for (const r of refs(b.entry.map((e: any) => e.resource))) expect(urls.has(r), r).toBe(true);
    const of = (type: string) => b.entry.map((e: any) => e.resource).filter((r: any) => r.resourceType === type);

    const [pat] = of('Patient');
    expect(pat.gender).toBe('male');
    expect(pat.birthDate).toBe('1970');
    expect(pat.identifier.find((i: any) => i.system === 'urn:vn:cccd').value).toBe('****4321');
    expect(JSON.stringify(b)).not.toContain('079300004321');

    const codes = of('Observation').flatMap((o: any) => o.code.coding?.map((c: any) => c.code) ?? []);
    expect(codes).toEqual(expect.arrayContaining(['8867-4', '59408-5', '9279-1', '9269-2', '85354-9']));
    const bp = of('Observation').find((o: any) => o.code.coding?.[0].code === '85354-9');
    expect(bp.component.map((c: any) => c.valueQuantity.value)).toEqual([150, 90]);
    // Giờ "10:05" ghi trên phiếu được đổi thành thời điểm đầy đủ theo ngày ca
    expect(of('Observation').some((o: any) => o.effectiveDateTime.endsWith(':05:00.000Z'))).toBe(true);

    const [cond] = of('Condition');
    expect(cond.code.coding[0]).toMatchObject({ system: 'http://hl7.org/fhir/sid/icd-10', code: 'J45.9' });
    expect(of('MedicationAdministration')[0].note[0].text).toContain('SB123');
    expect(of('MedicationAdministration')[0].encounter).toBeUndefined();
    expect(of('Procedure')).toHaveLength(1);
    expect(of('AllergyIntolerance')[0].code.text).toBe('Penicillin');
    const [enc] = of('Encounter');
    expect(enc.class.code).toBe('EMER');
    expect(enc.status).toBe('finished');
    expect(of('Practitioner').length).toBeGreaterThan(0);
    expect(of('Organization').map((o: any) => o.name)).toContain('Bệnh viện Chợ Rẫy');
    // Composition có div XHTML hợp lệ, đã thoát ký tự
    expect(b.entry[0].resource.section.every((s: any) => s.text.div.startsWith('<div xmlns="http://www.w3.org/1999/xhtml">'))).toBe(true);
  });

  it('số định danh đầy đủ chỉ trưởng ca, QLCL, quản trị; mỗi lần xuất ghi nhật ký', async () => {
    const crew = await login(app, 'bs.als');
    expect((await crew('GET', `/api/transfers/${tid}/fhir?nationalId=1`)).http).toBe(403);
    const sup = await login(app, 'truongca');
    const b = await sup('GET', `/api/transfers/${tid}/fhir?nationalId=1`);
    expect(b.http).toBe(200);
    expect(b.entry.find((e: any) => e.resource.resourceType === 'Patient').resource.identifier.some((i: any) => i.value === '079300004321')).toBe(true);
    const log = await pool.query(`SELECT data FROM audit_events WHERE action = 'transfer.fhir_exported' ORDER BY id`);
    expect(log.rows.map((r) => r.data.nationalId)).toEqual([false, true]);
    expect((await (await login(app, 'ketoan'))('GET', `/api/transfers/${tid}/fhir`)).http).toBe(403);
  });
});
