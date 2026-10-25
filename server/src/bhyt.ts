import { createHash } from 'node:crypto';
import { decryptId } from './crypto.js';
import { many, one, type Queryable } from './db.js';

/**
 * Bảng kê BHYT cho chi phí vận chuyển người bệnh, xuất XML theo QĐ 130/QĐ-BYT (sửa đổi bởi QĐ 4750/QĐ-BYT):
 * Bảng 1 (tổng hợp) và Bảng 3 (dịch vụ kỹ thuật: dòng vận chuyển "VC.<mã nơi đến>"), gói trong hồ sơ gửi Cổng giám định.
 * Bản này chưa kê thuốc dùng trên xe (Bảng 2) vì danh mục thuốc chưa có mã hoạt chất và giá BHYT.
 * Mọi quy tắc tính và mã mặc định là bản nháp: kế toán đối chiếu với BHXH và kiểm thử trên cổng gdbhyt trước khi gửi thật.
 */

export interface BhytSettings {
  maCskcb: string;          // mã cơ sở KBCB của công ty do Sở Y tế/BHXH cấp
  maKhoa: string;           // mã khoa theo PL5 QĐ 5937 (cấp cứu)
  maNhomVc: string;         // mã nhóm chi phí vận chuyển theo PL3 QĐ 5937
  maLoaiKcb: string;        // mã hình thức KBCB (DMDC)
  maXangDau: string;        // mã loại xăng dầu (DMDC)
  fuelPrice: number;        // giá xăng dầu đang áp dụng (đồng/lít)
  litrePerKm: number;       // định mức nhiên liệu quỹ BHYT thanh toán cho mỗi km
  maTtdv: string;           // mã định danh y tế người đứng đầu hoặc được ủy quyền ký
  maBacSi: string;          // mã định danh y tế mặc định của người chỉ định khi phiếu chưa có
}
export const DEFAULT_BHYT: BhytSettings = {
  maCskcb: '', maKhoa: 'K01', maNhomVc: '12', maLoaiKcb: '01', maXangDau: '', fuelPrice: 0, litrePerKm: 0.2, maTtdv: '', maBacSi: '',
};
export async function getBhytSettings(q: Queryable): Promise<BhytSettings> {
  const r = await one(q, `SELECT value FROM finance_settings WHERE key = 'bhyt'`);
  return { ...DEFAULT_BHYT, ...(r?.value ?? {}) };
}

export interface BhytCard {
  cardNo: string; dkbd: string; validFrom: string; validTo: string; mucHuong: number;
  khuVuc?: string | null; doiTuongKcb?: string | null; noiDi?: string | null;
}

/* ---------------- Tính tiền một dòng vận chuyển ---------------- */

const r2 = (n: number) => Math.round(n * 100) / 100;
export function transportAmounts(p: { km: number; totalBv: number; s: BhytSettings; mucHuong: number }) {
  const donGiaBv = p.km > 0 ? r2(p.totalBv / p.km) : 0;
  const thanhTienBv = r2(p.totalBv);
  const donGiaBh = r2(p.s.litrePerKm * p.s.fuelPrice);
  // Quỹ không trả quá chi phí thực tế
  const thanhTienBh = Math.min(r2(p.km * donGiaBh), thanhTienBv);
  const bhtt = r2(thanhTienBh * p.mucHuong / 100);
  return { donGiaBv, thanhTienBv, donGiaBh, thanhTienBh, bhtt, bncct: r2(thanhTienBh - bhtt), bntt: r2(thanhTienBv - thanhTienBh) };
}

/* ---------------- Danh sách khoản thu BHYT và kiểm tra đủ thông tin ---------------- */

const ymd = (d: Date | string) => new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).replace(/[-: ]/g, '').slice(0, 12);

export async function bhytRows(q: Queryable, from: string, to: string) {
  const s = await getBhytSettings(q);
  const rows = await many(q, `
    SELECT c.id, c.code, c.service_date::text AS service_date, c.km::float8 AS km, c.total::float8 AS total, c.status, c.bhyt, c.bhyt_exported_at,
           c.vehicle_id, t.transfer_number, t.signed_at, t.epcr, i.final_priority, i.created_at AS incident_at,
           p.ba_number, p.full_name, p.dob::text AS dob, p.birth_year, p.sex, p.id_enc, p.phone, p.address,
           h.kcb_code AS hospital_code, t.epcr->'disposition'->>'hospital' AS hospital
      FROM charges c JOIN transfers t ON t.id = c.transfer_id
      LEFT JOIN incidents i ON i.id = c.incident_id
      LEFT JOIN patients p ON p.id = t.patient_id
      LEFT JOIN hospitals h ON h.name = t.epcr->'disposition'->>'hospital'
     WHERE c.payer_kind = 'BHYT' AND c.status <> 'huy' AND c.service_date BETWEEN $1 AND $2
     ORDER BY c.service_date, c.code`, [from, to]);
  return rows.map((r) => {
    const card: BhytCard | null = r.bhyt;
    const missing: string[] = [];
    if (!s.maCskcb) missing.push('Mã cơ sở KBCB của công ty (Cài đặt BHYT)');
    if (!s.fuelPrice) missing.push('Giá xăng dầu (Cài đặt BHYT)');
    if (!card?.cardNo) missing.push('Mã thẻ BHYT');
    if (!card?.dkbd) missing.push('Nơi đăng ký ban đầu');
    if (!card?.validFrom || !card?.validTo) missing.push('Hạn thẻ');
    if (!card?.mucHuong) missing.push('Mức hưởng');
    if (!r.km) missing.push('Số km');
    if (!r.hospital_code) missing.push(r.hospital ? `Mã KCB của "${r.hospital}"` : 'Bệnh viện nhận');
    if (!r.full_name) missing.push('Họ tên người bệnh');
    const amounts = card?.mucHuong && r.km ? transportAmounts({ km: r.km, totalBv: r.total, s, mucHuong: card.mucHuong }) : null;
    return {
      id: r.id, code: r.code, serviceDate: r.service_date, km: r.km, total: r.total, status: r.status, vehicleId: r.vehicle_id,
      transferNumber: r.transfer_number, patient: r.full_name, baNumber: r.ba_number, hospital: r.hospital, hospitalCode: r.hospital_code,
      card, exportedAt: r.bhyt_exported_at, missing, amounts, _raw: r,
    };
  });
}
export type BhytRow = Awaited<ReturnType<typeof bhytRows>>[number];

/* ---------------- XML ---------------- */

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const el = (fields: [string, unknown][]) => fields.map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

function birth(r: any): string {
  if (r.dob) return `${String(r.dob).slice(0, 10).replace(/-/g, '')}0000`;
  return r.birth_year ? `${r.birth_year}00000000` : '';
}
const SEX: Record<string, number> = { M: 1, F: 2, U: 3 };

export function xml1(row: BhytRow, stt: number, s: BhytSettings): string {
  const r = row._raw; const c = row.card!; const a = row.amounts!;
  const e = r.epcr ?? {};
  const vao = ymd(r.incident_at ?? r.signed_at);
  const ra = ymd(e.disposition?.handoverAt ?? r.signed_at);
  let cccd = '';
  try { cccd = r.id_enc ? decryptId(r.id_enc) : ''; } catch { cccd = ''; }
  const doiTuong = c.doiTuongKcb || (r.final_priority === 'HEN' ? '1' : '2');
  return `<TONG_HOP>${el([
    ['MA_LK', row.code], ['STT', stt], ['MA_BN', r.ba_number], ['HO_TEN', r.full_name], ['SO_CCCD', cccd], ['NGAY_SINH', birth(r)],
    ['GIOI_TINH', SEX[r.sex] ?? 3], ['NHOM_MAU', ''], ['MA_QUOCTICH', ''], ['MA_DANTOC', ''], ['MA_NGHE_NGHIEP', ''], ['DIA_CHI', r.address ?? ''],
    ['MATINH_CU_TRU', ''], ['MAHUYEN_CU_TRU', ''], ['MAXA_CU_TRU', ''], ['DIEN_THOAI', r.phone ?? ''],
    ['MA_THE_BHYT', c.cardNo], ['MA_DKBD', c.dkbd], ['GT_THE_TU', c.validFrom.replace(/-/g, '')], ['GT_THE_DEN', c.validTo.replace(/-/g, '')],
    ['NGAY_MIEN_CCT', ''], ['LY_DO_VV', e.chiefComplaint ?? ''], ['LY_DO_VNT', ''], ['MA_LY_DO_VNT', ''],
    ['CHAN_DOAN_VAO', e.diagnosis?.text ?? ''], ['CHAN_DOAN_RV', e.diagnosis?.text ?? ''], ['MA_BENH_CHINH', e.diagnosis?.icd10 ?? ''],
    ['MA_BENH_KT', ''], ['MA_BENH_YHCT', ''], ['MA_PTTT_QT', ''], ['MA_DOITUONG_KCB', doiTuong], ['MA_NOI_DI', c.noiDi ?? ''], ['MA_NOI_DEN', row.hospitalCode],
    ['MA_TAI_NAN', ''], ['NGAY_VAO', vao], ['NGAY_VAO_NOI_TRU', ''], ['NGAY_RA', ra], ['GIAY_CHUYEN_TUYEN', r.transfer_number ?? ''], ['SO_NGAY_DTRI', 0],
    ['PP_DIEU_TRI', 'Cấp cứu, vận chuyển người bệnh'], ['KET_QUA_DTRI', 7], ['MA_LOAI_RV', 2], ['GHI_CHU', ''], ['NGAY_TTOAN', ''],
    ['T_THUOC', 0], ['T_VTYT', 0], ['T_TONGCHI_BV', num(a.thanhTienBv)], ['T_TONGCHI_BH', num(a.thanhTienBh)], ['T_BNTT', num(a.bntt)], ['T_BNCCT', num(a.bncct)],
    ['T_BHTT', num(a.bhtt)], ['T_NGUONKHAC', 0], ['T_BHTT_GDV', 0], ['NAM_QT', row.serviceDate.slice(0, 4)], ['THANG_QT', Number(row.serviceDate.slice(5, 7))],
    ['MA_LOAI_KCB', s.maLoaiKcb], ['MA_KHOA', s.maKhoa], ['MA_CSKCB', s.maCskcb], ['MA_KHUVUC', c.khuVuc ?? ''], ['CAN_NANG', ''], ['CAN_NANG_CON', ''],
    ['NAM_NAM_LIEN_TUC', ''], ['NGAY_TAI_KHAM', ''], ['MA_HSBA', r.transfer_number ?? row.code], ['MA_TTDV', s.maTtdv], ['DU_PHONG', ''],
  ])}</TONG_HOP>`;
}

export function xml3(row: BhytRow, s: BhytSettings): string {
  const r = row._raw; const c = row.card!; const a = row.amounts!;
  const at = ymd(r.incident_at ?? r.signed_at);
  return `<CHITIEU_CHITIET_DVKT_VTYT><DSACH_CHI_TIET_DVKT><CHI_TIET_DVKT>${el([
    ['MA_LK', row.code], ['STT', 1], ['MA_DICH_VU', `VC.${row.hospitalCode}`], ['MA_PTTT_QT', ''], ['MA_VAT_TU', ''], ['MA_NHOM', s.maNhomVc], ['GOI_VTYT', ''],
    ['TEN_VAT_TU', ''], ['TEN_DICH_VU', `Vận chuyển người bệnh đến ${row.hospital} (${row.km} km, xe ${row.vehicleId ?? ''})`], ['MA_XANG_DAU', s.maXangDau],
    ['DON_VI_TINH', 'km'], ['PHAM_VI', 1], ['SO_LUONG', num(row.km)], ['DON_GIA_BV', num(a.donGiaBv)], ['DON_GIA_BH', num(a.donGiaBh)], ['TT_THAU', ''],
    ['TYLE_TT_DV', ''], ['TYLE_TT_BH', 100], ['THANH_TIEN_BV', num(a.thanhTienBv)], ['THANH_TIEN_BH', num(a.thanhTienBh)], ['T_TRANTT', ''], ['MUC_HUONG', c.mucHuong],
    ['T_NGUONKHAC_NSNN', 0], ['T_NGUONKHAC_VTNN', 0], ['T_NGUONKHAC_VTTN', 0], ['T_NGUONKHAC_CL', 0], ['T_NGUONKHAC', 0],
    ['T_BNTT', num(a.bntt)], ['T_BNCCT', num(a.bncct)], ['T_BHTT', num(a.bhtt)], ['MA_KHOA', s.maKhoa], ['MA_GIUONG', ''], ['MA_BAC_SI', s.maBacSi],
    ['NGUOI_THUC_HIEN', ''], ['MA_BENH', r.epcr?.diagnosis?.icd10 ?? ''], ['MA_BENH_YHCT', ''], ['NGAY_YL', at], ['NGAY_TH_YL', at], ['NGAY_KQ', ''],
    ['MA_PTTT', 1], ['VET_THUONG_TP', ''], ['PP_VO_CAM', ''], ['VI_TRI_TH_DVKT', ''], ['MA_MAY', ''], ['MA_HIEU_SP', ''], ['TAI_SU_DUNG', ''], ['DU_PHONG', ''],
  ])}</CHI_TIET_DVKT></DSACH_CHI_TIET_DVKT></CHITIEU_CHITIET_DVKT_VTYT>`;
}

const DECL = '<?xml version="1.0" encoding="utf-8"?>';
const b64 = (xml: string) => Buffer.from(DECL + xml, 'utf8').toString('base64');

/** Hồ sơ gửi Cổng giám định: mỗi lượt vận chuyển một HOSO gồm XML1 và XML3 (nội dung mã hóa base64). Chưa ký số đơn vị */
export function giamDinhXml(rows: BhytRow[], s: BhytSettings, now = new Date()): string {
  const hoso = rows.map((row, i) => `<HOSO>${[['XML1', xml1(row, i + 1, s)], ['XML3', xml3(row, s)]]
    .map(([k, x]) => `<FILEHOSO><LOAIHOSO>${k}</LOAIHOSO><NOIDUNGFILE>${b64(x)}</NOIDUNGFILE></FILEHOSO>`).join('')}</HOSO>`).join('');
  return `${DECL}<GIAMDINHHS xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<THONGTINDONVI><MACSKCB>${esc(s.maCskcb)}</MACSKCB></THONGTINDONVI>`
    + `<THONGTINHOSO><NGAYLAP>${ymd(now).slice(0, 8)}</NGAYLAP><SOLUONGHOSO>${rows.length}</SOLUONGHOSO><DANHSACHHOSO>${hoso}</DANHSACHHOSO></THONGTINHOSO>`
    + '<CHUKYDONVI></CHUKYDONVI></GIAMDINHHS>';
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
