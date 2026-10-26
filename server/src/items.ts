import ExcelJS from 'exceljs';
import { audit, type Actor } from './audit.js';
import { many, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';

/**
 * Danh mục hàng hóa chia nhóm (thuốc, dịch truyền, vật tư, dụng cụ, văn phòng phẩm) và bảng cơ số chuẩn theo loại xe
 * dạng bảng tính: tải về Excel (mỗi loại xe một trang), sửa, nạp lại.
 */

export const ITEM_KIND: Record<string, string> = {
  thuoc: 'Thuốc', dich_truyen: 'Dịch truyền', vat_tu: 'Vật tư tiêu hao', dung_cu: 'Dụng cụ dùng lại', van_phong_pham: 'Văn phòng phẩm',
};

const HEADERS = ['Nhóm', 'Mã hàng', 'Tên hàng', 'Đơn vị', 'Loại', 'Cơ số chuẩn'];

export async function parWorkbook(q: Queryable, types: string[]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Medone';
  const items = await many(q, `SELECT d.id, d.name, d.unit, d.kind, d.code, g.name AS group_name, g.sort
                                 FROM drugs d JOIN item_groups g ON g.code = d.group_code WHERE d.active ORDER BY g.sort, d.name`);
  for (const vt of types) {
    const par = new Map((await many(q, 'SELECT drug_id, qty::float AS qty FROM par_levels WHERE vehicle_type = $1', [vt])).map((r) => [r.drug_id, r.qty]));
    const ws = wb.addWorksheet(vt);
    ws.columns = [{ width: 30 }, { width: 12 }, { width: 44 }, { width: 10 }, { width: 18 }, { width: 13 }];
    ws.addRow(HEADERS).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    // Mọi mặt hàng đang dùng đều có dòng: ô cơ số để trống nghĩa là xe loại này không mang
    for (const it of items) ws.addRow([it.group_name, it.code ?? '', it.name, it.unit, ITEM_KIND[it.kind] ?? it.kind, par.get(it.id) ?? null]);
    ws.autoFilter = { from: 'A1', to: 'F1' };
  }
  const guide = wb.addWorksheet('Hướng dẫn');
  guide.addRows([
    ['Mỗi trang là cơ số chuẩn của một loại xe (tên trang = loại xe: ALS, BLS, MSU...).'],
    ['Sửa cột "Cơ số chuẩn". Để trống hoặc ghi 0 là xe loại đó không mang mặt hàng này.'],
    ['Thêm dòng mới: ghi Nhóm (đúng tên nhóm có sẵn), Tên hàng, Đơn vị, Loại (Thuốc, Dịch truyền, Vật tư tiêu hao, Dụng cụ dùng lại, Văn phòng phẩm).'],
    ['Mặt hàng mới loại Thuốc/Dịch truyền quản lý theo số lô, hạn dùng; loại khác không bắt buộc.'],
    ['Không đổi tên trang và tên cột. Nạp lại ở Kho thuốc → Định mức, cơ số chuẩn → Nạp từ Excel.'],
  ]);
  guide.getColumn(1).width = 120;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return String(v.result ?? '');
    if ('text' in v) return String(v.text);
  }
  return String(v);
};

/** Nạp bảng cơ số từ Excel; trả về số dòng đổi, mặt hàng mới, dòng lỗi (không dừng cả tệp vì một dòng sai) */
export async function importParWorkbook(tx: Tx, actor: Actor, buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { throw new HttpError(400, 'Tệp không phải Excel (.xlsx) hợp lệ'); }
  const types = new Set((await many(tx, 'SELECT DISTINCT type FROM vehicles UNION SELECT DISTINCT vehicle_type FROM par_levels')).map((r) => r.type ?? r.vehicle_type));
  const groups = await many(tx, 'SELECT code, name FROM item_groups');
  const kindByLabel = Object.fromEntries(Object.entries(ITEM_KIND).map(([k, v]) => [v.toLowerCase(), k]));
  const report = { sheets: [] as string[], set: 0, removed: 0, unchanged: 0, created: [] as string[], errors: [] as string[] };
  for (const ws of wb.worksheets) {
    const vt = ws.name.trim().toUpperCase();
    if (!types.has(vt)) continue;
    const head = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((v) => cellText(v).trim());
    const col = (name: string) => head.findIndex((h) => h.toLowerCase() === name.toLowerCase()) + 1;
    const cName = col('Tên hàng'); const cQty = col('Cơ số chuẩn');
    if (!cName || !cQty) { report.errors.push(`Trang ${ws.name}: thiếu cột "Tên hàng" hoặc "Cơ số chuẩn"`); continue; }
    const cGroup = col('Nhóm'); const cCode = col('Mã hàng'); const cUnit = col('Đơn vị'); const cKind = col('Loại');
    report.sheets.push(vt);
    const current = new Map((await many(tx, 'SELECT drug_id, qty::float AS qty FROM par_levels WHERE vehicle_type = $1', [vt])).map((r) => [r.drug_id, r.qty]));
    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const name = cellText(row.getCell(cName).value).trim();
      if (!name) continue;
      const qtyText = cellText(row.getCell(cQty).value).trim().replace(',', '.');
      const qty = qtyText === '' ? 0 : Number(qtyText);
      if (!Number.isFinite(qty) || qty < 0 || qty > 10000) { report.errors.push(`${vt} dòng ${i}: cơ số "${qtyText}" không hợp lệ`); continue; }
      const code = cCode ? cellText(row.getCell(cCode).value).trim() : '';
      let item = await one(tx, `SELECT id FROM drugs WHERE ($1 <> '' AND code = $1) OR lower(name) = lower($2) ORDER BY (code = $1) DESC LIMIT 1`, [code, name]);
      if (!item) {
        if (qty === 0) continue;
        const gName = cGroup ? cellText(row.getCell(cGroup).value).trim().toLowerCase() : '';
        const g = groups.find((x) => x.name.toLowerCase() === gName || x.code === gName);
        if (!g) { report.errors.push(`${vt} dòng ${i}: "${name}" là hàng mới nhưng nhóm "${gName}" không có trong danh mục nhóm`); continue; }
        const kind = kindByLabel[(cKind ? cellText(row.getCell(cKind).value) : '').trim().toLowerCase()] ?? (g.code === 'van_phong_pham' ? 'van_phong_pham' : 'vat_tu');
        const unit = (cUnit ? cellText(row.getCell(cUnit).value).trim() : '') || 'cái';
        item = await one(tx, `INSERT INTO drugs(name, unit, kind, group_code, code, track_lot) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [name, unit, kind, g.code, code || null, ['thuoc', 'dich_truyen'].includes(kind)]);
        report.created.push(name);
      }
      const before = current.get(item.id) ?? 0;
      if (before === qty) { report.unchanged++; continue; }
      if (qty === 0) { await tx.query('DELETE FROM par_levels WHERE vehicle_type = $1 AND drug_id = $2', [vt, item.id]); report.removed++; }
      else {
        await tx.query(`INSERT INTO par_levels(vehicle_type, drug_id, qty) VALUES ($1,$2,$3) ON CONFLICT (vehicle_type, drug_id) DO UPDATE SET qty = EXCLUDED.qty`, [vt, item.id, qty]);
        report.set++;
      }
      current.set(item.id, qty);
    }
  }
  if (!report.sheets.length) throw new HttpError(400, 'Không có trang nào mang tên loại xe (ALS, BLS, MSU...)');
  await audit(tx, 'system', actor, 'stock.par_imported', 'vehicle_type', report.sheets.join(','), { ...report, created: report.created.length, errors: report.errors.length });
  return report;
}
