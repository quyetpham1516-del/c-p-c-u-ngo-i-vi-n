import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { findHeader, readTable } from './table.js';

/** Thư mục dữ liệu đi kèm mã nguồn (danh mục ICD-10 Bộ Y tế, danh sách cơ sở KCB của Medone) */
export const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
export const BUNDLED_ICD = `${DATA_DIR}icd10-byt-2021.csv`;
export const BUNDLED_HOSPITALS = `${DATA_DIR}co-so-kcb-tphcm-2022.csv`;

const ICD_CODE = /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?[*+†]?$/;

/** Khoa nhận bệnh mặc định: bệnh viện nhận vào cấp cứu/hồi sức, phòng khám và trung tâm y tế nhận vào phòng khám */
export const HOSPITAL_DEPTS = [
  'Khoa Cấp cứu', 'Khoa Hồi sức tích cực – Chống độc', 'Khoa Tim mạch', 'Khoa Nội thần kinh (Đột quỵ)',
  'Khoa Ngoại chấn thương', 'Khoa Nội tổng hợp',
];
export const CLINIC_DEPTS = ['Phòng Cấp cứu', 'Khoa Khám bệnh'];
const isHospital = (name: string) => /^(b[eệ]nh vi[eệ]n|bv\b|vi[eệ]n)/i.test(name.trim());

async function inTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Nạp danh mục ICD-10 (cột Mã, Tên bệnh; tùy chọn Nhóm bệnh, Hiệu lực). Mã đã có thì cập nhật tên;
 * Hiệu lực = "Không" thì đánh dấu ngừng dùng. Trả về số mã đã nạp.
 */
export async function importIcd(pool: pg.Pool, file: string): Promise<number> {
  const rows = await readTable(file);
  const { index, cols } = findHeader(rows, { code: ['Mã', 'Ma', 'Mã bệnh', 'Code'], name: ['Tên bệnh', 'Ten benh', 'Tên', 'Name'] });
  const chapterCol = rows[index].findIndex((c) => /nh[oó]m b[eệ]nh|chương|chapter/i.test(c));
  const activeCol = rows[index].findIndex((c) => /hi[eệ]u l[uự]c/i.test(c));
  const seen = new Map<string, [string, string, string | null, boolean]>();
  for (const r of rows.slice(index + 1)) {
    const code = (r[cols.code] ?? '').toUpperCase().replace(/\s+/g, '');
    const name = (r[cols.name] ?? '').replace(/\s+/g, ' ').trim();
    if (!ICD_CODE.test(code) || !name || seen.has(code)) continue;
    const active = activeCol < 0 || !/^kh[oô]ng$/i.test(r[activeCol] ?? '');
    seen.set(code, [code, name, chapterCol >= 0 ? r[chapterCol] || null : null, active]);
  }
  const all = [...seen.values()];
  await inTx(pool, async (c) => {
    // Nạp theo lô 1000 mã để nhanh (danh mục Bộ Y tế hơn 13.000 mã)
    for (let i = 0; i < all.length; i += 1000) {
      const part = all.slice(i, i + 1000);
      await c.query(
        `INSERT INTO icd10(code, name, chapter, active)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[])
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, chapter = EXCLUDED.chapter, active = EXCLUDED.active`,
        [part.map((x) => x[0]), part.map((x) => x[1]), part.map((x) => x[2]), part.map((x) => x[3])]);
    }
  });
  return all.length;
}

/**
 * Nạp danh sách bệnh viện/cơ sở KCB: cột "Tên bệnh viện" (hoặc Tên cơ sở), tùy chọn "Mã KCB", "Khoa" (cách nhau bằng ;),
 * "Địa chỉ", "Số điện thoại", "Nhóm". Có mã KCB thì khớp theo mã, không thì khớp theo tên.
 * Cơ sở chưa có khoa nào được gán khoa mặc định để chọn được ngay.
 */
export async function importHospitals(pool: pg.Pool, file: string): Promise<{ hospitals: number; departments: number }> {
  const rows = await readTable(file);
  const { index, cols } = findHeader(rows, { name: ['Tên bệnh viện', 'Bệnh viện', 'Tên cơ sở KCB', 'Tên cơ sở', 'Tên', 'Cơ sở'] });
  const header = rows[index];
  const col = (re: RegExp) => header.findIndex((c) => re.test(c));
  const codeCol = col(/m[aã]\s*(kcb|c[oơ] s[oở])/i);
  const deptCol = col(/^khoa/i);
  const addrCol = col(/đ[iị]a ch[iỉ]/i);
  const phoneCol = col(/đi[eệ]n tho[aạ]i|sđt|sdt/i);
  const kindCol = col(/nh[oó]m|tuy[eế]n|lo[aạ]i/i);
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() || null : null);
  return inTx(pool, async (c) => {
    let nh = 0;
    let nd = 0;
    for (const r of rows.slice(index + 1)) {
      const name = (r[cols.name] ?? '').replace(/\s+/g, ' ').trim();
      if (!name) continue;
      const code = cell(r, codeCol);
      const existing = code
        ? (await c.query('SELECT id FROM hospitals WHERE kcb_code = $1 OR (kcb_code IS NULL AND lower(name) = lower($2)) LIMIT 1', [code, name])).rows[0]
        : (await c.query('SELECT id FROM hospitals WHERE lower(name) = lower($1) LIMIT 1', [name])).rows[0];
      let id: number;
      if (existing) {
        id = existing.id;
        await c.query(
          `UPDATE hospitals SET name = $2, kcb_code = COALESCE($3, kcb_code), address = COALESCE($4, address),
                  phone = COALESCE($5, phone), kind = COALESCE($6, kind) WHERE id = $1`,
          [id, name, code, cell(r, addrCol), cell(r, phoneCol), cell(r, kindCol)]);
      } else {
        id = (await c.query('INSERT INTO hospitals(name, kcb_code, address, phone, kind) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [name, code, cell(r, addrCol), cell(r, phoneCol), cell(r, kindCol)])).rows[0].id;
        nh++;
      }
      let depts = (cell(r, deptCol) ?? '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
      if (!depts.length) {
        const has = await c.query('SELECT 1 FROM hospital_departments WHERE hospital_id = $1 LIMIT 1', [id]);
        if (!has.rowCount) depts = isHospital(name) ? HOSPITAL_DEPTS : CLINIC_DEPTS;
      }
      for (const d of depts) {
        const x = await c.query('INSERT INTO hospital_departments(hospital_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, d]);
        nd += x.rowCount ?? 0;
      }
    }
    return { hospitals: nh, departments: nd };
  });
}
