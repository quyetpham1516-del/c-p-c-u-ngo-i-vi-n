import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDateTime, session } from '../api';
import { PatientPicker, type PatientRow } from '../components/PatientPicker';

const REVIEW = ['supervisor', 'qa', 'admin'];

export function Patients() {
  const nav = useNavigate();
  return (
    <div className="col" style={{ maxWidth: 980, margin: '0 auto' }}>
      <h2>Bệnh án</h2>
      <div className="small muted">Mỗi người bệnh một bệnh án (khóa là số CCCD/định danh cá nhân); mỗi lần cấp cứu hoặc chuyển viện là một phiếu gắn vào bệnh án.</div>
      <PatientPicker value={null} label={null} onPick={(p: PatientRow) => nav(`/benh-an/${p.id}`)} />
    </div>
  );
}

export function PatientDetail() {
  const { id } = useParams();
  const [p, setP] = useState<any>(null);
  const [shared, setShared] = useState<any>({});
  const [msg, setMsg] = useState('');
  const role = session.user?.role ?? 'crew';
  const canReview = REVIEW.includes(role);

  const load = (reveal = false) => api('GET', `/api/patients/${id}${reveal ? '?reveal=1' : ''}`).then((x) => { setP(x); setShared(x.shared ?? {}); }).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, [id]);

  if (!p) return <div className="panel">{msg || 'Đang tải…'}</div>;

  const saveShared = async () => {
    await api('PATCH', `/api/patients/${id}`, { shared });
    setMsg('Đã lưu thông tin dùng chung.');
  };

  const merge = async (target: PatientRow) => {
    const reason = prompt(`Gộp ${p.ba_number} vào ${target.ba_number}. Lý do:`);
    if (!reason) return;
    try { await api('POST', `/api/patients/${id}/merge`, { intoId: target.id, reason }); location.href = `/benh-an/${target.id}`; }
    catch (e) { setMsg((e as Error).message); }
  };

  return (
    <div className="col" style={{ maxWidth: 980, margin: '0 auto' }}>
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>{p.full_name ?? 'Chưa rõ tên'} {p.is_temporary && <span className="badge">Bệnh án tạm</span>}</h2>
            <div className="mono">Số BA: <b>{p.ba_number}</b></div>
          </div>
          <Link to="/benh-an">← Tìm bệnh án khác</Link>
        </div>
        {p.merged_into && <div className="alert amber" style={{ marginTop: 8 }}>Bệnh án này đã gộp vào <Link to={`/benh-an/${p.merged_into}`}>{p.merged_into_ba}</Link>.</div>}
        <div className="grid4" style={{ marginTop: 8 }}>
          <div><div className="small muted">Giấy tờ</div>{p.id_type} {p.id_number ?? p.id_masked ?? '—'}
            {canReview && p.id_masked && !p.id_number && <button className="ghost small" onClick={() => load(true)}>Xem đủ số</button>}</div>
          <div><div className="small muted">Ngày/năm sinh</div>{p.dob ?? p.birth_year ?? '—'}</div>
          <div><div className="small muted">Giới</div>{({ M: 'Nam', F: 'Nữ', U: 'Chưa rõ' } as any)[p.sex] ?? '—'}</div>
          <div><div className="small muted">Điện thoại</div>{p.phone ?? '—'}</div>
        </div>
      </div>

      <div className="panel">
        <h3>Thông tin dùng chung giữa các lần (phải xác nhận lại với người bệnh)</h3>
        <div className="grid2">
          {[['allergies', 'Dị ứng'], ['history', 'Tiền sử'], ['medications', 'Thuốc đang dùng'], ['bloodType', 'Nhóm máu'], ['contact', 'Người liên hệ'], ['advanceDirective', 'Ý nguyện điều trị']].map(([k, l]) => (
            <label key={k} className="field">{l}<input value={shared[k] ?? ''} onChange={(e) => setShared({ ...shared, [k]: e.target.value })} /></label>
          ))}
        </div>
        <button style={{ marginTop: 8 }} onClick={saveShared}>Lưu</button>
      </div>

      <div className="panel">
        <h3>Phiếu chuyển viện ({p.transfers.length})</h3>
        <table>
          <thead><tr><th>Số chuyển viện</th><th>Ngày</th><th>Mã ca</th><th>Chẩn đoán</th><th>Nơi nhận</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>
            {p.transfers.map((t: any) => (
              <tr key={t.id}>
                <td className="mono"><b>{t.transfer_number}</b></td>
                <td className="small">{fmtDateTime(t.created_at)}</td>
                <td className="mono small">{t.incident_code ?? '—'} {t.final_priority && <span className={`badge prio ${t.final_priority}`}>{t.final_priority}</span>}</td>
                <td>{t.diagnosis ?? '—'}</td>
                <td>{t.hospital ?? '—'}</td>
                <td>{t.status === 'signed' ? 'Đã ký' : 'Nháp'}</td>
                <td><Link to={`/phieu/${t.id}`}>Xem</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canReview && !p.merged_into && (
        <div className="panel">
          <h3>Gộp bệnh án (QLCL duyệt)</h3>
          <div className="small muted" style={{ marginBottom: 6 }}>Dùng khi bệnh án tạm đã xác định được danh tính, hoặc phát hiện trùng. Gộp nhầm thì tách lại được.</div>
          {p.merges?.map((m: any) => (
            <div key={m.id} className="row small" style={{ marginBottom: 6 }}>
              Đã gộp {m.from_ba} ({m.transfer_ids.length} phiếu) lúc {fmtDateTime(m.merged_at)}: {m.reason}
              <button className="ghost" onClick={async () => { const r = prompt('Lý do tách lại:'); if (r) { await api('POST', `/api/patients/merges/${m.id}/undo`, { reason: r }); load(); } }}>Tách lại</button>
            </div>
          ))}
          <PatientPicker value={null} label="Chọn bệnh án đích để gộp vào" onPick={(t) => (t.id === p.id ? setMsg('Không gộp vào chính nó') : merge(t))} />
        </div>
      )}
      {msg && <div className="alert blue">{msg}</div>}
    </div>
  );
}
