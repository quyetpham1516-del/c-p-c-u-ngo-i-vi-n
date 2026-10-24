import { useEffect, useRef, useState } from 'react';
import { api, fmtTime } from '../api';
import { saveDraft, syncDraft, type Draft } from '../offline';
import { useVehicleStock, type StockLot } from '../catalog';
import { HospitalPicker } from './HospitalPicker';
import { IcdInput } from './IcdInput';
import { PatientPicker } from './PatientPicker';

/** Các thẻ đi theo đúng thứ tự các khối trên mẫu "Bệnh án cấp cứu ngoại viện" */
const TABS = ['Thông tin, điều phối', 'ABCDE và can thiệp', 'SAMPLE, khám, chẩn đoán', 'Theo dõi', 'Em bé (sanh rớt)', 'Giao nhận bệnh', 'Ký phiếu'] as const;

export const TRAUMA_TYPES = ['Bỏng', 'Bụng kín/hở', 'Đứt lìa', 'Động vật cắn', 'Gẫy xương', 'Giập – nát', 'Liệt – yếu', 'Ngực kín/hở', 'Tê', 'Trật khớp', 'Rách da', 'Sưng', 'Xuất huyết'];

const nowIso = () => new Date().toISOString();
const localInput = (iso?: string) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : undefined);
const toNum = (v: string) => (v === '' ? undefined : Number(v));
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
/** "Adrenalin" khớp "Adrenalin 1 mg/1 ml" trong kho */
const sameDrug = (stockName: string, name?: string) => !!name && (norm(stockName).startsWith(norm(name)) || norm(name).startsWith(norm(stockName)));
const QUICK_DRUGS = ['Adrenalin', 'Amiodaron', 'Aspirin', 'Nitroglycerin', 'Salbutamol', 'Glucose 30%', 'Acid tranexamic', 'Naloxon'];

type Setter = (path: string, v: any) => void;

function Txt({ label, value, onChange, area = false, type = 'text', width }: { label: string; value: any; onChange: (v: any) => void; area?: boolean; type?: string; width?: number }) {
  return (
    <label className="field" style={width ? { width } : undefined}>{label}
      {area
        ? <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        : <input type={type === 'number' ? 'text' : type} inputMode={type === 'number' ? 'decimal' : undefined} value={value ?? ''}
            onChange={(e) => onChange(type === 'number' ? toNum(e.target.value) : e.target.value)} />}
    </label>
  );
}

function Chk({ label, value, onChange }: { label: string; value: any; onChange: (v: boolean) => void }) {
  return (
    <label className={`chk ${value ? 'on' : ''}`}>
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

function Pick<T extends string>({ label, value, options, onChange }: { label?: string; value: T | undefined; options: [T, string][]; onChange: (v: T | undefined) => void }) {
  return (
    <div className="row" style={{ gap: 4 }}>
      {label && <span className="small muted">{label}</span>}
      {options.map(([k, l]) => (
        <button key={k} type="button" className={`choice ${value === k ? 'sel' : ''}`} onClick={() => onChange(value === k ? undefined : k)}>{l}</button>
      ))}
    </div>
  );
}

/** Một dòng ABCDE: bên trái là đánh giá, bên phải là can thiệp (như mẫu giấy) */
function AbcdeRow({ title, left, right }: { title: string; left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="abcde-row">
      <div className="abcde-title">{title}</div>
      <div className="col">{left}</div>
      <div className="col abcde-care">{right}</div>
    </div>
  );
}

/** Phiếu chuyển viện / ePCR: lưu vào máy ngay mỗi lần sửa, đồng bộ khi có mạng */
export function EpcrForm({ draft: initial, onChange }: { draft: Draft; onChange?: (d: Draft) => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  const [msg, setMsg] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const syncTimer = useRef<number | undefined>(undefined);
  const e = d.epcr;
  const a = e.abcde ?? {};
  const c = e.care ?? {};
  const nb = e.newborn ?? {};
  const locked = d.status === 'signed';

  useEffect(() => { onChange?.(d); }, [d]);

  const update = (patch: (epcr: any) => any, extra: Partial<Draft> = {}) => {
    setD((cur) => {
      const next: Draft = { ...cur, ...extra, epcr: patch(structuredClone(cur.epcr)), dirty: true, updatedAt: nowIso() };
      saveDraft(next);
      clearTimeout(syncTimer.current);
      syncTimer.current = window.setTimeout(async () => {
        const s = await syncDraft(next.id);
        if (s) setD((x) => ({ ...x, baseVersion: s.baseVersion, number: s.number, dirty: x.updatedAt !== next.updatedAt || s.dirty, conflict: s.conflict, syncedAt: s.syncedAt }));
      }, 1500);
      return next;
    });
  };
  const set: Setter = (path, v) => update((x) => {
    const parts = path.split('.');
    let o = x;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts[parts.length - 1]] = v;
    return x;
  });
  /** Chọn bệnh viện nhận: điền luôn "Kính gửi", bệnh viện/khoa chuyển đến và "Đơn vị nhận bệnh" */
  const setHospital = (hospital: string, department: string) => update((x) => {
    x.disposition ??= {};
    x.disposition.hospital = hospital || undefined;
    x.disposition.department = department || undefined;
    x.kinhGui = hospital || undefined;
    x.disposition.toUnit = hospital ? (department ? `${department} – ${hospital}` : hospital) : undefined;
    return x;
  });
  const stock = useVehicleStock(d.vehicleId);
  const stockDrugs = [...new Map(stock.map((l) => [l.drug_id, l])).values()];
  /** Gắn một lô trong kho xe vào dòng thuốc: tự điền tên, số lô, hạn dùng, đường dùng mặc định */
  const applyLot = (m: any, l: StockLot | undefined) => {
    if (!l) { delete m.lotId; return m; }
    m.name = l.drug_name; m.drugId = l.drug_id; m.lotId = l.id; m.lot = l.lot; m.expiry = l.expiry;
    m.route ??= l.default_route ?? undefined; m.qty ??= 1;
    return m;
  };
  const addDrug = (n: string) => update((x) => {
    // Lô hết hạn sớm nhất đứng đầu danh sách kho (FEFO)
    (x.medications ??= []).push(applyLot({ at: nowIso(), name: n }, stock.find((l) => sameDrug(l.drug_name, n))));
    return x;
  });
  const toggleTrauma = (t: string) => update((x) => {
    x.trauma ??= {};
    const list: string[] = x.trauma.types ?? [];
    x.trauma.types = list.includes(t) ? list.filter((y) => y !== t) : [...list, t];
    if (x.trauma.types.length) x.trauma.present = true;
    return x;
  });

  const sign = async () => {
    setMsg('');
    setMissing([]);
    const s = await syncDraft(d.id);
    if (s?.dirty) { setMsg('Chưa đồng bộ được (mất mạng?). Phiếu đã lưu trên máy, ký khi có mạng.'); return; }
    try {
      await api('POST', `/api/transfers/${d.id}/sign`);
      const next = { ...d, ...(s ?? {}), status: 'signed' as const, dirty: false };
      await saveDraft(next);
      setD(next);
      setMsg('Đã ký phiếu. Mọi sửa đổi sau đây phải qua “bổ sung” có lý do.');
    } catch (err: any) {
      if (Array.isArray(err.body?.details)) setMissing(err.body.details);
      setMsg(err.message);
    }
  };

  const syncState = d.conflict ? <span className="error">Xung đột: {d.conflict}</span>
    : d.dirty ? <span style={{ color: 'var(--warn)' }}>● Đã lưu trên máy, chờ đồng bộ</span>
    : <span style={{ color: 'var(--ok)' }}>● Đã đồng bộ {d.syncedAt ? fmtTime(d.syncedAt) : ''}</span>;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><b>Bệnh án cấp cứu ngoại viện – Số chuyển viện {d.number ?? '(cấp khi đồng bộ)'}</b>{locked && <span className="badge" style={{ marginLeft: 6 }}>Đã ký</span>}</div>
        <div className="small">{syncState}</div>
      </div>
      <div className="tabs" style={{ marginTop: 8 }}>
        {TABS.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <fieldset disabled={locked} style={{ border: 'none', padding: 0, margin: 0 }}>
        {tab === 'Thông tin, điều phối' && (
          <div className="col">
            <div className="grid2">
              <label className="field">Kính gửi (bệnh viện và khoa nhận)
                <HospitalPicker hospital={e.disposition?.hospital ?? e.kinhGui ?? ''} department={e.disposition?.department ?? ''} disabled={locked} onChange={setHospital} />
              </label>
              <div className="row"><Chk label="Bệnh truyền nhiễm" value={e.infectious} onChange={(v) => set('infectious', v)} /></div>
            </div>
            <h3>Thông tin bệnh nhân</h3>
            <PatientPicker value={d.patientId} label={d.patientLabel ?? null}
              onPick={(p) => update((x) => { x.patient = { ...x.patient, fullName: p.full_name ?? x.patient?.fullName, sex: p.sex ?? x.patient?.sex, birthYear: p.birth_year ?? x.patient?.birthYear }; return x; }, { patientId: p.id, patientLabel: `${p.ba_number} · ${p.full_name ?? 'Chưa rõ tên'}` })} />
            <div className="grid4">
              <Txt label="Tên" value={e.patient?.fullName} onChange={(v) => set('patient.fullName', v)} />
              <Txt label="Quốc tịch" value={e.patient?.nationality} onChange={(v) => set('patient.nationality', v)} />
              <Txt label="Năm sinh" type="number" value={e.patient?.birthYear} onChange={(v) => set('patient.birthYear', v)} />
              <label className="field">Giới
                <select value={e.patient?.sex ?? ''} onChange={(ev) => set('patient.sex', ev.target.value || undefined)}>
                  <option value="">—</option><option value="M">Nam</option><option value="F">Nữ</option><option value="U">Chưa rõ</option>
                </select>
              </label>
            </div>
            <Txt label="Địa chỉ cấp cứu" value={e.scene?.address} onChange={(v) => set('scene.address', v)} />
            <div className="grid3">
              <Txt label="Người gọi" value={e.caller?.name} onChange={(v) => set('caller.name', v)} />
              <Txt label="Số điện thoại" value={e.caller?.phone} onChange={(v) => set('caller.phone', v)} />
              <Txt label="Lý do" value={e.chiefComplaint} onChange={(v) => set('chiefComplaint', v)} />
            </div>
            <h3>Điều phối viên</h3>
            <div className="row">
              <Chk label="Chuyển cấp cứu TTCC 115" value={e.dispatch?.from115} onChange={(v) => set('dispatch.from115', v)} />
              <Chk label="TVT" value={e.dispatch?.tvt} onChange={(v) => set('dispatch.tvt', v)} />
              <Chk label="Hướng dẫn sơ cứu" value={e.dispatch?.firstAidGuided} onChange={(v) => set('dispatch.firstAidGuided', v)} />
              <Chk label="Kích hoạt báo động liên viện" value={e.dispatch?.interHospitalAlert} onChange={(v) => set('dispatch.interHospitalAlert', v)} />
            </div>
            <div className="grid2">
              <Txt label="Nội dung hướng dẫn sơ cứu" value={e.dispatch?.firstAidNote} onChange={(v) => set('dispatch.firstAidNote', v)} />
              <Txt label="Khác" value={e.dispatch?.other} onChange={(v) => set('dispatch.other', v)} />
              <Txt label="Vận chuyển từ" value={e.transferFrom} onChange={(v) => set('transferFrom', v)} />
              <Txt label="Lý do chuyển bệnh" value={e.transferReason} onChange={(v) => set('transferReason', v)} />
            </div>
            <Txt label="Can thiệp tuyến trước / cộng đồng" area value={e.priorCare} onChange={(v) => set('priorCare', v)} />
            <div className="row">
              <span className="small muted">Hiện trường nguy hiểm</span>
              <Pick value={e.scene?.danger === true ? 'y' : e.scene?.danger === false ? 'n' : undefined} options={[['n', 'Không'], ['y', 'Có']]}
                onChange={(v) => set('scene.danger', v === undefined ? undefined : v === 'y')} />
              {e.scene?.danger && <input className="grow" placeholder="Mô tả nguy hiểm" value={e.scene?.dangerNote ?? ''} onChange={(ev) => set('scene.dangerNote', ev.target.value)} />}
            </div>
          </div>
        )}

        {tab === 'ABCDE và can thiệp' && (
          <div className="col">
            <div className="abcde-row abcde-head"><div /><b>Tiếp cận ABCDE</b><b>Can thiệp</b></div>
            <AbcdeRow title="Đường thở (A)"
              left={<>
                <Pick value={a.airway} options={[['patent', 'Thông thoáng'], ['obstructed', 'Tắc']]} onChange={(v) => set('abcde.airway', v)} />
                {a.airway === 'obstructed' && <input placeholder="Mô tả tắc" value={a.airwayNote ?? ''} onChange={(ev) => set('abcde.airwayNote', ev.target.value)} />}
              </>}
              right={<div className="row">
                <Chk label="Heimlich" value={c.heimlich} onChange={(v) => set('care.heimlich', v)} />
                <Chk label="Bóp bóng" value={c.bvm} onChange={(v) => set('care.bvm', v)} />
                <Chk label="Mask thanh quản" value={c.lma} onChange={(v) => set('care.lma', v)} />
                <Chk label="Nội khí quản" value={c.ett} onChange={(v) => set('care.ett', v)} />
                {c.ett && <input style={{ width: 90 }} placeholder="Cỡ ống" value={c.ettNote ?? ''} onChange={(ev) => set('care.ettNote', ev.target.value)} />}
                <Chk label="Hút đàm" value={c.suction} onChange={(v) => set('care.suction', v)} />
              </div>} />
            <AbcdeRow title="Kiểu thở (B)"
              left={<>
                <div className="row">
                  <Txt label="Nhịp thở (l/p)" type="number" width={110} value={a.rr} onChange={(v) => set('abcde.rr', v)} />
                  <Txt label="SpO₂ (%)" type="number" width={90} value={a.spo2} onChange={(v) => set('abcde.spo2', v)} />
                  <Chk label="Co kéo cơ hô hấp" value={a.retractions} onChange={(v) => set('abcde.retractions', v)} />
                </div>
                <input placeholder="Ghi chú" value={a.breathingNote ?? ''} onChange={(ev) => set('abcde.breathingNote', ev.target.value)} />
              </>}
              right={<div className="row">
                <Chk label="Thở oxy canula" value={c.o2Cannula} onChange={(v) => set('care.o2Cannula', v)} />
                {c.o2Cannula && <input style={{ width: 80 }} placeholder="l/p" value={c.o2CannulaFlow ?? ''} onChange={(ev) => set('care.o2CannulaFlow', ev.target.value)} />}
                <Chk label="Mask có túi khí" value={c.nrbMask} onChange={(v) => set('care.nrbMask', v)} />
                {c.nrbMask && <input style={{ width: 80 }} placeholder="l/p" value={c.nrbFlow ?? ''} onChange={(ev) => set('care.nrbFlow', ev.target.value)} />}
                <Chk label="Bóp mask" value={c.bagMask} onChange={(v) => set('care.bagMask', v)} />
                <Chk label="Bóp bóng NKQ" value={c.bagEtt} onChange={(v) => set('care.bagEtt', v)} />
                <Chk label="PKD" value={c.nebulizer} onChange={(v) => set('care.nebulizer', v)} />
              </div>} />
            <AbcdeRow title="Tuần hoàn (C)"
              left={<>
                <div className="row">
                  <Txt label="Mạch (l/p)" type="number" width={90} value={a.hr} onChange={(v) => set('abcde.hr', v)} />
                  <Txt label="CRT (s)" type="number" width={70} value={a.crt} onChange={(v) => set('abcde.crt', v)} />
                  <Txt label="HA tâm thu" type="number" width={90} value={a.sbp} onChange={(v) => set('abcde.sbp', v)} />
                  <Txt label="HA tâm trương" type="number" width={100} value={a.dbp} onChange={(v) => set('abcde.dbp', v)} />
                </div>
                <Txt label="ECG" value={a.ecg} onChange={(v) => set('abcde.ecg', v)} />
              </>}
              right={<>
                <div className="row">
                  <Chk label="Ép tim" value={c.cpr} onChange={(v) => set('care.cpr', v)} />
                  <Chk label="Sốc điện" value={c.defib} onChange={(v) => set('care.defib', v)} />
                  {c.defib && <input style={{ width: 120 }} placeholder="Số lần, năng lượng" value={c.defibNote ?? ''} onChange={(ev) => set('care.defibNote', ev.target.value)} />}
                  <Chk label="Monitor" value={c.monitor} onChange={(v) => set('care.monitor', v)} />
                  <Chk label="TTM" value={c.iv} onChange={(v) => set('care.iv', v)} />
                </div>
                {c.iv && <input placeholder="Dịch truyền, đường truyền" value={c.ivNote ?? ''} onChange={(ev) => set('care.ivNote', ev.target.value)} />}
              </>} />
            <AbcdeRow title="Thần kinh (D)"
              left={<>
                <Pick label="AVPU" value={a.avpu} options={[['A', 'A'], ['V', 'V'], ['P', 'P'], ['U', 'U']]} onChange={(v) => set('abcde.avpu', v)} />
                <div className="row">
                  <span className="small muted">FAST</span>
                  <Chk label="F" value={a.fastF} onChange={(v) => set('abcde.fastF', v)} />
                  <Chk label="A" value={a.fastA} onChange={(v) => set('abcde.fastA', v)} />
                  <Chk label="S" value={a.fastS} onChange={(v) => set('abcde.fastS', v)} />
                  <Chk label="T" value={a.fastT} onChange={(v) => set('abcde.fastT', v)} />
                </div>
                <div className="row">
                  <Chk label="Co giật" value={a.seizure} onChange={(v) => set('abcde.seizure', v)} />
                  <Txt label="Đồng tử (mm)" width={110} value={a.pupils} onChange={(v) => set('abcde.pupils', v)} />
                  <Txt label="ĐH (mg%)" type="number" width={90} value={a.glucose} onChange={(v) => set('abcde.glucose', v)} />
                </div>
              </>}
              right={<Txt label="Can thiệp thần kinh" area value={c.neuroCare} onChange={(v) => set('care.neuroCare', v)} />} />
            <AbcdeRow title="Toàn diện (E)"
              left={<>
                <Txt label="Nhiệt độ (°C)" type="number" width={110} value={a.temp} onChange={(v) => set('abcde.temp', v)} />
                <div className="row">
                  <span className="small muted">Chấn thương</span>
                  <Chk label="Đầu" value={a.injHead} onChange={(v) => set('abcde.injHead', v)} />
                  <Chk label="Cột sống" value={a.injSpine} onChange={(v) => set('abcde.injSpine', v)} />
                  <Chk label="Chi" value={a.injLimb} onChange={(v) => set('abcde.injLimb', v)} />
                  <Chk label="Đa chấn thương" value={a.injMulti} onChange={(v) => set('abcde.injMulti', v)} />
                </div>
                <Pick label="Chảy máu" value={a.bleeding} options={[['spurting', 'Thành tia'], ['flowing', 'Dòng'], ['oozing', 'Rỉ']]} onChange={(v) => set('abcde.bleeding', v)} />
              </>}
              right={<>
                <div className="row">
                  <span className="small muted">Cố định</span>
                  <Chk label="Cổ" value={c.collar} onChange={(v) => set('care.collar', v)} />
                  <Chk label="Cột sống" value={c.spine} onChange={(v) => set('care.spine', v)} />
                  <Chk label="Khung chậu" value={c.pelvis} onChange={(v) => set('care.pelvis', v)} />
                  <Chk label="Vai" value={c.splintShoulder} onChange={(v) => set('care.splintShoulder', v)} />
                  <Chk label="Tay" value={c.splintArm} onChange={(v) => set('care.splintArm', v)} />
                  <Chk label="Chân" value={c.splintLeg} onChange={(v) => set('care.splintLeg', v)} />
                </div>
                <input placeholder="Ghi chú cố định" value={c.splintNote ?? ''} onChange={(ev) => set('care.splintNote', ev.target.value)} />
                <div className="row">
                  <Chk label="Băng ép cầm máu" value={c.pressureBandage} onChange={(v) => set('care.pressureBandage', v)} />
                  {c.pressureBandage && <input className="grow" placeholder="Vị trí" value={c.bandageNote ?? ''} onChange={(ev) => set('care.bandageNote', ev.target.value)} />}
                </div>
              </>} />
            <div className="panel" style={{ background: 'var(--panel-2)' }}>
              <div className="row">
                <b>Chấn thương</b>
                <Pick value={e.trauma?.present === true ? 'y' : e.trauma?.present === false ? 'n' : undefined} options={[['y', 'Có'], ['n', 'Không']]}
                  onChange={(v) => set('trauma.present', v === undefined ? undefined : v === 'y')} />
              </div>
              {e.trauma?.present && (
                <>
                  <div className="row" style={{ marginTop: 6 }}>
                    {TRAUMA_TYPES.map((t) => <Chk key={t} label={t} value={(e.trauma?.types ?? []).includes(t)} onChange={() => toggleTrauma(t)} />)}
                  </div>
                  <input style={{ marginTop: 6, width: '100%' }} placeholder="Vị trí trên cơ thể (VD: cẳng chân phải mặt trước)" value={e.trauma?.note ?? ''} onChange={(ev) => set('trauma.note', ev.target.value)} />
                </>
              )}
            </div>
          </div>
        )}

        {tab === 'SAMPLE, khám, chẩn đoán' && (
          <div className="col">
            <h3>Bệnh sử SAMPLE</h3>
            <Txt label="Dấu hiệu / triệu chứng (S)" area value={e.sample?.symptoms} onChange={(v) => set('sample.symptoms', v)} />
            <div className="row">
              <span className="small muted">Dị ứng (A)</span>
              <Pick value={e.sample?.allergy === true ? 'y' : e.sample?.allergy === false ? 'n' : undefined} options={[['n', 'Không'], ['y', 'Có']]}
                onChange={(v) => set('sample.allergy', v === undefined ? undefined : v === 'y')} />
              {e.sample?.allergy && <input className="grow" placeholder="Dị ứng với" value={e.sample?.allergies ?? ''} onChange={(ev) => set('sample.allergies', ev.target.value)} />}
            </div>
            <div className="grid2">
              <Txt label="Thuốc đang dùng (M)" value={e.sample?.medications} onChange={(v) => set('sample.medications', v)} />
              <Txt label="Tiền sử bệnh (P)" value={e.sample?.pastHistory} onChange={(v) => set('sample.pastHistory', v)} />
              <Txt label="Ăn cuối cùng (L)" value={e.sample?.lastMeal} onChange={(v) => set('sample.lastMeal', v)} />
              <Txt label="Liên quan (E)" value={e.sample?.events} onChange={(v) => set('sample.events', v)} />
            </div>
            <h3>Khám toàn diện</h3>
            <div className="grid2">
              <Txt label="Đầu – Mặt" value={e.exam?.headFace} onChange={(v) => set('exam.headFace', v)} />
              <Txt label="Cổ" value={e.exam?.neck} onChange={(v) => set('exam.neck', v)} />
              <Txt label="Ngực" value={e.exam?.chest} onChange={(v) => set('exam.chest', v)} />
              <Txt label="Bụng" value={e.exam?.abdomen} onChange={(v) => set('exam.abdomen', v)} />
              <Txt label="Chi" value={e.exam?.limbs} onChange={(v) => set('exam.limbs', v)} />
              <Txt label="Da niêm" value={e.exam?.skin} onChange={(v) => set('exam.skin', v)} />
            </div>
            <Txt label="Khác" value={e.exam?.other} onChange={(v) => set('exam.other', v)} />
            <Txt label="Can thiệp sau khám toàn diện" area value={e.postExamCare} onChange={(v) => set('postExamCare', v)} />
            <div className="grid2">
              <Txt label="Chẩn đoán" value={e.diagnosis?.text} onChange={(v) => set('diagnosis.text', v)} />
              <label className="field">Mã ICD-10
                <IcdInput value={e.diagnosis?.icd10 ?? ''} disabled={locked} onChange={(v) => set('diagnosis.icd10', v || undefined)}
                  onResolved={(code, name) => update((x) => {
                    x.diagnosis ??= {};
                    x.diagnosis.icd10 = code;
                    // Chưa ghi chẩn đoán thì lấy tên bệnh theo mã
                    if (!x.diagnosis.text?.trim()) x.diagnosis.text = name;
                    x.diagnosis.icdName = name;
                    return x;
                  })} />
              </label>
            </div>
          </div>
        )}

        {tab === 'Theo dõi' && (
          <div className="col">
            <div className="small muted">Cột đầu tiên là lúc nhận bệnh; mỗi lần đo thêm một cột.</div>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr><th>Theo dõi / Thời gian</th>{(e.vitals ?? []).map((v: any, i: number) => (
                    <th key={i}>{i === 0 ? 'Nhận bệnh ' : ''}{fmtTime(v.at, false)} <button className="ghost small" onClick={() => update((x) => { x.vitals.splice(i, 1); return x; })}>✕</button></th>
                  ))}</tr>
                </thead>
                <tbody>
                  {([['hr', 'Mạch'], ['bp', 'Huyết áp'], ['spo2', 'SpO₂'], ['temp', 'Nhiệt độ'], ['rr', 'Nhịp thở'], ['monitor', 'Monitor'], ['other', 'Khác']] as const).map(([k, l]) => (
                    <tr key={k}>
                      <td><b>{l}</b></td>
                      {(e.vitals ?? []).map((v: any, i: number) => (
                        <td key={i}>
                          {k === 'bp'
                            ? <span className="row" style={{ flexWrap: 'nowrap', gap: 2 }}>
                                <input style={{ width: 50 }} inputMode="numeric" value={v.sbp ?? ''} onChange={(ev) => set(`vitals.${i}.sbp`, toNum(ev.target.value))} />/
                                <input style={{ width: 50 }} inputMode="numeric" value={v.dbp ?? ''} onChange={(ev) => set(`vitals.${i}.dbp`, toNum(ev.target.value))} />
                              </span>
                            : k === 'monitor' || k === 'other'
                              ? <input style={{ width: 110 }} value={v[k] ?? ''} onChange={(ev) => set(`vitals.${i}.${k}`, ev.target.value)} />
                              : <input style={{ width: 64 }} inputMode="decimal" value={v[k] ?? ''} onChange={(ev) => set(`vitals.${i}.${k}`, toNum(ev.target.value))} />}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="big" onClick={() => update((x) => { (x.vitals ??= []).push({ at: nowIso() }); return x; })}>+ Đo lúc này</button>
            <div className="hr" />
            <h3>Can thiệp (có giờ)</h3>
            {(e.interventions ?? []).map((it: any, i: number) => (
              <div key={i} className="grid4">
                <label className="field">Giờ<input type="datetime-local" value={localInput(it.at)} onChange={(ev) => set(`interventions.${i}.at`, fromLocal(ev.target.value))} /></label>
                <Txt label="Can thiệp" value={it.name} onChange={(v) => set(`interventions.${i}.name`, v)} />
                <Txt label="Người làm" value={it.by} onChange={(v) => set(`interventions.${i}.by`, v)} />
                <Txt label="Ghi chú" value={it.note} onChange={(v) => set(`interventions.${i}.note`, v)} />
              </div>
            ))}
            <div className="row">
              {['Ép tim', 'Sốc điện', 'Mask thanh quản', 'Nội khí quản', 'Đường truyền TM', 'Kim truyền trong xương', 'Thở oxy', 'Cố định cột sống', 'Garo cầm máu'].map((n) => (
                <button key={n} onClick={() => update((x) => { (x.interventions ??= []).push({ at: nowIso(), name: n }); return x; })}>+ {n}</button>
              ))}
            </div>
            <h3>Thuốc (số lô lấy từ kho của điểm, lô hết hạn sớm nhất được chọn trước)</h3>
            {!d.vehicleId && <div className="small muted">Phiếu chưa gắn xe nên chưa lấy được kho thuốc; nhập số lô bằng tay.</div>}
            {(e.medications ?? []).map((m: any, i: number) => {
              const lots = stock.filter((l) => l.drug_id === m.drugId || (!m.drugId && sameDrug(l.drug_name, m.name)));
              return (
                <div key={i} className="grid4" style={{ marginBottom: 6 }}>
                  <label className="field">Giờ<input type="datetime-local" value={localInput(m.at)} onChange={(ev) => set(`medications.${i}.at`, fromLocal(ev.target.value))} /></label>
                  {stockDrugs.length ? (
                    <label className="field">Thuốc
                      <select value={m.drugId ?? ''} onChange={(ev) => update((x) => {
                        const id = Number(ev.target.value);
                        const row = x.medications[i];
                        delete row.lotId; delete row.lot; delete row.expiry; delete row.drugId;
                        applyLot(row, stock.find((l) => l.drug_id === id));
                        return x;
                      })}>
                        <option value="">{m.name && !m.drugId ? `${m.name} (ngoài kho)` : '— Chọn thuốc —'}</option>
                        {stockDrugs.map((l) => <option key={l.drug_id} value={l.drug_id}>{l.drug_name}</option>)}
                      </select>
                    </label>
                  ) : <Txt label="Thuốc" value={m.name} onChange={(v) => set(`medications.${i}.name`, v)} />}
                  <Txt label="Liều" value={m.dose} onChange={(v) => set(`medications.${i}.dose`, v)} />
                  <Txt label="Đường dùng" value={m.route} onChange={(v) => set(`medications.${i}.route`, v)} />
                  {lots.length ? (
                    <label className="field">Số lô
                      <select value={m.lotId ?? ''} onChange={(ev) => update((x) => { applyLot(x.medications[i], stock.find((l) => l.id === ev.target.value)); return x; })}>
                        <option value="">— Chọn lô —</option>
                        {lots.map((l) => <option key={l.id} value={l.id}>{l.place === 'kho' ? 'Kho điểm' : 'Trên xe'} · {l.lot} · HD {l.expiry} · còn {Number(l.qty)} {l.unit}</option>)}
                      </select>
                    </label>
                  ) : <Txt label="Số lô" value={m.lot} onChange={(v) => set(`medications.${i}.lot`, v)} />}
                  <Txt label="Hạn dùng" value={m.expiry} onChange={(v) => set(`medications.${i}.expiry`, v)} />
                  <Txt label="Số lượng" type="number" value={m.qty} onChange={(v) => set(`medications.${i}.qty`, v)} />
                  <Txt label="Người dùng" value={m.by} onChange={(v) => set(`medications.${i}.by`, v)} />
                  <Txt label={lots.some((l) => l.controlled) ? 'Người chứng kiến (bắt buộc: thuốc kiểm soát đặc biệt)' : 'Người chứng kiến'} value={m.witness} onChange={(v) => set(`medications.${i}.witness`, v)} />
                </div>
              );
            })}
            <div className="row">
              {QUICK_DRUGS.map((n) => <button key={n} onClick={() => addDrug(n)}>+ {n}</button>)}
            </div>
          </div>
        )}

        {tab === 'Em bé (sanh rớt)' && (
          <div className="col">
            <Chk label="Có sanh rớt (sinh trước khi tới viện)" value={nb.born} onChange={(v) => set('newborn.born', v)} />
            {nb.born && (
              <>
                <div className="grid3">
                  <label className="field">Giờ sinh<input type="datetime-local" value={localInput(nb.at)} onChange={(ev) => set('newborn.at', fromLocal(ev.target.value))} /></label>
                  <label className="field">Giới
                    <select value={nb.sex ?? ''} onChange={(ev) => set('newborn.sex', ev.target.value || undefined)}><option value="">—</option><option value="M">Nam</option><option value="F">Nữ</option></select>
                  </label>
                  <div className="row">
                    <Txt label="Apgar 1'" type="number" width={80} value={nb.apgar1} onChange={(v) => set('newborn.apgar1', v)} />
                    <Txt label="Apgar 5'" type="number" width={80} value={nb.apgar5} onChange={(v) => set('newborn.apgar5', v)} />
                  </div>
                  <Txt label="Nhịp tim" value={nb.heartRate} onChange={(v) => set('newborn.heartRate', v)} />
                  <Txt label="Hô hấp" value={nb.respiration} onChange={(v) => set('newborn.respiration', v)} />
                  <Txt label="Cử động" value={nb.movement} onChange={(v) => set('newborn.movement', v)} />
                  <Txt label="Phản xạ" value={nb.reflex} onChange={(v) => set('newborn.reflex', v)} />
                  <Txt label="Màu da" value={nb.color} onChange={(v) => set('newborn.color', v)} />
                </div>
                <div className="row">
                  <Chk label="Cắt rốn" value={nb.cordCut} onChange={(v) => set('newborn.cordCut', v)} />
                  <Chk label="Kẹp rốn" value={nb.cordClamped} onChange={(v) => set('newborn.cordClamped', v)} />
                  <Chk label="Ủ ấm" value={nb.warmed} onChange={(v) => set('newborn.warmed', v)} />
                  <Chk label="Da kề da" value={nb.skinToSkin} onChange={(v) => set('newborn.skinToSkin', v)} />
                  <Chk label="Đường thở sạch" value={nb.airwayClear} onChange={(v) => set('newborn.airwayClear', v)} />
                  <Chk label="Hút đàm nhớt" value={nb.suction} onChange={(v) => set('newborn.suction', v)} />
                  <Chk label="Thở oxy" value={nb.oxygen} onChange={(v) => set('newborn.oxygen', v)} />
                  <Chk label="Nội khí quản" value={nb.ett} onChange={(v) => set('newborn.ett', v)} />
                </div>
                <div className="grid3">
                  {!nb.airwayClear && <Txt label="Đường thở (mô tả)" value={nb.airwayNote} onChange={(v) => set('newborn.airwayNote', v)} />}
                  {nb.oxygen && <Txt label="Oxy (l/p, cách thở)" value={nb.oxygenNote} onChange={(v) => set('newborn.oxygenNote', v)} />}
                  {nb.ett && <Txt label="Nội khí quản (cỡ ống)" value={nb.ettNote} onChange={(v) => set('newborn.ettNote', v)} />}
                </div>
                <Txt label="Hồi sinh tim phổi em bé" area value={nb.cpr} onChange={(v) => set('newborn.cpr', v)} />
              </>
            )}
          </div>
        )}

        {tab === 'Giao nhận bệnh' && (
          <div className="col">
            <Txt label="Lưu ý khi vận chuyển" area value={e.transportNotes} onChange={(v) => set('transportNotes', v)} />
            <label className="field">Kết cục
              <select value={e.disposition?.type ?? ''} onChange={(ev) => set('disposition.type', ev.target.value || undefined)}>
                <option value="">— Chọn —</option>
                <option value="transported">Vận chuyển tới bệnh viện</option>
                <option value="treated_released">Xử trí tại chỗ, không vận chuyển</option>
                <option value="refused">Người bệnh từ chối (có cam kết)</option>
                <option value="dead_on_scene">Tử vong tại hiện trường</option>
                <option value="cancelled">Hủy trên đường</option>
              </select>
            </label>
            {e.disposition?.type === 'refused' && (
              <div className="grid2">
                <Chk label="Người bệnh/người nhà đã ký cam kết" value={e.disposition?.refusalSigned} onChange={(v) => set('disposition.refusalSigned', v)} />
                <Txt label="Người chứng kiến" value={e.disposition?.refusalWitness} onChange={(v) => set('disposition.refusalWitness', v)} />
              </div>
            )}
            <div className="grid2">
              <label className="field" style={{ gridColumn: '1 / -1' }}>Chuyển bệnh (bệnh viện và khoa nhận)
                <HospitalPicker hospital={e.disposition?.hospital ?? ''} department={e.disposition?.department ?? ''} disabled={locked} onChange={setHospital} />
              </label>
              <label className="field">Thời gian giao bệnh
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input className="grow" type="datetime-local" value={localInput(e.disposition?.handoverAt)} onChange={(ev) => set('disposition.handoverAt', fromLocal(ev.target.value))} />
                  <button onClick={() => set('disposition.handoverAt', nowIso())}>Bây giờ</button>
                </div>
              </label>
              <label className="field">Đối tượng
                <select value={e.payer ?? ''} onChange={(ev) => set('payer', ev.target.value || undefined)}>
                  <option value="">— Chọn —</option><option value="BHYT">BHYT</option><option value="THU_PHI">Thu phí</option>
                  <option value="MIEN">Miễn</option><option value="GIAM">Giảm</option><option value="THAT_THU">Thất thu</option>
                </select>
              </label>
            </div>
            <div className="grid2">
              <div className="col">
                <h3>Đơn vị giao bệnh</h3>
                <Txt label="Đơn vị" value={e.disposition?.fromUnit} onChange={(v) => set('disposition.fromUnit', v)} />
                <Txt label="Nhận xét" area value={e.disposition?.fromComment} onChange={(v) => set('disposition.fromComment', v)} />
              </div>
              <div className="col">
                <h3>Đơn vị nhận bệnh</h3>
                <Txt label="Đơn vị (tự điền theo bệnh viện, khoa chuyển đến)" value={e.disposition?.toUnit} onChange={(v) => set('disposition.toUnit', v)} />
                <Txt label="Người nhận" value={e.disposition?.receiverName} onChange={(v) => set('disposition.receiverName', v)} />
                <Txt label="Chức danh" value={e.disposition?.receiverTitle} onChange={(v) => set('disposition.receiverTitle', v)} />
                <Txt label="Nhận xét" area value={e.disposition?.toComment} onChange={(v) => set('disposition.toComment', v)} />
              </div>
            </div>
          </div>
        )}
      </fieldset>
      {tab === 'Ký phiếu' && (
        <div className="col">
          {!d.patientId && <div className="alert amber">Chưa gắn bệnh án (Số BA). Vào thẻ “Thông tin, điều phối” để tìm theo CCCD hoặc tạo bệnh án.</div>}
          {missing.length > 0 && <div className="alert red">Còn thiếu: <ul>{missing.map((m) => <li key={m}>{m}</li>)}</ul></div>}
          {msg && <div className="alert blue">{msg}</div>}
          <div className="row">
            {!locked && <button className="primary big" onClick={sign}>Ký và đóng phiếu</button>}
            <a className="btn" href={`/phieu/${d.id}`} target="_blank" rel="noreferrer">Xem / in phiếu theo mẫu</a>
          </div>
        </div>
      )}
    </div>
  );
}
