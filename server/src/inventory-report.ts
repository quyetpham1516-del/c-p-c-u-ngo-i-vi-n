import ExcelJS from 'exceljs';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';

/**
 * Báo cáo kho tự động sau mỗi lần nộp kiểm kê: nhập, xuất, tồn trong kỳ (từ báo cáo trước tới lúc nộp) và chênh lệch đếm thực tế.
 * Người nhận: kho tổng → quản trị, Ban Giám đốc, kế toán; kho điểm → trưởng bộ phận cấp cứu (trưởng nhóm mảng kíp).
 */

const IN = ['nhap_kho', 'nhan_kho_tong', 'tra_kho'];
const USE = ['dung_cho_nguoi_benh'];
const OUT = ['cap_xe', 'xuat_kho_diem', 'huy'];

export async function reportRecipients(q: Queryable, scope: string): Promise<string[]> {
  const rows = scope === 'kho_tong'
    ? await many(q, `SELECT id FROM users WHERE active AND role IN ('admin', 'director', 'accountant')`)
    : await many(q, `SELECT DISTINCT s.user_id AS id FROM org_members m JOIN org_units o ON o.id = m.unit_id JOIN staff s ON s.id = m.staff_id
                      JOIN users u ON u.id = s.user_id WHERE m.is_lead AND o.domain = 'kip' AND o.active AND u.active`);
  return rows.map((r) => r.id);
}

export async function buildStocktakeReport(tx: Tx, sessionId: string) {
  const s = await one(tx, `SELECT ss.*, st.name AS station_name FROM stocktake_sessions ss JOIN stations st ON st.id = ss.station_id WHERE ss.id = $1`, [sessionId]);
  if (!s?.voucher_id) throw new HttpError(409, 'Phiên kiểm kê chưa nộp');
  const prev = await one(tx, `SELECT period_end FROM inventory_reports WHERE station_id = $1 ORDER BY period_end DESC LIMIT 1`, [s.station_id]);
  const end = new Date(s.submitted_at ?? Date.now());
  const start = prev?.period_end ?? new Date(end.getTime() - (s.scope === 'kho_tong' ? 31 : 1) * 86_400_000);
  const rows = await many(tx, `
    WITH moves AS (
      SELECT l.drug_id, m.reason, m.delta
        FROM stock_moves m JOIN stock_lots l ON l.id = m.lot_id
       WHERE l.station_id = $1 AND l.vehicle_id IS NULL AND m.at > $2 AND m.at <= $3),
    agg AS (
      SELECT drug_id,
             sum(delta) FILTER (WHERE reason = ANY($5) OR (reason = 'dieu_chuyen' AND delta > 0)) AS received,
             -sum(delta) FILTER (WHERE reason = ANY($6)) AS used,
             -sum(delta) FILTER (WHERE reason = ANY($7) OR (reason = 'dieu_chuyen' AND delta < 0)) AS issued,
             sum(delta) FILTER (WHERE reason IN ('kiem_ke', 'dieu_chinh')) AS adjusted,
             sum(delta) AS net
        FROM moves GROUP BY drug_id),
    counted AS (
      SELECT sl.drug_id, sum(vl.book_qty) AS book, sum(vl.counted_qty) AS counted
        FROM stock_voucher_lines vl JOIN stock_lots sl ON sl.id = vl.lot_id WHERE vl.voucher_id = $4 GROUP BY sl.drug_id)
    SELECT d.id AS drug_id, d.name AS drug_name, d.unit,
           (coalesce(c.book, 0) - coalesce(a.net, 0))::float AS opening,
           coalesce(a.received, 0)::float AS received, coalesce(a.used, 0)::float AS used, coalesce(a.issued, 0)::float AS issued,
           coalesce(a.adjusted, 0)::float AS adjusted, coalesce(c.book, 0)::float AS book, coalesce(c.counted, 0)::float AS counted,
           (coalesce(c.counted, 0) - coalesce(c.book, 0))::float AS diff
      FROM drugs d LEFT JOIN agg a ON a.drug_id = d.id LEFT JOIN counted c ON c.drug_id = d.id
     WHERE a.drug_id IS NOT NULL OR c.drug_id IS NOT NULL
     ORDER BY (coalesce(c.counted, 0) <> coalesce(c.book, 0)) DESC, d.name`,
  [s.station_id, start, end, s.voucher_id, IN, USE, OUT]);
  const summary = {
    stationName: s.station_name, dueDate: s.due_date instanceof Date ? s.due_date.toISOString().slice(0, 10) : String(s.due_date),
    items: rows.length, diffItems: rows.filter((r) => r.diff !== 0).length,
    received: rows.reduce((t, r) => t + r.received, 0), used: rows.reduce((t, r) => t + r.used, 0), issued: rows.reduce((t, r) => t + r.issued, 0),
    late: s.status === 'qua_han',
  };
  const recipients = await reportRecipients(tx, s.scope);
  const year = String(end.getFullYear());
  const code = `BCK-${year}-${String(await nextCounter(tx, 'inventory_report', year)).padStart(5, '0')}`;
  const rep = await one(tx, `INSERT INTO inventory_reports(code, station_id, scope, period_start, period_end, session_id, summary, rows, recipients)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code`,
  [code, s.station_id, s.scope, start, end, sessionId, JSON.stringify(summary), JSON.stringify(rows), recipients]);
  const title = `Báo cáo kho ${s.scope === 'kho_tong' ? 'tổng' : s.station_id} ${summary.dueDate}: ${summary.diffItems ? `lệch ${summary.diffItems} mặt hàng` : 'khớp sổ sách'}`;
  await tx.query(`INSERT INTO notifications(user_id, kind, title, body, link) SELECT unnest($1::uuid[]), 'inventory_report', $2, $3, $4`,
    [recipients, title, `Nhập ${summary.received}, dùng cho người bệnh ${summary.used}, xuất ${summary.issued} (${summary.items} mặt hàng)`, `/ca-nhan#bao-cao-${rep.id}`]);
  return rep;
}

export async function reportWorkbook(rep: any) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Medone';
  const ws = wb.addWorksheet('Báo cáo');
  ws.addRow([`Báo cáo kho ${rep.summary.stationName} – ${rep.code}`]).font = { bold: true, size: 13 };
  ws.addRow([`Kỳ: ${new Date(rep.period_start).toLocaleString('vi-VN')} đến ${new Date(rep.period_end).toLocaleString('vi-VN')}${rep.summary.late ? ' (kiểm kê nộp trễ)' : ''}`]);
  ws.addRow([]);
  const head = ws.addRow(['Mặt hàng', 'Đơn vị', 'Đầu kỳ', 'Nhập', 'Dùng cho người bệnh', 'Xuất (cấp xe, phát, hủy)', 'Điều chỉnh', 'Sổ sách', 'Đếm thực tế', 'Chênh lệch']);
  head.font = { bold: true };
  for (const r of rep.rows) {
    const row = ws.addRow([r.drug_name, r.unit, r.opening, r.received, r.used, r.issued, r.adjusted, r.book, r.counted, r.diff]);
    if (r.diff !== 0) row.getCell(10).font = { bold: true, color: { argb: 'FFB91C1C' } };
  }
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 40 : 14; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
