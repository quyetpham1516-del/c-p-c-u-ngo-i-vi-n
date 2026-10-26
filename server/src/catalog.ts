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

/**
 * Vật tư tiêu hao, dụng cụ, văn phòng phẩm trên xe (bản nháp, điều dưỡng trưởng và dược sửa ở Kho → Cơ số xe).
 * [tên, đơn vị, nhóm, loại, quản lý lô/hạn, cơ số ALS, cơ số BLS]
 */
export const SUPPLIES: [string, string, string, 'vat_tu' | 'dung_cu' | 'van_phong_pham', boolean, number, number][] = [
  // Đường thở – Oxy
  ['Mask oxy người lớn', 'cái', 'duong_tho', 'vat_tu', false, 3, 2],
  ['Mask oxy trẻ em', 'cái', 'duong_tho', 'vat_tu', false, 2, 2],
  ['Mask có túi dự trữ người lớn', 'cái', 'duong_tho', 'vat_tu', false, 3, 2],
  ['Gọng mũi oxy (cannula)', 'cái', 'duong_tho', 'vat_tu', false, 4, 3],
  ['Dây nối oxy', 'sợi', 'duong_tho', 'vat_tu', false, 3, 2],
  ['Canuyn miệng hầu các cỡ (bộ)', 'bộ', 'duong_tho', 'dung_cu', false, 1, 1],
  ['Ống nội khí quản 6.5', 'cái', 'duong_tho', 'vat_tu', true, 2, 0],
  ['Ống nội khí quản 7.0', 'cái', 'duong_tho', 'vat_tu', true, 2, 0],
  ['Ống nội khí quản 7.5', 'cái', 'duong_tho', 'vat_tu', true, 2, 0],
  ['Mask thanh quản (LMA) số 4', 'cái', 'duong_tho', 'vat_tu', true, 1, 1],
  ['Dây cố định ống nội khí quản', 'cái', 'duong_tho', 'vat_tu', false, 2, 0],
  ['Sonde hút đàm số 12', 'cái', 'duong_tho', 'vat_tu', true, 5, 3],
  ['Sonde hút đàm số 14', 'cái', 'duong_tho', 'vat_tu', true, 5, 3],
  ['Bộ khí dung (mask + bầu)', 'bộ', 'duong_tho', 'vat_tu', false, 2, 2],
  ['Lọc khuẩn bóng bóp/máy thở', 'cái', 'duong_tho', 'vat_tu', true, 3, 2],
  // Tuần hoàn – Truyền dịch
  ['Bơm tiêm 1 ml', 'cái', 'tuan_hoan', 'vat_tu', true, 10, 5],
  ['Bơm tiêm 3 ml', 'cái', 'tuan_hoan', 'vat_tu', true, 10, 5],
  ['Bơm tiêm 5 ml', 'cái', 'tuan_hoan', 'vat_tu', true, 10, 5],
  ['Bơm tiêm 10 ml', 'cái', 'tuan_hoan', 'vat_tu', true, 10, 5],
  ['Bơm tiêm 20 ml', 'cái', 'tuan_hoan', 'vat_tu', true, 5, 2],
  ['Bơm tiêm 50 ml (bơm tiêm điện)', 'cái', 'tuan_hoan', 'vat_tu', true, 3, 0],
  ['Kim tiêm 18G', 'cái', 'tuan_hoan', 'vat_tu', true, 10, 5],
  ['Kim luồn 18G', 'cái', 'tuan_hoan', 'vat_tu', true, 4, 2],
  ['Kim luồn 20G', 'cái', 'tuan_hoan', 'vat_tu', true, 4, 2],
  ['Kim luồn 22G', 'cái', 'tuan_hoan', 'vat_tu', true, 4, 2],
  ['Kim luồn 24G', 'cái', 'tuan_hoan', 'vat_tu', true, 2, 1],
  ['Dây truyền dịch', 'bộ', 'tuan_hoan', 'vat_tu', true, 4, 2],
  ['Dây nối bơm tiêm điện', 'sợi', 'tuan_hoan', 'vat_tu', true, 2, 0],
  ['Khóa ba chạc', 'cái', 'tuan_hoan', 'vat_tu', true, 4, 2],
  ['Băng dán cố định kim luồn', 'miếng', 'tuan_hoan', 'vat_tu', false, 6, 4],
  ['Garo tĩnh mạch', 'sợi', 'tuan_hoan', 'dung_cu', false, 2, 1],
  ['Kim truyền tủy xương (IO)', 'cái', 'tuan_hoan', 'vat_tu', true, 1, 0],
  ['Điện cực dán monitor', 'miếng', 'tuan_hoan', 'vat_tu', true, 20, 10],
  ['Miếng dán sốc điện người lớn', 'cặp', 'tuan_hoan', 'vat_tu', true, 2, 2],
  ['Que thử đường huyết', 'que', 'tuan_hoan', 'vat_tu', true, 10, 10],
  ['Kim chích máu', 'cái', 'tuan_hoan', 'vat_tu', true, 10, 10],
  // Băng bó – Cố định – Vết thương
  ['Băng cá nhân', 'miếng', 'bang_bo', 'vat_tu', false, 20, 20],
  ['Gạc vô khuẩn 10x10', 'gói', 'bang_bo', 'vat_tu', true, 10, 10],
  ['Bông cồn (gạc tẩm cồn)', 'miếng', 'bang_bo', 'vat_tu', false, 20, 20],
  ['Băng cuộn 10 cm', 'cuộn', 'bang_bo', 'vat_tu', false, 6, 6],
  ['Băng thun 10 cm', 'cuộn', 'bang_bo', 'vat_tu', false, 4, 4],
  ['Băng dính lụa', 'cuộn', 'bang_bo', 'vat_tu', false, 2, 2],
  ['Băng ép cầm máu (Israeli)', 'cái', 'bang_bo', 'vat_tu', false, 2, 2],
  ['Garo cầm máu chi (CAT)', 'cái', 'bang_bo', 'dung_cu', false, 2, 2],
  ['Băng tam giác', 'cái', 'bang_bo', 'vat_tu', false, 2, 2],
  ['Nẹp cổ cứng người lớn', 'cái', 'bang_bo', 'dung_cu', false, 2, 2],
  ['Nẹp chi các cỡ (bộ)', 'bộ', 'bang_bo', 'dung_cu', false, 1, 1],
  ['Chăn giữ nhiệt (bạc)', 'tấm', 'bang_bo', 'vat_tu', false, 2, 2],
  ['Nước muối sinh lý rửa vết thương 500 ml', 'chai', 'bang_bo', 'vat_tu', true, 2, 2],
  // Sản – Nhi
  ['Bộ đỡ đẻ vô khuẩn', 'bộ', 'san_nhi', 'vat_tu', true, 1, 1],
  ['Kẹp rốn', 'cái', 'san_nhi', 'vat_tu', true, 2, 2],
  ['Bóng bóp sơ sinh (mask số 0, 1)', 'bộ', 'san_nhi', 'dung_cu', false, 1, 1],
  // Bảo hộ – Khử khuẩn
  ['Găng tay khám (đôi)', 'đôi', 'bao_ho', 'vat_tu', false, 30, 30],
  ['Găng tay vô khuẩn (đôi)', 'đôi', 'bao_ho', 'vat_tu', true, 5, 3],
  ['Khẩu trang y tế', 'cái', 'bao_ho', 'vat_tu', false, 20, 20],
  ['Khẩu trang N95', 'cái', 'bao_ho', 'vat_tu', false, 4, 4],
  ['Áo choàng phòng hộ', 'bộ', 'bao_ho', 'vat_tu', false, 2, 2],
  ['Kính chắn giọt bắn', 'cái', 'bao_ho', 'vat_tu', false, 2, 2],
  ['Dung dịch sát khuẩn tay nhanh 500 ml', 'chai', 'bao_ho', 'vat_tu', true, 1, 1],
  ['Túi đựng chất thải lây nhiễm (vàng)', 'cái', 'bao_ho', 'vat_tu', false, 5, 5],
  ['Hộp đựng vật sắc nhọn', 'hộp', 'bao_ho', 'vat_tu', false, 1, 1],
  ['Khăn lau khử khuẩn bề mặt', 'gói', 'bao_ho', 'vat_tu', true, 1, 1],
  // Văn phòng phẩm – Giấy tờ
  ['Phiếu chuyển viện in sẵn (dự phòng mất mạng)', 'tờ', 'van_phong_pham', 'van_phong_pham', false, 10, 10],
  ['Biên bản từ chối vận chuyển in sẵn', 'tờ', 'van_phong_pham', 'van_phong_pham', false, 5, 5],
  ['Bút bi', 'cây', 'van_phong_pham', 'van_phong_pham', false, 3, 3],
  ['Bút lông dầu', 'cây', 'van_phong_pham', 'van_phong_pham', false, 1, 1],
  ['Sổ ghi chép kíp', 'quyển', 'van_phong_pham', 'van_phong_pham', false, 1, 1],
  ['Giấy in điện tim (cuộn)', 'cuộn', 'van_phong_pham', 'van_phong_pham', false, 2, 0],
  ['Pin AA', 'viên', 'van_phong_pham', 'van_phong_pham', false, 4, 4],
  ['Bìa kẹp hồ sơ', 'cái', 'van_phong_pham', 'van_phong_pham', false, 2, 2],
  ['Thẻ phân loại nạn nhân (thảm họa)', 'thẻ', 'van_phong_pham', 'van_phong_pham', false, 20, 20],
];

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
  await pool.query(`UPDATE drugs SET kind = 'dich_truyen', group_code = 'tuan_hoan' WHERE kind = 'thuoc' AND name ~* '^(natri clorid 0,9% 500|ringer)'`);
  await pool.query(`UPDATE drugs SET group_code = 'thuoc_kiem_soat' WHERE controlled AND group_code = 'thuoc_cap_cuu'`);
  await pool.query(`UPDATE drugs SET group_code = 'san_nhi' WHERE group_code = 'thuoc_cap_cuu' AND name ~* '^oxytocin'`);
  for (const [name, unit, group, kind, lot] of SUPPLIES) {
    await pool.query(`INSERT INTO drugs(name, unit, kind, group_code, track_lot) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [name, unit, kind, group, lot]);
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
  // Cơ số vật tư, văn phòng phẩm mẫu: chỉ nạp cho loại xe chưa có dòng vật tư nào (không ghi đè chỗ đã sửa)
  const SUPPLY_PAR_TYPES: Record<string, 5 | 6> = { ALS: 5, DP: 5, ECMO: 5, MSU: 5, BLS: 6, VC: 6 };
  for (const [vt, col] of Object.entries(SUPPLY_PAR_TYPES)) {
    const has = await pool.query(`SELECT 1 FROM par_levels p JOIN drugs d ON d.id = p.drug_id WHERE p.vehicle_type = $1 AND d.kind NOT IN ('thuoc', 'dich_truyen') LIMIT 1`, [vt]);
    if (has.rowCount) continue;
    for (const row of SUPPLIES) {
      const qty = vt === 'VC' ? Math.min(row[col], 2) : row[col];
      if (qty > 0) await pool.query('INSERT INTO par_levels(vehicle_type, drug_id, qty) SELECT $1, id, $3 FROM drugs WHERE name = $2 ON CONFLICT DO NOTHING', [vt, row[0], qty]);
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
