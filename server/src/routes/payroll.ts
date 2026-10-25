import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx, type Queryable } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import { computeLine, DEFAULT_PAYROLL, getPayrollSettings, payrollInputs, toInput, type Adjustment, type PayrollSettings } from '../payroll.js';

const VIEW: Role[] = ['hr', 'accountant', 'director'];
const PREPARE: Role[] = ['hr', 'accountant'];
const STATUS: Record<string, string> = { nhap: 'Nháp', da_duyet: 'Đã duyệt', da_chi: 'Đã chi' };
const idParam = (p: unknown, k = 'id') => z.object({ [k]: z.string().uuid() }).parse(p)[k] as string;
const money = z.number().int().min(0).max(10_000_000_000);
const AllowanceZ = z.object({ name: z.string().trim().min(1).max(80), amount: money, taxable: z.boolean(), insurable: z.boolean() });
const AdjZ = z.object({ name: z.string().trim().min(1).max(80), amount: z.number().int().min(-10_000_000_000).max(10_000_000_000), taxable: z.boolean() });

async function periodDetail(q: Queryable, id: string) {
  const p = await one(q, `SELECT p.*, c.full_name AS created_by_name, a.full_name AS approved_by_name FROM payroll_periods p
                            JOIN users c ON c.id = p.created_by LEFT JOIN users a ON a.id = p.approved_by WHERE p.id = $1`, [id]);
  if (!p) throw new HttpError(404, 'Không tìm thấy bảng lương');
  const lines = await many(q, `SELECT l.*, l.gross::float8, l.ins_emp::float8, l.ins_er::float8, l.pit::float8, l.net::float8, s.code, s.full_name, s.title
                                 FROM payroll_lines l JOIN staff s ON s.id = l.staff_id WHERE l.period_id = $1 ORDER BY s.code`, [id]);
  const sum = (k: string) => lines.reduce((t, l) => t + Number(l[k]), 0);
  return { ...p, lines, totals: { count: lines.length, gross: sum('gross'), insEmp: sum('ins_emp'), insEr: sum('ins_er'), pit: sum('pit'), net: sum('net') } };
}

export function registerPayroll(app: FastifyInstance, { pool }: Ctx) {
  /* ---------- Tham số ---------- */

  app.get('/api/payroll/settings', { preHandler: guard(...VIEW) }, async () => ({ settings: await getPayrollSettings(pool), defaults: DEFAULT_PAYROLL }));

  app.put('/api/payroll/settings', { preHandler: guard('accountant', 'director') }, async (req) => {
    const rate = z.number().min(0).max(100);
    const b = z.object({
      standardDays: z.number().int().min(20).max(31), nightAllowance: money, duty24Allowance: money, tripAllowance: money,
      baseWage: money, regionMinWage: money,
      empRates: z.object({ bhxh: rate, bhyt: rate, bhtn: rate }), erRates: z.object({ bhxh: rate, bhyt: rate, bhtn: rate, kpcd: rate }),
      selfDeduction: money, dependentDeduction: money,
      brackets: z.array(z.object({ upTo: money.nullable(), rate })).min(1).max(10),
      flatRate: rate, flatThreshold: money,
    }).parse(req.body) as PayrollSettings;
    const ups = b.brackets.map((x) => x.upTo);
    if (ups[ups.length - 1] !== null || ups.slice(0, -1).some((u, k) => u === null || (k > 0 && u <= (ups[k - 1] as number)))) {
      throw new HttpError(422, 'Biểu thuế: các bậc tăng dần, bậc cuối để trống mức trên');
    }
    await withTx(pool, async (tx) => {
      await tx.query(`INSERT INTO finance_settings(key, value) VALUES ('payroll', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [b]);
      await audit(tx, 'system', actorOf(req), 'payroll.settings_changed', 'finance_settings', 'payroll', b as any);
    });
    return getPayrollSettings(pool);
  });

  /* ---------- Hồ sơ lương ---------- */

  app.get('/api/payroll/salaries', { preHandler: guard(...VIEW) }, async () => many(pool, `
    SELECT s.id AS staff_id, s.code, s.full_name, s.title, s.contract_type, s.status,
           sal.pay_type, sal.base_salary::float8, sal.insurance_salary::float8, sal.shift_rate::float8, sal.allowances, sal.dependents, sal.updated_at,
           u.full_name AS updated_by_name
      FROM staff s LEFT JOIN staff_salary sal ON sal.staff_id = s.id LEFT JOIN users u ON u.id = sal.updated_by
     WHERE s.status <> 'nghi_viec' ORDER BY s.code`));

  app.put('/api/payroll/salaries/:staffId', { preHandler: guard(...PREPARE) }, async (req) => {
    const staffId = idParam(req.params, 'staffId');
    const b = z.object({
      payType: z.enum(['thang', 'ca']), baseSalary: money, insuranceSalary: money.nullable(), shiftRate: money,
      allowances: z.array(AllowanceZ).max(20), dependents: z.number().int().min(0).max(20),
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (!(await one(tx, 'SELECT 1 FROM staff WHERE id = $1', [staffId]))) throw new HttpError(404, 'Không tìm thấy nhân viên');
      const r = await one(tx, `INSERT INTO staff_salary(staff_id, pay_type, base_salary, insurance_salary, shift_rate, allowances, dependents, updated_by)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                               ON CONFLICT (staff_id) DO UPDATE SET pay_type = $2, base_salary = $3, insurance_salary = $4, shift_rate = $5, allowances = $6,
                                 dependents = $7, updated_by = $8, updated_at = now() RETURNING *`,
        [staffId, b.payType, b.baseSalary, b.insuranceSalary, b.shiftRate, JSON.stringify(b.allowances), b.dependents, req.user.id]);
      // Không ghi số tiền vào nhật ký chung: chỉ ghi là đã sửa
      await audit(tx, 'system', actorOf(req), 'payroll.salary_changed', 'staff', staffId, { payType: b.payType });
      return r;
    });
  });

  /* ---------- Bảng lương tháng ---------- */

  app.get('/api/payroll/periods', { preHandler: guard(...VIEW) }, async () => many(pool, `
    SELECT p.id, p.month, p.status, p.created_at, p.approved_at, p.paid_at, count(l.id)::int AS lines,
           coalesce(sum(l.gross), 0)::float8 AS gross, coalesce(sum(l.net), 0)::float8 AS net
      FROM payroll_periods p LEFT JOIN payroll_lines l ON l.period_id = p.id GROUP BY p.id ORDER BY p.month DESC`));

  /** Tính (hoặc tính lại khi còn nháp) bảng lương tháng; giữ các khoản điều chỉnh đã nhập */
  app.post('/api/payroll/periods', { preHandler: guard(...PREPARE) }, async (req) => {
    const b = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(req.body);
    const id = await withTx(pool, async (tx) => {
      const s = await getPayrollSettings(tx);
      let p = await one(tx, 'SELECT * FROM payroll_periods WHERE month = $1 FOR UPDATE', [b.month]);
      if (p && p.status !== 'nhap') throw new HttpError(409, `Bảng lương tháng ${b.month} đã duyệt, không tính lại được`);
      if (!p) p = await one(tx, 'INSERT INTO payroll_periods(month, settings, created_by) VALUES ($1, $2, $3) RETURNING *', [b.month, s, req.user.id]);
      else await tx.query('UPDATE payroll_periods SET settings = $2, computed_at = now() WHERE id = $1', [p.id, s]);
      const old = new Map((await many(tx, 'SELECT staff_id, adjustments FROM payroll_lines WHERE period_id = $1', [p.id])).map((l) => [l.staff_id, l.adjustments]));
      await tx.query('DELETE FROM payroll_lines WHERE period_id = $1', [p.id]);
      for (const r of await payrollInputs(tx, b.month)) {
        const input = toInput(r);
        const adj: Adjustment[] = old.get(r.staff_id) ?? [];
        const c = computeLine(input, s, adj);
        await tx.query(`INSERT INTO payroll_lines(period_id, staff_id, input, adjustments, result, gross, ins_emp, ins_er, pit, net)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [p.id, r.staff_id, input, JSON.stringify(adj), c, c.gross, c.insEmp, c.insEr, c.pit, c.net]);
      }
      await audit(tx, 'system', actorOf(req), 'payroll.computed', 'payroll_period', p.id, { month: b.month });
      return p.id as string;
    });
    return periodDetail(pool, id);
  });

  app.get('/api/payroll/periods/:id', { preHandler: guard(...VIEW) }, async (req) => periodDetail(pool, idParam(req.params)));

  app.put('/api/payroll/lines/:id/adjustments', { preHandler: guard(...PREPARE) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ items: z.array(AdjZ).max(20) }).parse(req.body);
    return withTx(pool, async (tx) => {
      const l = await one(tx, `SELECT l.*, p.status, p.settings FROM payroll_lines l JOIN payroll_periods p ON p.id = l.period_id WHERE l.id = $1 FOR UPDATE OF l`, [id]);
      if (!l) throw new HttpError(404, 'Không tìm thấy dòng lương');
      if (l.status !== 'nhap') throw new HttpError(409, 'Bảng lương đã duyệt');
      const c = computeLine(l.input, l.settings, b.items);
      await tx.query('UPDATE payroll_lines SET adjustments = $2, result = $3, gross = $4, ins_emp = $5, ins_er = $6, pit = $7, net = $8 WHERE id = $1',
        [id, JSON.stringify(b.items), c, c.gross, c.insEmp, c.insEr, c.pit, c.net]);
      await audit(tx, 'system', actorOf(req), 'payroll.adjusted', 'payroll_period', l.period_id, { staffId: l.staff_id, items: b.items.length });
      return { ok: true, result: c };
    });
  });

  /** Ban Giám đốc duyệt; người lập không tự duyệt */
  app.post('/api/payroll/periods/:id/approve', { preHandler: guard('director') }, async (req) => {
    const id = idParam(req.params);
    await withTx(pool, async (tx) => {
      const p = await one(tx, 'SELECT * FROM payroll_periods WHERE id = $1 FOR UPDATE', [id]);
      if (!p) throw new HttpError(404, 'Không tìm thấy bảng lương');
      if (p.status !== 'nhap') throw new HttpError(409, 'Bảng lương đã duyệt');
      if (p.created_by === req.user.id) throw new HttpError(403, 'Người lập bảng lương không tự duyệt');
      await tx.query(`UPDATE payroll_periods SET status = 'da_duyet', approved_by = $2, approved_at = now() WHERE id = $1`, [id, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'payroll.approved', 'payroll_period', id, { month: p.month });
    });
    return periodDetail(pool, id);
  });

  app.post('/api/payroll/periods/:id/paid', { preHandler: guard('accountant') }, async (req) => {
    const id = idParam(req.params);
    await withTx(pool, async (tx) => {
      const p = await one(tx, `UPDATE payroll_periods SET status = 'da_chi', paid_by = $2, paid_at = now() WHERE id = $1 AND status = 'da_duyet' RETURNING month`, [id, req.user.id]);
      if (!p) throw new HttpError(409, 'Chỉ ghi đã chi cho bảng lương đã duyệt');
      await audit(tx, 'system', actorOf(req), 'payroll.paid', 'payroll_period', id, { month: p.month });
    });
    return periodDetail(pool, id);
  });

  app.get('/api/payroll/periods/:id/xlsx', { preHandler: guard(...VIEW) }, async (req, reply) => {
    const d = await periodDetail(pool, idParam(req.params));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'MedOne EOC';
    const ws = wb.addWorksheet(`Luong ${d.month}`);
    ws.addRow([`BẢNG LƯƠNG THÁNG ${d.month.slice(5)}/${d.month.slice(0, 4)} – ${STATUS[d.status]}`]).font = { bold: true, size: 13 };
    const head = ['Mã NV', 'Họ tên', 'Chức danh', 'Số ca', 'Ca đêm', 'Trực 24h', 'Chuyến', 'Nghỉ KL', 'Tổng thu nhập', 'BHXH', 'BHYT', 'BHTN',
      'Thu nhập tính thuế', 'Thuế TNCN', 'Thực lĩnh', 'BH đơn vị đóng', 'Ký nhận'];
    ws.addRow(head).font = { bold: true };
    for (const l of d.lines) {
      const r = l.result; const i = l.input;
      ws.addRow([l.code, l.full_name, l.title ?? '', i.shifts, i.nightShifts, i.duty24, i.trips, i.unpaidDays, l.gross, r.emp.bhxh, r.emp.bhyt, r.emp.bhtn,
        r.assessable, l.pit, l.net, l.ins_er, '']);
    }
    const t = d.totals;
    ws.addRow(['', 'Tổng cộng', '', '', '', '', '', '', t.gross, '', '', '', '', t.pit, t.net, t.insEr]).font = { bold: true };
    for (const c of [9, 10, 11, 12, 13, 14, 15, 16]) ws.getColumn(c).numFmt = '#,##0';
    ws.columns.forEach((c, k) => { c.width = k === 1 ? 26 : k === 16 ? 14 : 12; });
    ws.views = [{ state: 'frozen', ySplit: 2 }];
    await withTx(pool, (tx) => audit(tx, 'system', actorOf(req), 'payroll.exported', 'payroll_period', d.id, { month: d.month }));
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="bang-luong-${d.month}.xlsx"`);
    return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  /** Phiếu lương của chính mình: chỉ bảng lương đã duyệt */
  app.get('/api/payroll/me', { preHandler: guard() }, async (req) => many(pool, `
    SELECT p.month, p.status, l.input, l.adjustments, l.result, l.gross::float8, l.ins_emp::float8, l.pit::float8, l.net::float8
      FROM payroll_lines l JOIN payroll_periods p ON p.id = l.period_id JOIN staff s ON s.id = l.staff_id
     WHERE s.user_id = $1 AND p.status IN ('da_duyet', 'da_chi') ORDER BY p.month DESC LIMIT 24`, [req.user.id]));
}
