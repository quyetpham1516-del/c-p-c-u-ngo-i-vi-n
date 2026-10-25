import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { computeLine, DEFAULT_PAYROLL as S, progressiveTax, type LineInput } from '../src/payroll.js';
import { freshApp, login, token } from './helpers.js';

const base: LineInput = { contractType: 'khong_xac_dinh', payType: 'thang', baseSalary: 0, insuranceSalary: null, shiftRate: 0, allowances: [], dependents: 0,
  shifts: 0, nightShifts: 0, duty24: 0, trips: 0, unpaidDays: 0 };

describe('tính lương', () => {
  it('lương tháng: phụ cấp ca, chuyến; phụ cấp ăn trưa không tính thuế, không đóng BH; giảm trừ gia cảnh', () => {
    const c = computeLine({ ...base, baseSalary: 20_000_000, dependents: 1, nightShifts: 4, duty24: 2, trips: 10,
      allowances: [{ name: 'Ăn trưa', amount: 730_000, taxable: false, insurable: false }, { name: 'Trách nhiệm', amount: 1_000_000, taxable: true, insurable: true }] }, S);
    expect(c.gross).toBe(23_430_000);
    expect(c.insBase).toBe(21_000_000);
    expect(c.emp).toEqual({ bhxh: 1_680_000, bhyt: 315_000, bhtn: 210_000 });
    expect(c.insEr).toBe(4_935_000);
    expect(c.taxableIncome).toBe(22_700_000);
    expect(c.pit).toBe(0);
    expect(c.net).toBe(21_225_000);
  });

  it('thu nhập cao: trần đóng BHXH/BHYT 20 lần lương cơ sở; thuế lũy tiến từng phần', () => {
    const c = computeLine({ ...base, baseSalary: 60_000_000 }, S);
    expect(c.emp).toEqual({ bhxh: 3_744_000, bhyt: 702_000, bhtn: 600_000 });
    expect(c.assessable).toBe(39_454_000);
    expect(c.pit).toBe(4_390_800);
    expect(c.net).toBe(50_563_200);
    expect(progressiveTax(150_000_000, S.brackets)).toBe(500_000 + 2_000_000 + 6_000_000 + 12_000_000 + 17_500_000);
  });

  it('cộng tác viên trả theo ca: không đóng BH, khấu trừ 10% từ 2 triệu; nghỉ không lương trừ theo ngày công', () => {
    const ctv = computeLine({ ...base, contractType: 'cong_tac_vien', payType: 'ca', shiftRate: 800_000, shifts: 10, nightShifts: 3 }, S);
    expect([ctv.gross, ctv.insEmp, ctv.pit, ctv.pitMethod]).toEqual([8_450_000, 0, 845_000, 'khau_tru_10']);
    expect(computeLine({ ...base, contractType: 'cong_tac_vien', payType: 'ca', shiftRate: 500_000, shifts: 3 }, S).pit).toBe(0);
    const lv = computeLine({ ...base, baseSalary: 26_000_000, unpaidDays: 2 }, S);
    expect(lv.items[1]).toMatchObject({ amount: -2_000_000 });
    expect(lv.gross).toBe(24_000_000);
    expect(computeLine({ ...base, contractType: 'thu_viec', baseSalary: 10_000_000 }, S)).toMatchObject({ insEmp: 0, pit: 1_000_000 });
  });
});

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let nhansu: Client, ketoan: Client, giamdoc: Client, crew: Client;
const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
const month = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
let crewStaff = '';

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [nhansu, ketoan, giamdoc, crew] = await Promise.all(['nhansu', 'ketoan', 'giamdoc', 'bs.als'].map((u) => login(app, u)));
  crewStaff = (await one(`SELECT s.id FROM staff s JOIN users u ON u.id = s.user_id WHERE u.username = 'bs.als'`)).id;
  await pool.query(`UPDATE staff SET contract_type = 'khong_xac_dinh' WHERE id = $1`, [crewStaff]);
  for (const [d, sh] of [[1, 'dem'], [2, 'dem'], [3, 'truc_24'], [4, 'ngay']] as const) {
    await pool.query(`INSERT INTO roster(staff_id, work_date, shift) VALUES ($1, $2, $3)`, [crewStaff, `${month}-0${d}`, sh]);
  }
  // Một chuyến đã ký trong ca trên xe
  expect((await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Bác sĩ' })).http).toBe(200);
  const dpv = await login(app, 'dpv06');
  const inc = await dpv('POST', '/api/incidents', { source: '1800', callerPhone: '0900000004' });
  const patient = await crew('POST', '/api/patients', { idType: 'CCCD', idNumber: '079300004321', fullName: 'Ngô Văn Bình', birthYear: 1970, sex: 'M' });
  const at = new Date().toISOString();
  const epcr = { chiefComplaint: 'Khó thở', vitals: [{ at, hr: 100 }], diagnosis: { text: 'Hen phế quản', icd10: 'J45.9' }, payer: 'THU_PHI',
    disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', department: 'Khoa Cấp cứu', receiverName: 'BS Nhận', handoverAt: at, distanceKm: 8 } };
  const tid = randomUUID();
  expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId: inc.id, vehicleId: 'MD-ALS-01', patientId: patient.id, baseVersion: 0, epcr })).http).toBe(200);
  expect((await crew('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('bảng lương tháng', () => {
  let periodId = '';
  it('chỉ nhân sự, kế toán, Ban Giám đốc xem hồ sơ lương; nhập hồ sơ', async () => {
    expect((await crew('GET', '/api/payroll/salaries')).http).toBe(403);
    const r = await nhansu('PUT', `/api/payroll/salaries/${crewStaff}`, { payType: 'thang', baseSalary: 20_000_000, insuranceSalary: null, shiftRate: 0, dependents: 1,
      allowances: [{ name: 'Ăn trưa', amount: 730_000, taxable: false, insurable: false }] });
    expect(r.http).toBe(200);
    const audit = await one(`SELECT data FROM audit_events WHERE action = 'payroll.salary_changed'`);
    expect(JSON.stringify(audit.data)).not.toContain('20000000');
  });

  it('kế toán tính bảng lương: lấy ca đêm, trực 24h, chuyến từ phần mềm', async () => {
    const p = await ketoan('POST', '/api/payroll/periods', { month });
    expect(p.http).toBe(200);
    periodId = p.id;
    const l = p.lines.find((x: any) => x.staff_id === crewStaff);
    expect(l.input).toMatchObject({ shifts: 4, nightShifts: 2, duty24: 1, trips: 1 });
    expect(l.gross).toBe(20_000_000 + 300_000 + 300_000 + 50_000 + 730_000);
    expect(p.totals.count).toBe(1);
  });

  it('điều chỉnh thưởng, trừ tạm ứng rồi tính lại vẫn giữ điều chỉnh; phiếu lương chưa hiện khi chưa duyệt', async () => {
    const line = (await ketoan('GET', `/api/payroll/periods/${periodId}`)).lines[0];
    const adj = await ketoan('PUT', `/api/payroll/lines/${line.id}/adjustments`, { items: [{ name: 'Thưởng ca khó', amount: 1_000_000, taxable: true }, { name: 'Trừ tạm ứng', amount: -2_000_000, taxable: false }] });
    expect(adj.result.gross).toBe(line.gross - 1_000_000);
    const again = await ketoan('POST', '/api/payroll/periods', { month });
    expect(again.lines[0].adjustments).toHaveLength(2);
    expect((await crew('GET', '/api/payroll/me')).data).toEqual([]);
  });

  it('Ban Giám đốc duyệt (người lập không tự duyệt); đã duyệt thì khóa; nhân viên xem phiếu lương; xuất Excel', async () => {
    expect((await ketoan('POST', `/api/payroll/periods/${periodId}/approve`)).http).toBe(403);
    await pool.query(`UPDATE payroll_periods SET created_by = (SELECT id FROM users WHERE username = 'giamdoc') WHERE id = $1`, [periodId]);
    expect((await giamdoc('POST', `/api/payroll/periods/${periodId}/approve`)).http).toBe(403);
    await pool.query(`UPDATE payroll_periods SET created_by = (SELECT id FROM users WHERE username = 'ketoan') WHERE id = $1`, [periodId]);
    expect((await giamdoc('POST', `/api/payroll/periods/${periodId}/approve`)).status).toBe('da_duyet');
    expect((await ketoan('POST', '/api/payroll/periods', { month })).http).toBe(409);
    const me = await crew('GET', '/api/payroll/me');
    expect(me.data[0]).toMatchObject({ month, status: 'da_duyet' });
    expect(me.data[0].result.items.map((x: any) => x.name)).toContain('Thưởng ca khó');
    expect((await ketoan('POST', `/api/payroll/periods/${periodId}/paid`)).status).toBe('da_chi');
    const res = await app.inject({ method: 'GET', url: `/api/payroll/periods/${periodId}/xlsx`, headers: { authorization: `Bearer ${await token(app, 'giamdoc')}` } });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as any);
    const rows = wb.worksheets[0].getSheetValues() as any[];
    expect(rows[1][1]).toMatch(/BẢNG LƯƠNG THÁNG .* Đã chi/);
    expect(rows[3][2]).toBe('BS Kíp ALS');
  });

  it('biểu thuế phải tăng dần, bậc cuối để trống', async () => {
    const { settings } = await ketoan('GET', '/api/payroll/settings');
    expect((await ketoan('PUT', '/api/payroll/settings', { ...settings, brackets: [{ upTo: 10_000_000, rate: 5 }] })).http).toBe(422);
    expect((await ketoan('PUT', '/api/payroll/settings', { ...settings, nightAllowance: 200_000 })).nightAllowance).toBe(200_000);
    expect((await nhansu('PUT', '/api/payroll/settings', settings)).http).toBe(403);
  });
});
