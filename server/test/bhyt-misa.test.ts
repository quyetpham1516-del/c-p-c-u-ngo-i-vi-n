import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { DEFAULT_BHYT, transportAmounts } from '../src/bhyt.js';
import { freshApp, login, token } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let dpv: Client, crew: Client, ketoan: Client, giamdoc: Client;
const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
const vnDate = (d = 0) => new Date(Date.now() + 7 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const range = `from=${vnDate(-1)}&to=${vnDate(1)}`;
let chargeId = '';

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [dpv, crew, ketoan, giamdoc] = await Promise.all(['dpv06', 'bs.als', 'ketoan', 'giamdoc'].map((u) => login(app, u)));
  expect((await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Bác sĩ' })).http).toBe(200);
  await pool.query(`INSERT INTO hospitals(name, kcb_code) VALUES ('Bệnh viện Thử BHYT', '79998') ON CONFLICT (name) DO UPDATE SET kcb_code = '79998'`);
  const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000002' });
  const patient = await crew('POST', '/api/patients', { idType: 'CCCD', idNumber: '079300001234', fullName: 'Trần Thị Bảo', birthYear: 1950, sex: 'F' });
  const tid = randomUUID();
  const at = new Date().toISOString();
  const epcr = {
    chiefComplaint: 'Đau ngực', vitals: [{ at, hr: 110 }], diagnosis: { text: 'Nhồi máu cơ tim cấp', icd10: 'I21.9' }, payer: 'BHYT',
    disposition: { type: 'transported', hospital: 'Bệnh viện Thử BHYT', department: 'Khoa Cấp cứu', receiverName: 'BS Nhận', handoverAt: at, distanceKm: 20 },
  };
  expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId: inc.id, vehicleId: 'MD-ALS-01', patientId: patient.id, baseVersion: 0, epcr })).http).toBe(200);
  expect((await crew('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
  chargeId = (await one('SELECT id FROM charges WHERE transfer_id = $1', [tid])).id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('bảng kê BHYT', () => {
  it('tính tiền vận chuyển: quỹ trả theo định mức nhiên liệu, phần còn lại người bệnh trả', () => {
    const a = transportAmounts({ km: 20, totalBv: 2_000_000, s: { ...DEFAULT_BHYT, fuelPrice: 25_000, litrePerKm: 0.2 }, mucHuong: 80 });
    expect(a).toMatchObject({ donGiaBv: 100_000, donGiaBh: 5_000, thanhTienBh: 100_000, bhtt: 80_000, bncct: 20_000, bntt: 1_900_000 });
    // Quỹ không trả quá chi phí thực tế
    expect(transportAmounts({ km: 10, totalBv: 50_000, s: { ...DEFAULT_BHYT, fuelPrice: 30_000 }, mucHuong: 100 }).thanhTienBh).toBe(50_000);
  });

  it('báo thiếu thông tin; kế toán nhập thẻ và cài đặt; sai định dạng bị chặn', async () => {
    const r = await ketoan('GET', `/api/finance/bhyt?${range}`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].missing.join()).toMatch(/Mã cơ sở KBCB.*Giá xăng.*Mã thẻ BHYT/);
    expect(r.rows[0]._raw).toBeUndefined();
    expect((await ketoan('GET', `/api/finance/bhyt/xml?${range}`)).http).toBe(409);
    expect((await ketoan('PUT', `/api/finance/charges/${chargeId}/bhyt`, { cardNo: 'DN479', dkbd: '79001', validFrom: '2026-01-01', validTo: '2026-12-31', mucHuong: 80 })).http).toBe(400);
    expect((await crew('PUT', `/api/finance/charges/${chargeId}/bhyt`, { cardNo: 'HT3797932128888', dkbd: '79001', validFrom: '2026-01-01', validTo: '2026-12-31', mucHuong: 80 })).http).toBe(403);
    expect((await ketoan('PUT', `/api/finance/charges/${chargeId}/bhyt`, { cardNo: 'ht3797932128888', dkbd: '79001', validFrom: '2026-01-01', validTo: '2026-12-31', mucHuong: 80, khuVuc: null })).http).toBe(200);
    const s = await ketoan('PUT', '/api/finance/bhyt/settings', { maCskcb: '79123', fuelPrice: 25_000, maXangDau: 'XD01', maTtdv: '7900000001' });
    expect(s).toMatchObject({ maCskcb: '79123', fuelPrice: 25_000, litrePerKm: 0.2, maNhomVc: '12' });
    const after = await ketoan('GET', `/api/finance/bhyt?${range}`);
    expect(after.rows[0].missing).toEqual([]);
    expect(after.rows[0].card.cardNo).toBe('HT3797932128888');
    expect(after.rows[0].amounts.thanhTienBh).toBe(100_000);   // 20 km × 0,2 lít × 25.000 đ
  });

  it('xuất XML: hồ sơ gồm XML1 và XML3 base64, dòng vận chuyển VC.<mã nơi đến>; lần sau không xuất lại', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/finance/bhyt/xml?${range}`, headers: { authorization: `Bearer ${await token(app, 'ketoan')}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/GIAMDINHHS_79123_/);
    const xml = res.body;
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?><GIAMDINHHS/);
    expect(xml).toContain('<MACSKCB>79123</MACSKCB>');
    expect(xml).toContain('<SOLUONGHOSO>1</SOLUONGHOSO>');
    const files = [...xml.matchAll(/<LOAIHOSO>(XML\d)<\/LOAIHOSO><NOIDUNGFILE>([^<]+)<\/NOIDUNGFILE>/g)].map((m) => [m[1], Buffer.from(m[2], 'base64').toString('utf8')]);
    expect(files.map((f) => f[0])).toEqual(['XML1', 'XML3']);
    const [x1, x3] = [files[0][1], files[1][1]];
    expect(x1).toContain('<HO_TEN>Trần Thị Bảo</HO_TEN>');
    expect(x1).toContain('<SO_CCCD>079300001234</SO_CCCD>');
    expect(x1).toContain('<NGAY_SINH>195000000000</NGAY_SINH>');
    expect(x1).toContain('<GIOI_TINH>2</GIOI_TINH>');
    expect(x1).toContain('<MA_THE_BHYT>HT3797932128888</MA_THE_BHYT>');
    expect(x1).toContain('<MA_BENH_CHINH>I21.9</MA_BENH_CHINH>');
    expect(x1).toContain('<MA_NOI_DEN>79998</MA_NOI_DEN>');
    expect(x1).toContain('<T_BHTT>80000</T_BHTT>');
    expect(x1).toMatch(/<NGAY_VAO>\d{12}<\/NGAY_VAO>/);
    expect(x3).toContain('<MA_DICH_VU>VC.79998</MA_DICH_VU>');
    expect(x3).toContain('<MA_NHOM>12</MA_NHOM>');
    expect(x3).toContain('<SO_LUONG>20</SO_LUONG>');
    expect(x3).toContain('<DON_GIA_BH>5000</DON_GIA_BH>');
    expect((await one('SELECT bhyt_exported_at FROM charges WHERE id = $1', [chargeId])).bhyt_exported_at).toBeTruthy();
    const log = await one('SELECT * FROM bhyt_exports');
    expect(Number(log.total_bhtt)).toBe(80_000);
    expect((await ketoan('GET', `/api/finance/bhyt/xml?${range}`)).http).toBe(409);
    const again = await app.inject({ method: 'GET', url: `/api/finance/bhyt/xml?${range}&all=1`, headers: { authorization: `Bearer ${await token(app, 'ketoan')}` } });
    expect(again.statusCode).toBe(200);
  });
});

describe('xuất MISA', () => {
  it('Excel có trang phiếu thu, thu tiền gửi, phiếu chi, nghiệp vụ khác với đúng tài khoản', async () => {
    const c = await one('SELECT total FROM charges WHERE id = $1', [chargeId]);
    expect((await ketoan('POST', `/api/finance/charges/${chargeId}/payments`, { amount: 1_000_000, method: 'tien_mat', payerName: 'Con người bệnh' })).http).toBe(200);
    expect((await ketoan('POST', `/api/finance/charges/${chargeId}/payments`, { amount: Number(c.total) - 1_000_000, method: 'bhyt', reference: 'BHXH-T10' })).http).toBe(200);
    expect((await ketoan('POST', '/api/finance/expenses', { category: 'nhien_lieu', amount: 600_000, spentOn: vnDate(), method: 'tien_mat', payee: 'Cây xăng 1', vehicleId: 'MD-ALS-01' })).http).toBe(200);
    expect((await ketoan('POST', '/api/finance/expenses', { category: 'cau_duong', amount: 200_000, spentOn: vnDate(), method: 'cong_no', payee: 'VETC' })).http).toBe(200);
    expect((await crew('GET', `/api/finance/misa?${range}`)).http).toBe(403);
    const res = await app.inject({ method: 'GET', url: `/api/finance/misa?${range}`, headers: { authorization: `Bearer ${await token(app, 'giamdoc')}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Phieu thu', 'Thu tien gui', 'Phieu chi', 'Chi tien gui', 'Nghiep vu khac', 'Huong dan']);
    const rows = (name: string) => (wb.getWorksheet(name)!.getSheetValues() as any[]).slice(2).map((r) => r.slice(1));
    const thu = rows('Phieu thu');
    expect(thu).toHaveLength(1);
    expect(thu[0][0]).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(thu[0].slice(8, 11)).toEqual(['1111', '131', 1_000_000]);
    expect(thu[0][3]).toBe('BHXH');
    const gui = rows('Thu tien gui');
    expect(gui[0].slice(8, 10)).toEqual(['1121', '131']);
    expect(gui[0][12]).toBe('BHXH-T10');
    expect(rows('Phieu chi')[0].slice(8, 11)).toEqual(['6278', '1111', 600_000]);
    const khac = rows('Nghiep vu khac');
    expect(khac.some((r) => r[4] === '131' && r[5] === '5113')).toBe(true);
    expect(khac.some((r) => r[4] === '6278' && r[5] === '331' && r[6] === 200_000)).toBe(true);
    expect((await one(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'finance.misa_exported'`)).n).toBe(1);
  });
});
