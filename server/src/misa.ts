import ExcelJS from 'exceljs';
import { many, type Queryable } from './db.js';
import { EXPENSE_CATEGORY, getSettings, journal } from './finance.js';

/**
 * Xuất chứng từ sang MISA SME bằng Excel: phiếu thu tiền mặt, thu tiền gửi, phiếu chi, chi tiền gửi
 * và chứng từ nghiệp vụ khác (doanh thu, miễn giảm, chi công nợ). Mỗi loại một trang tính, đúng tên cột của mẫu nhập khẩu MISA;
 * khi nhập, MISA cho ghép cột nên cột lệch tên vẫn chọn lại được.
 */

const vn = (d: string) => d.slice(0, 10).split('-').reverse().join('/');
const RECEIPT_COLS = ['Ngày hạch toán (*)', 'Ngày chứng từ (*)', 'Số chứng từ (*)', 'Mã đối tượng', 'Tên đối tượng', 'Người nộp', 'Lý do thu',
  'Diễn giải (*)', 'TK Nợ (*)', 'TK Có (*)', 'Số tiền', 'Mã thống kê', 'Tham chiếu'];
const PAYMENT_COLS = ['Ngày hạch toán (*)', 'Ngày chứng từ (*)', 'Số chứng từ (*)', 'Mã đối tượng', 'Tên đối tượng', 'Người nhận', 'Lý do chi',
  'Diễn giải (*)', 'TK Nợ (*)', 'TK Có (*)', 'Số tiền', 'Mã thống kê', 'Số hóa đơn'];
const OTHER_COLS = ['Ngày hạch toán (*)', 'Ngày chứng từ (*)', 'Số chứng từ (*)', 'Diễn giải (*)', 'TK Nợ (*)', 'TK Có (*)', 'Số tiền', 'Đối tượng', 'Mã thống kê'];

export async function misaData(q: Queryable, from: string, to: string) {
  const a = (await getSettings(q)).accounts;
  const pays = await many(q, `
    SELECT p.code, p.amount::float8 AS amount, p.method, p.reference, p.payer_name, (p.received_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS d,
           c.code AS charge_code, c.payer_kind, c.payer_name AS charge_payer, c.vehicle_id, cu.code AS cu_code, cu.name AS cu_name
      FROM payments p JOIN charges c ON c.id = p.charge_id LEFT JOIN customers cu ON cu.id = c.customer_id
     WHERE NOT p.voided AND (p.received_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1 AND $2 ORDER BY p.received_at`, [from, to]);
  const receipt = (p: any) => {
    const obj = p.cu_code ?? (p.payer_kind === 'BHYT' ? 'BHXH' : 'KHACHLE');
    const name = p.cu_name ?? (p.payer_kind === 'BHYT' ? 'Bảo hiểm xã hội' : p.charge_payer ?? 'Khách lẻ');
    return [vn(p.d), vn(p.d), p.code, obj, name, p.payer_name ?? '', `Thu tiền vận chuyển cấp cứu ${p.charge_code}`,
      `Thu tiền ${p.charge_code}`, p.method === 'tien_mat' ? a.cash : a.bank, a.receivable, p.amount, p.vehicle_id ?? '', p.reference ?? ''];
  };
  const exps = await many(q, `SELECT e.code, e.category, e.amount::float8 AS amount, e.method, e.payee, e.doc_no, e.note, e.vehicle_id, e.spent_on::text AS d
                                FROM expenses e WHERE e.spent_on BETWEEN $1 AND $2 ORDER BY e.spent_on, e.code`, [from, to]);
  const expense = (e: any) => [vn(e.d), vn(e.d), e.code, '', e.payee ?? '', e.payee ?? '', EXPENSE_CATEGORY[e.category] ?? e.category,
    `${EXPENSE_CATEGORY[e.category] ?? e.category}${e.note ? `: ${e.note}` : ''}`, a[e.category] ?? a.khac, e.method === 'tien_mat' ? a.cash : a.bank,
    e.amount, e.vehicle_id ?? '', e.doc_no ?? ''];
  // Doanh thu, thuế, miễn giảm (chứng từ KT-) và chi ghi công nợ: chứng từ nghiệp vụ khác
  const other = (await journal(q, from, to)).filter((r) => r.docNo.startsWith('KT-'))
    .map((r) => [vn(r.date), vn(r.date), r.docNo, r.description, r.debit, r.credit, r.amount, r.object, r.vehicle]);
  for (const e of exps.filter((x) => x.method === 'cong_no')) {
    other.push([vn(e.d), vn(e.d), e.code, `${EXPENSE_CATEGORY[e.category] ?? e.category}${e.payee ? ` – ${e.payee}` : ''}`, a[e.category] ?? a.khac, a.payable,
      e.amount, e.payee ?? '', e.vehicle_id ?? '']);
  }
  return {
    phieuThu: pays.filter((p) => p.method === 'tien_mat').map(receipt),
    thuTienGui: pays.filter((p) => p.method !== 'tien_mat').map(receipt),
    phieuChi: exps.filter((e) => e.method === 'tien_mat').map(expense),
    chiTienGui: exps.filter((e) => e.method === 'chuyen_khoan').map(expense),
    khac: other,
  };
}

export async function misaWorkbook(q: Queryable, from: string, to: string): Promise<{ buffer: Buffer; counts: Record<string, number> }> {
  const d = await misaData(q, from, to);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MedOne EOC';
  const sheet = (name: string, cols: string[], rows: (string | number)[][]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(cols).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    ws.columns.forEach((c, i) => { c.width = Math.max(12, Math.min(48, cols[i].length + 4)); });
    const money = cols.indexOf('Số tiền') + 1;
    if (money) ws.getColumn(money).numFmt = '#,##0';
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  sheet('Phieu thu', RECEIPT_COLS, d.phieuThu);
  sheet('Thu tien gui', RECEIPT_COLS, d.thuTienGui);
  sheet('Phieu chi', PAYMENT_COLS, d.phieuChi);
  sheet('Chi tien gui', PAYMENT_COLS, d.chiTienGui);
  sheet('Nghiep vu khac', OTHER_COLS, d.khac);
  const guide = wb.addWorksheet('Huong dan');
  [
    [`Chứng từ từ ${vn(from)} đến ${vn(to)}, xuất từ MedOne EOC.`],
    ['Cách nhập vào MISA SME: vào phân hệ tương ứng (Quỹ: phiếu thu, phiếu chi; Ngân hàng: thu, chi tiền gửi; Tổng hợp: chứng từ nghiệp vụ khác)'],
    ['→ Nhập khẩu từ Excel → chọn tệp này và trang tính tương ứng → bước Ghép cột: kiểm tra từng cột khớp → Thực hiện.'],
    ['Thu tiền gửi, chi tiền gửi: chọn tài khoản ngân hàng nhận/chi khi nhập (cột "Nộp vào TK"/"Chi từ TK" của MISA).'],
    ['Mã đối tượng (khách hàng hợp đồng, BHXH, KHACHLE) phải có sẵn trong danh mục đối tượng của MISA; mã thống kê là biển số/mã xe.'],
    ['Số hiệu tài khoản lấy theo Tài chính → Cài đặt. Kế toán đối chiếu với chế độ kế toán đơn vị đang áp dụng.'],
    ['Nhập một lần cho mỗi khoảng ngày: MISA báo trùng số chứng từ nếu nhập lại.'],
  ].forEach((r) => guide.addRow(r));
  guide.getColumn(1).width = 120;
  const counts = { phieuThu: d.phieuThu.length, thuTienGui: d.thuTienGui.length, phieuChi: d.phieuChi.length, chiTienGui: d.chiTienGui.length, khac: d.khac.length };
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), counts };
}
