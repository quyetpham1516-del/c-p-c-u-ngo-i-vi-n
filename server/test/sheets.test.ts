import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login, token } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance; let pool: pg.Pool;
let admin: Client, dpv06: Client, ketoan: Client, giamdoc: Client;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [admin, dpv06, ketoan, giamdoc] = await Promise.all(['admin', 'dpv06', 'ketoan', 'giamdoc'].map((u) => login(app, u)));
}, 60000);
afterAll(async () => { await app.close(); await pool.end(); });

async function download(key: string) {
  const res = await app.inject({ method: 'GET', url: `/api/sheets/${key}/template`, headers: { authorization: `Bearer ${await token(app, 'dpv06')}` } });
  expect(res.statusCode).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.rawPayload as any);
  return wb;
}
const b64 = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

describe('file mẫu Excel cho danh mục', () => {
  it('tải file mẫu kèm dữ liệu đang dùng và trang hướng dẫn', async () => {
    const list = (await dpv06('GET', '/api/sheets')).data;
    expect(list.map((s: any) => s.key)).toEqual(expect.arrayContaining(['diem', 'xe', 'benh-vien', 'gia-dich-vu', 'bang-gia-xe', 'loai-thiet-bi', 'vi-tri-kip', 'viec-kip', 'bo-phan']));
    const wb = await download('diem');
    const ws = wb.getWorksheet('Dữ liệu')!;
    expect(ws.getRow(1).getCell(1).value).toBe('Mã điểm *');
    expect(ws.rowCount).toBe(4);
    expect(wb.getWorksheet('Hướng dẫn')).toBeTruthy();
  });

  it('nạp lên chỉ so (thêm, sửa, giữ nguyên, lỗi), áp dụng mới ghi', async () => {
    const wb = await download('diem');
    const ws = wb.getWorksheet('Dữ liệu')!;
    ws.getRow(2).getCell(2).value = 'Trạm 1 Gò Vấp';
    ws.addRow(['TR-03', 'Trạm 3', 'Trạm', 'Quận 12', '0283', 10.86, 106.65, 'Có']);
    ws.addRow(['TR-04', 'Trạm 4', 'Kho lạ', null, null, 10.8, 106.6, 'Có']);
    ws.addRow(['TR-05', '', 'Trạm', null, null, 'abc', 106.6, 'Có']);
    const p = await dpv06('POST', '/api/sheets/diem/parse', { fileBase64: await b64(wb) });
    expect(p.http).toBe(200);
    expect(p.changes.map((r: any) => [r.id, r._action])).toEqual([['TR-01', 'sua'], ['TR-03', 'them']]);
    expect(p.unchanged).toBe(2);
    expect(p.errors.map((e: any) => e.row)).toEqual([6, 7]);
    expect(p.errors[0].error).toContain('Loại');
    expect((await pool.query(`SELECT count(*)::int AS n FROM stations`)).rows[0].n).toBe(3);
    expect((await dpv06('POST', '/api/sheets/diem/apply', { rows: p.changes })).http).toBe(403);
    const a = await admin('POST', '/api/sheets/diem/apply', { rows: p.changes });
    expect(a).toMatchObject({ inserted: 1, updated: 1 });
    expect((await pool.query(`SELECT name FROM stations WHERE id = 'TR-01'`)).rows[0].name).toBe('Trạm 1 Gò Vấp');
    expect((await pool.query(`SELECT kind FROM stations WHERE id = 'TR-03'`)).rows[0].kind).toBe('tram');
  });

  it('bệnh viện: mã số thuế giữ số 0 đầu, bệnh viện mới phải có mã số thuế', async () => {
    const wb = await download('benh-vien');
    const ws = wb.getWorksheet('Dữ liệu')!;
    ws.addRow(['Bệnh viện Thử Nghiệm', 301234567, null, 'Hạng I', 'Quận 1', null, null, null, 'Có']);
    const p = await dpv06('POST', '/api/sheets/benh-vien/parse', { fileBase64: await b64(wb) });
    expect(p.changes).toHaveLength(1);
    expect((await admin('POST', '/api/sheets/benh-vien/apply', { rows: p.changes })).inserted).toBe(1);
    expect((await pool.query(`SELECT tax_code FROM hospitals WHERE name = 'Bệnh viện Thử Nghiệm'`)).rows[0].tax_code).toBe('0301234567');
    expect((await admin('POST', '/api/sheets/benh-vien/apply', { rows: [{ name: 'Bệnh viện Không MST' }] })).http).toBe(400);
  });

  it('giá dịch vụ viết kiểu Việt Nam 1.500.000; việc kíp thay theo vị trí', async () => {
    const wb = await download('gia-dich-vu');
    const ws = wb.getWorksheet('Dữ liệu')!;
    ws.addRow(['DV-THU', 'Dịch vụ thử', 'lần', '1.500.000', null, null, 99, null, 'Có']);
    const p = await ketoan('POST', '/api/sheets/gia-dich-vu/parse', { fileBase64: await b64(wb) });
    expect(p.changes[0]).toMatchObject({ code: 'DV-THU', price: 1500000, _action: 'them' });

    const wv = await download('viec-kip');
    const sv = wv.getWorksheet('Dữ liệu')!;
    sv.addRow(['Lái xe', 'Sau ca', 'Rửa xe']);
    const pv = await dpv06('POST', '/api/sheets/viec-kip/parse', { fileBase64: await b64(wv) });
    expect(new Set(pv.changes.map((r: any) => r.position))).toEqual(new Set(['Lái xe']));
    expect((await admin('POST', '/api/sheets/viec-kip/apply', { rows: pv.changes })).http).toBe(200);
    expect((await pool.query(`SELECT count(*)::int AS n FROM crew_duty_tasks WHERE position = 'Lái xe'`)).rows[0].n).toBe(4);
  });

  it('đã khóa cấu hình: trưởng nhóm đúng mảng áp dụng thì thành đề xuất, quản trị duyệt mới ghi', async () => {
    await pool.query(`UPDATE org_members m SET is_lead = true FROM staff s, users u, org_units o
                       WHERE m.staff_id = s.id AND s.user_id = u.id AND u.username = 'dpv06' AND o.id = m.unit_id AND o.code = 'EOC-DP'`);
    expect((await admin('PUT', '/api/governance', { enforced: true })).http).toBe(200);
    const rows = [{ id: 'MD-ALS-02', plate: '51B-009.99', type: 'ALS', station_id: 'TR-03', duty: '24/7' }];
    expect((await ketoan('POST', '/api/sheets/xe/apply', { rows })).details.code).toBe('GOVERNED_NOT_LEAD');
    const p = await dpv06('POST', '/api/sheets/xe/apply', { rows });
    expect(p.http).toBe(202);
    const cr = (await admin('GET', '/api/change-requests?status=cho_duyet')).data[0];
    expect(cr).toMatchObject({ label: 'Nạp Excel: Xe', domain: 'dieu_phoi' });
    expect((await pool.query(`SELECT 1 FROM vehicles WHERE id = 'MD-ALS-02'`)).rowCount).toBe(0);
    expect((await admin('POST', `/api/change-requests/${p.id}/decide`, { approve: true })).status).toBe('da_duyet');
    expect((await pool.query(`SELECT status, station_id FROM vehicles WHERE id = 'MD-ALS-02'`)).rows[0]).toEqual({ status: 'S9', station_id: 'TR-03' });
    const off = await giamdoc('PUT', '/api/governance', { enforced: false });
    await admin('POST', `/api/change-requests/${off.id}/decide`, { approve: true });
  });
});
