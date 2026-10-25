import { many, one, type Queryable } from './db.js';

/**
 * Bảng lương tháng. Số liệu công lấy từ phần mềm: số ca theo lịch trực (ca đêm, trực 24 giờ), số chuyến kíp đã ký phiếu,
 * ngày nghỉ không lương đã duyệt. Lương tháng trừ ngày nghỉ không lương theo ngày công chuẩn; cộng tác viên trả theo ca.
 * BHXH, BHYT, BHTN, KPCĐ và thuế TNCN theo tham số trong cài đặt: mặc định là bản nháp, kế toán đối chiếu văn bản hiện hành rồi sửa.
 */

export interface PayrollSettings {
  standardDays: number;          // ngày công chuẩn tháng
  nightAllowance: number;        // phụ cấp mỗi ca đêm
  duty24Allowance: number;       // phụ cấp mỗi ca trực 24 giờ
  tripAllowance: number;         // phụ cấp mỗi chuyến (phiếu chuyển viện đã ký) của kíp
  baseWage: number;              // lương cơ sở: trần BHXH, BHYT = 20 lần
  regionMinWage: number;         // lương tối thiểu vùng: trần BHTN = 20 lần
  empRates: { bhxh: number; bhyt: number; bhtn: number };
  erRates: { bhxh: number; bhyt: number; bhtn: number; kpcd: number };
  selfDeduction: number;         // giảm trừ bản thân / tháng
  dependentDeduction: number;    // giảm trừ mỗi người phụ thuộc / tháng
  brackets: { upTo: number | null; rate: number }[];   // biểu thuế lũy tiến theo tháng
  flatRate: number;              // khấu trừ 10% với hợp đồng dưới 3 tháng, cộng tác viên
  flatThreshold: number;         // từ mức chi trả này mới khấu trừ
}

export const DEFAULT_PAYROLL: PayrollSettings = {
  standardDays: 26,
  nightAllowance: 150_000,
  duty24Allowance: 300_000,
  tripAllowance: 50_000,
  baseWage: 2_340_000,
  regionMinWage: 5_310_000,
  empRates: { bhxh: 8, bhyt: 1.5, bhtn: 1 },
  erRates: { bhxh: 17.5, bhyt: 3, bhtn: 1, kpcd: 2 },
  selfDeduction: 15_500_000,
  dependentDeduction: 6_200_000,
  brackets: [
    { upTo: 10_000_000, rate: 5 }, { upTo: 30_000_000, rate: 10 }, { upTo: 60_000_000, rate: 20 },
    { upTo: 100_000_000, rate: 30 }, { upTo: null, rate: 35 },
  ],
  flatRate: 10,
  flatThreshold: 2_000_000,
};

export interface Allowance { name: string; amount: number; taxable: boolean; insurable: boolean }
export interface Adjustment { name: string; amount: number; taxable: boolean }
export interface LineInput {
  contractType: string | null;
  payType: 'thang' | 'ca';
  baseSalary: number; insuranceSalary: number | null; shiftRate: number;
  allowances: Allowance[]; dependents: number;
  shifts: number; nightShifts: number; duty24: number; trips: number; unpaidDays: number;
}

const r0 = (n: number) => Math.round(n);

export function progressiveTax(income: number, brackets: PayrollSettings['brackets']) {
  let tax = 0; let low = 0;
  for (const b of brackets) {
    if (income <= low) break;
    const high = b.upTo ?? Infinity;
    tax += (Math.min(income, high) - low) * b.rate / 100;
    low = high;
  }
  return r0(tax);
}

/** Tính một dòng lương; trả về từng khoản để in phiếu lương */
export function computeLine(i: LineInput, s: PayrollSettings, adjustments: Adjustment[] = []) {
  const items: { name: string; amount: number; taxable: boolean }[] = [];
  if (i.payType === 'ca') {
    items.push({ name: `Lương theo ca (${i.shifts} ca × ${i.shiftRate.toLocaleString('vi-VN')})`, amount: r0(i.shifts * i.shiftRate), taxable: true });
  } else {
    items.push({ name: 'Lương theo hợp đồng', amount: r0(i.baseSalary), taxable: true });
    if (i.unpaidDays > 0) items.push({ name: `Trừ ${i.unpaidDays} ngày nghỉ không lương`, amount: -r0(i.baseSalary / s.standardDays * i.unpaidDays), taxable: true });
  }
  if (i.nightShifts) items.push({ name: `Phụ cấp ca đêm (${i.nightShifts} ca)`, amount: r0(i.nightShifts * s.nightAllowance), taxable: true });
  if (i.duty24) items.push({ name: `Phụ cấp trực 24 giờ (${i.duty24} ca)`, amount: r0(i.duty24 * s.duty24Allowance), taxable: true });
  if (i.trips) items.push({ name: `Phụ cấp chuyến (${i.trips} chuyến)`, amount: r0(i.trips * s.tripAllowance), taxable: true });
  for (const a of i.allowances) if (a.amount) items.push({ name: a.name, amount: r0(a.amount), taxable: a.taxable });
  for (const a of adjustments) if (a.amount) items.push({ name: a.name, amount: r0(a.amount), taxable: a.taxable });
  const gross = items.reduce((t, x) => t + x.amount, 0);

  // Bảo hiểm bắt buộc: hợp đồng lao động từ 1 tháng trở lên trả lương tháng (thử việc, cộng tác viên không đóng)
  const insured = i.payType === 'thang' && (i.contractType === 'xac_dinh' || i.contractType === 'khong_xac_dinh');
  const insBase = insured ? (i.insuranceSalary ?? (i.baseSalary + i.allowances.filter((a) => a.insurable).reduce((t, a) => t + a.amount, 0))) : 0;
  const capSi = Math.min(insBase, 20 * s.baseWage);
  const capUi = Math.min(insBase, 20 * s.regionMinWage);
  const emp = { bhxh: r0(capSi * s.empRates.bhxh / 100), bhyt: r0(capSi * s.empRates.bhyt / 100), bhtn: r0(capUi * s.empRates.bhtn / 100) };
  const er = { bhxh: r0(capSi * s.erRates.bhxh / 100), bhyt: r0(capSi * s.erRates.bhyt / 100), bhtn: r0(capUi * s.erRates.bhtn / 100), kpcd: r0(insBase * s.erRates.kpcd / 100) };
  const insEmp = emp.bhxh + emp.bhyt + emp.bhtn;
  const insEr = er.bhxh + er.bhyt + er.bhtn + er.kpcd;

  const taxableIncome = Math.max(0, items.filter((x) => x.taxable).reduce((t, x) => t + x.amount, 0));
  let pit = 0; let assessable = 0; let method: 'luy_tien' | 'khau_tru_10' | 'khong';
  if (i.contractType === 'cong_tac_vien' || i.contractType === 'thu_viec' || i.payType === 'ca') {
    method = taxableIncome >= s.flatThreshold ? 'khau_tru_10' : 'khong';
    pit = method === 'khau_tru_10' ? r0(taxableIncome * s.flatRate / 100) : 0;
  } else {
    assessable = Math.max(0, taxableIncome - insEmp - s.selfDeduction - i.dependents * s.dependentDeduction);
    pit = progressiveTax(assessable, s.brackets);
    method = pit ? 'luy_tien' : 'khong';
  }
  return { items, gross, insured, insBase, emp, er, insEmp, insEr, taxableIncome, assessable, pitMethod: method, pit, net: gross - insEmp - pit };
}

export async function getPayrollSettings(q: Queryable): Promise<PayrollSettings> {
  const r = await one(q, `SELECT value FROM finance_settings WHERE key = 'payroll'`);
  const v = r?.value ?? {};
  return { ...DEFAULT_PAYROLL, ...v, empRates: { ...DEFAULT_PAYROLL.empRates, ...v.empRates }, erRates: { ...DEFAULT_PAYROLL.erRates, ...v.erRates } };
}

/** Số liệu công của tháng cho từng nhân viên đang làm hoặc có công trong tháng */
export async function payrollInputs(q: Queryable, month: string) {
  return many(q, `
    WITH m AS (SELECT $1::date AS s, ($1::date + interval '1 month')::date AS e),
    plan AS (
      SELECT r.staff_id, count(*)::int AS shifts, count(*) FILTER (WHERE r.shift = 'dem')::int AS night, count(*) FILTER (WHERE r.shift = 'truc_24')::int AS duty24
        FROM roster r, m WHERE r.work_date >= m.s AND r.work_date < m.e GROUP BY r.staff_id),
    trips AS (
      SELECT st.id AS staff_id, count(DISTINCT t.id)::int AS n
        FROM crew_shifts cs JOIN staff st ON st.user_id = cs.user_id
        JOIN transfers t ON t.vehicle_id = cs.vehicle_id AND t.status = 'signed' AND t.signed_at >= cs.started_at AND t.signed_at <= coalesce(cs.ended_at, now()), m
       WHERE t.signed_at >= m.s::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AND t.signed_at < m.e::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
       GROUP BY st.id),
    lv AS (
      SELECT l.staff_id, sum(least(l.to_date, m.e - 1) - greatest(l.from_date, m.s) + 1)::int AS days
        FROM leave_requests l, m WHERE l.status = 'da_duyet' AND l.kind = 'khong_luong' AND l.from_date < m.e AND l.to_date >= m.s GROUP BY l.staff_id)
    SELECT s.id AS staff_id, s.code, s.full_name, s.title, s.contract_type,
           sal.pay_type, sal.base_salary::float8, sal.insurance_salary::float8, sal.shift_rate::float8, sal.allowances, sal.dependents,
           coalesce(plan.shifts, 0) AS shifts, coalesce(plan.night, 0) AS night, coalesce(plan.duty24, 0) AS duty24,
           coalesce(trips.n, 0) AS trips, coalesce(lv.days, 0) AS unpaid_days
      FROM staff s JOIN staff_salary sal ON sal.staff_id = s.id
      LEFT JOIN plan ON plan.staff_id = s.id LEFT JOIN trips ON trips.staff_id = s.id LEFT JOIN lv ON lv.staff_id = s.id
     WHERE s.status <> 'nghi_viec' OR plan.shifts > 0 OR trips.n > 0
     ORDER BY s.code`, [`${month}-01`]);
}

export function toInput(r: any): LineInput {
  return {
    contractType: r.contract_type, payType: r.pay_type, baseSalary: Number(r.base_salary), insuranceSalary: r.insurance_salary == null ? null : Number(r.insurance_salary),
    shiftRate: Number(r.shift_rate), allowances: r.allowances ?? [], dependents: Number(r.dependents),
    shifts: r.shifts, nightShifts: r.night, duty24: r.duty24, trips: r.trips, unpaidDays: r.unpaid_days,
  };
}
