import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login, token } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let duoc: Client, crew: Client;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [duoc, crew] = await Promise.all(['duoc', 'bs.als'].map((u) => login(app, u)));
  await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('danh mục hàng hóa chia nhóm, có vật tư và văn phòng phẩm', () => {
  it('danh mục có nhóm, vật tư từng cỡ bơm tiêm, văn phòng phẩm', async () => {
    const groups = (await duoc('GET', '/api/item-groups')).data as any[];
    expect(groups.map((g) => g.name)).toContain('Văn phòng phẩm – Giấy tờ');
    const items = (await duoc('GET', '/api/items')).data as any[];
    expect(items.find((i) => i.name === 'Bơm tiêm 5 ml')).toMatchObject({ kind: 'vat_tu', group_name: 'Tuần hoàn – Truyền dịch' });
    expect(items.find((i) => i.name === 'Băng cá nhân')).toMatchObject({ track_lot: false });
    expect(items.find((i) => i.name === 'Bút bi')).toMatchObject({ kind: 'van_phong_pham' });
    expect(items.find((i) => /^Morphin/.test(i.name)).group_code).toBe('thuoc_kiem_soat');
  });

  it('cơ số xe ALS gồm thuốc và vật tư, sắp theo nhóm', async () => {
    const par = await crew('GET', '/api/stock/vehicle/MD-ALS-01/par');
    const names = par.items.map((i: any) => i.drug_name);
    expect(names).toContain('Bơm tiêm 10 ml');
    expect(names).toContain('Bút bi');
    const order = [...new Set(par.items.map((i: any) => i.group_name))];
    expect(order[0]).toBe('Đường thở – Oxy');
    expect(order.at(-1)).toBe('Văn phòng phẩm – Giấy tờ');
    // Phiếu chọn thuốc không lẫn vật tư
    const lots = (await crew('GET', '/api/stock/vehicle/MD-ALS-01')).data as any[];
    expect(lots.some((l) => l.drug_name === 'Bơm tiêm 10 ml')).toBe(false);
  });

  it('nhập kho vật tư không cần số lô, hạn dùng; thuốc vẫn bắt buộc', async () => {
    const items = (await duoc('GET', '/api/items')).data as any[];
    const band = items.find((i) => i.name === 'Băng cá nhân');
    const r = await duoc('POST', '/api/stock/receive', { stationId: 'TR-01', drugId: band.id, qty: 100 });
    expect(r.http).toBe(200);
    expect(r).toMatchObject({ lot: 'KHONG-LO', expiry: '9999-12-31' });
    const adr = items.find((i) => /^Adrenalin/.test(i.name));
    expect((await duoc('POST', '/api/stock/receive', { stationId: 'TR-01', drugId: adr.id, qty: 5 })).http).toBe(400);
  });

  it('thêm, sửa mặt hàng; kíp không được sửa', async () => {
    const r = await duoc('POST', '/api/items', { name: 'Giấy in nhiệt máy đo đường huyết', unit: 'cuộn', kind: 'van_phong_pham', groupCode: 'van_phong_pham' });
    expect(r.http).toBe(200);
    expect(r.track_lot).toBe(false);
    expect((await duoc('POST', '/api/items', { name: 'giấy in nhiệt máy đo đường huyết', unit: 'cuộn', kind: 'van_phong_pham', groupCode: 'van_phong_pham' })).http).toBe(409);
    const u = await duoc('PATCH', `/api/items/${r.id}`, { billable: true, sellPrice: 15000, code: 'VPP-01' });
    expect(u).toMatchObject({ billable: true, code: 'VPP-01' });
    expect((await crew('PATCH', `/api/items/${r.id}`, { billable: false })).http).toBe(403);
  });
});

describe('cơ số chuẩn tải về Excel, sửa, nạp lại', () => {
  it('xuất Excel mỗi loại xe một trang, nạp lại đổi cơ số, thêm hàng mới, báo dòng lỗi', async () => {
    const t = await token(app, 'duoc');
    const res = await app.inject({ method: 'GET', url: '/api/par-levels/excel?types=ALS,BLS', headers: { authorization: `Bearer ${t}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['ALS', 'BLS', 'Hướng dẫn']);
    const ws = wb.getWorksheet('ALS')!;
    expect(ws.getRow(1).getCell(6).value).toBe('Cơ số chuẩn');
    let syringeRow = 0; let penRow = 0;
    ws.eachRow((row, i) => { if (row.getCell(3).value === 'Bơm tiêm 5 ml') syringeRow = i; if (row.getCell(3).value === 'Bút bi') penRow = i; });
    expect(ws.getRow(syringeRow).getCell(6).value).toBe(10);
    ws.getRow(syringeRow).getCell(6).value = 15;
    ws.getRow(penRow).getCell(6).value = 0;
    ws.addRow(['Văn phòng phẩm – Giấy tờ', '', 'Đèn pin đội đầu', 'cái', 'Dụng cụ dùng lại', 2]);
    ws.addRow(['Nhóm không có', '', 'Hàng lạ', 'cái', 'Vật tư tiêu hao', 1]);
    ws.addRow(['Băng bó – Cố định – Vết thương', '', 'Băng thun 10 cm', 'cuộn', 'Vật tư tiêu hao', 'nhiều']);
    const file = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

    expect((await crew('POST', '/api/par-levels/import', { file })).http).toBe(403);
    const r = await duoc('POST', '/api/par-levels/import', { file });
    expect(r.http).toBe(200);
    expect(r.sheets).toEqual(['ALS', 'BLS']);
    expect(r.set).toBe(2);
    expect(r.removed).toBe(1);
    expect(r.created).toEqual(['Đèn pin đội đầu']);
    expect(r.errors).toHaveLength(2);

    const par = await crew('GET', '/api/stock/vehicle/MD-ALS-01/par');
    expect(par.items.find((i: any) => i.drug_name === 'Bơm tiêm 5 ml').par).toBe(15);
    expect(par.items.some((i: any) => i.drug_name === 'Bút bi')).toBe(false);
    expect(par.items.find((i: any) => i.drug_name === 'Đèn pin đội đầu')).toMatchObject({ kind: 'dung_cu', track_lot: false });
    expect((await duoc('POST', '/api/par-levels/import', { file: Buffer.from('không phải excel').toString('base64') })).http).toBe(400);
  });

  it('bù cơ số lấy cả vật tư không lô từ kho điểm', async () => {
    const r = await crew('POST', '/api/stock/vehicle/MD-ALS-01/restock', { witness: 'ĐD Kíp ALS' });
    expect(r.http).toBe(200);
    const par = await crew('GET', '/api/stock/vehicle/MD-ALS-01/par');
    const band = par.items.find((i: any) => i.drug_name === 'Băng cá nhân');
    expect(band.on_vehicle).toBe(band.par);
    expect(band.nearest_expiry).toBeNull();
  });
});
