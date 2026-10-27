import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let dpv: Client, crew: Client, admin: Client, sup: Client, duoc: Client, kythuat: Client, ksnk: Client;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [dpv, crew, admin, sup, duoc, kythuat, ksnk] = await Promise.all(
    ['dpv06', 'bs.als', 'admin', 'truongca', 'duoc', 'kythuat', 'ksnk'].map((u) => login(app, u)));
  await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function confirmedIncident(lat = 10.78, lng = 106.70) {
  const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000000' });
  await dpv('PATCH', `/api/incidents/${inc.id}`, { address: 'Hiện trường', lat, lng, callbackPhone: '0900000000' });
  await dpv('PUT', `/api/incidents/${inc.id}/triage`, { answers: { conscious: 'yes', breathing: 'difficult', age_group: 'adult' }, group: 'kho_tho' });
  await dpv('POST', `/api/incidents/${inc.id}/confirm`, { priority: 'P1', vehicleType: 'ALS', lights: true, overrideReason: 'kiểm thử' });
  return inc.id as string;
}

let patientId: string | null = null;
async function signTransfer(incidentId: string, meds: any[]) {
  patientId ??= (await crew('POST', '/api/patients', { idType: 'UNKNOWN', fullName: 'Người bệnh kho', birthYear: 1960, sex: 'M' })).id;
  const p = { id: patientId };
  const tid = randomUUID();
  const at = new Date().toISOString();
  const epcr = {
    chiefComplaint: 'Đau ngực', vitals: [{ at, hr: 90 }], diagnosis: { text: 'Đau ngực', icd10: 'R07.4' },
    disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', department: 'Khoa Cấp cứu', receiverName: 'BS Nhận', handoverAt: at },
    payer: 'BHYT', medications: meds.map((m) => ({ at, dose: '1', route: 'TM', ...m })),
  };
  const put = await crew('PUT', `/api/transfers/${tid}`, { incidentId, vehicleId: 'MD-ALS-01', patientId: p.id, baseVersion: 0, epcr });
  expect(put.http).toBe(200);
  return crew('POST', `/api/transfers/${tid}/sign`);
}

describe('cơ số xe, thuốc kiểm soát đặc biệt, phiếu kho duyệt hai cấp', () => {
  let incidentId = '';

  it('xe mẫu đủ cơ số; dùng cho người bệnh thì thiếu, kíp bấm bù cơ số thì đủ lại', async () => {
    const par0 = await crew('GET', '/api/stock/vehicle/MD-ALS-01/par');
    expect(par0.short).toBe(0);
    incidentId = await confirmedIncident();
    expect((await dpv('POST', `/api/incidents/${incidentId}/assign`, { vehicleId: 'MD-ALS-01' })).http).toBe(200);
    const lots = (await crew('GET', '/api/stock/vehicle/MD-ALS-01')).data;
    const asp = lots.find((l: any) => /Aspirin/.test(l.drug_name) && l.place === 'xe');
    expect((await signTransfer(incidentId, [{ name: asp.drug_name, drugId: asp.drug_id, lotId: asp.id, lot: asp.lot, expiry: asp.expiry, qty: 4 }])).http).toBe(200);
    const par1 = await crew('GET', '/api/stock/vehicle/MD-ALS-01/par');
    expect(par1.items.find((i: any) => /Aspirin/.test(i.drug_name)).missing).toBe(4);
    const r = await crew('POST', '/api/stock/vehicle/MD-ALS-01/restock', {});
    expect(r.http).toBe(200);
    expect(r.voucher.code).toMatch(/^CX-/);
    expect((await crew('GET', '/api/stock/vehicle/MD-ALS-01/par')).short).toBe(0);
  });

  it('thuốc gây nghiện dùng cho người bệnh phải có người chứng kiến mới ký được phiếu', async () => {
    const lots = (await crew('GET', '/api/stock/vehicle/MD-ALS-01')).data;
    const mor = lots.find((l: any) => /Morphin/.test(l.drug_name) && l.place === 'xe');
    expect(mor.controlled).toBe(true);
    const med = { name: mor.drug_name, drugId: mor.drug_id, lotId: mor.id, lot: mor.lot, expiry: mor.expiry, qty: 1 };
    const no = await signTransfer(incidentId, [med]);
    expect(no.http).toBe(409);
    expect(no.error).toMatch(/người chứng kiến/);
    expect((await signTransfer(incidentId, [{ ...med, witness: 'ĐD Kíp ALS' }])).http).toBe(200);
  });

  it('kiểm kê lệch sổ phải chờ người khác duyệt; người lập không tự duyệt', async () => {
    const lot = (await sup('GET', '/api/stock?stationId=TR-01')).data.find((l: any) => /Furosemid/.test(l.drug_name));
    const book = Number(lot.qty);
    const v = await sup('POST', '/api/stock/stocktake', { stationId: 'TR-01', lines: [{ lotId: lot.id, counted: book - 2 }] });
    expect(v.status).toBe('cho_duyet');
    expect((await sup('POST', `/api/stock/vouchers/${v.id}/decide`, { approve: true })).http).toBe(403);
    expect((await duoc('POST', `/api/stock/vouchers/${v.id}/decide`, { approve: true })).http).toBe(403);
    expect((await admin('POST', `/api/stock/vouchers/${v.id}/decide`, { approve: true })).http).toBe(200);
    const after = (await sup('GET', '/api/stock?stationId=TR-01')).data.find((l: any) => l.id === lot.id);
    expect(Number(after.qty)).toBe(book - 2);
    const ok = await sup('POST', '/api/stock/stocktake', { stationId: 'TR-01', lines: [{ lotId: lot.id, counted: book - 2 }] });
    expect(ok.status).toBe('da_duyet');
  });

  it('hủy thuốc chờ duyệt rồi mới trừ kho; điều chuyển giữa điểm chuyển đúng lô', async () => {
    const lot = (await duoc('GET', '/api/stock?stationId=TR-02')).data.find((l: any) => /Oxytocin/.test(l.drug_name));
    const book = Number(lot.qty);
    const h = await duoc('POST', '/api/stock/disposal', { stationId: 'TR-02', lines: [{ lotId: lot.id, qty: 3 }], note: 'Vỡ ống khi vận chuyển' });
    expect(h.status).toBe('cho_duyet');
    expect(Number((await one('SELECT qty FROM stock_lots WHERE id = $1', [lot.id])).qty)).toBe(book);
    expect((await sup('POST', `/api/stock/vouchers/${h.id}/decide`, { approve: true })).http).toBe(200);
    expect(Number((await one('SELECT qty FROM stock_lots WHERE id = $1', [lot.id])).qty)).toBe(book - 3);

    const t = await duoc('POST', '/api/stock/transfer', { fromStation: 'TR-02', toStation: 'TR-01', lines: [{ lotId: lot.id, qty: 5 }] });
    expect(t.code).toMatch(/^DC-/);
    const dst = await one(`SELECT qty FROM stock_lots WHERE station_id = 'TR-01' AND vehicle_id IS NULL AND lot = $1`, [lot.lot]);
    expect(Number(dst.qty)).toBe(5);
    const mor = (await duoc('GET', '/api/stock?stationId=TR-02')).data.find((l: any) => /Morphin/.test(l.drug_name));
    expect((await duoc('POST', '/api/stock/transfer', { fromStation: 'TR-02', toStation: 'TR-01', lines: [{ lotId: mor.id, qty: 1 }] })).http).toBe(409);
  });

  it('không nhập lô đã hết hạn; cảnh báo lô sắp hết hạn và kho dưới định mức', async () => {
    const drugs = (await duoc('GET', '/api/drugs')).data;
    const nalo = drugs.find((d: any) => /Naloxon/.test(d.name));
    expect((await duoc('POST', '/api/stock/receive', { stationId: 'TR-01', drugId: nalo.id, lot: 'CU', expiry: '2020-01-01', qty: 1 })).http).toBe(409);
    const soon = new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 10);
    await duoc('POST', '/api/stock/receive', { stationId: 'TR-01', drugId: nalo.id, lot: 'SAP-HET', expiry: soon, qty: 2 });
    await duoc('PUT', '/api/stock/minimums', { stationId: 'TR-01', drugId: nalo.id, minQty: 500 });
    const a = await duoc('GET', '/api/stock/alerts?stationId=TR-01');
    expect(a.expiring.some((l: any) => l.lot === 'SAP-HET')).toBe(true);
    expect(a.belowMin.some((x: any) => x.drug_id === nalo.id)).toBe(true);
    const o = (await duoc('GET', '/api/stock/order-suggestion?stationId=TR-01')).data;
    expect(o.find((x: any) => x.drug_id === nalo.id).order).toBeGreaterThan(0);
  });
});

describe('thiết bị bắt buộc chặn giao xe; dụng cụ tiệt khuẩn', () => {
  it('máy sốc điện trên xe hỏng => xe không được gợi ý, điều phối không giao được, trưởng ca cho đi phải ghi lý do', async () => {
    // xe vừa xong ca ở trên: đưa về sẵn sàng
    await crew('POST', '/api/vehicles/MD-ALS-01/status', { status: 'S1' });
    const eq = (await crew('GET', '/api/equipment?vehicleId=MD-ALS-01')).data.find((e: any) => /sốc điện/.test(e.type_name));
    expect((await crew('POST', `/api/equipment/${eq.id}/events`, { kind: 'kiem_dinh', certNo: 'X' })).http).toBe(403);
    expect((await crew('POST', `/api/equipment/${eq.id}/events`, { kind: 'bao_hong', note: 'Không sạc được pin' })).http).toBe(200);

    const id = await confirmedIncident();
    const s = await dpv('GET', `/api/incidents/${id}/suggest`);
    expect(s.suggestions.some((x: any) => x.vehicleId === 'MD-ALS-01')).toBe(false);
    expect(s.advice.join(' ')).toMatch(/MD-ALS-01 rảnh nhưng không được gợi ý/);
    const board = await dpv('GET', '/api/board');
    expect(board.vehicles.find((v: any) => v.id === 'MD-ALS-01').equipment_gaps).toMatch(/sốc điện/);

    const no = await dpv('POST', `/api/incidents/${id}/assign`, { vehicleId: 'MD-ALS-01' });
    expect(no.http).toBe(409);
    expect(no.details.code).toBe('EQUIPMENT');
    expect((await dpv('POST', `/api/incidents/${id}/assign`, { vehicleId: 'MD-ALS-01', equipmentOverride: 'gấp' })).http).toBe(403);
    expect((await sup('POST', `/api/incidents/${id}/assign`, { vehicleId: 'MD-ALS-01', equipmentOverride: 'Mang AED dự phòng từ trạm' })).http).toBe(200);
    const a = await one(`SELECT data FROM audit_events WHERE action = 'assignment.created' AND entity_id = 'MD-ALS-01' ORDER BY id DESC LIMIT 1`);
    expect(a.data.equipmentOverride.reason).toMatch(/AED dự phòng/);
  });

  it('kỹ thuật sửa xong, kiểm định phải có số giấy chứng nhận; quá hạn kiểm định cũng chặn xe', async () => {
    const eq = (await kythuat('GET', '/api/equipment?vehicleId=MD-ALS-01')).data.find((e: any) => /sốc điện/.test(e.type_name));
    expect((await kythuat('POST', `/api/equipment/${eq.id}/events`, { kind: 'sua_xong', note: 'Thay pin' })).http).toBe(200);
    expect((await kythuat('POST', `/api/equipment/${eq.id}/events`, { kind: 'kiem_dinh' })).http).toBe(400);
    const r = await kythuat('POST', `/api/equipment/${eq.id}/events`, { kind: 'kiem_dinh', certNo: 'KĐ-001', nextDue: '2020-01-01' });
    expect(r.http).toBe(200);
    let ready = (await kythuat('GET', '/api/equipment/readiness')).data.find((v: any) => v.id === 'MD-ALS-01');
    expect(ready.ok).toBe(false);
    expect(ready.gaps[0].issues.join()).toMatch(/quá hạn kiểm định/);
    const due = (await kythuat('GET', '/api/equipment/due?days=0')).data;
    expect(due.some((d: any) => d.id === eq.id && d.kind === 'kiem_dinh')).toBe(true);
    const ok = await kythuat('POST', `/api/equipment/${eq.id}/events`, { kind: 'kiem_dinh', certNo: 'KĐ-002' });
    expect(ok.next_inspection > new Date().toISOString().slice(0, 10)).toBe(true);
    ready = (await kythuat('GET', '/api/equipment/readiness')).data.find((v: any) => v.id === 'MD-ALS-01');
    expect(ready.ok).toBe(true);
    const ev = (await kythuat('GET', `/api/equipment/${eq.id}/events`)).data.map((e: any) => e.kind);
    expect(ev).toEqual(expect.arrayContaining(['bao_hong', 'sua_xong', 'kiem_dinh']));
  });

  it('bộ dụng cụ: kíp báo đã dùng → lô hấp không đạt quay lại chờ → lô đạt thì sẵn sàng, có hạn vô khuẩn', async () => {
    const set = (await crew('GET', '/api/instrument-sets?vehicleId=MD-ALS-01')).data.find((s: any) => s.code === 'NKQ-MD-ALS-01');
    expect((await crew('POST', `/api/instrument-sets/${set.id}/used`, {})).http).toBe(200);
    expect((await crew('POST', `/api/instrument-sets/${set.id}/used`, {})).http).toBe(409);
    const b1 = await ksnk('POST', '/api/sterilization-batches', { method: 'hap_uot', stationId: 'TS', setIds: [set.id] });
    expect(b1.code).toMatch(/^TK-/);
    expect((await ksnk('POST', `/api/sterilization-batches/${b1.id}/finish`, { indicatorOk: false })).passed).toBe(false);
    expect((await one('SELECT status FROM instrument_sets WHERE id = $1', [set.id])).status).toBe('da_dung');
    const b2 = await ksnk('POST', '/api/sterilization-batches', { method: 'hap_uot', stationId: 'TS', setIds: [set.id], shelfDays: 14 });
    expect((await ksnk('POST', `/api/sterilization-batches/${b2.id}/finish`, { indicatorOk: true, biOk: true })).passed).toBe(true);
    const s = await one('SELECT status, cycles, sterile_until FROM instrument_sets WHERE id = $1', [set.id]);
    expect(s.status).toBe('san_sang');
    expect(s.cycles).toBe(2);
    expect(s.sterile_until > new Date().toISOString().slice(0, 10)).toBe(true);
  });
});

describe('tìm ICD không dấu, tài khoản cho các vai trò mới', () => {
  it('gõ không dấu vẫn ra tên bệnh', async () => {
    const r = (await crew('GET', `/api/icd10?q=${encodeURIComponent('nhoi mau co tim cap')}`)).data;
    expect(r.map((x: any) => x.code)).toContain('I21.9');
  });

  it('admin tạo tài khoản dược sĩ, khóa tài khoản; người khác không tạo được', async () => {
    const u = await admin('POST', '/api/users', { username: 'duoc2', fullName: 'Dược sĩ 2', role: 'pharmacist', cccd: '079200000003', password: 'mat-khau-dai-du-10' });
    expect(u.http).toBe(200);
    expect((await sup('POST', '/api/users', { username: 'x1', fullName: 'X', role: 'admin', password: 'mat-khau-dai-du-10' })).http).toBe(403);
    expect((await admin('POST', '/api/users', { username: 'duoc2', fullName: 'Trùng', role: 'pharmacist', cccd: '079200000004', password: 'mat-khau-dai-du-10' })).http).toBe(409);
    const login1 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'duoc2', password: 'mat-khau-dai-du-10' } });
    expect(login1.statusCode).toBe(200);
    expect((await admin('PATCH', `/api/users/${u.id}`, { active: false })).http).toBe(200);
    const login2 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'duoc2', password: 'mat-khau-dai-du-10' } });
    expect(login2.statusCode).toBe(401);
  });
});

async function one(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows[0];
}
