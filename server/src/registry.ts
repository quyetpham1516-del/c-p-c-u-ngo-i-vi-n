import { audit, type Actor } from './audit.js';
import { many, one, type Queryable, type Tx } from './db.js';
import { HttpError, incidentScope } from './domain.js';

/**
 * Biểu mẫu nghiên cứu theo ca: Utstein (ngừng tuần hoàn ngoài viện, phần trong viện theo Utstein 2014/2024),
 * PATOS (Pan-Asian Trauma Outcomes Study, chấn thương) và đột quỵ. Ký phiếu thì ca đúng tiêu chí tự vào biểu mẫu
 * đang bật; phần trước viện lấy từ phiếu, phần trong viện bệnh viện nhận (hoặc bác sĩ, điều phối) điền sau.
 */

export type FieldType = 'bool' | 'number' | 'text' | 'date' | 'datetime' | 'select';
export interface Field { key: string; label: string; type: FieldType; options?: [string, string][]; part: 'truoc_vien' | 'trong_vien'; required?: boolean; when?: [string, string] }

const YN3: [string, string][] = [['co', 'Có'], ['khong', 'Không'], ['khong_ro', 'Không rõ']];
const CPC: [string, string][] = [['1', 'CPC 1: tốt'], ['2', 'CPC 2: di chứng vừa'], ['3', 'CPC 3: di chứng nặng'], ['4', 'CPC 4: hôn mê, sống thực vật'], ['5', 'CPC 5: tử vong']];
const MRS: [string, string][] = [0, 1, 2, 3, 4, 5, 6].map((n) => [String(n), `mRS ${n}`]);
const OUTCOME: [string, string][] = [['song', 'Sống ra viện'], ['tu_vong', 'Tử vong trong viện'], ['chuyen_vien', 'Chuyển viện khác'], ['xin_ve', 'Xin về']];

export const REGISTRIES: Record<string, { name: string; criteria: string; fields: Field[] }> = {
  utstein: {
    name: 'Utstein: ngừng tuần hoàn ngoài viện',
    criteria: 'Phiếu có ngừng tuần hoàn (mẫu Utstein trên phiếu)',
    fields: [
      { key: 'edRosc', label: 'Còn tuần hoàn khi tới khoa cấp cứu', type: 'select', options: YN3, part: 'trong_vien', required: true },
      { key: 'edOutcome', label: 'Kết cục tại khoa cấp cứu', type: 'select', options: [['nhap_vien', 'Nhập viện'], ['tu_vong_cc', 'Tử vong tại cấp cứu'], ['chuyen_vien', 'Chuyển viện khác']], part: 'trong_vien', required: true },
      { key: 'coronaryAngio', label: 'Chụp mạch vành', type: 'bool', part: 'trong_vien' },
      { key: 'pci', label: 'Can thiệp mạch vành (PCI)', type: 'bool', part: 'trong_vien' },
      { key: 'ttm', label: 'Kiểm soát thân nhiệt (TTM)', type: 'bool', part: 'trong_vien' },
      { key: 'ecmo', label: 'ECMO, ECPR trong viện', type: 'bool', part: 'trong_vien' },
      { key: 'discharge', label: 'Ra viện', type: 'select', options: OUTCOME, part: 'trong_vien', required: true, when: ['edOutcome', 'nhap_vien'] },
      { key: 'dischargeDate', label: 'Ngày ra viện / tử vong', type: 'date', part: 'trong_vien' },
      { key: 'survival30d', label: 'Còn sống sau 30 ngày', type: 'select', options: YN3, part: 'trong_vien' },
      { key: 'cpcDischarge', label: 'CPC khi ra viện', type: 'select', options: CPC, part: 'trong_vien', required: true, when: ['discharge', 'song'] },
      { key: 'mrsDischarge', label: 'mRS khi ra viện', type: 'select', options: MRS, part: 'trong_vien' },
      { key: 'finalCause', label: 'Nguyên nhân ngừng tuần hoàn (chẩn đoán cuối)', type: 'text', part: 'trong_vien' },
      { key: 'note', label: 'Ghi chú', type: 'text', part: 'trong_vien' },
    ],
  },
  patos: {
    name: 'PATOS: chấn thương',
    criteria: 'Phiếu có chấn thương (mục chấn thương, chấn thương ở mục E hoặc cố định cột sống)',
    fields: [
      { key: 'mechanism', label: 'Cơ chế chấn thương', type: 'select', part: 'truoc_vien', required: true, options: [
        ['tngt', 'Tai nạn giao thông'], ['nga_cao', 'Ngã cao'], ['nga_mat_phang', 'Ngã cùng mặt phẳng'], ['vat_sac', 'Vật sắc nhọn'], ['vat_tu', 'Vật tù, bị đánh'],
        ['hoa_khi', 'Hỏa khí, nổ'], ['bong', 'Bỏng'], ['duoi_nuoc', 'Đuối nước'], ['dong_vat', 'Động vật'], ['may_moc', 'Máy móc lao động'], ['khac', 'Khác']] },
      { key: 'intent', label: 'Chủ ý', type: 'select', part: 'truoc_vien', options: [['vo_y', 'Vô ý'], ['tu_hai', 'Tự hại'], ['hanh_hung', 'Bị hành hung'], ['khong_ro', 'Không rõ']] },
      { key: 'roadUser', label: 'Người bị nạn là', type: 'select', part: 'truoc_vien', when: ['mechanism', 'tngt'], options: [['xe_may', 'Đi xe máy'], ['o_to', 'Đi ô tô'], ['xe_dap', 'Đi xe đạp'], ['di_bo', 'Đi bộ'], ['khac', 'Khác']] },
      { key: 'protection', label: 'Mũ bảo hiểm / dây an toàn', type: 'select', options: YN3, part: 'truoc_vien', when: ['mechanism', 'tngt'] },
      { key: 'alcohol', label: 'Có uống rượu bia', type: 'select', options: YN3, part: 'truoc_vien' },
      { key: 'place', label: 'Nơi xảy ra', type: 'select', part: 'truoc_vien', options: [['duong', 'Đường giao thông'], ['nha', 'Nhà'], ['noi_lam_viec', 'Nơi làm việc'], ['truong_hoc', 'Trường học'], ['cong_cong', 'Nơi công cộng'], ['khac', 'Khác']] },
      { key: 'edSbp', label: 'HA tâm thu khi tới cấp cứu', type: 'number', part: 'trong_vien' },
      { key: 'edHr', label: 'Mạch khi tới cấp cứu', type: 'number', part: 'trong_vien' },
      { key: 'edRr', label: 'Nhịp thở khi tới cấp cứu', type: 'number', part: 'trong_vien' },
      { key: 'edGcs', label: 'GCS khi tới cấp cứu', type: 'number', part: 'trong_vien', required: true },
      { key: 'edDisposition', label: 'Sau khoa cấp cứu', type: 'select', part: 'trong_vien', required: true, options: [['phong_mo', 'Phòng mổ'], ['icu', 'Hồi sức (ICU)'], ['noi_tru', 'Khoa nội trú'], ['ve_nha', 'Về nhà'], ['tu_vong_cc', 'Tử vong tại cấp cứu'], ['chuyen_vien', 'Chuyển viện']] },
      { key: 'surgery', label: 'Phẫu thuật', type: 'bool', part: 'trong_vien' },
      { key: 'surgeryAt', label: 'Giờ bắt đầu phẫu thuật', type: 'datetime', part: 'trong_vien', when: ['surgery', 'true'] },
      { key: 'iss', label: 'Điểm ISS', type: 'number', part: 'trong_vien' },
      { key: 'icuDays', label: 'Số ngày nằm hồi sức', type: 'number', part: 'trong_vien' },
      { key: 'ventilator', label: 'Thở máy', type: 'bool', part: 'trong_vien' },
      { key: 'discharge', label: 'Ra viện', type: 'select', options: OUTCOME, part: 'trong_vien', required: true },
      { key: 'dischargeDate', label: 'Ngày ra viện / tử vong', type: 'date', part: 'trong_vien' },
      { key: 'survival30d', label: 'Còn sống sau 30 ngày', type: 'select', options: YN3, part: 'trong_vien' },
      { key: 'gosDischarge', label: 'GOS khi ra viện (1–5)', type: 'select', options: [['1', '1: tử vong'], ['2', '2: sống thực vật'], ['3', '3: di chứng nặng'], ['4', '4: di chứng vừa'], ['5', '5: hồi phục tốt']], part: 'trong_vien' },
      { key: 'note', label: 'Ghi chú', type: 'text', part: 'trong_vien' },
    ],
  },
  stroke: {
    name: 'Đột quỵ',
    criteria: 'FAST dương tính trên phiếu, hoặc chẩn đoán ICD I60–I64, G45, hoặc chẩn đoán có chữ "đột quỵ"',
    fields: [
      { key: 'lastKnownWell', label: 'Lần cuối còn bình thường', type: 'datetime', part: 'truoc_vien', required: true },
      { key: 'onsetWitnessed', label: 'Có người chứng kiến lúc khởi phát', type: 'bool', part: 'truoc_vien' },
      { key: 'prehospitalScale', label: 'Thang điểm trước viện (BE-FAST, RACE...)', type: 'text', part: 'truoc_vien' },
      { key: 'prenotified', label: 'Đã báo trước bệnh viện (kích hoạt đột quỵ)', type: 'bool', part: 'truoc_vien' },
      { key: 'doorAt', label: 'Giờ tới cửa bệnh viện', type: 'datetime', part: 'trong_vien', required: true },
      { key: 'ctAt', label: 'Giờ chụp CT/MRI', type: 'datetime', part: 'trong_vien' },
      { key: 'strokeType', label: 'Thể đột quỵ', type: 'select', part: 'trong_vien', required: true, options: [['nhoi_mau', 'Nhồi máu não'], ['xuat_huyet', 'Xuất huyết não'], ['duoi_nhen', 'Xuất huyết dưới nhện'], ['tia', 'Cơn thiếu máu não thoáng qua'], ['gia', 'Giả đột quỵ'], ['khac', 'Khác']] },
      { key: 'nihss', label: 'NIHSS khi tới', type: 'number', part: 'trong_vien' },
      { key: 'thrombolysis', label: 'Tiêu sợi huyết', type: 'bool', part: 'trong_vien' },
      { key: 'needleAt', label: 'Giờ bắt đầu tiêu sợi huyết', type: 'datetime', part: 'trong_vien', when: ['thrombolysis', 'true'] },
      { key: 'thrombectomy', label: 'Lấy huyết khối cơ học', type: 'bool', part: 'trong_vien' },
      { key: 'groinAt', label: 'Giờ chọc động mạch', type: 'datetime', part: 'trong_vien', when: ['thrombectomy', 'true'] },
      { key: 'discharge', label: 'Ra viện', type: 'select', options: OUTCOME, part: 'trong_vien', required: true },
      { key: 'dischargeDate', label: 'Ngày ra viện / tử vong', type: 'date', part: 'trong_vien' },
      { key: 'mrsDischarge', label: 'mRS khi ra viện', type: 'select', options: MRS, part: 'trong_vien' },
      { key: 'mrs90d', label: 'mRS sau 90 ngày', type: 'select', options: MRS, part: 'trong_vien' },
      { key: 'note', label: 'Ghi chú', type: 'text', part: 'trong_vien' },
    ],
  },
};

const has = (v: unknown) => v !== undefined && v !== null && v !== '';
const shown = (f: Field, d: Record<string, unknown>) => !f.when || String(d[f.when[0]]) === f.when[1];

/** Đủ khi mọi trường bắt buộc (đang hiện theo câu trả lời trước) đã điền */
export function missingFields(code: string, data: Record<string, unknown>) {
  return REGISTRIES[code].fields.filter((f) => f.required && shown(f, data) && !has(data[f.key])).map((f) => f.label);
}

/** Ca có đúng tiêu chí của biểu mẫu không */
export function matchesRegistry(code: string, e: any): boolean {
  if (code === 'utstein') return e.arrest?.present === true;
  if (code === 'patos') {
    const a = e.abcde ?? {}; const c = e.care ?? {};
    return e.trauma?.present === true || !!(a.injHead || a.injSpine || a.injLimb || a.injMulti || c.collar || c.spine || c.pelvis);
  }
  if (code === 'stroke') {
    const a = e.abcde ?? {};
    const icd = String(e.diagnosis?.icd10 ?? '').toUpperCase();
    return !!(a.fastF || a.fastA || a.fastS) || /^I6[0-4]|^G45/.test(icd) || /đột quỵ|tai biến mạch máu não/i.test(String(e.diagnosis?.text ?? ''));
  }
  return false;
}

/** Phần trước viện chụp lại từ phiếu lúc đưa vào biểu mẫu (bệnh viện xem, không sửa) */
export function prehospitalSnapshot(code: string, e: any, t: any) {
  const v = Array.isArray(e.vitals) ? e.vitals : [];
  const pt = e.patient ?? {};
  const base = {
    transferNumber: t.transfer_number, incidentCode: t.incident_code ?? null, signedAt: t.signed_at,
    age: pt.age ?? (pt.birthYear ? new Date().getFullYear() - pt.birthYear : null), sex: pt.sex ?? null,
    chiefComplaint: e.chiefComplaint ?? null, diagnosis: e.diagnosis?.text ?? null, icd10: e.diagnosis?.icd10 ?? null,
    firstVitals: v[0] ?? null, lastVitals: v.length ? v[v.length - 1] : null, hospital: e.disposition?.hospital ?? null, handoverAt: e.disposition?.handoverAt ?? null,
  };
  if (code === 'utstein') return { ...base, arrest: e.arrest ?? {} };
  if (code === 'patos') return { ...base, trauma: e.trauma ?? {}, injuries: { head: e.abcde?.injHead, spine: e.abcde?.injSpine, limb: e.abcde?.injLimb, multi: e.abcde?.injMulti }, gcs: v.find((x: any) => x.gcs != null)?.gcs ?? null };
  if (code === 'stroke') return { ...base, fast: { f: e.abcde?.fastF, a: e.abcde?.fastA, s: e.abcde?.fastS, t: e.abcde?.fastT }, glucose: e.abcde?.glucose ?? null, avpu: e.abcde?.avpu ?? null };
  return base;
}

export async function activeRegistries(q: Queryable) {
  return many(q, `SELECT code FROM registry_settings WHERE enabled AND (start_on IS NULL OR start_on <= vn_today()) AND (end_on IS NULL OR end_on >= vn_today())`);
}

/**
 * Ký phiếu: gắn bệnh viện nhận, đưa ca vào các biểu mẫu đang bật, báo tài khoản của bệnh viện nhận có ca chuyển tới
 * và biểu mẫu cần bổ sung.
 */
export async function enrollOnSign(tx: Tx, actor: Actor, transferId: string, e: any) {
  const t = await one(tx, `SELECT t.id, t.transfer_number, t.incident_id, t.signed_at, i.code AS incident_code FROM transfers t
                             LEFT JOIN incidents i ON i.id = t.incident_id WHERE t.id = $1`, [transferId]);
  const name = e.disposition?.type === 'transported' ? e.disposition?.hospital : null;
  const h = name ? await one(tx, 'SELECT id, name FROM hospitals WHERE name = $1', [name]) : null;
  if (h) await tx.query('UPDATE transfers SET hospital_id = $2 WHERE id = $1', [transferId, h.id]);
  const enrolled: string[] = [];
  for (const r of await activeRegistries(tx)) {
    if (!matchesRegistry(r.code, e)) continue;
    const ins = await one(tx, `INSERT INTO registry_cases(registry, transfer_id, incident_id, hospital_id, prehospital) VALUES ($1,$2,$3,$4,$5)
                               ON CONFLICT (registry, transfer_id) DO NOTHING RETURNING id`,
    [r.code, transferId, t.incident_id, h?.id ?? null, prehospitalSnapshot(r.code, e, t)]);
    if (ins) enrolled.push(r.code);
  }
  if (enrolled.length) await audit(tx, t.incident_id ? incidentScope(t.incident_id) : 'system', actor, 'registry.enrolled', 'transfer', transferId, { registries: enrolled });
  if (h) {
    const forms = enrolled.map((c) => REGISTRIES[c].name).join(', ');
    await tx.query(`INSERT INTO notifications(user_id, kind, title, body, link, incident_id)
                    SELECT id, 'hospital_transfer', $2, $3, $4, $5 FROM users WHERE active AND role = 'hospital' AND hospital_id = $1`,
    [h.id, `Phiếu chuyển viện ${t.transfer_number ?? ''} chuyển tới ${h.name}`.trim(),
      forms ? `Cần bổ sung phần trong viện: ${forms}` : (e.diagnosis?.text ?? null), `/benh-vien?phieu=${transferId}`, t.incident_id]);
  }
  return enrolled;
}

/** Ai được sửa phần nào: bệnh viện chỉ phần trong viện của ca bệnh viện mình; nhân viên trung tâm sửa cả hai phần */
export async function saveRegistryCase(tx: Tx, actor: Actor, user: { id: string; role: string }, id: string, patch: Record<string, unknown>) {
  const c = await one(tx, 'SELECT * FROM registry_cases WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw new HttpError(404, 'Không tìm thấy ca trong biểu mẫu');
  const def = REGISTRIES[c.registry];
  if (user.role === 'hospital') {
    const me = await one(tx, 'SELECT hospital_id FROM users WHERE id = $1', [user.id]);
    if (!me?.hospital_id || me.hospital_id !== c.hospital_id) throw new HttpError(403, 'Ca này không chuyển tới bệnh viện của bạn');
  }
  const allowed = new Set(def.fields.filter((f) => user.role !== 'hospital' || f.part === 'trong_vien').map((f) => f.key));
  const bad = Object.keys(patch).filter((k) => !allowed.has(k));
  if (bad.length) throw new HttpError(403, `Không sửa được trường: ${bad.join(', ')}`);
  for (const f of def.fields) {
    const v = patch[f.key];
    if (!(f.key in patch) || v === null || v === '') continue;
    if (f.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) throw new HttpError(400, `${f.label}: phải là số`);
    if (f.type === 'bool' && typeof v !== 'boolean') throw new HttpError(400, `${f.label}: có hoặc không`);
    if (f.type === 'select' && !f.options!.some(([k]) => k === v)) throw new HttpError(400, `${f.label}: lựa chọn không hợp lệ`);
    if (['text', 'date', 'datetime'].includes(f.type) && (typeof v !== 'string' || v.length > 2000)) throw new HttpError(400, `${f.label}: không hợp lệ`);
  }
  const data = { ...(c.data ?? {}), ...patch };
  for (const [k, v] of Object.entries(data)) if (v === null || v === '') delete data[k];
  const miss = missingFields(c.registry, data);
  const status = miss.length ? (Object.keys(data).length ? 'dang_bo_sung' : 'cho_bo_sung') : 'du';
  const row = await one(tx, `UPDATE registry_cases SET data = $2, status = $3, completed_at = CASE WHEN $3 = 'du' THEN coalesce(completed_at, now()) ELSE NULL END,
                                  updated_by = $4, updated_at = now() WHERE id = $1 RETURNING *`, [id, data, status, user.id]);
  await audit(tx, c.incident_id ? incidentScope(c.incident_id) : 'system', actor, 'registry.updated', 'registry_case', id, { registry: c.registry, fields: Object.keys(patch), status });
  return { ...row, missing: miss };
}
