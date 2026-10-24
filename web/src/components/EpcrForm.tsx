import { useEffect, useRef, useState } from 'react';
import { api, fmtTime } from '../api';
import { saveDraft, syncDraft, type Draft } from '../offline';
import { PatientPicker } from './PatientPicker';

const TABS = ['Người bệnh', 'ABCDE', 'SAMPLE và khám', 'Sinh hiệu', 'Can thiệp, thuốc', 'Chẩn đoán, kết cục', 'Ký phiếu'] as const;

const nowIso = () => new Date().toISOString();
const localInput = (iso?: string) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : undefined);

function Txt({ label, value, onChange, area = false, type = 'text' }: { label: string; value: any; onChange: (v: any) => void; area?: boolean; type?: string }) {
  return (
    <label className="field">{label}
      {area
        ? <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        : <input type={type} inputMode={type === 'number' ? 'decimal' : undefined} value={value ?? ''}
            onChange={(e) => onChange(type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)} />}
    </label>
  );
}

/** Phiếu chuyển viện / ePCR: lưu vào máy ngay mỗi lần sửa, đồng bộ khi có mạng */
export function EpcrForm({ draft: initial, onChange }: { draft: Draft; onChange?: (d: Draft) => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Người bệnh');
  const [msg, setMsg] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const syncTimer = useRef<number | undefined>(undefined);
  const e = d.epcr;
  const locked = d.status === 'signed';

  useEffect(() => { onChange?.(d); }, [d]);

  const update = (patch: (epcr: any) => any, extra: Partial<Draft> = {}) => {
    setD((cur) => {
      const next: Draft = { ...cur, ...extra, epcr: patch(structuredClone(cur.epcr)), dirty: true, updatedAt: nowIso() };
      saveDraft(next);
      clearTimeout(syncTimer.current);
      syncTimer.current = window.setTimeout(async () => { const s = await syncDraft(next.id); if (s) setD((c) => ({ ...c, baseVersion: s.baseVersion, number: s.number, dirty: c.updatedAt !== next.updatedAt || s.dirty, conflict: s.conflict, syncedAt: s.syncedAt })); }, 1500);
      return next;
    });
  };
  const setPath = (path: string, v: any) => update((x) => {
    const parts = path.split('.');
    let o = x;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts[parts.length - 1]] = v;
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
        <div><b>Phiếu chuyển viện {d.number ?? '(chưa cấp số – cấp khi đồng bộ)'}</b>{locked && <span className="badge" style={{ marginLeft: 6 }}>Đã ký</span>}</div>
        <div className="small">{syncState}</div>
      </div>
      <div className="tabs" style={{ marginTop: 8 }}>
        {TABS.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <fieldset disabled={locked} style={{ border: 'none', padding: 0, margin: 0 }}>
        {tab === 'Người bệnh' && (
          <div className="col">
            <PatientPicker value={d.patientId} label={d.patientLabel ?? null}
              onPick={(p) => update((x) => { x.patient = { ...x.patient, fullName: p.full_name ?? x.patient?.fullName, sex: p.sex ?? x.patient?.sex }; return x; }, { patientId: p.id, patientLabel: `${p.ba_number} · ${p.full_name ?? 'Chưa rõ tên'}` })} />
            <div className="grid4">
              <Txt label="Họ tên" value={e.patient?.fullName} onChange={(v) => setPath('patient.fullName', v)} />
              <label className="field">Giới
                <select value={e.patient?.sex ?? ''} onChange={(ev) => setPath('patient.sex', ev.target.value || undefined)}>
                  <option value="">—</option><option value="M">Nam</option><option value="F">Nữ</option><option value="U">Chưa rõ</option>
                </select>
              </label>
              <Txt label="Tuổi" type="number" value={e.patient?.age} onChange={(v) => setPath('patient.age', v)} />
              <Txt label="Cân nặng (kg)" type="number" value={e.patient?.weightKg} onChange={(v) => setPath('patient.weightKg', v)} />
            </div>
            <Txt label="Lý do cấp cứu" value={e.chiefComplaint} onChange={(v) => setPath('chiefComplaint', v)} />
            <div className="grid2">
              <Txt label="Nơi xảy ra / loại hiện trường" value={e.scene?.type} onChange={(v) => setPath('scene.type', v)} />
              <Txt label="An toàn hiện trường" value={e.scene?.safety} onChange={(v) => setPath('scene.safety', v)} />
            </div>
          </div>
        )}
        {tab === 'ABCDE' && (
          <div className="col">
            <Txt label="A – Đường thở" value={e.abcde?.airway} onChange={(v) => setPath('abcde.airway', v)} />
            <Txt label="B – Hô hấp" value={e.abcde?.breathing} onChange={(v) => setPath('abcde.breathing', v)} />
            <Txt label="C – Tuần hoàn" value={e.abcde?.circulation} onChange={(v) => setPath('abcde.circulation', v)} />
            <div className="grid4">
              <Txt label="GCS – Mắt (E)" type="number" value={e.abcde?.gcsE} onChange={(v) => setPath('abcde.gcsE', v)} />
              <Txt label="GCS – Lời (V)" type="number" value={e.abcde?.gcsV} onChange={(v) => setPath('abcde.gcsV', v)} />
              <Txt label="GCS – Vận động (M)" type="number" value={e.abcde?.gcsM} onChange={(v) => setPath('abcde.gcsM', v)} />
              <Txt label="Đồng tử" value={e.abcde?.pupils} onChange={(v) => setPath('abcde.pupils', v)} />
            </div>
            <Txt label="D – Thần kinh (khác)" value={e.abcde?.disability} onChange={(v) => setPath('abcde.disability', v)} />
            <Txt label="E – Bộc lộ, toàn thân" value={e.abcde?.exposure} onChange={(v) => setPath('abcde.exposure', v)} />
          </div>
        )}
        {tab === 'SAMPLE và khám' && (
          <div className="col">
            <div className="grid2">
              <Txt label="S – Triệu chứng" value={e.sample?.symptoms} onChange={(v) => setPath('sample.symptoms', v)} />
              <Txt label="A – Dị ứng" value={e.sample?.allergies} onChange={(v) => setPath('sample.allergies', v)} />
              <Txt label="M – Thuốc đang dùng" value={e.sample?.medications} onChange={(v) => setPath('sample.medications', v)} />
              <Txt label="P – Tiền sử" value={e.sample?.pastHistory} onChange={(v) => setPath('sample.pastHistory', v)} />
              <Txt label="L – Bữa ăn cuối" value={e.sample?.lastMeal} onChange={(v) => setPath('sample.lastMeal', v)} />
              <Txt label="E – Diễn biến trước đó" value={e.sample?.events} onChange={(v) => setPath('sample.events', v)} />
            </div>
            <Txt label="Khám toàn diện" area value={e.exam} onChange={(v) => setPath('exam', v)} />
            <div className="grid3">
              <label className="row small"><input type="checkbox" checked={!!e.ecg?.done} onChange={(ev) => setPath('ecg.done', ev.target.checked)} /> Đã làm điện tim 12 chuyển đạo</label>
              <Txt label="Kết quả điện tim" value={e.ecg?.interpretation} onChange={(v) => setPath('ecg.interpretation', v)} />
              <label className="row small"><input type="checkbox" checked={!!e.ecg?.stemi} onChange={(ev) => setPath('ecg.stemi', ev.target.checked)} /> STEMI</label>
            </div>
          </div>
        )}
        {tab === 'Sinh hiệu' && (
          <div className="col">
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Giờ</th><th>Mạch</th><th>HA</th><th>Nhịp thở</th><th>SpO₂</th><th>Nhiệt độ</th><th>Đường huyết</th><th>GCS</th><th>Đau</th><th /></tr></thead>
                <tbody>
                  {(e.vitals ?? []).map((v: any, i: number) => (
                    <tr key={i}>
                      <td className="mono">{fmtTime(v.at, false)}</td>
                      {(['hr', 'sbp', 'rr', 'spo2', 'temp', 'glucose', 'gcs', 'pain'] as const).map((k) => (
                        <td key={k}>
                          {k === 'sbp'
                            ? <span className="row" style={{ flexWrap: 'nowrap', gap: 2 }}>
                                <input style={{ width: 52 }} inputMode="numeric" value={v.sbp ?? ''} onChange={(ev) => setPath(`vitals.${i}.sbp`, ev.target.value === '' ? undefined : Number(ev.target.value))} />/
                                <input style={{ width: 52 }} inputMode="numeric" value={v.dbp ?? ''} onChange={(ev) => setPath(`vitals.${i}.dbp`, ev.target.value === '' ? undefined : Number(ev.target.value))} />
                              </span>
                            : <input style={{ width: 60 }} inputMode="decimal" value={v[k] ?? ''} onChange={(ev) => setPath(`vitals.${i}.${k}`, ev.target.value === '' ? undefined : Number(ev.target.value))} />}
                        </td>
                      ))}
                      <td><button className="ghost" onClick={() => update((x) => { x.vitals.splice(i, 1); return x; })}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="big" onClick={() => update((x) => { (x.vitals ??= []).push({ at: nowIso() }); return x; })}>+ Đo sinh hiệu lúc này</button>
          </div>
        )}
        {tab === 'Can thiệp, thuốc' && (
          <div className="col">
            <h3>Thủ thuật, can thiệp</h3>
            {(e.interventions ?? []).map((it: any, i: number) => (
              <div key={i} className="grid4">
                <label className="field">Giờ<input type="datetime-local" value={localInput(it.at)} onChange={(ev) => setPath(`interventions.${i}.at`, fromLocal(ev.target.value))} /></label>
                <Txt label="Tên" value={it.name} onChange={(v) => setPath(`interventions.${i}.name`, v)} />
                <Txt label="Người làm" value={it.by} onChange={(v) => setPath(`interventions.${i}.by`, v)} />
                <Txt label="Ghi chú" value={it.note} onChange={(v) => setPath(`interventions.${i}.note`, v)} />
              </div>
            ))}
            <div className="row">
              {['Ép tim', 'Sốc điện', 'Đặt i-gel', 'Đặt NKQ', 'Đường truyền TM', 'Kim truyền trong xương', 'Thở oxy', 'Cố định cột sống', 'Garo cầm máu'].map((n) => (
                <button key={n} onClick={() => update((x) => { (x.interventions ??= []).push({ at: nowIso(), name: n }); return x; })}>+ {n}</button>
              ))}
            </div>
            <div className="hr" />
            <h3>Thuốc (ghi số lô bắt buộc)</h3>
            {(e.medications ?? []).map((m: any, i: number) => (
              <div key={i} className="grid4" style={{ marginBottom: 6 }}>
                <label className="field">Giờ<input type="datetime-local" value={localInput(m.at)} onChange={(ev) => setPath(`medications.${i}.at`, fromLocal(ev.target.value))} /></label>
                <Txt label="Thuốc" value={m.name} onChange={(v) => setPath(`medications.${i}.name`, v)} />
                <Txt label="Liều" value={m.dose} onChange={(v) => setPath(`medications.${i}.dose`, v)} />
                <Txt label="Đường dùng" value={m.route} onChange={(v) => setPath(`medications.${i}.route`, v)} />
                <Txt label="Số lô" value={m.lot} onChange={(v) => setPath(`medications.${i}.lot`, v)} />
                <Txt label="Hạn dùng" value={m.expiry} onChange={(v) => setPath(`medications.${i}.expiry`, v)} />
                <Txt label="Người dùng" value={m.by} onChange={(v) => setPath(`medications.${i}.by`, v)} />
                <Txt label="Người chứng kiến" value={m.witness} onChange={(v) => setPath(`medications.${i}.witness`, v)} />
              </div>
            ))}
            <div className="row">
              {['Adrenalin', 'Amiodaron', 'Aspirin', 'Nitroglycerin', 'Salbutamol', 'Glucose 30%', 'Tranexamic acid', 'Naloxon'].map((n) => (
                <button key={n} onClick={() => update((x) => { (x.medications ??= []).push({ at: nowIso(), name: n }); return x; })}>+ {n}</button>
              ))}
            </div>
          </div>
        )}
        {tab === 'Chẩn đoán, kết cục' && (
          <div className="col">
            <div className="grid2">
              <Txt label="Chẩn đoán" value={e.diagnosis?.text} onChange={(v) => setPath('diagnosis.text', v)} />
              <Txt label="Mã ICD-10" value={e.diagnosis?.icd10} onChange={(v) => setPath('diagnosis.icd10', v)} />
            </div>
            <label className="field">Kết cục
              <select value={e.disposition?.type ?? ''} onChange={(ev) => setPath('disposition.type', ev.target.value || undefined)}>
                <option value="">— Chọn —</option>
                <option value="transported">Vận chuyển tới bệnh viện</option>
                <option value="treated_released">Xử trí tại chỗ, không vận chuyển</option>
                <option value="refused">Người bệnh từ chối (có cam kết)</option>
                <option value="dead_on_scene">Tử vong tại hiện trường</option>
                <option value="cancelled">Hủy trên đường</option>
              </select>
            </label>
            {e.disposition?.type === 'transported' && (
              <div className="grid2">
                <Txt label="Bệnh viện nhận" value={e.disposition?.hospital} onChange={(v) => setPath('disposition.hospital', v)} />
                <Txt label="Khoa" value={e.disposition?.department} onChange={(v) => setPath('disposition.department', v)} />
                <Txt label="Người nhận bàn giao" value={e.disposition?.receiverName} onChange={(v) => setPath('disposition.receiverName', v)} />
                <Txt label="Chức danh người nhận" value={e.disposition?.receiverTitle} onChange={(v) => setPath('disposition.receiverTitle', v)} />
                <label className="field">Giờ bàn giao
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <input className="grow" type="datetime-local" value={localInput(e.disposition?.handoverAt)} onChange={(ev) => setPath('disposition.handoverAt', fromLocal(ev.target.value))} />
                    <button onClick={() => setPath('disposition.handoverAt', nowIso())}>Bây giờ</button>
                  </div>
                </label>
                <Txt label="Nội dung bàn giao (IMIST-AMBO)" area value={e.disposition?.handoverNote} onChange={(v) => setPath('disposition.handoverNote', v)} />
              </div>
            )}
            {e.disposition?.type === 'refused' && (
              <div className="grid2">
                <label className="row small"><input type="checkbox" checked={!!e.disposition?.refusalSigned} onChange={(ev) => setPath('disposition.refusalSigned', ev.target.checked)} /> Người bệnh/người nhà đã ký cam kết</label>
                <Txt label="Người chứng kiến" value={e.disposition?.refusalWitness} onChange={(v) => setPath('disposition.refusalWitness', v)} />
              </div>
            )}
            <div className="hr" />
            <h3>Sơ sinh (sanh rớt)</h3>
            <div className="grid4">
              <label className="row small"><input type="checkbox" checked={!!e.newborn?.born} onChange={(ev) => setPath('newborn.born', ev.target.checked)} /> Có sinh trên đường</label>
              <Txt label="Apgar 1 phút" type="number" value={e.newborn?.apgar1} onChange={(v) => setPath('newborn.apgar1', v)} />
              <Txt label="Apgar 5 phút" type="number" value={e.newborn?.apgar5} onChange={(v) => setPath('newborn.apgar5', v)} />
              <Txt label="Ghi chú" value={e.newborn?.note} onChange={(v) => setPath('newborn.note', v)} />
            </div>
            <label className="field">Đối tượng thu phí
              <select value={e.payer ?? ''} onChange={(ev) => setPath('payer', ev.target.value || undefined)}>
                <option value="">— Chọn —</option><option value="BHYT">BHYT</option><option value="THU_PHI">Thu phí</option>
                <option value="MIEN">Miễn</option><option value="GIAM">Giảm</option><option value="THAT_THU">Thất thu</option>
              </select>
            </label>
            <Txt label="Ghi chú khác" area value={e.notes} onChange={(v) => setPath('notes', v)} />
          </div>
        )}
      </fieldset>
      {tab === 'Ký phiếu' && (
        <div className="col">
          {!d.patientId && <div className="alert amber">Chưa gắn bệnh án (Số BA). Vào thẻ “Người bệnh” để tìm theo CCCD hoặc tạo bệnh án.</div>}
          {missing.length > 0 && <div className="alert red">Còn thiếu: <ul>{missing.map((m) => <li key={m}>{m}</li>)}</ul></div>}
          {msg && <div className="alert blue">{msg}</div>}
          {!locked
            ? <button className="primary big" onClick={sign}>Ký và đóng phiếu</button>
            : <a className="btn" href={`/phieu/${d.id}`} target="_blank" rel="noreferrer">Xem / in phiếu</a>}
        </div>
      )}
    </div>
  );
}
