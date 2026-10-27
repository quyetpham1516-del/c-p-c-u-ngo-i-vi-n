import { useEffect, useState } from 'react';
import { api, ROLE_LABEL, type Role } from '../api';
import { STATION_KIND, useHospitals, useStations, type Station } from '../catalog';
import { MapView } from '../components/MapView';
import { TelephonyAdmin } from '../components/Telephony';
import { PkiAdmin } from '../components/Pki';
import { ScopeAdmin } from '../components/ScopeAdmin';
import { ServicePrices } from '../components/ServicePrices';
import { ChangeRequests } from '../components/ChangeRequests';

interface UserRow { id: string; username: string; full_name: string; title: string | null; role: Role; active: boolean; station_id: string | null; sso_linked_at?: string | null; hospital_id?: number | null; hospital_name?: string | null; account_type?: string; tax_code?: string | null; cccd_last4?: string | null; license_no?: string | null }
interface VehicleRow { id: string; type: string; status: string; station_id: string; station_name: string }

const EMPTY = { id: '', name: '', kind: 'tram', address: '', phone: '', lat: '', lng: '' };

/** Quản trị điểm/trạm: chỉ tài khoản admin quyết định có những điểm nào, xe và nhân viên thuộc điểm nào */
export function Admin() {
  const [stations, reloadStations] = useStations(true);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [form, setForm] = useState<typeof EMPTY>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadAll = async () => {
    const [u, b] = await Promise.all([api<UserRow[]>('GET', '/api/users'), api<{ vehicles: VehicleRow[] }>('GET', '/api/board')]);
    setUsers(u); setVehicles(b.vehicles);
    reloadStations();
  };
  useEffect(() => { loadAll().catch((e) => setError(e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await loadAll(); } catch (e) { setError((e as Error).message); }
  };

  const save = () => run(async () => {
    const body = { name: form.name, kind: form.kind, address: form.address || null, phone: form.phone || null, lat: Number(form.lat), lng: Number(form.lng) };
    if (editing) await api('PATCH', `/api/stations/${editing}`, body);
    else await api('POST', '/api/stations', { id: form.id, ...body });
    setForm(EMPTY); setEditing(null);
  });

  const edit = (s: Station) => {
    setEditing(s.id);
    setForm({ id: s.id, name: s.name, kind: s.kind, address: s.address ?? '', phone: s.phone ?? '', lat: String(s.lat), lng: String(s.lng) });
  };
  const active = stations.filter((s) => s.active);
  const valid = form.name.trim().length >= 2 && (editing || /^[A-Za-z0-9-]{2,20}$/.test(form.id)) && form.lat !== '' && form.lng !== '' && !Number.isNaN(Number(form.lat)) && !Number.isNaN(Number(form.lng));

  return (
    <div className="col">
      <ChangeRequests />
      <h2 style={{ margin: 0 }}>Quản trị điểm, trạm</h2>
      {error && <div className="error">{error}</div>}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Mã</th><th>Tên điểm</th><th>Loại</th><th>Địa chỉ</th><th className="right">Xe</th><th className="right">Nhân viên</th><th>Quản lý điểm / người thay</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>
            {stations.map((s) => (
              <tr key={s.id} style={s.active ? undefined : { opacity: 0.55 }}>
                <td className="mono"><b>{s.id}</b></td><td>{s.name}</td><td>{STATION_KIND[s.kind] ?? s.kind}</td><td className="small">{s.address ?? '—'}</td>
                <td className="right">{s.vehicle_count}</td><td className="right">{s.staff_count}</td>
                <td className="small">
                  {(['manager_id', 'deputy_id'] as const).map((k) => (
                    <select key={k} value={s[k] ?? ''} title={k === 'manager_id' ? 'Quản lý điểm' : 'Người thay khi vắng'} style={{ display: 'block', marginBottom: 2 }}
                      onChange={(e) => run(() => api('PUT', `/api/stations/${s.id}/managers`, {
                        managerId: k === 'manager_id' ? e.target.value || null : s.manager_id ?? null,
                        deputyId: k === 'deputy_id' ? e.target.value || null : s.deputy_id ?? null,
                      }))}>
                      <option value="">{k === 'manager_id' ? '— Quản lý điểm —' : '— Người thay —'}</option>
                      {users.filter((u) => u.active && u.station_id === s.id).map((u) => <option key={u.id} value={u.id}>{u.full_name}{u.title ? ` (${u.title})` : ''}</option>)}
                    </select>
                  ))}
                </td>
                <td>{s.active ? 'Đang hoạt động' : 'Tạm ngưng'}</td>
                <td className="right row" style={{ justifyContent: 'flex-end' }}>
                  <button className="ghost small" onClick={() => edit(s)}>Sửa</button>
                  <button className="ghost small" onClick={() => run(() => api('PATCH', `/api/stations/${s.id}`, { active: !s.active }))}>{s.active ? 'Tạm ngưng' : 'Mở lại'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel col">
        <h3 style={{ margin: 0 }}>{editing ? `Sửa điểm ${editing}` : 'Thêm điểm mới'}</h3>
        <div className="grid4">
          <label className="field">Mã điểm<input value={form.id} disabled={!!editing} placeholder="VD: TR-03" onChange={(e) => setForm({ ...form, id: e.target.value.toUpperCase() })} /></label>
          <label className="field">Tên điểm<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field">Loại
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {Object.entries(STATION_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="field">Điện thoại<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          <label className="field" style={{ gridColumn: 'span 2' }}>Địa chỉ<input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
          <label className="field">Vĩ độ<input value={form.lat} inputMode="decimal" onChange={(e) => setForm({ ...form, lat: e.target.value })} /></label>
          <label className="field">Kinh độ<input value={form.lng} inputMode="decimal" onChange={(e) => setForm({ ...form, lng: e.target.value })} /></label>
        </div>
        <div className="small muted">Bấm lên bản đồ để lấy tọa độ. Tọa độ dùng để tính xe gần nhất khi xe chưa có GPS.</div>
        <MapView className="map-small" onPick={(lat, lng) => setForm((f) => ({ ...f, lat: lat.toFixed(5), lng: lng.toFixed(5) }))}
          scene={form.lat && form.lng ? { lat: Number(form.lat), lng: Number(form.lng) } : null} zoom={11} />
        <div className="row">
          <button className="primary" disabled={!valid} onClick={save}>{editing ? 'Lưu' : 'Thêm điểm'}</button>
          {editing && <button className="ghost" onClick={() => { setEditing(null); setForm(EMPTY); }}>Hủy</button>}
        </div>
      </div>

      <div className="grid2">
        <div className="panel" style={{ overflowX: 'auto' }}>
          <h3>Xe thuộc điểm nào</h3>
          <table><tbody>
            {vehicles.map((v) => (
              <tr key={v.id}><td><b>{v.id}</b> <span className="small muted">{v.type} · {v.status}</span></td>
                <td className="right">
                  <select value={v.station_id} onChange={(e) => run(() => api('PATCH', `/api/vehicles/${v.id}/station`, { stationId: e.target.value }))}>
                    {active.map((s) => <option key={s.id} value={s.id}>{s.id} – {s.name}</option>)}
                  </select>
                </td></tr>
            ))}
          </tbody></table>
          <div className="small muted">Chỉ chuyển được xe đang rảnh hoặc ngoài hoạt động.</div>
        </div>
        <div className="panel" style={{ overflowX: 'auto' }}>
          <h3>Nhân viên làm ở điểm nào</h3>
          <table><tbody>
            {users.filter((u) => u.active && u.role !== 'hospital').map((u) => (
              <tr key={u.id}><td>{u.full_name} <span className="small muted">{u.username} · {ROLE_LABEL[u.role]}</span></td>
                <td className="right">
                  <select value={u.station_id ?? ''} onChange={(e) => run(() => api('PATCH', `/api/users/${u.id}/station`, { stationId: e.target.value || null }))}>
                    <option value="">Mọi điểm</option>
                    {active.map((s) => <option key={s.id} value={s.id}>{s.id} – {s.name}</option>)}
                  </select>
                </td></tr>
            ))}
          </tbody></table>
          <div className="small muted">Kíp được phân điểm chỉ nhận ca trên xe của điểm đó.</div>
        </div>
      </div>
      <Accounts users={users} run={run} />
      <HospitalOrgs />
      <ScopeAdmin />
      <ServicePrices canEdit />
      <TelephonyAdmin />
      <PkiAdmin />
    </div>
  );
}

const NEW_USER = { username: '', fullName: '', role: 'crew' as Role, title: '', licenseNo: '', password: '', hospitalId: '', accountType: 'ca_nhan', cccd: '', taxCode: '' };
/** Bác sĩ, Y sĩ, Điều dưỡng cần số chứng chỉ hành nghề; lái xe và nhóm khác không cần */
const needsLicense = (t: string) => /^(bác s[ĩỹ]|y s[ĩỹ]|điều dưỡng|bs|ys|đd|dd)(\s|$|\.)/i.test(t.trim());

/** Tài khoản: tạo, đổi vai trò, khóa/mở, đặt lại mật khẩu. Mật khẩu do admin đặt, chỉ lưu bản băm ở máy chủ */
function Accounts({ users, run }: { users: UserRow[]; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [f, setF] = useState(NEW_USER);
  const [q, setQ] = useState('');
  const hospitals = useHospitals();
  const shown = users.filter((u) => !q || `${u.username} ${u.full_name}`.toLowerCase().includes(q.toLowerCase()));
  const org = f.accountType === 'to_chuc';
  const valid = /^[a-z0-9._-]{3,40}$/.test(f.username) && f.fullName.trim().length >= 2 && f.password.length >= 10 && (f.role !== 'hospital' || !!f.hospitalId)
    && (org ? /^\d{10}(\d{3})?$/.test(f.taxCode.replace(/[\s.-]/g, '')) : /^\d{12}$/.test(f.cccd.replace(/\s/g, '')))
    && (org || !needsLicense(f.title) || !!f.licenseNo.trim());
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <h3>Tài khoản</h3>
      <div className="grid4">
        <label className="field">Tên đăng nhập<input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} placeholder="chữ thường, số, . _ -" /></label>
        <label className="field">Loại tài khoản<select value={f.accountType} onChange={(e) => setF({ ...f, accountType: e.target.value, cccd: '', taxCode: '', title: '', licenseNo: '' })}>
          <option value="ca_nhan">Cá nhân (có số căn cước)</option><option value="to_chuc">Tổ chức (có mã số thuế)</option></select></label>
        <label className="field">{org ? 'Tên tổ chức' : 'Họ tên'}<input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></label>
        <label className="field">Vai trò<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
        {f.role === 'hospital' && <label className="field">Bệnh viện (tài khoản chỉ thấy ca chuyển tới bệnh viện này)<select value={f.hospitalId} onChange={(e) => setF({ ...f, hospitalId: e.target.value })}>
          <option value="">Chọn bệnh viện</option>
          {hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>}
        {org
          ? <label className="field">Mã số thuế (10 hoặc 13 số)<input value={f.taxCode} inputMode="numeric" onChange={(e) => setF({ ...f, taxCode: e.target.value })} /></label>
          : <>
            <label className="field">Số căn cước (12 số, lưu mã hóa)<input value={f.cccd} inputMode="numeric" autoComplete="off" onChange={(e) => setF({ ...f, cccd: e.target.value })} /></label>
            <label className="field">Chức danh<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Bác sĩ, Y sĩ, Điều dưỡng, Lái xe…" /></label>
            {needsLicense(f.title) && <label className="field">Số chứng chỉ hành nghề (bắt buộc)<input value={f.licenseNo} onChange={(e) => setF({ ...f, licenseNo: e.target.value })} /></label>}
          </>}
        <label className="field">Mật khẩu ban đầu (≥ 10 ký tự)<input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
      </div>
      <div className="row" style={{ margin: '8px 0' }}>
        <button className="primary" disabled={!valid} onClick={() => run(async () => {
          await api('POST', '/api/users', { ...f, title: f.title || null, licenseNo: needsLicense(f.title) ? f.licenseNo : null, hospitalId: f.role === 'hospital' ? Number(f.hospitalId) : null,
            cccd: org ? null : f.cccd, taxCode: org ? f.taxCode : null }); setF(NEW_USER);
        })}>Tạo tài khoản</button>
        <input placeholder="Tìm tài khoản" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <table>
        <thead><tr><th>Tài khoản</th><th>Vai trò</th><th>Trạng thái</th><th /></tr></thead>
        <tbody>{shown.map((u) => (
          <tr key={u.id} style={u.active ? undefined : { opacity: 0.55 }}>
            <td>{u.full_name} <span className="small muted">{u.username}{u.title ? ` · ${u.title}` : ''}</span>
              <div className="small muted">{u.account_type === 'to_chuc' ? `Tổ chức · MST ${u.tax_code ?? 'chưa có'}`
                : u.cccd_last4 ? `CCCD ••••${u.cccd_last4}` : <span style={{ color: 'var(--p2)' }}>Chưa có số căn cước</span>}
                {u.account_type !== 'to_chuc' && needsLicense(u.title ?? '') && !u.license_no && <span style={{ color: 'var(--p2)' }}> · Thiếu chứng chỉ hành nghề</span>}</div></td>
            <td><select value={u.role} onChange={(e) => {
                if (e.target.value !== 'hospital') return run(() => api('PATCH', `/api/users/${u.id}`, { role: e.target.value }));
                const name = prompt('Tài khoản bệnh viện: gõ tên bệnh viện (đúng như trong danh mục)');
                const h = name ? hospitals.find((x) => x.name.toLowerCase() === name.trim().toLowerCase()) : null;
                if (!h) { if (name) alert('Không thấy bệnh viện này trong danh mục'); return; }
                run(() => api('PATCH', `/api/users/${u.id}`, { role: 'hospital', hospitalId: h.id }));
              }}>
              {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
              {u.role === 'hospital' && <div className="small muted">{u.hospital_name}</div>}</td>
            <td>{u.active ? 'Đang dùng' : 'Đã khóa'}{u.sso_linked_at && <span className="badge" title="Đã nối tài khoản đăng nhập một lần"> SSO</span>}</td>
            <td className="right">
              <button className="ghost small" onClick={() => run(() => api('PATCH', `/api/users/${u.id}`, { active: !u.active }))}>{u.active ? 'Khóa' : 'Mở khóa'}</button>{' '}
              <button className="ghost small" onClick={() => {
                const pw = prompt(`Mật khẩu mới cho ${u.username} (≥ 10 ký tự):`);
                if (pw && pw.length >= 10) run(() => api('POST', `/api/users/${u.id}/password`, { password: pw }));
              }}>Đặt lại mật khẩu</button>
              {u.account_type !== 'to_chuc' && <>{' '}<button className="ghost small" onClick={() => {
                const c = prompt(`Số căn cước (12 số) của ${u.full_name}:`);
                if (c) run(() => api('PUT', `/api/users/${u.id}/cccd`, { cccd: c }));
              }}>{u.cccd_last4 ? 'Sửa CCCD' : 'Ghi CCCD'}</button></>}
              {u.sso_linked_at && <>{' '}<button className="ghost small" onClick={() => confirm(`Gỡ nối đăng nhập một lần của ${u.username}?`) && run(() => api('POST', `/api/users/${u.id}/sso-unlink`))}>Gỡ SSO</button></>}
            </td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

/** Bệnh viện là tổ chức có mã số thuế; tài khoản cá nhân của bác sĩ bệnh viện (có số căn cước) gắn dưới bệnh viện */
function HospitalOrgs() {
  const [list, setList] = useState<any[]>([]);
  const [f, setF] = useState({ name: '', taxCode: '', address: '' });
  const [error, setError] = useState('');
  const load = () => api<any[]>('GET', '/api/hospitals').then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };
  const mstOk = (t: string) => /^\d{10}(\d{3})?$/.test(t.replace(/[\s.-]/g, ''));
  return (
    <details className="panel">
      <summary><b>Bệnh viện (tổ chức, mã số thuế)</b> <span className="small muted">{list.filter((h) => !h.tax_code).length} bệnh viện chưa có mã số thuế</span></summary>
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ flexWrap: 'wrap', margin: '8px 0' }}>
        <input placeholder="Tên bệnh viện" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ minWidth: 240 }} />
        <input placeholder="Mã số thuế" value={f.taxCode} inputMode="numeric" onChange={(e) => setF({ ...f, taxCode: e.target.value })} />
        <input placeholder="Địa chỉ" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} style={{ minWidth: 240 }} />
        <button disabled={f.name.trim().length < 3 || !mstOk(f.taxCode)} onClick={() => run(async () => {
          await api('POST', '/api/hospitals', { name: f.name, taxCode: f.taxCode, address: f.address || null }); setF({ name: '', taxCode: '', address: '' });
        })}>Thêm bệnh viện</button>
      </div>
      <table className="small">
        <thead><tr><th>Bệnh viện</th><th>Mã số thuế</th><th /></tr></thead>
        <tbody>{list.map((h) => (
          <tr key={h.id}><td>{h.name}</td><td className="mono">{h.tax_code ?? <span style={{ color: 'var(--p2)' }}>Chưa có</span>}</td>
            <td className="right"><button className="ghost small" onClick={() => {
              const t = prompt(`Mã số thuế của ${h.name} (10 hoặc 13 số):`, h.tax_code ?? '');
              if (t) run(() => api('PATCH', `/api/hospitals/${h.id}`, { taxCode: t }));
            }}>Sửa mã số thuế</button></td></tr>
        ))}</tbody>
      </table>
    </details>
  );
}
