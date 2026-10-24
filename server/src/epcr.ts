import { z } from 'zod';

/**
 * Bộ dữ liệu ePCR tối thiểu (mục 12.5: 40–60 trường), theo bố cục "Bệnh án cấp cứu ngoại viện"
 * của 115 TP.HCM: ABCDE, SAMPLE, khám toàn diện, chẩn đoán, can thiệp, theo dõi, sơ sinh, giao/nhận bệnh.
 * Bản nháp cho phép thiếu trường; khi ký mới kiểm tra các trường bắt buộc.
 */
const str = z.string().max(2000).optional();
const num = z.number().finite().optional();

export const VitalSchema = z.object({
  at: z.string(),
  hr: num, sbp: num, dbp: num, rr: num, spo2: num, temp: num, glucose: num, pain: num,
  gcs: num, etco2: num, rhythm: str,
});

export const EpcrSchema = z.object({
  patient: z.object({
    fullName: str, sex: z.enum(['M', 'F', 'U']).optional(), age: num, ageUnit: z.enum(['y', 'm', 'd']).optional(),
    weightKg: num,
  }).partial().default({}),
  scene: z.object({ address: str, type: str, safety: str }).partial().default({}),
  chiefComplaint: str,
  abcde: z.object({
    airway: str, breathing: str, circulation: str,
    gcsE: num, gcsV: num, gcsM: num, pupils: str, disability: str, exposure: str,
  }).partial().default({}),
  sample: z.object({ symptoms: str, allergies: str, medications: str, pastHistory: str, lastMeal: str, events: str }).partial().default({}),
  exam: str,
  vitals: z.array(VitalSchema).max(500).default([]),
  ecg: z.object({ done: z.boolean().optional(), at: str, interpretation: str, stemi: z.boolean().optional() }).partial().default({}),
  diagnosis: z.object({ text: str, icd10: z.string().max(10).optional() }).partial().default({}),
  interventions: z.array(z.object({ at: z.string(), name: z.string().max(200), by: str, note: str })).max(500).default([]),
  medications: z.array(z.object({
    at: z.string(), name: z.string().max(200), dose: str, route: str, lot: str, expiry: str, by: str, witness: str,
  })).max(500).default([]),
  newborn: z.object({ born: z.boolean().optional(), at: str, apgar1: num, apgar5: num, sex: z.enum(['M', 'F', 'U']).optional(), note: str }).partial().default({}),
  disposition: z.object({
    type: z.enum(['transported', 'treated_released', 'refused', 'dead_on_scene', 'cancelled']).optional(),
    hospital: str, department: str, receiverName: str, receiverTitle: str, handoverAt: str,
    refusalSigned: z.boolean().optional(), refusalWitness: str, handoverNote: str,
  }).partial().default({}),
  payer: z.enum(['BHYT', 'THU_PHI', 'MIEN', 'GIAM', 'THAT_THU']).optional(),
  notes: str,
});

export type Epcr = z.infer<typeof EpcrSchema>;

/** Kiểm tra trước khi ký: trả về danh sách trường còn thiếu (rỗng = đủ) */
export function missingForSign(e: Epcr): string[] {
  const miss: string[] = [];
  if (!e.chiefComplaint) miss.push('Lý do cấp cứu');
  if (!e.vitals.length) miss.push('Ít nhất một lần đo sinh hiệu');
  if (!e.diagnosis.text) miss.push('Chẩn đoán');
  if (!e.disposition.type) miss.push('Kết cục (vận chuyển, từ chối, tử vong...)');
  if (e.disposition.type === 'transported') {
    if (!e.disposition.hospital) miss.push('Bệnh viện nhận');
    if (!e.disposition.receiverName) miss.push('Người nhận bàn giao');
  }
  if (e.disposition.type === 'refused' && !e.disposition.refusalSigned) miss.push('Cam kết từ chối có chữ ký');
  for (const m of e.medications) {
    if (!m.lot) miss.push(`Số lô thuốc ${m.name}`);
  }
  if (!e.payer) miss.push('Đối tượng thu phí');
  return miss;
}
