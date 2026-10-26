import type pg from 'pg';
import { createPool, withTx } from './db.js';
import { migrate } from './migrate.js';
import { seedQcSets } from './qc.js';
import { seedTraining } from './training.js';
import { seedQms } from './qms.js';
import { seedCompliance } from './compliance.js';
import { BUNDLED_HOSPITALS, BUNDLED_ICD, HOSPITAL_DEPTS, importHospitals, importIcd } from './tools/importers.js';

/**
 * Danh mục dùng chung: bệnh viện và khoa nhận bệnh, mã ICD-10, thuốc.
 * - Bệnh viện: danh sách cơ sở KCB TP.HCM của Medone (server/data/co-so-kcb-tphcm-2022.csv, theo BHXH TP.HCM quý 3/2022)
 *   cộng các bệnh viện tuyến cuối thường nhận chuyển viện nhưng không có trong danh sách đăng ký KCB ban đầu.
 * - ICD-10: danh mục Bộ Y tế ngày 19/08/2021 (server/data/icd10-byt-2021.csv).
 * Nạp lại không xóa dữ liệu đã có; danh sách mới hơn nạp bằng import:hospitals / import:icd.
 */

const GENERAL_DEPTS = HOSPITAL_DEPTS;
const OB_DEPTS = ['Khoa Cấp cứu', 'Khoa Sanh', 'Khoa Hồi sức sơ sinh', 'Khoa Hậu sản'];
const PED_DEPTS = ['Khoa Cấp cứu', 'Khoa Hồi sức tích cực – Chống độc', 'Khoa Sơ sinh', 'Khoa Ngoại'];

/** Bệnh viện tuyến cuối/chuyên khoa nhận chuyển viện, không nằm trong danh sách đăng ký KCB ban đầu */
export const HOSPITALS: { name: string; departments: string[]; capabilities?: string[]; address?: string }[] = [
  { name: 'Bệnh viện Chợ Rẫy', address: '201B Nguyễn Chí Thanh, Phường 12, Quận 5', departments: GENERAL_DEPTS, capabilities: ['Can thiệp tim 24/7', 'Lấy huyết khối', 'Chấn thương'] },
  { name: 'Bệnh viện Đại học Y Dược TP.HCM', address: '215 Hồng Bàng, Phường 11, Quận 5', departments: GENERAL_DEPTS, capabilities: ['Can thiệp tim 24/7', 'Lấy huyết khối'] },
  { name: 'Bệnh viện Bình Dân', address: '371 Điện Biên Phủ, Phường 4, Quận 3', departments: ['Khoa Cấp cứu', 'Khoa Hồi sức', 'Khoa Ngoại tổng hợp', 'Khoa Niệu'] },
  { name: 'Bệnh viện Chấn thương Chỉnh hình TP.HCM', address: '929 Trần Hưng Đạo, Phường 1, Quận 5', departments: ['Khoa Cấp cứu', 'Khoa Hồi sức', 'Khoa Chấn thương'], capabilities: ['Chấn thương'] },
  { name: 'Viện Tim TP.HCM', address: '4 Dương Quang Trung, Phường 12, Quận 10', departments: ['Khoa Cấp cứu', 'Khoa Hồi sức', 'Khoa Tim mạch can thiệp'], capabilities: ['Can thiệp tim 24/7'] },
  { name: 'Bệnh viện Tim Tâm Đức', address: '4 Nguyễn Lương Bằng, Phường Tân Phú, Quận 7', departments: ['Khoa Cấp cứu', 'Khoa Hồi sức', 'Khoa Tim mạch can thiệp'], capabilities: ['Can thiệp tim 24/7'] },
  { name: 'Bệnh viện Từ Dũ', address: '284 Cống Quỳnh, Phường Phạm Ngũ Lão, Quận 1', departments: OB_DEPTS, capabilities: ['Sản'] },
  { name: 'Bệnh viện Hùng Vương', address: '128 Hồng Bàng, Phường 12, Quận 5', departments: OB_DEPTS, capabilities: ['Sản'] },
  { name: 'Bệnh viện Nhi Đồng 1', address: '341 Sư Vạn Hạnh, Phường 10, Quận 10', departments: PED_DEPTS, capabilities: ['Nhi'] },
  { name: 'Bệnh viện Nhi Đồng 2', address: '14 Lý Tự Trọng, Phường Bến Nghé, Quận 1', departments: PED_DEPTS, capabilities: ['Nhi'] },
  { name: 'Bệnh viện Bệnh Nhiệt đới', address: '764 Võ Văn Kiệt, Phường 1, Quận 5', departments: ['Khoa Cấp cứu', 'Khoa Hồi sức tích cực – Chống độc', 'Khoa Nhiễm'] },
];

/** Năng lực đặc biệt của một số cơ sở trong danh sách KCB (theo mã KCB), dùng để gợi ý bệnh viện đích */
const CAPABILITIES_BY_KCB: Record<string, string[]> = {
  '79024': ['Can thiệp tim 24/7', 'Lấy huyết khối'],   // BV Nhân dân 115
  '79030': ['Can thiệp tim 24/7', 'Tiêu sợi huyết'],   // BV Nhân dân Gia Định
  '79025': ['Can thiệp tim 24/7'],                       // BV Thống Nhất
  '79034': ['Can thiệp tim 24/7', 'Chấn thương'],       // BV 175
  '79532': ['Nhi'],                                      // BV Nhi đồng Thành phố
};

/** Mã ICD-10 hay gặp trong cấp cứu ngoại viện; danh mục đầy đủ của Bộ Y tế nạp bằng import:icd */
export const ICD_STARTER: [string, string][] = [
  ['I21.9', 'Nhồi máu cơ tim cấp, không đặc hiệu'],
  ['I21.0', 'Nhồi máu cơ tim cấp xuyên thành ở thành trước'],
  ['I20.0', 'Cơn đau thắt ngực không ổn định'],
  ['I46.9', 'Ngừng tim, không đặc hiệu'],
  ['I49.0', 'Rung thất và cuồng thất'],
  ['I48', 'Rung nhĩ và cuồng nhĩ'],
  ['I50.9', 'Suy tim, không đặc hiệu'],
  ['I10', 'Bệnh lý tăng huyết áp vô căn (nguyên phát)'],
  ['I63.9', 'Nhồi máu não, không đặc hiệu'],
  ['I61.9', 'Xuất huyết trong não, không đặc hiệu'],
  ['I64', 'Đột quỵ, không xác định do xuất huyết hay nhồi máu'],
  ['G45.9', 'Cơn thiếu máu não cục bộ thoáng qua, không đặc hiệu'],
  ['G40.9', 'Động kinh, không đặc hiệu'],
  ['R56.8', 'Co giật khác và không đặc hiệu'],
  ['R40.2', 'Hôn mê, không đặc hiệu'],
  ['R55', 'Ngất và suy sụp'],
  ['J45.9', 'Hen, không đặc hiệu'],
  ['J46', 'Cơn hen ác tính'],
  ['J44.1', 'Bệnh phổi tắc nghẽn mạn tính với đợt cấp, không đặc hiệu'],
  ['J18.9', 'Viêm phổi, không đặc hiệu'],
  ['J96.0', 'Suy hô hấp cấp'],
  ['T78.2', 'Sốc phản vệ, không đặc hiệu'],
  ['R57.9', 'Sốc, không đặc hiệu'],
  ['A41.9', 'Nhiễm khuẩn huyết, không đặc hiệu'],
  ['E16.2', 'Hạ đường huyết, không đặc hiệu'],
  ['K92.2', 'Xuất huyết tiêu hóa, không đặc hiệu'],
  ['K35.8', 'Viêm ruột thừa cấp, khác và không đặc hiệu'],
  ['N23', 'Cơn đau quặn thận, không đặc hiệu'],
  ['O80', 'Đẻ thường một thai'],
  ['O15.9', 'Sản giật, không xác định thời gian'],
  ['S06.0', 'Chấn động não'],
  ['S06.9', 'Tổn thương nội sọ, không đặc hiệu'],
  ['S12.9', 'Gãy cổ, phần không xác định'],
  ['S22.4', 'Gãy nhiều xương sườn'],
  ['S27.0', 'Tràn khí màng phổi do chấn thương'],
  ['S36.9', 'Tổn thương cơ quan trong ổ bụng không xác định'],
  ['S42.0', 'Gãy xương đòn'],
  ['S52.9', 'Gãy cẳng tay, phần không xác định'],
  ['S72.0', 'Gãy cổ xương đùi'],
  ['S72.3', 'Gãy thân xương đùi'],
  ['S82.2', 'Gãy thân xương chày'],
  ['T07', 'Đa chấn thương không đặc hiệu'],
  ['T14.9', 'Tổn thương, không đặc hiệu'],
  ['T30.0', 'Bỏng, vùng cơ thể không xác định, độ không xác định'],
  ['T75.4', 'Tác dụng của dòng điện'],
  ['T71', 'Ngạt'],
  ['T75.1', 'Đuối nước và chìm không chết'],
  ['T67.0', 'Say nóng và say nắng'],
  ['T65.9', 'Tác dụng độc của chất không xác định'],
  ['T51.0', 'Tác dụng độc của ethanol'],
  ['T60.0', 'Tác dụng độc của thuốc trừ sâu phospho hữu cơ và carbamat'],
  ['T63.0', 'Nọc rắn'],
  ['F10.0', 'Rối loạn tâm thần và hành vi do rượu: nhiễm độc cấp'],
  ['F41.0', 'Rối loạn hoảng sợ'],
  ['R07.4', 'Đau ngực, không đặc hiệu'],
  ['R10.4', 'Đau bụng khác và không đặc hiệu'],
  ['R50.9', 'Sốt, không đặc hiệu'],
  ['R06.0', 'Khó thở'],
];

/** Thuốc gây nghiện, hướng thần: dùng cho người bệnh phải có người chứng kiến */
export const CONTROLLED = /^(morphin|fentanyl|midazolam|diazepam|ketamin|pethidin)/i;

export const DRUGS: [string, string, string][] = [
  ['Adrenalin 1 mg/1 ml', 'ống', 'TM'],
  ['Amiodaron 150 mg/3 ml', 'ống', 'TM'],
  ['Atropin sulfat 0,25 mg/1 ml', 'ống', 'TM'],
  ['Diazepam 10 mg/2 ml', 'ống', 'TM'],
  ['Midazolam 5 mg/1 ml', 'ống', 'TM'],
  ['Morphin 10 mg/1 ml', 'ống', 'TM'],
  ['Fentanyl 0,1 mg/2 ml', 'ống', 'TM'],
  ['Naloxon 0,4 mg/1 ml', 'ống', 'TM'],
  ['Glucose 30% 5 ml', 'ống', 'TM'],
  ['Natri clorid 0,9% 500 ml', 'chai', 'TTM'],
  ['Ringer lactat 500 ml', 'chai', 'TTM'],
  ['Salbutamol 2,5 mg/2,5 ml (khí dung)', 'ống', 'Khí dung'],
  ['Methylprednisolon 40 mg', 'lọ', 'TM'],
  ['Dexamethason 4 mg/1 ml', 'ống', 'TM'],
  ['Diphenhydramin 10 mg/1 ml', 'ống', 'TB'],
  ['Furosemid 20 mg/2 ml', 'ống', 'TM'],
  ['Aspirin 81 mg', 'viên', 'Uống'],
  ['Clopidogrel 75 mg', 'viên', 'Uống'],
  ['Nitroglycerin 0,4 mg (xịt dưới lưỡi)', 'nhát xịt', 'Dưới lưỡi'],
  ['Paracetamol 1 g/100 ml', 'chai', 'TTM'],
  ['Ondansetron 8 mg/4 ml', 'ống', 'TM'],
  ['Acid tranexamic 250 mg/5 ml', 'ống', 'TM'],
  ['Oxytocin 5 UI/1 ml', 'ống', 'TB'],
  ['Magnesi sulfat 15% 10 ml', 'ống', 'TM'],
];

/** Loại trang thiết bị và chu kỳ (ngày) bảo dưỡng, kiểm định, hiệu chuẩn — quản trị sửa được (QLCL-15) */
export const EQUIPMENT_TYPES: [string, number | null, number | null, number | null][] = [
  ['Máy sốc điện – monitor', 180, 365, 365],
  ['Máy sốc điện tự động (AED)', 180, 365, null],
  ['Máy thở vận chuyển', 180, 365, 365],
  ['Bơm tiêm điện', 180, null, 365],
  ['Máy hút đàm', 180, null, null],
  ['Bình oxy và van giảm áp', 90, 365, null],
  ['Máy đo SpO2 cầm tay', 365, null, 365],
  ['Cáng chính', 90, null, null],
  ['Ván cứng cố định cột sống', 180, null, null],
  ['Máy ép tim tự động', 180, 365, 365],
  ['Máy CT di động', 90, 365, 180],
  ['Máy ECMO', 90, 365, 180],
];

/** Thiết bị bắt buộc theo loại xe: thiếu, hỏng hoặc quá hạn kiểm định thì xe không được giao */
export const REQUIRED_EQUIPMENT: Record<string, [string, number][]> = {
  ALS: [['Máy sốc điện – monitor', 1], ['Máy thở vận chuyển', 1], ['Bơm tiêm điện', 1], ['Máy hút đàm', 1], ['Bình oxy và van giảm áp', 2], ['Cáng chính', 1], ['Ván cứng cố định cột sống', 1]],
  DP: [['Máy sốc điện – monitor', 1], ['Máy hút đàm', 1], ['Bình oxy và van giảm áp', 2], ['Cáng chính', 1], ['Ván cứng cố định cột sống', 1]],
  BLS: [['Máy sốc điện tự động (AED)', 1], ['Máy hút đàm', 1], ['Bình oxy và van giảm áp', 1], ['Cáng chính', 1], ['Ván cứng cố định cột sống', 1]],
  MSU: [['Máy CT di động', 1], ['Máy sốc điện – monitor', 1], ['Bình oxy và van giảm áp', 1], ['Cáng chính', 1]],
  ECMO: [['Máy ECMO', 1], ['Máy sốc điện – monitor', 1], ['Máy thở vận chuyển', 1], ['Bơm tiêm điện', 2], ['Bình oxy và van giảm áp', 2], ['Cáng chính', 1]],
  VC: [['Bình oxy và van giảm áp', 1], ['Máy đo SpO2 cầm tay', 1], ['Cáng chính', 1]],
};

/** Cơ số thuốc chuẩn trên mỗi loại xe đầu ca (bản nháp, Hội đồng Chuyên môn duyệt) */
const ALS_PAR: [string, number][] = [
  ['Adrenalin 1 mg/1 ml', 10], ['Amiodaron 150 mg/3 ml', 3], ['Atropin sulfat 0,25 mg/1 ml', 6], ['Diazepam 10 mg/2 ml', 2],
  ['Midazolam 5 mg/1 ml', 3], ['Morphin 10 mg/1 ml', 2], ['Fentanyl 0,1 mg/2 ml', 2], ['Naloxon 0,4 mg/1 ml', 2],
  ['Glucose 30% 5 ml', 4], ['Natri clorid 0,9% 500 ml', 4], ['Ringer lactat 500 ml', 2], ['Salbutamol 2,5 mg/2,5 ml (khí dung)', 4],
  ['Methylprednisolon 40 mg', 2], ['Furosemid 20 mg/2 ml', 4], ['Aspirin 81 mg', 8], ['Clopidogrel 75 mg', 8],
  ['Nitroglycerin 0,4 mg (xịt dưới lưỡi)', 1], ['Acid tranexamic 250 mg/5 ml', 4], ['Magnesi sulfat 15% 10 ml', 2],
];
export const PAR_LEVELS: Record<string, [string, number][]> = {
  ALS: ALS_PAR,
  DP: ALS_PAR,
  ECMO: ALS_PAR,
  MSU: [['Adrenalin 1 mg/1 ml', 5], ['Atropin sulfat 0,25 mg/1 ml', 2], ['Natri clorid 0,9% 500 ml', 2], ['Glucose 30% 5 ml', 2], ['Aspirin 81 mg', 4]],
  BLS: [['Adrenalin 1 mg/1 ml', 3], ['Glucose 30% 5 ml', 2], ['Natri clorid 0,9% 500 ml', 2], ['Salbutamol 2,5 mg/2,5 ml (khí dung)', 2], ['Aspirin 81 mg', 4]],
  VC: [['Natri clorid 0,9% 500 ml', 1]],
};

/**
 * Nạp danh mục đi kèm. Danh sách bệnh viện nạp mỗi lần (nhanh, không ghi đè khoa đã sửa);
 * ICD-10 Bộ Y tế chỉ nạp khi bảng còn ít mã hoặc khi gọi với force (lệnh npm run catalog).
 */
/** Bảng giá mẫu để thử tính tiền: [loại xe, giá mở cửa, số km gồm trong giá mở cửa, đ/km tiếp theo, đ/giờ chờ] */
export const SAMPLE_PRICES: [string, number, number, number, number][] = [
  ['ALS', 1_500_000, 10, 30_000, 300_000], ['BLS', 800_000, 10, 20_000, 200_000], ['MSU', 3_000_000, 10, 40_000, 500_000],
  ['ECMO', 10_000_000, 10, 60_000, 1_000_000], ['VC', 500_000, 10, 15_000, 100_000], ['DP', 800_000, 10, 20_000, 200_000],
];

export async function seedCatalog(pool: pg.Pool, opts: { force?: boolean } = {}) {
  const hosp = await importHospitals(pool, BUNDLED_HOSPITALS);
  for (const h of HOSPITALS) {
    const r = await pool.query(
      `INSERT INTO hospitals(name, capabilities, address, kind) VALUES ($1, $2, $3, 'Tuyến cuối, chuyên khoa')
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [h.name, h.capabilities ?? [], h.address ?? null]);
    for (const d of h.departments) {
      await pool.query('INSERT INTO hospital_departments(hospital_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [r.rows[0].id, d]);
    }
  }
  for (const [code, caps] of Object.entries(CAPABILITIES_BY_KCB)) {
    await pool.query(`UPDATE hospitals SET capabilities = $2 WHERE kcb_code = $1 AND capabilities = '{}'`, [code, caps]);
  }
  const icdCount = (await pool.query('SELECT count(*)::int AS n FROM icd10')).rows[0].n;
  let icd = 0;
  if (opts.force || icdCount < 5000) icd = await importIcd(pool, BUNDLED_ICD);
  for (const [code, name] of ICD_STARTER) {
    await pool.query('INSERT INTO icd10(code, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [code, name]);
  }
  for (const [name, unit, route] of DRUGS) {
    await pool.query('INSERT INTO drugs(name, unit, default_route, controlled) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [name, unit, route, CONTROLLED.test(name)]);
  }
  // Phân loại cho sổ thuốc kiểm soát đặc biệt; chỉ điền chỗ còn trống để không ghi đè dược sĩ đã chỉnh
  await pool.query(`UPDATE drugs SET control_class = CASE WHEN name ~* '^(morphin|fentanyl|pethidin)' THEN 'gay_nghien' ELSE 'huong_than' END
                     WHERE controlled AND control_class IS NULL AND name ~* '^(morphin|fentanyl|pethidin|midazolam|diazepam|ketamin)'`);
  for (const [name, m, i, c] of EQUIPMENT_TYPES) {
    await pool.query('INSERT INTO equipment_types(name, maintenance_days, inspection_days, calibration_days) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [name, m, i, c]);
  }
  // Danh mục bắt buộc và cơ số chuẩn chỉ nạp cho loại xe chưa cấu hình, để không ghi đè chỗ quản trị đã sửa
  for (const [vt, items] of Object.entries(REQUIRED_EQUIPMENT)) {
    if ((await pool.query('SELECT 1 FROM vehicle_required_equipment WHERE vehicle_type = $1 LIMIT 1', [vt])).rowCount) continue;
    for (const [name, qty] of items) {
      await pool.query(`INSERT INTO vehicle_required_equipment(vehicle_type, equipment_type_id, qty)
                        SELECT $1, id, $3 FROM equipment_types WHERE name = $2`, [vt, name, qty]);
    }
  }
  for (const [vt, items] of Object.entries(PAR_LEVELS)) {
    if ((await pool.query('SELECT 1 FROM par_levels WHERE vehicle_type = $1 LIMIT 1', [vt])).rowCount) continue;
    for (const [name, qty] of items) {
      await pool.query('INSERT INTO par_levels(vehicle_type, drug_id, qty) SELECT $1, id, $3 FROM drugs WHERE name = $2', [vt, name, qty]);
    }
  }
  // Bảng giá mẫu cho loại xe chưa có bảng giá; kế toán thay bằng giá theo quyết định của công ty ở trang Tài chính
  for (const [vt, base, baseKm, perKm, wait] of SAMPLE_PRICES) {
    if ((await pool.query('SELECT 1 FROM price_lists WHERE vehicle_type = $1 LIMIT 1', [vt])).rowCount) continue;
    await pool.query(`INSERT INTO price_lists(name, vehicle_type, base_fee, base_km, per_km, wait_per_hour, night_surcharge_pct)
                      VALUES ($1, $2, $3, $4, $5, $6, 20)`, [`Bảng giá mẫu ${vt} (cần cập nhật)`, vt, base, baseKm, perKm, wait]);
  }
  // Bộ tiêu chí chất lượng tham khảo (đơn vị CCNV 10 tiêu chí, TTCC 115 TP.HCM 41 tiêu chí) nếu chưa có; quản lý chất lượng nhân bản để sửa theo Medone
  await withTx(pool, (tx) => seedQcSets(tx));
  // Câu hỏi và bảng kiểm mẫu (dự thảo, chuyên môn duyệt mới dùng), danh mục quy trình công ty ở trạng thái cần soạn
  await withTx(pool, (tx) => seedTraining(tx));
  // Bộ chỉ số chất lượng, sổ rủi ro mẫu, thời hạn lưu hồ sơ đề xuất (QLCL xác nhận căn cứ)
  await withTx(pool, (tx) => seedQms(tx));
  // Sổ hoạt động xử lý dữ liệu cá nhân mẫu (pháp chế rà soát)
  await withTx(pool, (tx) => seedCompliance(tx));
  const counts = (await pool.query(`SELECT (SELECT count(*) FROM hospitals)::int AS hospitals, (SELECT count(*) FROM drugs)::int AS drugs,
                                           (SELECT count(*) FROM icd10)::int AS icd, (SELECT count(*) FROM tr_questions)::int AS questions,
                                           (SELECT count(*) FROM tr_procedures)::int AS procedures, (SELECT count(*) FROM qm_indicators)::int AS indicators,
                                           (SELECT count(*) FROM qm_risks)::int AS risks, (SELECT count(*) FROM qm_retention)::int AS retention, (SELECT count(*) FROM pd_activities)::int AS pd`)).rows[0];
  return { ...counts, newHospitals: hosp.hospitals, icdLoaded: icd };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool();
  migrate(pool)
    .then(() => seedCatalog(pool, { force: true }))
    .then((r) => {
      console.log(`Đã nạp danh mục: ${r.hospitals} bệnh viện/cơ sở KCB, ${r.icd} mã ICD-10, ${r.drugs} thuốc`);
      console.log(`Đào tạo: ${r.questions} câu hỏi, ${r.procedures} quy trình · Hệ thống chất lượng: ${r.indicators} chỉ số, ${r.risks} rủi ro, ${r.retention} loại hồ sơ lưu trữ · Dữ liệu cá nhân: ${r.pd} hoạt động xử lý`);
    })
    .finally(() => pool.end());
}
