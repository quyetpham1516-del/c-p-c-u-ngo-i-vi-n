import { useEffect, useState } from 'react';
import { api, download, money, session } from '../api';
import { useStations } from '../catalog';
import { Stat } from './Hr';

const vnDate = (d = 0) => new Date(Date.now() + 7 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const DISPOSITION: Record<string, string> = {
  transported: 'Vận chuyển tới bệnh viện', treated_released: 'Xử trí tại chỗ', refused: 'Từ chối vận chuyển', dead_on_scene: 'Tử vong tại hiện trường',
  cancelled: 'Hủy', chua_ghi: 'Chưa ghi',
};
const PAYER: Record<string, string> = { THU_PHI: 'Thu phí', BHYT: 'BHYT', HOP_DONG: 'Hợp đồng', MIEN: 'Miễn', GIAM: 'Giảm', THAT_THU: 'Thất thu', chua_ghi: 'Chưa ghi' };
const EXPENSE: Record<string, string> = {
  nhien_lieu: 'Nhiên liệu', sua_chua_xe: 'Sửa chữa xe', bao_duong_tb: 'Bảo dưỡng thiết bị', thuoc_vat_tu: 'Thuốc, vật tư', luong: 'Lương',
  thue_mat_bang: 'Mặt bằng', dien_nuoc: 'Điện nước', cau_duong: 'Cầu đường', bao_hiem: 'Bảo hiểm', khac: 'Khác',
};
const DOC_KIND: Record<string, string> = { quy_trinh: 'Quy trình', huong_dan: 'Hướng dẫn', bieu_mau: 'Biểu mẫu', quy_dinh: 'Quy định', phac_do: 'Phác đồ', khac: 'Khác' };
const DOC_STATUS: Record<string, string> = { du_thao: 'Dự thảo', hieu_luc: 'Hiệu lực', het_hieu_luc: 'Hết hiệu lực' };
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');

/** Báo cáo: vận hành, chuyên môn, chất lượng, tài chính; nhật ký thao tác; kiểm soát tài liệu. Xuất CSV (Excel) và in/lưu PDF */
export function Reports() {
  const role = session.user?.role ?? '';
  const ops = ['director', 'admin', 'supervisor', 'qa'].includes(role);
  const fin = ['director', 'admin', 'accountant'].includes(role);
  const aud = ['director', 'admin', 'qa'].includes(role);
  const tabs = [...(ops ? ['Vận hành', 'Chuyên môn', 'Chất lượng'] : []), ...(fin ? ['Tài chính'] : []), ...(aud ? ['Nhật ký thao tác'] : []), 'Tài liệu'];
  const [tab, setTab] = useState(tabs[0]);
  const [stations] = useStations();
  const [from, setFrom] = useState(vnDate().slice(0, 8) + '01');
  const [to, setTo] = useState(vnDate());
  const [stationId, setStationId] = useState('');
  const [error, setError] = useState('');
  const q = `from=${from}&to=${to}${stationId ? `&stationId=${stationId}` : ''}`;
  const section: Record<string, string> = { 'Vận hành': 'operations', 'Chuyên môn': 'clinical', 'Chất lượng': 'quality', 'Tài chính': 'financial' };
  const preset = (days: number) => { setFrom(vnDate(-days + 1)); setTo(vnDate()); };
  return (
    <div className="col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{tab === 'Tài liệu' ? 'Tài liệu' : 'Báo cáo'} {tab !== 'Tài liệu' && <span className="small muted">{from} → {to}{stationId ? ` · điểm ${stationId}` : ''}</span>}</h2>
        {section[tab] && (
          <div className="row no-print">
            <button onClick={() => { setError(''); download(`/api/reports/${section[tab]}?${q}&format=csv`, `${section[tab]}-${from}-${to}.csv`).catch((e) => setError(e.message)); }}>Tải Excel (CSV)</button>
            <button onClick={() => window.print()}>In / lưu PDF</button>
          </div>
        )}
      </div>
      <div className="row no-print" style={tab === 'Tài liệu' ? { display: 'none' } : undefined}>
        <label className="row small">Từ<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small">Đến<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="ghost small" onClick={() => preset(7)}>7 ngày</button>
        <button className="ghost small" onClick={() => preset(30)}>30 ngày</button>
        <button className="ghost small" onClick={() => { setFrom(vnDate().slice(0, 8) + '01'); setTo(vnDate()); }}>Tháng này</button>
        <button className="ghost small" onClick={() => { setFrom(vnDate().slice(0, 5) + '01-01'); setTo(vnDate()); }}>Từ đầu năm</button>
        <select value={stationId} onChange={(e) => setStationId(e.target.value)}><option value="">Mọi điểm</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.id} – {s.name}</option>)}</select>
      </div>
      <div className="tabs no-print">{tabs.map((t) => <button key={t} className={tab === t ? 'sel' : ''} onClick={() => { setTab(t); setError(''); }}>{t}</button>)}</div>
      {error && <div className="error">{error}</div>}
      {tab === 'Vận hành' && <Operations q={q} setError={setError} />}
      {tab === 'Chuyên môn' && <Clinical q={q} setError={setError} />}
      {tab === 'Chất lượng' && <QualityReport q={q} setError={setError} />}
      {tab === 'Tài chính' && <FinancialReport q={q} setError={setError} />}
      {tab === 'Nhật ký thao tác' && <Audit from={from} to={to} setError={setError} />}
      {tab === 'Tài liệu' && <Documents setError={setError} />}
    </div>
  );
}

function useReport<T>(url: string, setError: (s: string) => void) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => { setData(null); api<T>('GET', url).then(setData).catch((e) => setError(e.message)); }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return data;
}

/** Cột ngang một chuỗi số: nhãn, thanh mảnh bo đầu, giá trị bằng chữ; di chuột xem số chính xác */
function Bars({ rows, fmt = (n) => String(n) }: { rows: { label: string; value: number; note?: string }[]; fmt?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <div className="small muted">Không có dữ liệu.</div>;
  return (
    <div className="col" style={{ gap: 6 }}>
      {rows.map((r) => (
        <div key={r.label} title={`${r.label}: ${fmt(r.value)}${r.note ? ` · ${r.note}` : ''}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 34%) 1fr auto', gap: 8, alignItems: 'center' }}>
          <span className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
          <div style={{ background: 'var(--panel-2)', borderRadius: 4, height: 10 }}>
            <div style={{ width: `${(100 * r.value) / max}%`, minWidth: r.value ? 3 : 0, height: 10, borderRadius: 4, background: 'var(--brand)' }} />
          </div>
          <span className="small mono">{fmt(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Cột đứng theo ngày/giờ (một chuỗi) */
function Columns({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <div className="small muted">Không có dữ liệu.</div>;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 120, borderBottom: '1px solid var(--line)' }}>
        {rows.map((r) => (
          <div key={r.label} title={`${r.label}: ${r.value} ca`} style={{ flex: 1, maxWidth: 48, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
            <div style={{ width: '100%', height: `${(100 * r.value) / max}%`, minHeight: r.value ? 2 : 0, background: 'var(--brand)', borderRadius: '4px 4px 0 0' }} />
          </div>
        ))}
      </div>
      <div className="row small muted" style={{ justifyContent: 'space-between' }}><span>{rows[0].label}</span><span>cao nhất {max} ca</span><span>{rows[rows.length - 1].label}</span></div>
    </div>
  );
}

function Operations({ q, setError }: { q: string; setError: (s: string) => void }) {
  const r = useReport<any>(`/api/reports/operations?${q}`, setError);
  if (!r) return <div className="panel">Đang tải…</div>;
  const hours = Array.from({ length: 24 }, (_, h) => ({ label: `${h}h`, value: r.byHour.find((x: any) => x.hour === h)?.n ?? 0 }));
  return (
    <div className="col">
      <div className="grid4">
        <Stat label="Tổng ca" value={r.totals.total} />
        <Stat label="Có giao xe" value={r.totals.served} />
        <Stat label="Hủy / chỉ tư vấn / chuyển 115" value={`${r.totals.cancelled} / ${r.totals.advice_only} / ${r.totals.transferred_115}`} />
        <Stat label="Đổi mã ưu tiên so với máy đề xuất" value={r.totals.priority_overridden} />
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Thời gian đáp ứng theo mức ưu tiên <span className="small muted">phút, trung vị (phân vị 90)</span></h3>
        <table>
          <thead><tr><th>Mức</th><th>Số ca</th>{r.intervalLabels.map((l: any) => <th key={l.key}>{l.label}</th>)}<th>Đạt chỉ tiêu tới hiện trường</th></tr></thead>
          <tbody>{r.intervals.map((x: any) => (
            <tr key={x.priority}><td><span className={`prio ${x.priority}`}>{x.priority}</span></td><td>{x.n}</td>
              {r.intervalLabels.map((l: any) => <td key={l.key} className="mono small">{x[`${l.key}_median`] == null ? '—' : `${x[`${l.key}_median`]} (${x[`${l.key}_p90`]})`}</td>)}
              <td>{x.response_n ? <b>{pct(x.response_on_target, x.response_n)}</b> : '—'} <span className="small muted">≤ {r.targets[x.priority]} phút</span></td></tr>
          ))}</tbody>
        </table>
        {!r.intervals.length && <div className="small muted">Chưa có ca đủ mốc thời gian.</div>}
      </div>
      <div className="grid2">
        <div className="panel"><h3 style={{ marginTop: 0 }}>Số ca theo ngày</h3><Columns rows={r.byDay.map((d: any) => ({ label: d.day.slice(5).split('-').reverse().join('/'), value: d.n }))} /></div>
        <div className="panel"><h3 style={{ marginTop: 0 }}>Số ca theo giờ trong ngày</h3><Columns rows={hours} /></div>
      </div>
      <div className="grid2">
        <div className="panel"><h3 style={{ marginTop: 0 }}>Theo mức ưu tiên</h3><Bars rows={r.byPriority.map((p: any) => ({ label: p.priority, value: p.n }))} /></div>
        <div className="panel" style={{ overflowX: 'auto' }}>
          <h3 style={{ marginTop: 0 }}>Sử dụng xe <span className="small muted">giờ làm nhiệm vụ / (sẵn sàng + làm nhiệm vụ)</span></h3>
          <table>
            <thead><tr><th>Xe</th><th>Lượt</th><th>Sẵn sàng (h)</th><th>Nhiệm vụ (h)</th><th>Ngoài HĐ (h)</th><th>Sử dụng</th></tr></thead>
            <tbody>{r.fleet.map((f: any) => <tr key={f.vehicle_id}><td><b>{f.vehicle_id}</b><div className="small muted">{f.station_id}</div></td><td>{f.missions}</td><td>{f.available_h}</td><td>{f.busy_h}</td><td>{f.out_h}</td><td>{f.utilization_pct == null ? '—' : `${f.utilization_pct}%`}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Clinical({ q, setError }: { q: string; setError: (s: string) => void }) {
  const r = useReport<any>(`/api/reports/clinical?${q}`, setError);
  if (!r) return <div className="panel">Đang tải…</div>;
  return (
    <div className="col">
      <div className="grid4">
        <Stat label="Phiếu chuyển viện đã ký" value={r.totals.signed} />
        <Stat label="Phiếu bổ sung sau ký" value={`${r.totals.amended} (${pct(r.totals.amended, r.totals.signed)})`} />
        <Stat label="Ca nghi truyền nhiễm" value={r.totals.infectious} />
      </div>
      <div className="grid2">
        <div className="panel"><h3 style={{ marginTop: 0 }}>Kết cục</h3><Bars rows={r.dispositions.map((d: any) => ({ label: DISPOSITION[d.type] ?? d.type, value: d.n }))} /></div>
        <div className="panel"><h3 style={{ marginTop: 0 }}>Đối tượng</h3><Bars rows={r.payers.map((d: any) => ({ label: PAYER[d.payer] ?? d.payer, value: d.n }))} /></div>
      </div>
      <div className="grid2">
        <div className="panel"><h3 style={{ marginTop: 0 }}>Chẩn đoán thường gặp (ICD-10)</h3><Bars rows={r.diagnoses.map((d: any) => ({ label: `${d.icd10} ${d.name ?? ''}`, value: d.n }))} /></div>
        <div className="panel"><h3 style={{ marginTop: 0 }}>Bệnh viện nhận nhiều nhất</h3><Bars rows={r.hospitals.map((d: any) => ({ label: d.hospital, value: d.n }))} /></div>
      </div>
      <div className="panel"><h3 style={{ marginTop: 0 }}>Thuốc dùng nhiều</h3><Bars rows={r.medications.map((d: any) => ({ label: d.name, value: d.n }))} /></div>
    </div>
  );
}

function QualityReport({ q, setError }: { q: string; setError: (s: string) => void }) {
  const r = useReport<any>(`/api/reports/quality?${q}`, setError);
  if (!r) return <div className="panel">Đang tải…</div>;
  const rows: [string, string, string][] = [
    ['Sự cố y khoa / 1000 ca có giao xe', r.eventsPer1000 == null ? '—' : String(r.eventsPer1000), ''],
    ['Khiếu nại phản hồi đúng hạn', `${pct(r.complaints.on_time, r.complaints.n)} (${r.complaints.on_time}/${r.complaints.n})`, `${r.targets.complaintOnTimePct}%`],
    ['Khiếu nại quá hạn chưa phản hồi', String(r.complaints.overdue), '0'],
    ['Khảo sát: tỉ lệ trả lời', `${pct(r.surveys.answered, r.surveys.sent)} (${r.surveys.answered}/${r.surveys.sent})`, ''],
    ['Hài lòng (4–5 điểm)', pct(r.surveys.satisfied, r.surveys.answered), `${r.targets.satisfactionPct}%`],
    ['Điểm trung bình: chung / kịp thời / thái độ / chăm sóc', [r.surveys.avg_overall, r.surveys.avg_timeliness, r.surveys.avg_attitude, r.surveys.avg_care].map((x) => x ?? '—').join(' / '), ''],
    ['Tuân thủ vệ sinh tay', `${pct(r.hygiene.compliant, r.hygiene.n)} (${r.hygiene.n} lần quan sát)`, `${r.targets.handHygienePct}%`],
    ['Phiếu khử khuẩn xe đã ký', `${pct(r.disinfection.signed, r.disinfection.n)} (${r.disinfection.signed}/${r.disinfection.n}, ${r.disinfection.enhanced} ca mức tăng cường trở lên)`, '100%'],
    ['Phơi nhiễm nghề nghiệp', String(r.exposures), '0'],
    ['Giao xe thiếu thiết bị bắt buộc (trưởng ca cho đi)', String(r.equipmentOverrides), ''],
  ];
  return (
    <div className="col">
      <div className="grid4">
        <Stat label="Ca có giao xe" value={r.served} />
        <Stat label="Sự cố y khoa" value={r.eventTotal} />
        <Stat label="Khiếu nại" value={r.complaints.n} />
        <Stat label="Hài lòng" value={pct(r.surveys.satisfied, r.surveys.answered)} />
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table><thead><tr><th>Chỉ số</th><th>Kết quả</th><th>Chỉ tiêu</th></tr></thead>
          <tbody>{rows.map(([a, b, c]) => <tr key={a}><td>{a}</td><td><b>{b}</b></td><td className="small muted">{c}</td></tr>)}</tbody></table>
      </div>
      <div className="panel"><h3 style={{ marginTop: 0 }}>Sự cố theo mức độ</h3><Bars rows={r.events.map((e: any) => ({ label: e.severity, value: e.n, note: `${e.closed} đã đóng, ${e.anonymous} ẩn danh` }))} /></div>
    </div>
  );
}

function FinancialReport({ q, setError }: { q: string; setError: (s: string) => void }) {
  const r = useReport<any>(`/api/reports/financial?${q}`, setError);
  if (!r) return <div className="panel">Đang tải…</div>;
  return (
    <div className="col">
      <div className="grid4">
        <Stat label="Doanh thu (sau miễn giảm)" value={money(r.totals.revenue)} />
        <Stat label="Đã thu" value={money(r.totals.collected)} />
        <Stat label="Chi phí" value={money(r.totals.expenses)} />
        <Stat label="Chênh lệch" value={money(r.totals.margin)} />
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Theo tháng</h3>
        <table><thead><tr><th>Tháng</th><th className="right">Doanh thu</th><th className="right">Đã thu</th><th className="right">Chi phí</th><th className="right">Chênh lệch</th></tr></thead>
          <tbody>{r.monthly.map((m: any) => <tr key={m.month}><td>{m.month}</td><td className="right">{money(m.revenue)}</td><td className="right">{money(m.collected)}</td><td className="right">{money(m.expenses)}</td><td className="right"><b>{money(m.revenue - m.expenses)}</b></td></tr>)}</tbody></table>
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Theo xe</h3>
        <table><thead><tr><th>Xe</th><th>Chuyến</th><th className="right">Doanh thu</th><th className="right">Chi phí</th><th className="right">Chênh lệch</th><th className="right">Doanh thu/chuyến</th></tr></thead>
          <tbody>{r.byVehicle.map((v: any) => <tr key={v.vehicle_id}><td><b>{v.vehicle_id}</b><div className="small muted">{v.station_id}</div></td><td>{v.trips}</td><td className="right">{money(v.revenue)}</td><td className="right">{money(v.expenses)}</td>
            <td className="right" style={v.margin < 0 ? { color: 'var(--danger)' } : undefined}><b>{money(v.margin)}</b></td><td className="right">{money(v.per_trip)}</td></tr>)}</tbody></table>
      </div>
      <div className="grid2">
        <div className="panel" style={{ overflowX: 'auto' }}>
          <h3 style={{ marginTop: 0 }}>Theo điểm</h3>
          <table><tbody>{r.byStation.map((s: any) => <tr key={s.station_id}><td>{s.station_id} – {s.name}</td><td className="right">{money(s.revenue)}</td><td className="right">{money(s.expenses)}</td><td className="right"><b>{money(s.margin)}</b></td></tr>)}</tbody></table>
        </div>
        <div className="panel"><h3 style={{ marginTop: 0 }}>Chi phí theo khoản mục</h3><Bars rows={r.byCategory.map((c: any) => ({ label: EXPENSE[c.category] ?? c.category, value: c.amount }))} fmt={money} /></div>
      </div>
      <div className="panel"><h3 style={{ marginTop: 0 }}>Phải thu theo đối tượng</h3><Bars rows={r.byPayer.map((p: any) => ({ label: PAYER[p.payer_kind] ?? p.payer_kind, value: p.total, note: `đã thu ${money(p.paid)}, miễn giảm ${money(p.waived)}` }))} fmt={money} /></div>
    </div>
  );
}

function Audit({ from, to, setError }: { from: string; to: string; setError: (s: string) => void }) {
  const [actions, setActions] = useState<string[]>([]);
  const [f, setF] = useState({ action: '', actor: '' });
  const [rows, setRows] = useState<any[]>([]);
  const [check, setCheck] = useState<any>(null);
  const load = () => api<any[]>('GET', `/api/reports/audit?from=${from}&to=${to}${f.action ? `&action=${f.action}` : ''}${f.actor ? `&actor=${encodeURIComponent(f.actor)}` : ''}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { api<string[]>('GET', '/api/reports/audit/actions').then(setActions).catch(() => {}); }, []);
  useEffect(() => { load(); setCheck(null); }, [from, to, f.action]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col">
      <div className="row">
        <select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}><option value="">Mọi nhóm thao tác</option>{actions.map((a) => <option key={a} value={a}>{a}</option>)}</select>
        <input placeholder="Người thao tác" value={f.actor} onChange={(e) => setF({ ...f, actor: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && load()} />
        <button onClick={load}>Lọc</button>
        <button onClick={() => api('GET', `/api/reports/audit/verify?from=${from}&to=${to}`).then(setCheck).catch((e) => setError(e.message))}>Kiểm tra toàn vẹn nhật ký</button>
      </div>
      {check && (check.ok
        ? <div className="alert green">Toàn vẹn: {check.events} bản ghi trong {check.scopes} chuỗi (hệ thống, ca, bệnh án) khớp chuỗi băm, không bị sửa hay xóa.</div>
        : <div className="alert red">Phát hiện chuỗi bị phá: {check.broken.map((b: any) => `${b.scope} tại bản ghi ${b.brokenAt}`).join('; ')}. Báo ngay Ban Giám đốc và quản trị hệ thống.</div>)}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <div className="small muted">500 thao tác gần nhất trong khoảng ngày. Nhật ký chỉ ghi thêm, cơ sở dữ liệu chặn sửa/xóa.</div>
        <table>
          <thead><tr><th>Lúc</th><th>Người</th><th>Thao tác</th><th>Đối tượng</th><th>Chi tiết</th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.id}><td className="small mono">{new Date(a.at).toLocaleString('vi-VN')}</td><td className="small">{a.actor_name ?? (a.actor_id ? '' : 'ẩn danh/hệ thống')}</td>
              <td className="mono small">{a.action}</td><td className="small">{a.entity} {a.entity_id}</td>
              <td className="small mono" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={JSON.stringify(a.data)}>{JSON.stringify(a.data)}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function Documents({ setError }: { setError: (s: string) => void }) {
  const role = session.user?.role ?? '';
  const canEdit = ['qa', 'admin', 'director'].includes(role);
  const canApprove = ['director', 'admin'].includes(role);
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [f, setF] = useState({ code: '', title: '', kind: 'quy_trinh', version: '1.0', ownerUnit: '', reviewMonths: '12', url: '', changeNote: '' });
  const load = () => api<any[]>('GET', `/api/documents${all ? '?all=1' : ''}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(''); setMsg(''); try { await fn(); setMsg(ok); await load(); } catch (e) { setError((e as Error).message); } };
  return (
    <div className="col">
      <div className="small muted">Danh mục quy trình, hướng dẫn, biểu mẫu đang hiệu lực. Mỗi mã chỉ có một phiên bản hiệu lực; ban hành bản mới thì bản cũ tự hết hiệu lực. Người soạn không tự ban hành.</div>
      {msg && <div className="alert green">{msg}</div>}
      {canEdit && (
        <div className="panel grid4">
          <label className="field">Mã<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="QT-DP-01" /></label>
          <label className="field">Tên tài liệu<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="field">Loại<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(DOC_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Phiên bản<input value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} /></label>
          <label className="field">Đơn vị soạn<input value={f.ownerUnit} onChange={(e) => setF({ ...f, ownerUnit: e.target.value })} /></label>
          <label className="field">Rà soát sau (tháng)<input type="number" value={f.reviewMonths} onChange={(e) => setF({ ...f, reviewMonths: e.target.value })} /></label>
          <label className="field">Đường dẫn tệp<input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://drive.google.com/..." /></label>
          <label className="field">Nội dung thay đổi<input value={f.changeNote} onChange={(e) => setF({ ...f, changeNote: e.target.value })} /></label>
          <div><button className="primary" disabled={f.code.length < 2 || f.title.trim().length < 3} onClick={() => act(async () => {
            await api('POST', '/api/documents', { ...f, ownerUnit: f.ownerUnit || null, url: f.url || null, changeNote: f.changeNote || null, reviewMonths: Number(f.reviewMonths) });
            setF({ ...f, code: '', title: '', url: '', changeNote: '' });
          }, 'Đã lưu dự thảo. Ban Giám đốc ban hành.')}>Lưu dự thảo</button></div>
        </div>
      )}
      <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Hiện cả bản hết hiệu lực</label>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Mã</th><th>Tên</th><th>Loại</th><th>Phiên bản</th><th>Hiệu lực từ</th><th>Hạn rà soát</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>{rows.map((d) => (
            <tr key={d.id}><td className="mono">{d.code}</td><td>{d.url ? <a href={d.url} target="_blank" rel="noreferrer">{d.title}</a> : d.title}<div className="small muted">{d.owner_unit}{d.change_note ? ` · ${d.change_note}` : ''}</div></td>
              <td>{DOC_KIND[d.kind]}</td><td>{d.version}</td><td className="small">{d.effective_on ?? '—'}</td>
              <td className="small">{d.review_due ?? '—'}{d.review_soon && <span className="badge far" style={{ marginLeft: 4 }}>đến hạn</span>}</td>
              <td>{DOC_STATUS[d.status]}{d.approved_by_name && <div className="small muted">{d.approved_by_name}</div>}</td>
              <td className="right">
                {canApprove && d.status === 'du_thao' && <button className="primary small" onClick={() => act(() => api('POST', `/api/documents/${d.id}/approve`, { effectiveOn: vnDate() }), 'Đã ban hành.')}>Ban hành</button>}
                {canApprove && d.status === 'hieu_luc' && <button className="ghost small" onClick={() => confirm('Bãi bỏ tài liệu này?') && act(() => api('POST', `/api/documents/${d.id}/retire`), 'Đã bãi bỏ.')}>Bãi bỏ</button>}
              </td></tr>
          ))}</tbody>
        </table>
        {!rows.length && <div className="small muted">Chưa có tài liệu.</div>}
      </div>
    </div>
  );
}
