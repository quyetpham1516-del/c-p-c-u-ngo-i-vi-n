import { z } from 'zod';

/**
 * ePCR theo đúng mẫu "Bệnh án cấp cứu ngoại viện" của Trung tâm Cấp cứu 115 TP.HCM (bản chủ đầu tư gửi
 * trên Drive): Thông tin bệnh nhân, Điều phối viên, Thời gian, Can thiệp tuyến trước, Hiện trường nguy hiểm,
 * Tiếp cận ABCDE + Can thiệp, Chấn thương, SAMPLE, Khám toàn diện, Can thiệp sau khám, Chẩn đoán,
 * Theo dõi, Em bé (sanh rớt), Hồi sinh tim phổi em bé, Lưu ý khi vận chuyển, Đơn vị giao/nhận bệnh.
 * Bản nháp cho phép thiếu trường; khi ký mới kiểm tra các trường bắt buộc.
 */
const str = z.string().max(2000).optional();
const num = z.number().finite().optional();
const bool = z.boolean().optional();

export const TRAUMA_TYPES = [
  'Bỏng', 'Bụng kín/hở', 'Đứt lìa', 'Động vật cắn', 'Gẫy xương', 'Giập – nát', 'Liệt – yếu',
  'Ngực kín/hở', 'Tê', 'Trật khớp', 'Rách da', 'Sưng', 'Xuất huyết',
] as const;

export const VitalSchema = z.object({
  at: z.string(),
  hr: num, sbp: num, dbp: num, spo2: num, temp: num, rr: num, monitor: str, other: str,
  glucose: num, gcs: num, pain: num, etco2: num, rhythm: str,
});

export const EpcrSchema = z.object({
  kinhGui: str,
  infectious: bool,
  patient: z.object({
    fullName: str, nationality: str, birthYear: num, sex: z.enum(['M', 'F', 'U']).optional(),
    age: num, ageUnit: z.enum(['y', 'm', 'd']).optional(), weightKg: num,
  }).partial().default({}),
  caller: z.object({ name: str, phone: str }).partial().default({}),
  /** "Lý do" gọi cấp cứu trên mẫu */
  chiefComplaint: str,
  scene: z.object({ address: str, type: str, danger: bool, dangerNote: str, safety: str }).partial().default({}),
  dispatch: z.object({
    from115: bool, tvt: bool, firstAidGuided: bool, firstAidNote: str, interHospitalAlert: bool, other: str,
  }).partial().default({}),
  transferFrom: str,
  transferReason: str,
  priorCare: str,
  abcde: z.object({
    airway: z.enum(['patent', 'obstructed']).optional(), airwayNote: str,
    rr: num, spo2: num, breathingNote: str, retractions: bool,
    hr: num, crt: num, sbp: num, dbp: num, ecg: str,
    avpu: z.enum(['A', 'V', 'P', 'U']).optional(),
    fastF: bool, fastA: bool, fastS: bool, fastT: bool, neuroNote: str,
    seizure: bool, pupils: str, glucose: num,
    temp: num, injHead: bool, injSpine: bool, injLimb: bool, injMulti: bool,
    bleeding: z.enum(['spurting', 'flowing', 'oozing']).optional(),
  }).partial().default({}),
  /** Cột "Can thiệp" cạnh từng mục ABCDE */
  care: z.object({
    heimlich: bool, bvm: bool, lma: bool, ett: bool, ettNote: str, suction: bool,
    o2Cannula: bool, o2CannulaFlow: str, nrbMask: bool, nrbFlow: str, bagMask: bool, bagEtt: bool, nebulizer: bool,
    cpr: bool, defib: bool, defibNote: str, monitor: bool, iv: bool, ivNote: str,
    neuroCare: str,
    collar: bool, spine: bool, pelvis: bool, splintShoulder: bool, splintArm: bool, splintLeg: bool, splintNote: str,
    pressureBandage: bool, bandageNote: str,
  }).partial().default({}),
  trauma: z.object({ present: bool, types: z.array(z.enum(TRAUMA_TYPES)).default([]), note: str }).partial().default({}),
  sample: z.object({
    symptoms: str, allergy: bool, allergies: str, medications: str, pastHistory: str, lastMeal: str, events: str,
  }).partial().default({}),
  exam: z.object({ headFace: str, neck: str, chest: str, abdomen: str, limbs: str, skin: str, other: str }).partial().default({}),
  postExamCare: str,
  diagnosis: z.object({ text: str, icd10: z.string().max(10).optional(), icdName: str }).partial().default({}),
  vitals: z.array(VitalSchema).max(500).default([]),
  interventions: z.array(z.object({ at: z.string(), name: z.string().max(200), by: str, note: str })).max(500).default([]),
  medications: z.array(z.object({
    at: z.string(), name: z.string().max(200), dose: str, route: str, lot: str, expiry: str, by: str, witness: str,
    /** Lô trong kho trạm (tự điền khi chọn thuốc); số lượng đơn vị trừ kho khi ký phiếu */
    drugId: num, lotId: z.string().uuid().optional(), qty: num,
  })).max(500).default([]),
  newborn: z.object({
    born: bool, at: str, sex: z.enum(['M', 'F', 'U']).optional(),
    heartRate: str, respiration: str, movement: str, reflex: str, color: str,
    cordCut: bool, cordClamped: bool, warmed: bool, skinToSkin: bool,
    airwayClear: bool, airwayNote: str, suction: bool, oxygen: bool, oxygenNote: str, ett: bool, ettNote: str,
    cpr: str, apgar1: num, apgar5: num, note: str,
  }).partial().default({}),
  /** Ngừng tuần hoàn ngoài viện theo mẫu Utstein 2014 (cập nhật 2024): bắt buộc khi có ép tim hoặc sốc điện */
  arrest: z.object({
    present: bool,
    /** Ngừng tuần hoàn trước khi kíp tới, hay kíp chứng kiến */
    witnessed: z.enum(['khong', 'nguoi_dan', 'nhan_vien_y_te', 'kip']).optional(),
    location: z.enum(['nha', 'noi_cong_cong', 'duong', 'noi_lam_viec', 'co_so_y_te', 'xe_cuu_thuong', 'khac']).optional(),
    cause: z.enum(['tim', 'chan_thuong', 'ngat', 'duoi_nuoc', 'ngo_doc', 'dien_giat', 'qua_lieu', 'khac_khong_do_tim', 'khong_ro']).optional(),
    collapseAt: str,
    /** Hồi sinh tim phổi do người dân trước khi kíp tới */
    bystanderCpr: z.enum(['khong', 'chi_ep_tim', 'ep_tim_thoi_ngat', 'khong_ro']).optional(),
    dispatcherCpr: bool,
    publicAed: z.enum(['khong', 'gan_khong_soc', 'co_soc']).optional(),
    attempted: bool,
    notAttemptedReason: z.enum(['dau_hieu_tu_vong', 'y_nguyen', 'nguy_hiem', 'khac']).optional(),
    cprStartAt: str,
    firstRhythm: z.enum(['vf', 'pvt', 'pea', 'vo_tam_thu', 'aed_soc_duoc', 'aed_khong_soc', 'khong_ro']).optional(),
    firstShockAt: str,
    shocks: num,
    adrenalineFirstAt: str,
    adrenalineDoses: num,
    antiarrhythmic: bool,
    airway: z.enum(['khong', 'bop_bong', 'mat_na_thanh_quan', 'noi_khi_quan']).optional(),
    airwayAt: str,
    mechanicalCpr: bool,
    etco2Max: num,
    roscAny: bool,
    roscAt: str,
    /** Có tuần hoàn trở lại kéo dài từ 20 phút */
    roscSustained: bool,
    /** Còn tuần hoàn khi bàn giao tại bệnh viện */
    roscOnArrival: bool,
    terminatedAt: str,
    terminationReason: str,
    ttm: bool,
    ecpr: bool,
    note: str,
  }).partial().default({}),
  transportNotes: str,
  disposition: z.object({
    type: z.enum(['transported', 'treated_released', 'refused', 'dead_on_scene', 'cancelled']).optional(),
    hospital: str, department: str, receiverName: str, receiverTitle: str, handoverAt: str, distanceKm: num,
    refusalSigned: bool, refusalWitness: str, handoverNote: str,
    fromUnit: str, fromComment: str, toUnit: str, toComment: str,
  }).partial().default({}),
  payer: z.enum(['BHYT', 'THU_PHI', 'MIEN', 'GIAM', 'THAT_THU']).optional(),
  notes: str,
});

export type Epcr = z.infer<typeof EpcrSchema>;

/** Kiểm tra trước khi ký: trả về danh sách trường còn thiếu (rỗng = đủ) */
export function missingForSign(e: Epcr): string[] {
  const miss: string[] = [];
  if (!e.chiefComplaint) miss.push('Lý do cấp cứu');
  if (!e.vitals.length && e.abcde.hr == null && e.abcde.sbp == null) miss.push('Ít nhất một lần đo sinh hiệu');
  if (!e.diagnosis.text) miss.push('Chẩn đoán');
  if (!e.disposition.type) miss.push('Kết cục (vận chuyển, từ chối, tử vong...)');
  if (e.disposition.type === 'transported') {
    if (!e.disposition.hospital) miss.push('Chuyển bệnh (bệnh viện nhận)');
    if (!e.disposition.receiverName) miss.push('Người nhận bàn giao');
  }
  if (e.disposition.type === 'refused' && !e.disposition.refusalSigned) miss.push('Cam kết từ chối có chữ ký');
  if (e.trauma.present && !e.trauma.types?.length) miss.push('Loại chấn thương');
  for (const m of e.medications) {
    if (!m.lot) miss.push(`Số lô thuốc ${m.name}`);
  }
  if (!e.payer) miss.push('Đối tượng thu phí');
  const a = e.arrest;
  if ((e.care.cpr || e.care.defib) && a.present == null) miss.push('Có ngừng tuần hoàn không (đã ép tim hoặc sốc điện)');
  if (a.present) {
    if (!a.witnessed) miss.push('Utstein: người chứng kiến');
    if (!a.cause) miss.push('Utstein: nguyên nhân');
    if (!a.location) miss.push('Utstein: nơi xảy ra');
    if (!a.bystanderCpr && a.witnessed !== 'kip') miss.push('Utstein: người dân ép tim');
    if (a.attempted == null) miss.push('Utstein: có hồi sức không');
    if (a.attempted === false && !a.notAttemptedReason) miss.push('Utstein: lý do không hồi sức');
    if (a.attempted) {
      if (!a.firstRhythm) miss.push('Utstein: nhịp đầu tiên');
      if (!a.cprStartAt) miss.push('Utstein: giờ kíp bắt đầu ép tim');
      if (a.roscAny == null) miss.push('Utstein: có tuần hoàn trở lại (ROSC)');
      if (a.roscAny && a.roscOnArrival == null) miss.push('Utstein: còn tuần hoàn khi tới viện');
      if (!a.roscAny && !a.terminatedAt && e.disposition.type !== 'transported') miss.push('Utstein: giờ ngừng hồi sức');
    }
  }
  return miss;
}
