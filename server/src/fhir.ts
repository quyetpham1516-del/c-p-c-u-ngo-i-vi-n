import { createHash } from 'node:crypto';

/**
 * Liên thông bệnh viện theo HL7 FHIR R4: phiếu chuyển viện xuất thành Bundle loại "document" (Composition đứng đầu),
 * gồm Patient, Encounter, Practitioner, Organization, Observation (sinh hiệu, mã LOINC), Condition (ICD-10),
 * Procedure (can thiệp), MedicationAdministration (thuốc, số lô), AllergyIntolerance. Bệnh viện nhập vào HIS
 * hoặc đọc bằng bất kỳ phần mềm FHIR nào. Mã định danh dùng tiền tố urn của Medone khi Việt Nam chưa có hệ mã chung.
 */

export const SYS = {
  ba: 'urn:medone:so-benh-an',
  transfer: 'urn:medone:so-chuyen-vien',
  incident: 'urn:medone:ma-ca',
  cccd: 'urn:vn:cccd',
  passport: 'urn:vn:ho-chieu',
  license: 'urn:vn:gphn',
  kcb: 'urn:vn:bhxh:ma-kcb',
  loinc: 'http://loinc.org',
  icd10: 'http://hl7.org/fhir/sid/icd-10',
  ucum: 'http://unitsofmeasure.org',
  obsCat: 'http://terminology.hl7.org/CodeSystem/observation-category',
  actCode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
};

/** Sinh hiệu ePCR → mã LOINC, đơn vị UCUM */
export const VITAL_LOINC: Record<string, { code: string; display: string; unit: string; ucum: string }> = {
  hr: { code: '8867-4', display: 'Heart rate', unit: 'lần/phút', ucum: '/min' },
  rr: { code: '9279-1', display: 'Respiratory rate', unit: 'lần/phút', ucum: '/min' },
  spo2: { code: '59408-5', display: 'Oxygen saturation in Arterial blood by Pulse oximetry', unit: '%', ucum: '%' },
  temp: { code: '8310-5', display: 'Body temperature', unit: '°C', ucum: 'Cel' },
  gcs: { code: '9269-2', display: 'Glasgow coma score total', unit: 'điểm', ucum: '{score}' },
  glucose: { code: '15074-8', display: 'Glucose [Moles/volume] in Blood', unit: 'mmol/L', ucum: 'mmol/L' },
  pain: { code: '72514-3', display: 'Pain severity - 0-10 verbal numeric rating [Score] - Reported', unit: 'điểm', ucum: '{score}' },
};
const BP = { panel: '85354-9', sbp: '8480-6', dbp: '8462-4' };

const GENDER: Record<string, string> = { M: 'male', F: 'female', U: 'unknown' };
const DISPO: Record<string, string> = {
  transported: 'Vận chuyển tới bệnh viện', treated_released: 'Xử trí tại chỗ', refused: 'Từ chối vận chuyển', dead_on_scene: 'Tử vong tại hiện trường', cancelled: 'Hủy',
};

/** Mã định danh ổn định cho từng tài nguyên trong Bundle: cùng phiếu xuất lại cho cùng urn */
const uid = (...parts: string[]) => {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 + (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const narrative = (lines: (string | null | undefined | false)[]) => ({
  status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${lines.filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('') || '<p>Không có</p>'}</div>`,
});
/** Giờ trong ePCR có thể là "HH:MM" theo ngày ca, hoặc ISO */
function toInstant(at: string | null | undefined, baseIso: string | null): string | undefined {
  if (!at) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T/.test(at)) return new Date(at).toISOString();
  const m = /^(\d{1,2}):(\d{2})/.exec(at);
  if (!m || !baseIso) return undefined;
  const vnDay = new Date(new Date(baseIso).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  return new Date(`${vnDay}T${m[1].padStart(2, '0')}:${m[2]}:00+07:00`).toISOString();
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface TransferInput {
  id: string; transfer_number: string | null; status: string; epcr: any; created_at: string; signed_at: string | null; vehicle_id: string | null;
  incident_code: string | null; final_priority: string | null; incident_address: string | null;
  ba_number: string | null; patient_name: string | null; patient_sex: string | null; patient_dob: string | null; birth_year: number | null;
  id_type: string | null; national_id: string | null; id_last4: string | null; patient_phone: string | null;
  times: { code: string; at: string }[];
  crew: { full_name: string; title: string | null; license_no: string | null; crew_role: string | null }[];
  hospital: { name: string; kcb_code: string | null; address: string | null } | null;
  org: { name: string };
}

export function transferBundle(t: TransferInput) {
  const e = t.epcr ?? {};
  const base = t.times.find((x) => x.code === 'T0')?.at ?? t.created_at;
  const entries: { fullUrl: string; resource: any }[] = [];
  const add = (resource: any, ...key: string[]) => { const fullUrl = uid(t.id, resource.resourceType, ...key); entries.push({ fullUrl, resource }); return fullUrl; };
  const time = (code: string) => t.times.find((x) => x.code === code)?.at;

  const orgRef = add({ resourceType: 'Organization', name: t.org.name, type: [{ text: 'Đơn vị cấp cứu ngoại viện' }] }, 'self');
  const hospitalName = t.hospital?.name ?? e.disposition?.hospital ?? null;
  const hospRef = hospitalName ? add({
    resourceType: 'Organization', name: hospitalName,
    ...(t.hospital?.kcb_code ? { identifier: [{ system: SYS.kcb, value: t.hospital.kcb_code }] } : {}),
    ...(t.hospital?.address ? { address: [{ text: t.hospital.address }] } : {}),
  }, 'hospital') : null;

  const identifiers: any[] = [];
  if (t.ba_number) identifiers.push({ use: 'official', system: SYS.ba, value: t.ba_number });
  if (t.national_id) identifiers.push({ use: 'official', system: t.id_type === 'PASSPORT' ? SYS.passport : SYS.cccd, value: t.national_id });
  else if (t.id_last4) identifiers.push({ system: t.id_type === 'PASSPORT' ? SYS.passport : SYS.cccd, value: `****${t.id_last4}`, extension: [{ url: 'urn:medone:masked', valueBoolean: true }] });
  const name = t.patient_name ?? e.patient?.fullName;
  const birth = t.patient_dob ?? (t.birth_year ? String(t.birth_year) : e.patient?.birthYear ? String(e.patient.birthYear) : undefined);
  const patRef = add({
    resourceType: 'Patient', identifier: identifiers,
    ...(name ? { name: [{ text: name }] } : {}),
    gender: GENDER[t.patient_sex ?? e.patient?.sex ?? 'U'] ?? 'unknown',
    ...(birth ? { birthDate: birth } : {}),
    ...(t.patient_phone ? { telecom: [{ system: 'phone', value: t.patient_phone }] } : {}),
    ...(e.patient?.nationality ? { extension: [{ url: 'urn:medone:quoc-tich', valueString: e.patient.nationality }] } : {}),
  }, 'patient');

  const practRefs = t.crew.map((c, k) => add({
    resourceType: 'Practitioner', name: [{ text: c.full_name }],
    ...(c.license_no ? { identifier: [{ system: SYS.license, value: c.license_no }] } : {}),
    ...(c.title ? { qualification: [{ code: { text: c.title } }] } : {}),
  }, 'crew', String(k), c.full_name));

  const start = time('T0') ?? t.created_at;
  const end = toInstant(e.disposition?.handoverAt, base) ?? time('T13') ?? time('T14');
  const encRef = add({
    resourceType: 'Encounter',
    identifier: [
      ...(t.transfer_number ? [{ system: SYS.transfer, value: t.transfer_number }] : []),
      ...(t.incident_code ? [{ system: SYS.incident, value: t.incident_code }] : []),
    ],
    status: t.status === 'signed' ? 'finished' : 'in-progress',
    class: { system: SYS.actCode, code: 'EMER', display: 'emergency' },
    ...(t.final_priority ? { priority: { text: `Mức ưu tiên ${t.final_priority}` } } : {}),
    subject: { reference: patRef },
    participant: practRefs.map((r) => ({ individual: { reference: r } })),
    period: { start, ...(end ? { end } : {}) },
    ...(e.chiefComplaint ? { reasonCode: [{ text: e.chiefComplaint }] } : {}),
    ...(t.incident_address || e.scene?.address ? { location: [{ location: { display: e.scene?.address ?? t.incident_address } }] } : {}),
    hospitalization: {
      ...(hospRef ? { destination: { reference: hospRef } } : {}),
      ...(e.disposition?.type ? { dischargeDisposition: { text: DISPO[e.disposition.type] ?? e.disposition.type } } : {}),
    },
    serviceProvider: { reference: orgRef },
  }, 'encounter');
  const ctx = { subject: { reference: patRef }, encounter: { reference: encRef } };

  // Sinh hiệu: mỗi lần đo một nhóm Observation; huyết áp là bộ có hai thành phần
  const obsRefs: string[] = [];
  const vitals: any[] = Array.isArray(e.vitals) ? e.vitals : [];
  vitals.forEach((v, k) => {
    const when = toInstant(v.at, base);
    if (!when) return;
    for (const [key, m] of Object.entries(VITAL_LOINC)) {
      if (!isNum(v[key])) continue;
      obsRefs.push(add({
        resourceType: 'Observation', status: 'final',
        category: [{ coding: [{ system: SYS.obsCat, code: key === 'glucose' ? 'laboratory' : key === 'gcs' || key === 'pain' ? 'exam' : 'vital-signs' }] }],
        code: { coding: [{ system: SYS.loinc, code: m.code, display: m.display }], text: m.display },
        ...ctx, effectiveDateTime: when,
        valueQuantity: { value: v[key], unit: m.unit, system: SYS.ucum, code: m.ucum },
      }, 'vital', String(k), key));
    }
    if (isNum(v.sbp) || isNum(v.dbp)) {
      const comp = (code: string, display: string, val: number) => ({ code: { coding: [{ system: SYS.loinc, code, display }] }, valueQuantity: { value: val, unit: 'mmHg', system: SYS.ucum, code: 'mm[Hg]' } });
      obsRefs.push(add({
        resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: SYS.obsCat, code: 'vital-signs' }] }],
        code: { coding: [{ system: SYS.loinc, code: BP.panel, display: 'Blood pressure panel with all children optional' }], text: 'Huyết áp' },
        ...ctx, effectiveDateTime: when,
        component: [
          ...(isNum(v.sbp) ? [comp(BP.sbp, 'Systolic blood pressure', v.sbp)] : []),
          ...(isNum(v.dbp) ? [comp(BP.dbp, 'Diastolic blood pressure', v.dbp)] : []),
        ],
      }, 'vital', String(k), 'bp'));
    }
    if (v.rhythm || v.monitor) {
      obsRefs.push(add({
        resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: SYS.obsCat, code: 'exam' }] }],
        code: { text: 'Nhịp tim trên monitor' }, ...ctx, effectiveDateTime: when, valueString: [v.rhythm, v.monitor].filter(Boolean).join(' · '),
      }, 'vital', String(k), 'rhythm'));
    }
  });

  const condRefs: string[] = [];
  if (e.diagnosis?.text || e.diagnosis?.icd10) {
    condRefs.push(add({
      resourceType: 'Condition',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'provisional' }] },
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis' }] }],
      code: {
        ...(e.diagnosis.icd10 ? { coding: [{ system: SYS.icd10, code: e.diagnosis.icd10, ...(e.diagnosis.icdName ? { display: e.diagnosis.icdName } : {}) }] } : {}),
        text: e.diagnosis.text ?? e.diagnosis.icdName ?? e.diagnosis.icd10,
      },
      ...ctx, recordedDate: t.signed_at ?? t.created_at,
    }, 'diagnosis'));
  }

  const procRefs = (Array.isArray(e.interventions) ? e.interventions : []).map((p: any, k: number) => add({
    resourceType: 'Procedure', status: 'completed', code: { text: p.name }, ...ctx,
    ...(toInstant(p.at, base) ? { performedDateTime: toInstant(p.at, base) } : {}),
    ...(p.by ? { performer: [{ actor: { display: p.by } }] } : {}),
    ...(p.note ? { note: [{ text: p.note }] } : {}),
  }, 'procedure', String(k)));

  const medRefs = (Array.isArray(e.medications) ? e.medications : []).map((m: any, k: number) => add({
    resourceType: 'MedicationAdministration', status: 'completed',
    medicationCodeableConcept: { text: m.name }, ...ctx, context: { reference: encRef },
    effectiveDateTime: toInstant(m.at, base) ?? start,
    ...(m.by ? { performer: [{ actor: { display: m.by } }] } : {}),
    ...(m.dose || m.route ? { dosage: { text: [m.dose, m.route].filter(Boolean).join(' · '), ...(m.route ? { route: { text: m.route } } : {}) } } : {}),
    ...(m.lot ? { note: [{ text: `Số lô ${m.lot}${m.expiry ? `, hạn dùng ${m.expiry}` : ''}` }] } : {}),
  }, 'medication', String(k)));
  // context chỉ dùng cho R4; bỏ trường encounter (không có trong MedicationAdministration R4)
  for (const en of entries) if (en.resource.resourceType === 'MedicationAdministration') delete en.resource.encounter;

  // Cận lâm sàng tại chỗ: mỗi kết quả một Observation có giờ riêng (category laboratory)
  const labRefs = (Array.isArray(e.labs) ? e.labs : []).filter((l: any) => l.value).map((l: any, k: number) => {
    const n = Number(String(l.value).replace(',', '.'));
    return add({
      resourceType: 'Observation', status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
      code: { text: l.name ?? l.type }, ...ctx,
      effectiveDateTime: toInstant(l.at, base) ?? start,
      ...(Number.isFinite(n) && l.unit ? { valueQuantity: { value: n, unit: l.unit } } : { valueString: `${l.value}${l.unit ? ` ${l.unit}` : ''}` }),
      ...(l.note ? { note: [{ text: l.note }] } : {}),
    }, 'lab', String(k));
  });

  const allergyRefs: string[] = [];
  if (e.sample?.allergy && e.sample?.allergies) {
    allergyRefs.push(add({
      resourceType: 'AllergyIntolerance', patient: { reference: patRef }, encounter: { reference: encRef },
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
      code: { text: e.sample.allergies },
    }, 'allergy'));
  }

  const section = (title: string, lines: (string | null | undefined | false)[], refs: string[] = []) =>
    ({ title, text: narrative(lines), ...(refs.length ? { entry: refs.map((r) => ({ reference: r })) } : {}) });
  const lastVital = vitals[vitals.length - 1];
  const composition = {
    resourceType: 'Composition',
    identifier: { system: SYS.transfer, value: t.transfer_number ?? t.id },
    status: t.status === 'signed' ? 'final' : 'preliminary',
    type: { text: 'Bệnh án cấp cứu ngoại viện – phiếu chuyển viện' },
    subject: { reference: patRef }, encounter: { reference: encRef },
    date: t.signed_at ?? new Date().toISOString(),
    author: practRefs.length ? practRefs.slice(0, 2).map((r) => ({ reference: r })) : [{ reference: orgRef }],
    title: `Phiếu chuyển viện ${t.transfer_number ?? ''}`.trim(),
    custodian: { reference: orgRef },
    section: [
      section('Lý do cấp cứu, hiện trường', [e.chiefComplaint, e.scene?.address ?? t.incident_address, e.priorCare && `Sơ cứu trước: ${e.priorCare}`]),
      section('Tiền sử (SAMPLE)', [e.sample?.symptoms, e.sample?.allergy ? `Dị ứng: ${e.sample.allergies ?? 'có'}` : null, e.sample?.medications && `Thuốc đang dùng: ${e.sample.medications}`, e.sample?.pastHistory && `Tiền sử: ${e.sample.pastHistory}`, e.sample?.events], allergyRefs),
      section('Chẩn đoán', [e.diagnosis?.icd10 ? `${e.diagnosis.icd10} ${e.diagnosis.icdName ?? ''}` : null, e.diagnosis?.text], condRefs),
      section('Sinh hiệu', [lastVital && `Lần đo cuối ${lastVital.at}: mạch ${lastVital.hr ?? '—'}, HA ${lastVital.sbp ?? '—'}/${lastVital.dbp ?? '—'}, SpO2 ${lastVital.spo2 ?? '—'}%, nhịp thở ${lastVital.rr ?? '—'}, GCS ${lastVital.gcs ?? '—'}`, `${vitals.length} lần đo`], obsRefs),
      section('Cận lâm sàng tại chỗ', (e.labs ?? []).filter((l: any) => l.value).map((l: any) => `${l.at ?? ''} ${l.name ?? l.type}: ${l.value}${l.unit ? ` ${l.unit}` : ''}`), labRefs),
      section('Y lệnh qua bác sĩ trao đổi', (e.consults ?? []).map((c: any) => `${c.at ?? ''} ${c.doctor}${c.mode ? ` (${({ dien_thoai: 'điện thoại', video: 'video', truc_tiep: 'trực tiếp' } as Record<string, string>)[c.mode] ?? c.mode})` : ''}${c.note ? `: ${c.note}` : ''}`)),
      section('Can thiệp', (e.interventions ?? []).map((p: any) => `${p.at ?? ''} ${p.name}`), procRefs),
      section('Thuốc đã dùng', (e.medications ?? []).map((m: any) => `${m.at ?? ''} ${m.name} ${m.dose ?? ''} ${m.route ?? ''}${m.lot ? ` (lô ${m.lot})` : ''}`), medRefs),
      section('Bàn giao', [e.disposition?.type && DISPO[e.disposition.type], hospitalName && `Nơi nhận: ${[e.disposition?.department, hospitalName].filter(Boolean).join(' – ')}`,
        e.disposition?.receiverName && `Người nhận: ${e.disposition.receiverName}`, e.transportNotes, e.disposition?.handoverNote]),
    ],
  };
  const compRef = uid(t.id, 'Composition');
  return {
    resourceType: 'Bundle',
    identifier: { system: SYS.transfer, value: `${t.transfer_number ?? t.id}` },
    type: 'document',
    timestamp: new Date().toISOString(),
    entry: [{ fullUrl: compRef, resource: composition }, ...entries],
  };
}

/** Tên đơn vị ghi trên tài liệu xuất ra ngoài; đổi bằng biến môi trường MEDONE_ORG_NAME */
export const ORG_NAME = process.env.MEDONE_ORG_NAME?.trim() || 'Dịch vụ Chuyển viện - Cấp cứu ngoại viện Medone';
