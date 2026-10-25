import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, fmtDateTime } from '../api';
import { TRAUMA_TYPES } from '../components/EpcrForm';
import { StarOfLife } from '../Logo';
import qrcode from 'qrcode-generator';
import { SIGNATURE_KIND } from '../components/Signatures';

const PAYERS: [string, string][] = [['BHYT', 'BHYT'], ['THU_PHI', 'Thu phí'], ['MIEN', 'Miễn'], ['GIAM', 'Giảm'], ['THAT_THU', 'Thất thu']];
const DISPO: Record<string, string> = {
  transported: 'Vận chuyển tới bệnh viện', treated_released: 'Xử trí tại chỗ', refused: 'Từ chối (có cam kết)', dead_on_scene: 'Tử vong tại hiện trường', cancelled: 'Hủy',
};

/** Địa chỉ trang tra cứu mã phiếu: NEXT_PUBLIC_VERIFY_URL khi có địa chỉ công khai, không thì chính máy chủ đang mở */
const verifyBase = () => (process.env.NEXT_PUBLIC_VERIFY_URL || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '');

/** Mã xác thực và QR: bệnh viện nhận phiếu quét hoặc nhập mã để kiểm tra phiếu thật, đúng phiên bản */
function VerifyBox({ code }: { code: string }) {
  const url = `${verifyBase()}/xac-thuc?ma=${encodeURIComponent(code)}`;
  const q = qrcode(0, 'M');
  q.addData(url);
  q.make();
  return (
    <div className="verify">
      <span dangerouslySetInnerHTML={{ __html: q.createSvgTag({ cellSize: 2, margin: 0, scalable: true }) }} />
      <span>Mã xác thực<br /><b className="mono">{code}</b></span>
    </div>
  );
}

/** Ô đánh dấu như trên mẫu giấy */
function Cb({ on, label }: { on: any; label?: string }) {
  return <span style={{ whiteSpace: 'nowrap' }}>{label ? `${label} ` : ''}<span className="cb">{on ? '☑' : '☐'}</span></span>;
}

function F({ v, w }: { v: any; w?: number }) {
  return <span className="fill" style={w ? { minWidth: w } : undefined}>{v ?? v === 0 ? String(v) : ' '}</span>;
}

/** "14 giờ 02 phút 24/10/2026" theo cách ghi trên mẫu */
function gioPhut(iso?: string | null) {
  if (!iso) return <F v={null} w={120} />;
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return <F v={`${p(d.getHours())} giờ ${p(d.getMinutes())} phút ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`} />;
}

function hhmm(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Hình người mặt trước, mặt sau để đánh dấu vị trí chấn thương */
function BodyFigure() {
  const figure = (x: number) => (
    <g transform={`translate(${x} 0)`} fill="none" stroke="#555" strokeWidth="1.2">
      <circle cx="20" cy="10" r="7" />
      <path d="M13 20 Q20 17 27 20 L31 50 L27 51 L25 32 L25 58 L28 92 L22 92 L20 62 L18 92 L12 92 L15 58 L15 32 L13 51 L9 50 Z" />
    </g>
  );
  return (
    <svg viewBox="0 0 100 96" width="100" height="96" aria-label="Sơ đồ cơ thể mặt trước, mặt sau">
      {figure(4)}{figure(54)}
      <text x="24" y="96" fontSize="6" textAnchor="middle" fill="#555">Trước</text>
      <text x="74" y="96" fontSize="6" textAnchor="middle" fill="#555">Sau</text>
    </svg>
  );
}

/** Phiếu in theo mẫu "Bệnh án cấp cứu ngoại viện" (Trung tâm Cấp cứu 115 TP.HCM) chủ đầu tư gửi trên Drive */
export function TransferPrint() {
  const { id } = useParams<{ id: string }>();
  const [t, setT] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { api('GET', `/api/transfers/${id}`).then(setT).catch((e) => setError(e.message)); }, [id]);
  if (error) return <div className="panel error">{error}</div>;
  if (!t) return <div className="panel">Đang tải…</div>;

  const e = t.epcr ?? {};
  const a = e.abcde ?? {};
  const c = e.care ?? {};
  const s = e.sample ?? {};
  const x = e.exam ?? {};
  const nb = e.newborn ?? {};
  const dp = e.disposition ?? {};
  const time = (code: string) => t.times.find((y: any) => y.code === code)?.at;
  const traumaTypes: string[] = e.trauma?.types ?? [];
  const vit: any[] = (e.vitals ?? []).slice(0, 4);
  while (vit.length < 4) vit.push(null);
  const careRows: string[] = [
    ...(e.interventions ?? []).map((i: any) => `${hhmm(i.at)} ${i.name}${i.by ? ` (${i.by})` : ''}${i.note ? ` – ${i.note}` : ''}`),
    ...(e.medications ?? []).map((m: any) => `${hhmm(m.at)} ${m.name} ${m.dose ?? ''} ${m.route ?? ''}${m.qty ? ` ×${m.qty}` : ''} – lô ${m.lot ?? '—'}${m.expiry ? ` (HD ${m.expiry})` : ''}${m.by ? `, ${m.by}` : ''}${m.witness ? `, chứng kiến ${m.witness}` : ''}`),
  ];
  while (careRows.length < 4) careRows.push('');
  const sex = ({ M: 'Nam', F: 'Nữ', U: 'Chưa rõ' } as Record<string, string>)[t.patient_sex ?? e.patient?.sex] ?? '';

  return (
    <div>
      <div className="no-print row" style={{ justifyContent: 'center', marginBottom: 8 }}>
        <button className="primary" onClick={() => print()}>In phiếu (A4)</button>
      </div>
      <div className="ba">
        <div className="hdr">
          <div className="l"><StarOfLife size={34} /><div><b>MEDONE</b><div>DỊCH VỤ CHUYỂN VIỆN –<br />CẤP CỨU NGOẠI VIỆN</div></div></div>
          <div>Cộng Hòa Xã Hội Chủ Nghĩa Việt Nam<br />Độc Lập – Tự Do – Hạnh Phúc</div>
          <div className="r">Số BA: <b>{t.ba_number ?? '……'}</b><br />Số chuyển viện: <b>{t.transfer_number}</b><br /><span style={{ fontSize: 9 }}>Mã ca: {t.incident_code ?? '—'}</span>
            {t.verify_code && <VerifyBox code={t.verify_code} />}</div>
        </div>
        <h1>BỆNH ÁN CẤP CỨU NGOẠI VIỆN</h1>
        {t.status !== 'signed' && <div className="draft">BẢN NHÁP – CHƯA KÝ</div>}
        <div className="kg">
          <div className="t">Kính gửi: <F v={e.kinhGui ?? dp.hospital} w={260} /></div>
          <div className="infect"><span>Bệnh truyền nhiễm <span className="cb">{e.infectious ? '☑' : '☐'}</span></span></div>
        </div>

        <div className="box g3">
          <div>
            <div className="sec">Thông Tin Bệnh Nhân</div>
            <div><b>Tên</b>: <F v={t.patient_name ?? e.patient?.fullName} w={130} /> <b>Quốc tịch</b> <F v={e.patient?.nationality} w={50} /></div>
            <div><b>Năm sinh</b>: <F v={t.birth_year ?? e.patient?.birthYear} w={90} /> <b>Giới</b> <F v={sex} w={50} /></div>
            <div><b>Địa chỉ cấp cứu</b>: <F v={e.scene?.address ?? t.incident_address} w={190} /></div>
            <div><b>Người gọi</b>: <F v={e.caller?.name ?? t.caller_name} w={50} /> <b>Sđt</b> <F v={e.caller?.phone ?? t.callback_phone} w={60} /> <b>Lý do</b>: <F v={e.chiefComplaint} w={60} /></div>
            <div><b>Đối tượng</b>: {PAYERS.map(([k, l]) => <span key={k}><Cb on={e.payer === k} label={l} /> </span>)}</div>
          </div>
          <div>
            <div className="sec">Điều phối viên</div>
            <div><Cb on={e.dispatch?.from115} label="Chuyển cấp cứu TTCC115" /> <Cb on={e.dispatch?.tvt} label="TVT" /></div>
            <div><Cb on={e.dispatch?.firstAidGuided} label="Hướng dẫn sơ cứu" /> <F v={e.dispatch?.firstAidNote} /></div>
            <div><Cb on={e.dispatch?.interHospitalAlert} label="Kích hoạt báo động liên viện" /></div>
            <div>Khác: <F v={e.dispatch?.other} w={110} /></div>
            <div style={{ borderTop: '1px solid #000', margin: '3px -6px 0', padding: '2px 6px' }}>
              <div><b>Vận chuyển từ</b>: <F v={e.transferFrom} w={90} /></div>
              <div><b>Lý do chuyển bệnh</b>: <F v={e.transferReason} w={70} /></div>
            </div>
          </div>
          <div>
            <div className="sec">Thời gian</div>
            <div><b>Thời gian gọi cấp cứu</b>: {gioPhut(time('T0'))}</div>
            <div><b>Thời gian xuất xe</b>: {gioPhut(time('T6'))}</div>
            <div><b>Thời gian nhận bệnh</b>: {gioPhut(time('T8'))}</div>
            <div><b>Thời gian giao bệnh</b>: {gioPhut(time('T13') ?? dp.handoverAt)}</div>
            <div><b>Chuyển bệnh</b>: <F v={[dp.department, dp.hospital].filter(Boolean).join(' – ')} w={130} /></div>
          </div>
        </div>

        <div className="box" style={{ padding: '3px 6px' }}>
          <div><b>Can thiệp tuyến trước/cộng đồng</b>: <span className="line" style={{ display: 'inline-block', minWidth: 520 }}>{e.priorCare ?? ''}</span></div>
          <div style={{ marginTop: 3 }}><b>Hiện trường nguy hiểm (Dr)</b> <Cb on={e.scene?.danger === false} label="Không" /> <Cb on={e.scene?.danger === true} label="Có" /> <F v={e.scene?.dangerNote} w={380} /></div>
        </div>

        <div className="box abc-wrap">
          <table className="abc">
            <thead><tr><th style={{ width: 90 }} /><th>Tiếp cận ABCDE</th><th>Can Thiệp</th></tr></thead>
            <tbody>
              <tr>
                <td><b>Đường thở (A)</b></td>
                <td><Cb on={a.airway === 'patent'} label="Thông thoáng" /><br /><Cb on={a.airway === 'obstructed'} label="Tắc" /> <F v={a.airwayNote} w={110} /></td>
                <td><Cb on={c.heimlich} label="Heimlich" /> <Cb on={c.bvm} label="Bóp bóng" /> <Cb on={c.lma} label="Mask thanh quản" /><br /><Cb on={c.ett} label="Nội khí quản" /> <F v={c.ettNote} w={30} /> <Cb on={c.suction} label="Hút đàm" /></td>
              </tr>
              <tr>
                <td><b>Kiểu thở (B)</b></td>
                <td>Nhịp thở <F v={a.rr} w={24} /> l/p. SpO₂ <F v={a.spo2} w={24} />% <F v={a.breathingNote} w={50} /><br /><Cb on={a.retractions} label="Co kéo cơ hô hấp" /></td>
                <td><Cb on={c.o2Cannula} label="Thở oxy canula" /> <F v={c.o2CannulaFlow} w={24} /> <Cb on={c.nrbMask} label="Mask có túi khí" /> <F v={c.nrbFlow} w={24} /><br /><Cb on={c.bagMask} label="Bóp mask" /> <Cb on={c.bagEtt} label="Bóp bóng NKQ" /> <Cb on={c.nebulizer} label="PKD" /></td>
              </tr>
              <tr>
                <td><b>Tuần hoàn (C)</b></td>
                <td>Mạch <F v={a.hr} w={24} /> l/p. CRT <F v={a.crt} w={16} />(s) HA <F v={a.sbp != null ? `${a.sbp}/${a.dbp ?? ''}` : null} w={40} />mmHg<br />ECG <F v={a.ecg} w={170} /></td>
                <td><Cb on={c.cpr} label="Ép tim" /> <Cb on={c.defib} label="Sốc điện" /> <F v={c.defibNote} w={50} /> <Cb on={c.monitor} label="Monitor" /><br /><Cb on={c.iv} label="TTM" /> <F v={c.ivNote} w={170} /></td>
              </tr>
              <tr>
                <td><b>Thần kinh (D)</b></td>
                <td>AVPU: {(['A', 'V', 'P', 'U'] as const).map((k) => <span key={k}><Cb on={a.avpu === k} label={k} /> </span>)}<br />
                  FAST: <Cb on={a.fastF} label="F" /> <Cb on={a.fastA} label="A" /> <Cb on={a.fastS} label="S" /> <Cb on={a.fastT} label="T" /><br />
                  <Cb on={a.seizure} label="Co giật" /> Đồng tử <F v={a.pupils} w={24} />mm ĐH: <F v={a.glucose} w={24} /> mg%</td>
                <td><div className="line">{c.neuroCare ?? ''}</div><div className="line" /></td>
              </tr>
              <tr>
                <td><b>Toàn diện (E)</b></td>
                <td>T <F v={a.temp} w={24} /> °C. <b>Chấn thương</b>: <Cb on={a.injHead} label="Đầu" /> <Cb on={a.injSpine} label="Cột sống" /><br /><Cb on={a.injLimb} label="Chi" /> <Cb on={a.injMulti} label="Đa chấn thương" /><br />
                  <b>Chảy máu</b>: <Cb on={a.bleeding === 'spurting'} label="Thành tia" /> <Cb on={a.bleeding === 'flowing'} label="dòng" /> <Cb on={a.bleeding === 'oozing'} label="rỉ" /></td>
                <td>Cố định: <Cb on={c.collar} label="cổ" /> <Cb on={c.spine} label="Cột sống" /> <Cb on={c.pelvis} label="Khung chậu" /><br />
                  <Cb on={c.splintShoulder} label="Vai" /> <Cb on={c.splintArm} label="Tay" /> <Cb on={c.splintLeg} label="Chân" /> <F v={c.splintNote} w={80} /><br />
                  <Cb on={c.pressureBandage} label="Băng ép cầm máu" /> <F v={c.bandageNote} w={100} /></td>
              </tr>
            </tbody>
          </table>
          <div className="trauma">
            <div className="h">Chấn Thương: <Cb on={e.trauma?.present === true} label="Có" /> <Cb on={e.trauma?.present === false} label="Không" /></div>
            <div>{TRAUMA_TYPES.map((ty) => <div key={ty}><span className="cb">{traumaTypes.includes(ty) ? '☑' : '☐'}</span>{ty}</div>)}</div>
            <div><BodyFigure /><div style={{ fontSize: 9 }}>{e.trauma?.note ?? ''}</div></div>
          </div>
        </div>

        <div className="box sample">
          <div>
            <div className="sec">Bệnh Sử SAMPLE</div>
            <div className="kv"><b>Dấu hiệu/triệu chứng (S)</b><div className="line">{s.symptoms ?? ''}</div></div>
            <div className="kv"><b>Dị ứng (A)</b><div><Cb on={s.allergy === false} label="Không" /> <Cb on={s.allergy === true} label="Có" /> <F v={s.allergies} w={90} /></div></div>
            <div className="kv"><b>Thuốc đang dùng (M)</b><div className="line">{s.medications ?? ''}</div></div>
            <div className="kv"><b>Tiền sử bệnh (P)</b><div className="line">{s.pastHistory ?? ''}</div></div>
            <div className="kv"><b>Ăn cuối cùng (L)</b><div className="line">{s.lastMeal ?? ''}</div></div>
            <div className="kv"><b>Liên quan (E)</b><div className="line">{s.events ?? ''}</div></div>
          </div>
          <div>
            <div className="sec">Khám Toàn Diện</div>
            {([['headFace', 'Đầu-Mặt'], ['neck', 'Cổ'], ['chest', 'Ngực'], ['abdomen', 'Bụng'], ['limbs', 'Chi'], ['skin', 'Da niêm'], ['other', 'Khác']] as const).map(([k, l]) => (
              <div key={k} className="kv" style={{ gridTemplateColumns: '50px 1fr' }}><b>{l}</b><div className="line">{x[k] ?? ''}</div></div>
            ))}
          </div>
          <div>
            <div className="sec">Can Thiệp Sau Khám Toàn Diện</div>
            <div style={{ whiteSpace: 'pre-wrap' }} className="line">{e.postExamCare ?? ''}</div>
            <div className="line" /><div className="line" /><div className="line" />
          </div>
        </div>
        <div className="box dx" style={{ borderTop: 'none' }}>
          <b>CHẨN ĐOÁN:</b>
          <div className="line"><b>{e.diagnosis?.text ?? ''}</b>{e.diagnosis?.icd10 ? ` (ICD-10: ${e.diagnosis.icd10})` : ''}{dp.type ? ` — Kết cục: ${DISPO[dp.type]}` : ''}</div>
        </div>

        <div className="box bottom3">
          <div>
            <table className="td">
              <thead><tr><th>Theo dõi/Thời gian</th>{vit.map((v, i) => <th key={i}>{i === 0 ? 'Nhận bệnh ' : ''}{v ? hhmm(v.at) : ''}</th>)}</tr></thead>
              <tbody>
                <tr><td>Mạch</td>{vit.map((v, i) => <td key={i}>{v?.hr ?? ''}</td>)}</tr>
                <tr><td>Huyết áp</td>{vit.map((v, i) => <td key={i}>{v?.sbp != null ? `${v.sbp}/${v.dbp ?? ''}` : ''}</td>)}</tr>
                <tr><td>SpO₂</td>{vit.map((v, i) => <td key={i}>{v?.spo2 ?? ''}</td>)}</tr>
                <tr><td>Nhiệt độ</td>{vit.map((v, i) => <td key={i}>{v?.temp ?? ''}</td>)}</tr>
                <tr><td>Nhịp thở</td>{vit.map((v, i) => <td key={i}>{v?.rr ?? ''}</td>)}</tr>
                <tr><td>Monitor</td>{vit.map((v, i) => <td key={i}>{v?.monitor ?? ''}</td>)}</tr>
                <tr><td>Khác</td>{vit.map((v, i) => <td key={i}>{v?.other ?? ''}</td>)}</tr>
                {careRows.map((r, i) => (
                  <tr key={`c${i}`}>{i === 0 && <td rowSpan={careRows.length} style={{ verticalAlign: 'middle' }}>Can thiệp</td>}<td colSpan={4}>{r}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div className="nb">
              <div className="h">Em Bé (Sanh Rớt){nb.born && nb.at ? ` – ${hhmm(nb.at)}` : ''}</div>
              <div>Nhịp tim <F v={nb.heartRate} w={90} /></div>
              <div>Hô hấp <F v={nb.respiration} w={90} /></div>
              <div>Cử động <F v={nb.movement} w={90} /></div>
              <div>Phản xạ <F v={nb.reflex} w={90} /></div>
              <div>Màu da <F v={nb.color} w={90} /></div>
              <div><b>Cắt rốn</b>: <Cb on={nb.born && nb.cordCut} label="Có" /> <Cb on={nb.born && nb.cordCut === false} label="Không" /> <Cb on={nb.cordClamped} label="Kẹp rốn" /></div>
              <div><b>Ủ ấm</b>: <Cb on={nb.born && nb.warmed} label="Có" /> <Cb on={nb.born && nb.warmed === false} label="Không" /> <Cb on={nb.skinToSkin} label="Da kề da" /></div>
              <div><b>Đường thở</b>: <Cb on={nb.born && nb.airwayClear} label="Sạch" /> <Cb on={nb.born && nb.airwayClear === false} label="Không" /> <F v={nb.airwayNote} w={40} /></div>
              <div><b>Hút đàm nhớt</b>: <Cb on={nb.born && nb.suction} label="Có" /> <Cb on={nb.born && nb.suction === false} label="Không" /></div>
              <div><b>Thở Oxy</b> <Cb on={nb.born && nb.oxygen === false} label="Không" /> <Cb on={nb.born && nb.oxygen} label="Có" /> <F v={nb.oxygenNote} w={40} /></div>
              <div><b>Nội khí quản</b> <Cb on={nb.born && nb.ett === false} label="Không" /> <Cb on={nb.born && nb.ett} label="Có" /> <F v={nb.ettNote} w={40} /></div>
              {nb.born && (nb.apgar1 != null || nb.apgar5 != null) && <div>Apgar {nb.apgar1 ?? '-'}/{nb.apgar5 ?? '-'}</div>}
            </div>
          </div>
          <div>
            <div className="cprb">
              <div className="h">Hồi Sinh Tim Phổi Em Bé</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{nb.cpr ?? ''}</div>
            </div>
          </div>
        </div>

        <div className="box note">
          <b>Lưu ý – khi vận chuyển</b>: <span style={{ whiteSpace: 'pre-wrap' }}>{e.transportNotes ?? ''}</span>
          {dp.handoverNote && <div>Bàn giao: {dp.handoverNote}</div>}
        </div>
        <div className="box sig">
          <div>
            <div><b>Đơn vị giao bệnh</b>: <F v={dp.fromUnit ?? `Medone${t.vehicle_id ? ` – xe ${t.vehicle_id}` : ''}`} w={180} /></div>
            <div><b>Nhận xét</b>: <F v={dp.fromComment} w={220} /></div>
            <div><b>Chữ ký</b>: {t.signed_by_name ? <span>{t.signed_by_name} – ký điện tử {fmtDateTime(t.signed_at)}</span> : <F v={null} w={200} />}</div>
            <div style={{ fontSize: 9 }}>{t.crew.map((m: any) => `${m.full_name}${m.license_no ? ` (GPHN ${m.license_no})` : ''}`).join(', ')}</div>
          </div>
          <div>
            <div><b>Đơn vị nhận bệnh</b>: <F v={dp.toUnit ?? [dp.department, dp.hospital].filter(Boolean).join(' – ')} w={170} /></div>
            <div><b>Nhận xét</b>: <F v={dp.toComment} w={220} /></div>
            <div><b>Chữ ký</b>: <F v={[dp.receiverName, dp.receiverTitle].filter(Boolean).join(' – ')} w={200} /></div>
          </div>
        </div>
        {(e.signatures?.length ?? 0) > 0 && (
          <div className="box sigs">
            {e.signatures.map((g: any) => (
              <div key={g.id}>
                <div><b>{SIGNATURE_KIND[g.kind]?.label ?? g.kind}</b>{g.detail ? `: ${g.detail}` : ''}</div>
                <div style={{ fontSize: 8 }}>{g.statement}</div>
                <img src={g.image} alt="" />
                <div>{g.signerName}{g.relation ? ` (${g.relation})` : ''} · {fmtDateTime(g.signedAt)}{g.witness ? ` · chứng kiến: ${g.witness}` : ''}</div>
              </div>
            ))}
          </div>
        )}
        {t.amendments?.length > 0 && (
          <div style={{ marginTop: 4, fontSize: 9 }}>
            <b>Bổ sung sau khi ký:</b> {t.amendments.map((am: any) => `${fmtDateTime(am.created_at)} – ${am.author}: ${am.reason}`).join('; ')}
          </div>
        )}
      </div>
    </div>
  );
}
