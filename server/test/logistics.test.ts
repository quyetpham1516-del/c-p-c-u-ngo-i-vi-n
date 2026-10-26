import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { addMonths, depreciation, monthsBetween, o2Remaining } from '../src/logistics.js';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let duoc: Client, sup: Client, admin: Client, crew: Client, kythuat: Client, ketoan: Client, giamdoc: Client, nhansu: Client, dpv: Client;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [duoc, sup, admin, crew, kythuat, ketoan, giamdoc, nhansu, dpv] = await Promise.all(
    ['duoc', 'truongca', 'admin', 'bs.als', 'kythuat', 'ketoan', 'giamdoc', 'nhansu', 'dpv06'].map((u) => login(app, u)));
}, 60000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

const nextYear = () => `${new Date().getFullYear() + 1}-06-30`;
const month = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);

describe('tính toán thuần', () => {
  it('khấu hao đường thẳng theo tháng tròn, dừng khi hết thời gian hoặc thanh lý', () => {
    expect(monthsBetween('2026-01-15', '2026-03-14')).toBe(1);
    expect(monthsBetween('2026-01-15', '2026-03-15')).toBe(2);
    const a = { cost: 120_000_000, salvage: 0, life_months: 60, acquired_on: '2025-01-01' };
    expect(depreciation(a, '2026-01-01')).toMatchObject({ monthsUsed: 12, monthly: 2_000_000, accumulated: 24_000_000, netBook: 96_000_000 });
    expect(depreciation(a, '2035-01-01')).toMatchObject({ monthsUsed: 60, netBook: 0, fullyDepreciated: true });
    expect(depreciation({ ...a, disposed_on: '2025-07-01' }, '2026-01-01').monthsUsed).toBe(6);
  });
  it('oxy còn lại và ngày cấp lại', () => {
    expect(o2Remaining(10, 150)).toEqual({ liters: 1500, minutes: 100 });
    expect(o2Remaining(10, null).minutes).toBeNull();
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-10-26', 12)).toBe('2027-10-26');
  });
});

describe('mua hàng: đơn đặt hàng, duyệt hai cấp, nhận hàng theo lô', () => {
  let supplierId = '';
  let morphinId = 0;
  let poId = '';

  it('lập đơn, người lập không tự duyệt, nhận hàng không quá số đặt', async () => {
    const s = await duoc('POST', '/api/qms/suppliers', { name: 'Công ty Dược Kiểm Thử', category: 'thuoc_vat_tu' });
    expect(s.http).toBe(200);
    supplierId = s.id;
    const drugs = (await duoc('GET', '/api/drugs')).data as any[];
    morphinId = drugs.find((d) => /^morphin/i.test(d.name)).id;
    const adr = drugs.find((d) => /^adrenalin/i.test(d.name)) ?? drugs.find((d) => !d.controlled);

    const sug = await duoc('GET', '/api/logistics/po/suggest?stationId=TS');
    expect(sug.http).toBe(200);

    const po = await duoc('POST', '/api/logistics/po', {
      stationId: 'TS', supplierId, expectedOn: nextYear(),
      lines: [{ drugId: morphinId, qty: 10, unitPrice: 20000 }, { drugId: adr.id, qty: 20, unitPrice: 5000 }],
    });
    expect(po.http).toBe(200);
    expect(po.code).toMatch(/^DH-\d{4}-00001$/);
    expect(Number(po.total)).toBe(300000);
    poId = po.id;

    expect((await duoc('POST', `/api/logistics/po/${poId}/receive`, { lines: [{ lineId: 1, lot: 'X', expiry: nextYear(), qty: 1 }] })).http).toBe(409);
    expect((await sup('POST', `/api/logistics/po/${poId}/decide`, { approve: false })).http).toBe(400);
    expect((await sup('POST', `/api/logistics/po/${poId}/decide`, { approve: true })).http).toBe(200);

    const detail = await duoc('GET', `/api/logistics/po/${poId}`);
    const mLine = detail.lines.find((l: any) => l.drug_id === morphinId);
    const aLine = detail.lines.find((l: any) => l.drug_id !== morphinId);
    const over = await duoc('POST', `/api/logistics/po/${poId}/receive`, { lines: [{ lineId: mLine.id, lot: 'MOR-01', expiry: nextYear(), qty: 11 }] });
    expect(over.http).toBe(409);

    const r1 = await duoc('POST', `/api/logistics/po/${poId}/receive`, {
      invoiceNo: 'HD-0001', lines: [{ lineId: mLine.id, lot: 'MOR-01', expiry: nextYear(), qty: 10 }, { lineId: aLine.id, lot: 'ADR-01', expiry: nextYear(), qty: 5 }],
    });
    expect(r1.http).toBe(200);
    expect(r1.code).toMatch(/^NK-/);
    expect(r1.orderStatus).toBe('dang_nhan');
    const r2 = await duoc('POST', `/api/logistics/po/${poId}/receive`, { lines: [{ lineId: aLine.id, lot: 'ADR-01', expiry: nextYear(), qty: 15 }] });
    expect(r2.orderStatus).toBe('da_nhan');

    const lots = (await duoc('GET', '/api/stock?stationId=TS&place=kho')).data as any[];
    expect(lots.find((l) => l.lot === 'MOR-01')).toMatchObject({ qty: '10', supplier: 'Công ty Dược Kiểm Thử' });
    expect(Number(lots.find((l) => l.lot === 'ADR-01').qty)).toBe(20);
    const after = await duoc('GET', `/api/logistics/po/${poId}`);
    expect(after.receipts).toHaveLength(2);
  });

  it('đơn từ ngưỡng duyệt chi phải gắn đề xuất chi mua sắm đã duyệt đủ tiền', async () => {
    const big = { stationId: 'TS', supplierId, lines: [{ drugId: morphinId, qty: 500, unitPrice: 20000 }] };
    const no = await duoc('POST', '/api/logistics/po', big);
    expect(no.http).toBe(409);
    expect(no.error ?? no.message).toMatch(/đề xuất chi/);
    const p = await duoc('POST', '/api/finance/proposals', { kind: 'mua_sam', title: 'Mua thuốc quý IV', amount: 12_000_000 });
    expect(p.http).toBe(200);
    expect((await duoc('POST', '/api/logistics/po', { ...big, proposalId: p.id })).http).toBe(409); // chưa duyệt
    await ketoan('POST', `/api/finance/proposals/${p.id}/decide`, { approve: true });
    await giamdoc('POST', `/api/finance/proposals/${p.id}/decide`, { approve: true });
    const ok = await duoc('POST', '/api/logistics/po', { ...big, proposalId: p.id });
    expect(ok.http).toBe(200);
    expect((await duoc('POST', `/api/logistics/po/${ok.id}/cancel`, { note: 'đổi nhà cung cấp' })).http).toBe(200);
    expect((await duoc('POST', `/api/logistics/po/${ok.id}/cancel`, { note: 'lần hai' })).http).toBe(409);
  });

  it('sổ thuốc kiểm soát: tồn đầu kỳ, nhập theo phiếu nhập kho, tồn cuối khớp kho', async () => {
    const r = await duoc('GET', `/api/logistics/controlled-ledger?stationId=TS&month=${month()}`);
    expect(r.http).toBe(200);
    const m = r.drugs.find((d: any) => d.drugId === morphinId);
    expect(m.classLabel).toBe('Gây nghiện');
    expect(m.totalIn).toBe(10);
    expect(m.closing).toBe(m.opening + 10);
    expect(m.opening).toBe(50); // lô mẫu nhập trước khi có sổ
    expect(m.rows[0]).toMatchObject({ kind: 'Nhập kho', in: 10, invoice: 'HD-0001' });
    expect(m.rows[0].document).toMatch(/^NK-/);
    // Không phải thuốc kiểm soát thì không lên sổ
    expect(r.drugs.every((d: any) => d.classLabel !== undefined)).toBe(true);
    expect((await crew('GET', `/api/logistics/controlled-ledger?stationId=TS&month=${month()}`)).http).toBe(403);
  });
});

describe('bình oxy', () => {
  it('nhập bình, gắn xe, đo áp thấp thì cảnh báo, gửi nạp và nhận lại', async () => {
    const c = await kythuat('POST', '/api/logistics/o2', { code: 'O2-0001', sizeL: 10, stationId: 'TS', nextTestOn: nextYear() });
    expect(c.http).toBe(200);
    expect(c.status).toBe('day');
    expect((await kythuat('POST', '/api/logistics/o2', { code: 'O2-0001', sizeL: 10, stationId: 'TS' })).http).toBe(409);

    expect((await crew('POST', `/api/logistics/o2/${c.id}/event`, { kind: 'gan_xe', vehicleId: 'MD-ALS-01' })).http).toBe(200);
    let list = await crew('GET', '/api/logistics/o2?stationId=TS');
    expect(list.alerts.vehiclesWithoutFull).not.toContain('MD-ALS-01');
    expect(list.cylinders[0]).toMatchObject({ vehicle_id: 'MD-ALS-01', liters: 1500, minutes: 100 });

    expect((await crew('POST', `/api/logistics/o2/${c.id}/event`, { kind: 'do_ap', pressureBar: 40 })).http).toBe(200);
    list = await crew('GET', '/api/logistics/o2?stationId=TS');
    expect(list.alerts.low.map((x: any) => x.code)).toContain('O2-0001');
    expect(list.alerts.vehiclesWithoutFull).toContain('MD-ALS-01');

    expect((await crew('POST', `/api/logistics/o2/${c.id}/event`, { kind: 'gui_nap' })).http).toBe(403);
    expect((await kythuat('POST', `/api/logistics/o2/${c.id}/event`, { kind: 'gui_nap' })).status).toBe('gui_nap');
    const back = await kythuat('POST', `/api/logistics/o2/${c.id}/event`, { kind: 'nhan_nap', pressureBar: 150 });
    expect(back).toMatchObject({ status: 'day', vehicle_id: null });
    const ev = await kythuat('GET', `/api/logistics/o2/${c.id}/events`);
    expect(ev.data.map((e: any) => e.kind)).toEqual(['nhan_nap', 'gui_nap', 'do_ap', 'gan_xe', 'nhap']);
  });

  it('bình quá hạn kiểm định không được gắn lên xe', async () => {
    const c = await kythuat('POST', '/api/logistics/o2', { code: 'O2-0002', sizeL: 2, stationId: 'TS', nextTestOn: '2020-01-01' });
    const r = await crew('POST', `/api/logistics/o2/${c.id}/event`, { kind: 'gan_xe', vehicleId: 'MD-ALS-01' });
    expect(r.http).toBe(409);
    const list = await kythuat('GET', '/api/logistics/o2?stationId=TS');
    expect(list.alerts.testDue.map((x: any) => x.code)).toContain('O2-0002');
  });
});

describe('nhiệt độ bảo quản', () => {
  it('ngoài ngưỡng phải ghi xử trí, dược sĩ xem xét, nơi chưa đo bị nhắc', async () => {
    const p = await duoc('POST', '/api/logistics/storage', { name: 'Tủ lạnh thuốc TS', kind: 'tu_lanh', stationId: 'TS' });
    expect(p.http).toBe(200);
    expect(Number(p.min_c)).toBe(2);
    let s = await duoc('GET', '/api/logistics/storage?stationId=TS');
    expect(s.alerts.noRecentReading.map((x: any) => x.name)).toContain('Tủ lạnh thuốc TS');

    expect((await crew('POST', `/api/logistics/storage/${p.id}/readings`, { tempC: 5 })).out_of_range).toBe(false);
    expect((await crew('POST', `/api/logistics/storage/${p.id}/readings`, { tempC: 11 })).http).toBe(409);
    const bad = await crew('POST', `/api/logistics/storage/${p.id}/readings`, { tempC: 11, action: 'Chuyển insulin sang tủ dự phòng, báo kỹ thuật' });
    expect(bad.out_of_range).toBe(true);
    s = await duoc('GET', '/api/logistics/storage?stationId=TS');
    expect(s.alerts.outOfRange).toHaveLength(1);
    expect(s.alerts.noRecentReading).toHaveLength(0);
    expect((await duoc('POST', `/api/logistics/readings/${bad.id}/ack`, { note: 'Đã kiểm tra thuốc, còn dùng được' })).http).toBe(200);
    expect((await duoc('POST', `/api/logistics/readings/${bad.id}/ack`, { note: 'lần hai' })).http).toBe(409);
    s = await duoc('GET', '/api/logistics/storage?stationId=TS');
    expect(s.alerts.outOfRange).toHaveLength(0);
    expect((await dpv('POST', `/api/logistics/storage/${p.id}/readings`, { tempC: 5 })).http).toBe(403);
  });
});

describe('tài sản cố định và đồng phục, bảo hộ', () => {
  it('ghi tăng tài sản, tính khấu hao, thanh lý', async () => {
    const a = await ketoan('POST', '/api/logistics/assets', { name: 'Xe cứu thương 51B-001.01', category: 'xe', vehicleId: 'MD-ALS-01', stationId: 'TS', acquiredOn: '2025-01-01', cost: 1_200_000_000, lifeMonths: 120 });
    expect(a.http).toBe(200);
    expect(a.code).toMatch(/^TS-/);
    const l = await ketoan('GET', '/api/logistics/assets?asOf=2026-01-01');
    expect(l.items[0]).toMatchObject({ monthsUsed: 12, monthly: 10_000_000, accumulated: 120_000_000, netBook: 1_080_000_000 });
    expect(l.totals.netBook).toBe(1_080_000_000);
    expect((await duoc('POST', '/api/logistics/assets', { name: 'X', category: 'khac', acquiredOn: '2025-01-01', cost: 1, lifeMonths: 1 })).http).toBe(403);
    expect((await ketoan('POST', `/api/logistics/assets/${a.id}/dispose`, { disposedOn: '2025-07-01', note: 'Tai nạn, bảo hiểm bồi thường' })).http).toBe(200);
    const after = await ketoan('GET', '/api/logistics/assets?asOf=2026-01-01');
    expect(after.items[0]).toMatchObject({ status: 'thanh_ly', monthsUsed: 6 });
    expect(after.totals.cost).toBe(0);
  });

  it('cấp đồng phục có hạn cấp lại, nhân viên xác nhận đã nhận', async () => {
    const items = (await nhansu('GET', '/api/logistics/ppe/items')).data as any[];
    const uniform = items.find((i) => i.replace_months === 12);
    const userId = (await pool.query(`SELECT id FROM users WHERE username = 'bs.als'`)).rows[0].id;
    const r = await nhansu('POST', '/api/logistics/ppe', { userId, itemId: uniform.id, qty: 2, size: 'L', issuedOn: '2025-11-01' });
    expect(r.http).toBe(200);
    expect(r.due_on).toBe('2026-11-01');
    const due = await nhansu('GET', '/api/logistics/ppe?due=true');
    expect(due.data.some((x: any) => x.id === r.id)).toBe(true);
    const mine = await crew('GET', '/api/logistics/ppe/me');
    expect(mine.data[0]).toMatchObject({ item_name: uniform.name, qty: 2 });
    expect((await crew('POST', `/api/logistics/ppe/${r.id}/confirm`)).http).toBe(200);
    expect((await nhansu('POST', `/api/logistics/ppe/${r.id}/confirm`)).http).toBe(409);
    expect((await crew('POST', '/api/logistics/ppe', { userId, itemId: uniform.id, issuedOn: '2026-01-01' })).http).toBe(403);
    const alerts = await admin('GET', '/api/logistics/alerts');
    expect(alerts.ppeDueSoon).toBeGreaterThanOrEqual(1);
  });
});
