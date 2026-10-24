import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';

/** Đọc bảng từ tệp .xlsx (trang đầu tiên) hoặc .csv thành mảng các dòng chuỗi */
export async function readTable(file: string): Promise<string[][]> {
  if (/\.xlsx$/i.test(file)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0];
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values as unknown[]).slice(1).map(cellText);
      rows.push(vals);
    });
    return rows;
  }
  return parseCsv((await readFile(file, 'utf8')).replace(/^﻿/, ''));
}

function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as { text?: string; richText?: { text: string }[]; result?: unknown };
    if (o.richText) return o.richText.map((r) => r.text).join('').trim();
    if (o.text != null) return String(o.text).trim();
    if (o.result != null) return String(o.result).trim();
  }
  return String(v).trim();
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur.trim()); cur = ''; } else if (c === '\n') { row.push(cur.trim()); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur.trim()); rows.push(row); }
  return rows.filter((r) => r.some((x) => x));
}

/** Tìm dòng tiêu đề chứa các cột cần thiết (so khớp không dấu, không phân biệt hoa thường) */
export function findHeader(rows: string[][], wanted: Record<string, string[]>): { index: number; cols: Record<string, number> } {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map(norm);
    const cols: Record<string, number> = {};
    for (const [key, names] of Object.entries(wanted)) {
      const idx = cells.findIndex((c) => names.some((n) => c === norm(n)));
      if (idx >= 0) cols[key] = idx;
    }
    if (Object.keys(wanted).every((k) => k in cols)) return { index: i, cols };
  }
  throw new Error(`Không tìm thấy dòng tiêu đề có các cột: ${Object.values(wanted).map((n) => n[0]).join(', ')}`);
}
