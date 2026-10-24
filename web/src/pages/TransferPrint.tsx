import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, fmtDateTime, fmtTime } from '../api';
import { StarOfLife } from '../Logo';

const PAYER: Record<string, string> = { BHYT: 'BHYT', THU_PHI: 'Thu phí', MIEN: 'Miễn', GIAM: 'Giảm', THAT_THU: 'Thất thu' };
const DISPO: Record<string, string> = {
  transported: 'Vận chuyển tới bệnh viện', treated_released: 'Xử trí tại chỗ', refused: 'Từ chối (có cam kết)', dead_on_scene: 'Tử vong tại hiện trường', cancelled: 'Hủy',
};

/** Phiếu chuyển viện in được (mẫu tham khảo "Bệnh án cấp cứu ngoại viện" 115 TP.HCM) */
export function TransferPrint() {
  const { id } = useParams();
  const [t, setT] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { api('GET', `/api/transfers/${id}`).then(setT).catch((e) => setError(e.message)); }, [id]);
  if (error) return <div className="panel error">{error}</div>;
  if (!t) return <div className="panel">Đang tải…</div>;
  const e = t.epcr ?? {};
  const gcs = [e.abcde?.gcsE, e.abcde?.gcsV, e.abcde?.gcsM].every((x) => x != null) ? e.abcde.gcsE + e.abcde.gcsV + e.abcde.gcsM : null;
  return (
    <div>
      <div className="no-print row" style={{ justifyContent: 'center', marginBottom: 8 }}>
        <button className="primary" onClick={() => print()}>In phiếu</button>
      </div>
      <div className="print-page">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div className="row"><StarOfLife size={48} /><div><b>MEDONE</b><div>Dịch vụ Chuyển viện – Cấp cứu ngoại viện</div></div></div>
          <div className="right">
            <div>Số BA: <b>{t.ba_number ?? '—'}</b></div>
            <div>Số chuyển viện: <b>{t.transfer_number}</b></div>
            <div>Mã ca: {t.incident_code ?? '—'}</div>
          </div>
        </div>
        <h1>PHIẾU CHUYỂN VIỆN – BỆNH ÁN CẤP CỨU NGOẠI VIỆN</h1>
        {t.status !== 'signed' && <p style={{ textAlign: 'center', color: '#c00' }}><b>BẢN NHÁP – CHƯA KÝ</b></p>}
        <table>
          <tbody>
            <tr><td>Họ tên: <b>{t.patient_name ?? e.patient?.fullName ?? '—'}</b></td><td>Giới: {({ M: 'Nam', F: 'Nữ', U: 'Chưa rõ' } as any)[t.patient_sex ?? e.patient?.sex] ?? '—'}</td><td>Năm sinh/tuổi: {t.patient_dob ?? t.birth_year ?? e.patient?.age ?? '—'}</td></tr>
            <tr><td colSpan={2}>Địa chỉ hiện trường: {t.incident_address ?? e.scene?.address ?? '—'}</td><td>CCCD: ••••{t.id_last4 ?? '—'}</td></tr>
            <tr><td>Mức ưu tiên: {t.final_priority ?? '—'}</td><td>Nguồn ca: {t.source ?? '—'}</td><td>Xe: {t.vehicle_id ?? '—'}</td></tr>
            <tr><td colSpan={3}>Lý do cấp cứu: {e.chiefComplaint ?? '—'}</td></tr>
          </tbody>
        </table>
        <h3 style={{ marginTop: 10 }}>Mốc thời gian</h3>
        <table><tbody>
          {Array.from({ length: Math.ceil(t.times.length / 4) }, (_, r) => (
            <tr key={r}>{t.times.slice(r * 4, r * 4 + 4).map((x: any) => <td key={x.code}>{x.code} {x.label}: <b>{fmtTime(x.at)}</b></td>)}</tr>
          ))}
        </tbody></table>
        <h3 style={{ marginTop: 10 }}>Đánh giá ban đầu (ABCDE)</h3>
        <table><tbody>
          <tr><td>A: {e.abcde?.airway ?? ''}</td><td>B: {e.abcde?.breathing ?? ''}</td><td>C: {e.abcde?.circulation ?? ''}</td></tr>
          <tr><td>GCS: {gcs ?? '—'} (E{e.abcde?.gcsE ?? '-'} V{e.abcde?.gcsV ?? '-'} M{e.abcde?.gcsM ?? '-'})</td><td>Đồng tử: {e.abcde?.pupils ?? ''}</td><td>E: {e.abcde?.exposure ?? ''}</td></tr>
        </tbody></table>
        <h3 style={{ marginTop: 10 }}>SAMPLE</h3>
        <table><tbody>
          <tr><td>Triệu chứng: {e.sample?.symptoms ?? ''}</td><td>Dị ứng: {e.sample?.allergies ?? ''}</td><td>Thuốc: {e.sample?.medications ?? ''}</td></tr>
          <tr><td>Tiền sử: {e.sample?.pastHistory ?? ''}</td><td>Bữa ăn cuối: {e.sample?.lastMeal ?? ''}</td><td>Diễn biến: {e.sample?.events ?? ''}</td></tr>
          <tr><td colSpan={3}>Khám: {e.exam ?? ''}</td></tr>
          <tr><td colSpan={3}>Điện tim: {e.ecg?.done ? `${e.ecg.interpretation ?? ''}${e.ecg.stemi ? ' – STEMI' : ''}` : 'Không làm'}</td></tr>
        </tbody></table>
        <h3 style={{ marginTop: 10 }}>Theo dõi sinh hiệu</h3>
        <table>
          <thead><tr><th>Giờ</th><th>Mạch</th><th>HA</th><th>NT</th><th>SpO₂</th><th>T°</th><th>ĐH</th><th>GCS</th></tr></thead>
          <tbody>{(e.vitals ?? []).map((v: any, i: number) => (
            <tr key={i}><td>{fmtTime(v.at, false)}</td><td>{v.hr ?? ''}</td><td>{v.sbp ?? ''}/{v.dbp ?? ''}</td><td>{v.rr ?? ''}</td><td>{v.spo2 ?? ''}</td><td>{v.temp ?? ''}</td><td>{v.glucose ?? ''}</td><td>{v.gcs ?? ''}</td></tr>
          ))}</tbody>
        </table>
        <h3 style={{ marginTop: 10 }}>Can thiệp và thuốc</h3>
        <table><tbody>
          {(e.interventions ?? []).map((x: any, i: number) => <tr key={`i${i}`}><td>{fmtTime(x.at, false)}</td><td colSpan={3}>{x.name} {x.by ? `– ${x.by}` : ''} {x.note ?? ''}</td></tr>)}
          {(e.medications ?? []).map((m: any, i: number) => <tr key={`m${i}`}><td>{fmtTime(m.at, false)}</td><td>{m.name} {m.dose ?? ''} {m.route ?? ''}</td><td>Lô {m.lot ?? '—'} HSD {m.expiry ?? '—'}</td><td>{m.by ?? ''}{m.witness ? ` / chứng kiến ${m.witness}` : ''}</td></tr>)}
        </tbody></table>
        <h3 style={{ marginTop: 10 }}>Chẩn đoán và kết cục</h3>
        <table><tbody>
          <tr><td colSpan={2}>Chẩn đoán: <b>{e.diagnosis?.text ?? '—'}</b> {e.diagnosis?.icd10 ? `(${e.diagnosis.icd10})` : ''}</td></tr>
          <tr><td>Kết cục: {DISPO[e.disposition?.type] ?? '—'}</td><td>Nơi nhận: {e.disposition?.hospital ?? '—'} {e.disposition?.department ?? ''}</td></tr>
          <tr><td>Bàn giao lúc: {fmtDateTime(e.disposition?.handoverAt)}</td><td>Đối tượng thu phí: {PAYER[e.payer] ?? '—'}</td></tr>
          {e.disposition?.handoverNote && <tr><td colSpan={2}>Nội dung bàn giao: {e.disposition.handoverNote}</td></tr>}
          {e.newborn?.born && <tr><td colSpan={2}>Sơ sinh: Apgar {e.newborn.apgar1 ?? '-'}/{e.newborn.apgar5 ?? '-'} {e.newborn.note ?? ''}</td></tr>}
        </tbody></table>
        <div className="sig">
          <div>
            <div><b>Đơn vị giao bệnh – Trưởng kíp</b></div>
            <div style={{ height: 60 }} />
            <div>{t.signed_by_name ?? '(chưa ký)'}</div>
            <div className="small">{t.signed_at ? `Ký điện tử lúc ${fmtDateTime(t.signed_at)}` : ''}</div>
            <div className="small">{t.crew.map((c: any) => `${c.full_name}${c.license_no ? ` (GPHN ${c.license_no})` : ''}`).join(', ')}</div>
          </div>
          <div>
            <div><b>Đơn vị nhận bệnh</b></div>
            <div style={{ height: 60 }} />
            <div>{e.disposition?.receiverName ?? ''} {e.disposition?.receiverTitle ? `– ${e.disposition.receiverTitle}` : ''}</div>
          </div>
        </div>
        {t.amendments?.length > 0 && (
          <>
            <h3 style={{ marginTop: 10 }}>Bổ sung sau khi ký</h3>
            <ul>{t.amendments.map((a: any) => <li key={a.version}>{fmtDateTime(a.created_at)} – {a.author}: {a.reason} (từ phiên bản {a.version})</li>)}</ul>
          </>
        )}
      </div>
    </div>
  );
}
