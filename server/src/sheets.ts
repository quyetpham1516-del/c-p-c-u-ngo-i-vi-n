import ExcelJS from 'exceljs';
import { audit, type Actor } from './audit.js';
import { many, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';
import type { Domain } from './governance.js';
import { normalizeTaxCode } from './accounts.js';

/**
 * File mẫu Excel cho các danh mục: tải về (kèm dữ liệu đang dùng), sửa, nạp lên. Nạp lên chỉ đọc và so với dữ liệu hiện tại;
 * bước "áp dụng" mới ghi, và bước đó nằm trong danh sách đề xuất, duyệt (đã khóa cấu hình thì thành đề xuất của trưởng nhóm).
 */

type ColType = 'text' | 'int' | 'number' | 'bool' | 'date' | 'enum';
interface Col { key: string; header: string; type: ColType; required?: boolean; values?: Record<string, string>; width?: number }
type Row = Record<string, string | number | boolean | null>;

export interface Sheet {
  key: string;
  label: string;
  domain: Domain;
  keyCol: string;
  cols: Col[];
  guide: string[];
  current(q: Queryable): Promise<Row[]>;
  apply(tx: Tx, rows: Row[]): Promise<{ inserted: number; updated: number }>;
}

const BOOL_TRUE = new Set(['có', 'co', 'x', '1', 'true', 'đang dùng', 'dang dung', 'yes']);
const BOOL_FALSE = new Set(['không', 'khong', '0', 'false', 'ngưng', 'ngung', 'tạm ngưng', 'no', '']);

const STATION_KIND = { tru_so: 'Trụ sở', tram: 'Trạm', kho_trung_tam: 'Kho trung tâm', diem_su_kien: 'Điểm sự kiện' };
const VEHICLE_TYPE = { ALS: 'ALS', BLS: 'BLS', MSU: 'MSU', ECMO: 'ECMO', VC: 'VC', DP: 'DP' };
const VEHICLE_DUTY = { '24/7': '24/7', office: 'Giờ hành chính', reserve: 'Dự phòng' };
const PHASE = { dau_ca: 'Đầu ca', hien_truong: 'Tại hiện trường', sau_ca: 'Sau ca' };
const ORG_DOMAIN: Record<Domain, string> = {
  ban_giam_doc: 'Ban Giám đốc', tiep_nhan: 'Tiếp nhận', dieu_phoi: 'Điều phối', kip: 'Kíp', kho: 'Kho', thiet_bi: 'Thiết bị',
  ksnk: 'Kiểm soát nhiễm khuẩn', chat_luong: 'Chất lượng', nhan_su: 'Nhân sự', ke_toan: 'Kế toán', khac: 'Khác',
};

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return v.result instanceof Date ? v.result.toISOString().slice(0, 10) : String(v.result ?? '');
    if ('text' in v) return String(v.text);
  }
  return String(v);
};

/** Đọc một ô (từ Excel hoặc từ JSON đã đọc trước đó) thành giá trị chuẩn; sai thì báo lỗi bằng lời */
function normalizeCell(col: Col, raw: unknown): string | number | boolean | null {
  const s = typeof raw === 'string' ? raw.trim() : raw;
  if (s === '' || s == null) {
    if (col.type === 'bool') return true;
    if (col.required) throw new Error(`thiếu "${col.header}"`);
    return null;
  }
  switch (col.type) {
    case 'text': return String(s).slice(0, 500);
    case 'int': case 'number': {
      let t = String(s).replace(/\s/g, '');
      // 1.500.000 hoặc 1.500,5 (cách viết Việt Nam); 10.776 một dấu chấm vẫn là số thập phân
      if (/^\d{1,3}(\.\d{3}){2,}(,\d+)?$/.test(t) || /^\d{1,3}(\.\d{3})+,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
      else if (!t.includes('.')) t = t.replace(',', '.');
      const n = typeof s === 'number' ? s : Number(t);
      if (!Number.isFinite(n) || (col.type === 'int' && !Number.isInteger(n))) throw new Error(`"${col.header}" phải là số`);
      return n;
    }
    case 'bool': {
      if (typeof s === 'boolean') return s;
      const t = String(s).toLowerCase();
      if (BOOL_TRUE.has(t)) return true;
      if (BOOL_FALSE.has(t)) return false;
      throw new Error(`"${col.header}" ghi Có hoặc Không`);
    }
    case 'date': {
      const t = String(s);
      const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/) ?? t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) throw new Error(`"${col.header}" ghi ngày dạng 2026-10-27 hoặc 27/10/2026`);
      const iso = m[0].includes('/') ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : m[0];
      if (Number.isNaN(Date.parse(iso))) throw new Error(`"${col.header}" không phải ngày hợp lệ`);
      return iso;
    }
    case 'enum': {
      const t = String(s).toLowerCase();
      const hit = Object.entries(col.values ?? {}).find(([code, label]) => code.toLowerCase() === t || label.toLowerCase() === t);
      if (!hit) throw new Error(`"${col.header}" chỉ nhận: ${Object.values(col.values ?? {}).join(', ')}`);
      return hit[0];
    }
  }
}

export function normalizeRow(sheet: Sheet, raw: Record<string, unknown>): Row {
  const out: Row = {};
  for (const c of sheet.cols) out[c.key] = normalizeCell(c, raw[c.key]);
  return out;
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || String(a ?? '') === String(b ?? '');

const num = (v: unknown) => (v == null ? null : Number(v));

export const SHEETS: Sheet[] = [
  {
    key: 'diem', label: 'Điểm, trạm', domain: 'dieu_phoi', keyCol: 'id',
    cols: [
      { key: 'id', header: 'Mã điểm', type: 'text', required: true, width: 12 }, { key: 'name', header: 'Tên điểm', type: 'text', required: true, width: 30 },
      { key: 'kind', header: 'Loại', type: 'enum', required: true, values: STATION_KIND, width: 16 }, { key: 'address', header: 'Địa chỉ', type: 'text', width: 40 },
      { key: 'phone', header: 'Điện thoại', type: 'text', width: 14 }, { key: 'lat', header: 'Vĩ độ', type: 'number', required: true, width: 12 },
      { key: 'lng', header: 'Kinh độ', type: 'number', required: true, width: 12 }, { key: 'active', header: 'Đang dùng', type: 'bool', width: 10 },
    ],
    guide: ['Mã điểm 2–20 ký tự chữ, số, gạch ngang. Mã có sẵn thì sửa, mã mới thì thêm.', 'Điểm còn xe thì không tạm ngưng được: chuyển xe trước.'],
    current: (q) => many(q, `SELECT id, name, kind, address, phone, lat, lng, active FROM stations ORDER BY id`),
    async apply(tx, rows) {
      let inserted = 0; let updated = 0;
      for (const r of rows) {
        const id = String(r.id).toUpperCase();
        if (!/^[A-Z0-9-]{2,20}$/.test(id)) throw new HttpError(400, `Mã điểm "${r.id}" không hợp lệ`);
        if (r.active === false && (await one(tx, 'SELECT 1 FROM vehicles WHERE station_id = $1', [id]))) throw new HttpError(409, `Điểm ${id} còn xe, chưa tạm ngưng được`);
        const x = await one(tx, `INSERT INTO stations(id, name, kind, address, phone, lat, lng, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                                 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, address = EXCLUDED.address, phone = EXCLUDED.phone,
                                   lat = EXCLUDED.lat, lng = EXCLUDED.lng, active = EXCLUDED.active RETURNING (xmax = 0) AS inserted`,
        [id, r.name, r.kind, r.address, r.phone, r.lat, r.lng, r.active]);
        if (x.inserted) inserted++; else updated++;
      }
      return { inserted, updated };
    },
  },
  {
    key: 'xe', label: 'Xe', domain: 'dieu_phoi', keyCol: 'id',
    cols: [
      { key: 'id', header: 'Mã xe', type: 'text', required: true, width: 14 }, { key: 'plate', header: 'Biển số', type: 'text', width: 14 },
      { key: 'type', header: 'Loại xe', type: 'enum', required: true, values: VEHICLE_TYPE, width: 10 },
      { key: 'station_id', header: 'Mã điểm', type: 'text', required: true, width: 12 },
      { key: 'duty', header: 'Trực', type: 'enum', required: true, values: VEHICLE_DUTY, width: 16 },
    ],
    guide: ['Mã xe có sẵn thì sửa biển số, loại, điểm, chế độ trực; mã mới thì thêm xe (trạng thái ban đầu S9 ngoài hoạt động).', 'Mã điểm phải có trong danh mục điểm.'],
    current: (q) => many(q, `SELECT id, plate, type, station_id, duty FROM vehicles ORDER BY id`),
    async apply(tx, rows) {
      let inserted = 0; let updated = 0;
      for (const r of rows) {
        const st = await one(tx, 'SELECT lat, lng, active FROM stations WHERE id = $1', [r.station_id]);
        if (!st?.active) throw new HttpError(400, `Xe ${r.id}: điểm ${r.station_id} không có hoặc đang tạm ngưng`);
        const x = await one(tx, `INSERT INTO vehicles(id, plate, type, station_id, duty, status, lat, lng) VALUES ($1,$2,$3,$4,$5,'S9',$6,$7)
                                 ON CONFLICT (id) DO UPDATE SET plate = EXCLUDED.plate, type = EXCLUDED.type, station_id = EXCLUDED.station_id, duty = EXCLUDED.duty
                                 RETURNING (xmax = 0) AS inserted`, [r.id, r.plate, r.type, r.station_id, r.duty, st.lat, st.lng]);
        if (x.inserted) inserted++; else updated++;
      }
      return { inserted, updated };
    },
  },
  {
    key: 'benh-vien', label: 'Bệnh viện', domain: 'dieu_phoi', keyCol: 'name',
    cols: [
      { key: 'name', header: 'Tên bệnh viện', type: 'text', required: true, width: 40 }, { key: 'tax_code', header: 'Mã số thuế', type: 'text', width: 16 },
      { key: 'kcb_code', header: 'Mã KCB', type: 'text', width: 10 }, { key: 'kind', header: 'Hạng, loại', type: 'text', width: 14 },
      { key: 'address', header: 'Địa chỉ', type: 'text', width: 40 }, { key: 'phone', header: 'Điện thoại', type: 'text', width: 14 },
      { key: 'lat', header: 'Vĩ độ', type: 'number', width: 12 }, { key: 'lng', header: 'Kinh độ', type: 'number', width: 12 },
      { key: 'active', header: 'Đang dùng', type: 'bool', width: 10 },
    ],
    guide: ['Tên bệnh viện có sẵn thì sửa, tên mới thì thêm (thêm mới phải có mã số thuế 10 hoặc 13 số).', 'Khoa của bệnh viện sửa ở màn hình danh mục.'],
    current: (q) => many(q, `SELECT name, tax_code, kcb_code, kind, address, phone, lat, lng, active FROM hospitals ORDER BY name`),
    async apply(tx, rows) {
      let inserted = 0; let updated = 0;
      for (const r of rows) {
        let tax: string | null;
        // Excel hay biến mã số thuế thành số và mất số 0 đầu
        const rawTax = r.tax_code == null ? null : String(r.tax_code);
        try { tax = normalizeTaxCode(rawTax && /^(\d{9}|\d{12})$/.test(rawTax) ? `0${rawTax}` : rawTax); } catch { throw new HttpError(400, `${r.name}: mã số thuế gồm 10 hoặc 13 chữ số`); }
        const cur = await one(tx, 'SELECT id FROM hospitals WHERE name = $1', [r.name]);
        if (!cur && !tax) throw new HttpError(400, `${r.name}: bệnh viện mới cần mã số thuế`);
        if (cur) {
          await tx.query(`UPDATE hospitals SET tax_code = coalesce($2, tax_code), kcb_code = $3, kind = $4, address = $5, phone = $6, lat = $7, lng = $8, active = $9 WHERE id = $1`,
            [cur.id, tax, r.kcb_code, r.kind, r.address, r.phone, r.lat, r.lng, r.active]);
          updated++;
        } else {
          const h = await one(tx, `INSERT INTO hospitals(name, tax_code, kcb_code, kind, address, phone, lat, lng, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [r.name, tax, r.kcb_code, r.kind, r.address, r.phone, r.lat, r.lng, r.active]);
          await tx.query(`INSERT INTO hospital_departments(hospital_id, name) VALUES ($1, 'Khoa Cấp cứu') ON CONFLICT DO NOTHING`, [h.id]);
          inserted++;
        }
      }
      return { inserted, updated };
    },
  },
  {
    key: 'gia-dich-vu', label: 'Giá dịch vụ', domain: 'ke_toan', keyCol: 'code',
    cols: [
      { key: 'code', header: 'Mã dịch vụ', type: 'text', required: true, width: 14 }, { key: 'name', header: 'Tên dịch vụ', type: 'text', required: true, width: 40 },
      { key: 'unit', header: 'Đơn vị', type: 'text', required: true, width: 10 }, { key: 'price', header: 'Giá (đồng)', type: 'number', required: true, width: 14 },
      { key: 'care_key', header: 'Mã can thiệp', type: 'text', width: 14 }, { key: 'lab_type', header: 'Mã xét nghiệm', type: 'text', width: 14 },
      { key: 'sort', header: 'Thứ tự', type: 'int', width: 8 }, { key: 'note', header: 'Ghi chú', type: 'text', width: 30 },
      { key: 'active', header: 'Đang dùng', type: 'bool', width: 10 },
    ],
    guide: ['Mã dịch vụ có sẵn thì sửa, mã mới thì thêm. Giá không âm.', 'Mã can thiệp, mã xét nghiệm để tự tính giá khi kíp ghi can thiệp, xét nghiệm (để trống nếu không dùng).'],
    current: (q) => many(q, `SELECT code, name, unit, price::float AS price, care_key, lab_type, sort, note, active FROM service_prices ORDER BY sort, code`),
    async apply(tx, rows) {
      let inserted = 0; let updated = 0;
      for (const r of rows) {
        if (Number(r.price) < 0) throw new HttpError(400, `${r.code}: giá không âm`);
        const x = await one(tx, `INSERT INTO service_prices(code, name, unit, price, care_key, lab_type, sort, note, active, updated_at) VALUES ($1,$2,$3,$4,$5,$6,coalesce($7, 50),$8,$9, now())
                                 ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit, price = EXCLUDED.price, care_key = EXCLUDED.care_key,
                                   lab_type = EXCLUDED.lab_type, sort = EXCLUDED.sort, note = EXCLUDED.note, active = EXCLUDED.active, updated_at = now()
                                 RETURNING (xmax = 0) AS inserted`, [r.code, r.name, r.unit, r.price, r.care_key, r.lab_type, r.sort, r.note, r.active]);
        if (x.inserted) inserted++; else updated++;
      }
      return { inserted, updated };
    },
  },
  {
    key: 'bang-gia-xe', label: 'Bảng giá theo loại xe', domain: 'ke_toan', keyCol: 'vehicle_type',
    cols: [
      { key: 'vehicle_type', header: 'Loại xe', type: 'enum', required: true, values: VEHICLE_TYPE, width: 10 },
      { key: 'name', header: 'Tên bảng giá', type: 'text', required: true, width: 30 }, { key: 'base_fee', header: 'Giá mở cửa', type: 'number', required: true, width: 14 },
      { key: 'base_km', header: 'Số km đầu', type: 'number', width: 10 }, { key: 'per_km', header: 'Giá mỗi km', type: 'number', width: 12 },
      { key: 'wait_per_hour', header: 'Giá chờ mỗi giờ', type: 'number', width: 14 }, { key: 'night_surcharge_pct', header: 'Phụ thu đêm (%)', type: 'number', width: 14 },
      { key: 'vat_rate', header: 'Thuế GTGT (%)', type: 'number', width: 12 }, { key: 'effective_from', header: 'Áp dụng từ', type: 'date', width: 12 },
    ],
    guide: ['Mỗi loại xe một bảng giá đang dùng. Đổi số liệu thì hệ thống tạo bảng giá mới thay bảng cũ (bảng cũ giữ lại để tra khoản thu cũ).'],
    current: (q) => many(q, `SELECT vehicle_type, name, base_fee::float AS base_fee, base_km::float AS base_km, per_km::float AS per_km, wait_per_hour::float AS wait_per_hour,
                                    night_surcharge_pct::float AS night_surcharge_pct, vat_rate::float AS vat_rate, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
                               FROM price_lists WHERE active ORDER BY vehicle_type`),
    async apply(tx, rows) {
      let inserted = 0; let updated = 0;
      for (const r of rows) {
        for (const k of ['base_fee', 'base_km', 'per_km', 'wait_per_hour', 'night_surcharge_pct', 'vat_rate'] as const) {
          if (num(r[k]) != null && num(r[k])! < 0) throw new HttpError(400, `Bảng giá ${r.vehicle_type}: số liệu không âm`);
        }
        const old = await tx.query('UPDATE price_lists SET active = false WHERE vehicle_type = $1 AND active', [r.vehicle_type]);
        await tx.query(`INSERT INTO price_lists(name, vehicle_type, base_fee, base_km, per_km, wait_per_hour, night_surcharge_pct, vat_rate, effective_from)
                        VALUES ($1,$2,$3,coalesce($4,0),coalesce($5,0),coalesce($6,0),coalesce($7,0),coalesce($8,0), coalesce($9::date, vn_today()))`,
        [r.name, r.vehicle_type, r.base_fee, r.base_km, r.per_km, r.wait_per_hour, r.night_surcharge_pct, r.vat_rate, r.effective_from]);
        if (old.rowCount) updated++; else inserted++;
      }
      return { inserted, updated };
    },
  },
  {
    key: 'loai-thiet-bi', label: 'Loại thiết bị', domain: 'thiet_bi', keyCol: 'name',
    cols: [
      { key: 'name', header: 'Loại thiết bị', type: 'text', required: true, width: 36 },
      { key: 'maintenance_days', header: 'Bảo trì (ngày)', type: 'int', width: 14 }, { key: 'inspection_days', header: 'Kiểm định (ngày)', type: 'int', width: 14 },
      { key: 'calibration_days', header: 'Hiệu chuẩn (ngày)', type: 'int', width: 14 }, { key: 'active', header: 'Đang dùng', type: 'bool', width: 10 },
    ],
    guide: ['Chu kỳ tính bằng ngày, để trống nếu loại thiết bị đó không cần.'],
    current: (q) => many(q, `SELECT name, maintenance_days, inspection_days, calibration_days, active FROM equipment_types ORDER BY name`),
    async apply(tx, rows) {
      let inserted = 0; let updated = 0;
      for (const r of rows) {
        const x = await one(tx, `INSERT INTO equipment_types(name, maintenance_days, inspection_days, calibration_days, active) VALUES ($1,$2,$3,$4,$5)
                                 ON CONFLICT (name) DO UPDATE SET maintenance_days = EXCLUDED.maintenance_days, inspection_days = EXCLUDED.inspection_days,
                                   calibration_days = EXCLUDED.calibration_days, active = EXCLUDED.active RETURNING (xmax = 0) AS inserted`,
        [r.name, r.maintenance_days, r.inspection_days, r.calibration_days, r.active]);
        if (x.inserted) inserted++; else updated++;
      }
      return { inserted, updated };
    },
  },
  {
    key: 'vi-tri-kip', label: 'Vị trí trong kíp', domain: 'kip', keyCol: 'name',
    cols: [
      { key: 'name', header: 'Vị trí', type: 'text', required: true, width: 24 }, { key: 'sort', header: 'Thứ tự', type: 'int', width: 8 },
      { key: 'active', header: 'Đang dùng', type: 'bool', width: 10 },
    ],
    guide: ['Vị trí trong kíp: Trưởng kíp, Bác sĩ, Điều dưỡng 1, Điều dưỡng 2, Lái xe...'],
    current: (q) => many(q, `SELECT name, sort, active FROM crew_roles ORDER BY sort, name`),
    async apply(tx, rows) {
      let inserted = 0; let updated = 0;
      for (const r of rows) {
        const x = await one(tx, `INSERT INTO crew_roles(name, sort, active) VALUES ($1, coalesce($2, 0), $3)
                                 ON CONFLICT (name) DO UPDATE SET sort = EXCLUDED.sort, active = EXCLUDED.active RETURNING (xmax = 0) AS inserted`, [r.name, r.sort, r.active]);
        if (x.inserted) inserted++; else updated++;
      }
      return { inserted, updated };
    },
  },
  {
    key: 'viec-kip', label: 'Việc từng vị trí trong kíp', domain: 'kip', keyCol: 'position',
    cols: [
      { key: 'position', header: 'Vị trí', type: 'text', required: true, width: 20 }, { key: 'phase', header: 'Lúc', type: 'enum', required: true, values: PHASE, width: 16 },
      { key: 'task', header: 'Việc', type: 'text', required: true, width: 60 },
    ],
    guide: ['Mỗi dòng một việc. Vị trí nào có trong tệp thì danh sách việc của vị trí đó được thay bằng các dòng trong tệp; vị trí không có trong tệp giữ nguyên.'],
    current: (q) => many(q, `SELECT position, phase, task FROM crew_duty_tasks ORDER BY position, phase, sort, id`),
    async apply(tx, rows) {
      const positions = [...new Set(rows.map((r) => String(r.position)))];
      for (const p of positions) if (!(await one(tx, 'SELECT 1 FROM crew_roles WHERE name = $1', [p]))) throw new HttpError(400, `Không có vị trí "${p}" trong danh mục vị trí`);
      const old = await tx.query('DELETE FROM crew_duty_tasks WHERE position = ANY($1)', [positions]);
      let i = 0;
      for (const r of rows) await tx.query('INSERT INTO crew_duty_tasks(position, phase, sort, task) VALUES ($1,$2,$3,$4)', [r.position, r.phase, ++i, r.task]);
      return { inserted: rows.length, updated: old.rowCount ?? 0 };
    },
  },
  {
    key: 'bo-phan', label: 'Bộ phận (sơ đồ tổ chức)', domain: 'nhan_su', keyCol: 'code',
    cols: [
      { key: 'code', header: 'Mã bộ phận', type: 'text', required: true, width: 14 }, { key: 'name', header: 'Tên bộ phận', type: 'text', required: true, width: 34 },
      { key: 'parent', header: 'Mã bộ phận cấp trên', type: 'text', width: 18 },
      { key: 'domain', header: 'Mảng phụ trách', type: 'enum', required: true, values: ORG_DOMAIN, width: 20 },
      { key: 'sort', header: 'Thứ tự', type: 'int', width: 8 }, { key: 'active', header: 'Đang dùng', type: 'bool', width: 10 },
    ],
    guide: ['Mã có sẵn thì sửa, mã mới thì thêm. Bộ phận cấp trên ghi bằng mã (để trống chỉ dành cho Ban Giám đốc).', 'Xếp người và chỉ định trưởng nhóm làm ở màn hình Bộ phận.'],
    current: (q) => many(q, `SELECT o.code, o.name, p.code AS parent, o.domain, o.sort, o.active FROM org_units o LEFT JOIN org_units p ON p.id = o.parent_id ORDER BY o.sort, o.code`),
    async apply(tx, rows) {
      let inserted = 0; let updated = 0;
      // Thêm trước rồi mới gắn cấp trên, để cấp trên mới trong cùng tệp cũng dùng được
      for (const r of rows) {
        const code = String(r.code).toUpperCase();
        if (!/^[A-Z0-9-]{2,20}$/.test(code)) throw new HttpError(400, `Mã bộ phận "${r.code}" không hợp lệ`);
        const x = await one(tx, `INSERT INTO org_units(code, name, domain, sort, active) VALUES ($1,$2,$3,coalesce($4,0),$5)
                                 ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, domain = EXCLUDED.domain, sort = EXCLUDED.sort, active = EXCLUDED.active
                                 RETURNING (xmax = 0) AS inserted`, [code, r.name, r.domain, r.sort, r.active]);
        if (x.inserted) inserted++; else updated++;
      }
      for (const r of rows) {
        const code = String(r.code).toUpperCase();
        if (!r.parent) { if (code !== 'BGD') throw new HttpError(400, `Bộ phận ${code} cần mã bộ phận cấp trên`); continue; }
        const parent = await one(tx, 'SELECT id FROM org_units WHERE code = $1', [String(r.parent).toUpperCase()]);
        if (!parent) throw new HttpError(400, `Bộ phận ${code}: không có bộ phận cấp trên ${r.parent}`);
        await tx.query('UPDATE org_units SET parent_id = $2 WHERE code = $1', [code, parent.id]);
      }
      const loop = await one(tx, `WITH RECURSIVE up AS (SELECT id, parent_id, ARRAY[id] AS path FROM org_units
                                    UNION ALL SELECT up.id, o.parent_id, up.path || o.id FROM up JOIN org_units o ON o.id = up.parent_id WHERE NOT o.id = ANY(up.path))
                                  SELECT 1 FROM up WHERE parent_id = ANY(path) LIMIT 1`);
      if (loop) throw new HttpError(400, 'Sơ đồ có vòng lặp: một bộ phận là cấp trên của chính nó');
      return { inserted, updated };
    },
  },
];

export const sheetByKey = (key: string) => SHEETS.find((s) => s.key === key);

export async function sheetWorkbook(q: Queryable, sheet: Sheet) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Medone';
  const ws = wb.addWorksheet('Dữ liệu');
  ws.columns = sheet.cols.map((c) => ({ width: c.width ?? 16 }));
  // Cột chữ để dạng văn bản: mã số thuế, điện thoại không bị mất số 0 đầu
  sheet.cols.forEach((c, i) => { if (c.type === 'text') ws.getColumn(i + 1).numFmt = '@'; });
  const head = ws.addRow(sheet.cols.map((c) => (c.required ? `${c.header} *` : c.header)));
  head.font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of await sheet.current(q)) {
    ws.addRow(sheet.cols.map((c) => {
      const v = r[c.key];
      if (c.type === 'bool') return v === false ? 'Không' : 'Có';
      if (c.type === 'enum') return v == null ? null : c.values?.[String(v)] ?? v;
      return v ?? null;
    }));
  }
  const guide = wb.addWorksheet('Hướng dẫn');
  guide.addRows([
    [`Danh mục: ${sheet.label}. Sửa trang "Dữ liệu" rồi nạp lại ở màn hình Quản trị → File mẫu.`],
    ['Cột có dấu * là bắt buộc. Không đổi tên trang, tên cột. Cột "Đang dùng" ghi Có hoặc Không.'],
    ...sheet.cols.filter((c) => c.type === 'enum').map((c) => [`"${c.header}" ghi một trong: ${Object.values(c.values ?? {}).join(', ')}`]),
    ...sheet.guide.map((g) => [g]),
    ['Nạp lên chỉ so với dữ liệu đang dùng; bấm "Áp dụng" mới ghi. Đã khóa cấu hình thì "Áp dụng" thành đề xuất chờ quản trị duyệt.'],
  ]);
  guide.getColumn(1).width = 120;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Đọc tệp nạp lên, so với dữ liệu đang dùng: dòng thêm, dòng sửa, số dòng giữ nguyên, dòng lỗi. Không ghi gì. */
export async function parseSheet(q: Queryable, sheet: Sheet, buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { throw new HttpError(400, 'Tệp không phải Excel (.xlsx) hợp lệ'); }
  const ws = wb.getWorksheet('Dữ liệu') ?? wb.worksheets[0];
  if (!ws) throw new HttpError(400, 'Tệp không có trang dữ liệu');
  const headerIdx = new Map<string, number>();
  ws.getRow(1).eachCell((cell, i) => headerIdx.set(cellText(cell.value).replace(/\*/g, '').trim().toLowerCase(), i));
  const missing = sheet.cols.filter((c) => c.required && !headerIdx.has(c.header.toLowerCase()));
  if (missing.length) throw new HttpError(400, `Thiếu cột: ${missing.map((c) => c.header).join(', ')}. Tải file mẫu mới để đúng tên cột.`);

  const rows: Row[] = []; const errors: { row: number; error: string }[] = [];
  const seen = new Set<string>();
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const raw: Record<string, unknown> = {};
    let empty = true;
    for (const c of sheet.cols) {
      const i = headerIdx.get(c.header.toLowerCase());
      const cv = i ? row.getCell(i).value : null;
      const v = typeof cv === 'number' ? cv : cellText(cv);
      if (String(v).trim()) empty = false;
      raw[c.key] = v;
    }
    if (empty) return;
    try {
      const r = normalizeRow(sheet, raw);
      const k = String(r[sheet.keyCol]);
      // Riêng việc kíp: nhiều dòng cùng vị trí là bình thường
      if (sheet.key !== 'viec-kip') {
        if (seen.has(k)) throw new Error(`trùng "${sheet.cols.find((c) => c.key === sheet.keyCol)?.header}" ${k}`);
        seen.add(k);
      }
      rows.push(r);
    } catch (e) { errors.push({ row: n, error: (e as Error).message }); }
  });
  if (rows.length > 2000) throw new HttpError(400, 'Tệp quá 2000 dòng: chia nhỏ để nạp');

  const current = await sheet.current(q);
  if (sheet.key === 'viec-kip') {
    // So theo cả danh sách việc của từng vị trí
    const byPos = (list: Row[]) => list.reduce<Record<string, string>>((m, r) => { m[String(r.position)] = `${m[String(r.position)] ?? ''}|${r.phase}:${r.task}`; return m; }, {});
    const cur = byPos(current); const next = byPos(rows);
    const changedPos = new Set(Object.keys(next).filter((p) => cur[p] !== next[p]));
    const changes = rows.filter((r) => changedPos.has(String(r.position))).map((r) => ({ ...r, _action: cur[String(r.position)] ? 'sua' : 'them' }));
    return { changes, unchanged: rows.length - changes.length, errors, total: rows.length };
  }
  const curByKey = new Map(current.map((r) => [String(r[sheet.keyCol]).toUpperCase(), r]));
  const changes: Row[] = []; let unchanged = 0;
  for (const r of rows) {
    const c = curByKey.get(String(r[sheet.keyCol]).toUpperCase());
    if (!c) changes.push({ ...r, _action: 'them' });
    else if (sheet.cols.some((col) => !same(col.type === 'number' || col.type === 'int' ? num(c[col.key]) : c[col.key], r[col.key]))) changes.push({ ...r, _action: 'sua' });
    else unchanged++;
  }
  return { changes, unchanged, errors, total: rows.length };
}

/** Ghi các dòng đã đọc (kiểm tra lại từng dòng vì nội dung có thể đã qua phiếu đề xuất) */
export async function applySheet(tx: Tx, actor: Actor, sheet: Sheet, input: Record<string, unknown>[]) {
  const rows = input.map((raw, i) => {
    try { return normalizeRow(sheet, raw); } catch (e) { throw new HttpError(400, `Dòng ${i + 1}: ${(e as Error).message}`); }
  });
  if (!rows.length) throw new HttpError(400, 'Không có dòng nào để áp dụng');
  const r = await sheet.apply(tx, rows);
  await audit(tx, 'system', actor, 'sheet.applied', 'sheet', sheet.key, { rows: rows.length, ...r });
  return r;
}
