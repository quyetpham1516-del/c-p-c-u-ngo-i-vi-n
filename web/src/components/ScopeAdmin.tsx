'use client';
import { useEffect, useState } from 'react';
import { api, fmtTime } from '../api';

interface Rule { id: number; kind: 'thuoc' | 'can_thiep'; ref: string; label: string; allowed: string[]; note: string | null; active: boolean; grant_count: number; updated_by_name: string | null; updated_at: string }
interface RulesResp { rules: Rule[]; categories: Record<string, string>; care: Record<string, string>; drugs: { id: number; name: string }[] }
interface Person { id: string; username: string; full_name: string; title: string | null; scope_category: string | null; category: string; crew_roles: string[] | null; license_no: string | null;
  grants: { id: string; rule_id: number; label: string; note: string | null; expires_on: string | null }[] }
interface CrewRole { name: string; sort: number; active: boolean }
interface LabType { code: string; name: string; unit: string | null; normal_low: number | null; normal_high: number | null; sort: number; active: boolean }

/**
 * Quản trị phạm vi thực hiện: thuốc, can thiệp nào nhóm chức danh nào được tự làm; nhóm chức danh, vai trò trong kíp
 * và quyền cấp riêng của từng người; danh mục vai trò trong kíp; danh mục cận lâm sàng; ca có bác sĩ trao đổi.
 */
export function ScopeAdmin() {
  const [data, setData] = useState<RulesResp | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [roles, setRoles] = useState<CrewRole[]>([]);
  const [labs, setLabs] = useState<LabType[]>([]);
  const [consults, setConsults] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [newRule, setNewRule] = useState({ kind: 'thuoc' as 'thuoc' | 'can_thiep', ref: '', allowed: ['bac_si'] });
  const [newRole, setNewRole] = useState('');
  const [newLab, setNewLab] = useState({ code: '', name: '', unit: '', normalLow: '', normalHigh: '' });
  const [grantFor, setGrantFor] = useState<{ userId: string; ruleId: string; expiresOn: string; note: string } | null>(null);
  const [q, setQ] = useState('');

  const load = async () => {
    const [r, p, cr, lt, cs] = await Promise.all([
      api<RulesResp>('GET', '/api/scope/rules'), api<Person[]>('GET', '/api/scope/people'), api<CrewRole[]>('GET', '/api/crew-roles'),
      api<LabType[]>('GET', '/api/lab-types?all=1'), api<any[]>('GET', '/api/scope/consults?days=30'),
    ]);
    setData(r); setPeople(p); setRoles(cr); setLabs(lt); setConsults(cs);
  };
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };
  if (!data) return <div className="panel">{error ? <div className="error">{error}</div> : 'Đang tải phạm vi thực hiện…'}</div>;
  const cats = Object.entries(data.categories);
  const toggle = (list: string[], k: string) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  const usedRefs = new Set(data.rules.filter((r) => r.kind === newRule.kind).map((r) => r.ref));
  const shownPeople = people.filter((p) => !q || `${p.full_name} ${p.username} ${p.title ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="col">
      {error && <div className="error">{error}</div>}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3>Phạm vi thực hiện theo chức danh</h3>
        <div className="small muted">Đánh dấu nhóm chức danh được tự làm. Kíp không có ai thuộc nhóm đánh dấu (và không ai được cấp riêng) thì phiếu phải ghi bác sĩ đã trao đổi mới ký được. Danh sách mẫu là bản nháp, sửa theo quy định của trung tâm.</div>
        <table className="sheet" style={{ marginTop: 8 }}>
          <thead><tr><th>Loại</th><th>Thuốc / can thiệp</th>{cats.map(([k, v]) => <th key={k} className="small">{v}</th>)}<th>Cấp riêng</th><th>Dùng</th><th>Ghi chú</th></tr></thead>
          <tbody>{data.rules.map((r) => (
            <tr key={r.id} style={r.active ? undefined : { opacity: 0.5 }}>
              <td className="small">{r.kind === 'thuoc' ? 'Thuốc' : 'Can thiệp'}</td>
              <td>{r.label}</td>
              {cats.map(([k]) => (
                <td key={k} style={{ textAlign: 'center' }}>
                  <input type="checkbox" checked={r.allowed.includes(k)} onChange={() => run(() => api('PATCH', `/api/scope/rules/${r.id}`, { allowed: toggle(r.allowed, k) }))} />
                </td>
              ))}
              <td className="right small">{r.grant_count || '—'}</td>
              <td><input type="checkbox" checked={r.active} onChange={() => run(() => api('PATCH', `/api/scope/rules/${r.id}`, { active: !r.active }))} /></td>
              <td><input style={{ width: 160 }} defaultValue={r.note ?? ''} onBlur={(e) => e.target.value !== (r.note ?? '') && run(() => api('PATCH', `/api/scope/rules/${r.id}`, { note: e.target.value || null }))} /></td>
            </tr>
          ))}</tbody>
        </table>
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <select value={newRule.kind} onChange={(e) => setNewRule({ ...newRule, kind: e.target.value as 'thuoc' | 'can_thiep', ref: '' })}>
            <option value="thuoc">Thuốc</option><option value="can_thiep">Can thiệp</option>
          </select>
          <select value={newRule.ref} onChange={(e) => setNewRule({ ...newRule, ref: e.target.value })}>
            <option value="">— Chọn —</option>
            {newRule.kind === 'thuoc'
              ? data.drugs.filter((d) => !usedRefs.has(String(d.id))).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)
              : Object.entries(data.care).filter(([k]) => !usedRefs.has(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="small muted">được tự làm:</span>
          {cats.map(([k, v]) => <label key={k} className="row small"><input type="checkbox" checked={newRule.allowed.includes(k)} onChange={() => setNewRule({ ...newRule, allowed: toggle(newRule.allowed, k) })} /> {v}</label>)}
          <button className="primary" disabled={!newRule.ref} onClick={() => run(async () => { await api('POST', '/api/scope/rules', newRule); setNewRule({ ...newRule, ref: '' }); })}>Thêm vào danh sách</button>
        </div>
      </div>

      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3>Từng người: nhóm chức danh, vai trò trong kíp, quyền cấp riêng</h3>
        <div className="small muted">Nhóm chức danh để trống thì tự nhận theo chức danh ghi trên tài khoản. Vai trò trong kíp để trống là nhận được mọi vai trò.</div>
        <input placeholder="Tìm người" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: '8px 0' }} />
        <table>
          <thead><tr><th>Người</th><th>Nhóm chức danh</th><th>Vai trò được nhận trong kíp</th><th>Được cấp riêng</th></tr></thead>
          <tbody>{shownPeople.map((p) => (
            <tr key={p.id}>
              <td>{p.full_name}<div className="small muted">{p.username}{p.title ? ` · ${p.title}` : ''}{p.license_no ? ` · ${p.license_no}` : ''}</div></td>
              <td>
                <select value={p.scope_category ?? ''} onChange={(e) => run(() => api('PATCH', `/api/users/${p.id}/scope`, { scopeCategory: e.target.value || null }))}>
                  <option value="">Theo chức danh ({data.categories[p.category] ?? p.category})</option>
                  {cats.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </td>
              <td>
                <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                  {roles.filter((r) => r.active).map((r) => {
                    const on = !!p.crew_roles?.includes(r.name);
                    return (
                      <label key={r.name} className="row small" style={{ gap: 2 }}>
                        <input type="checkbox" checked={on} onChange={() => run(() => api('PATCH', `/api/users/${p.id}/scope`, { crewRoles: toggle(p.crew_roles ?? [], r.name) }))} />{r.name}
                      </label>
                    );
                  })}
                </div>
                {!p.crew_roles?.length && <span className="small muted">Mọi vai trò</span>}
              </td>
              <td>
                {p.grants.map((g) => (
                  <span key={g.id} className="badge" style={{ marginRight: 4 }} title={g.note ?? ''}>
                    {g.label}{g.expires_on ? ` (đến ${g.expires_on})` : ''}{' '}
                    <button className="ghost small" onClick={() => confirm(`Thu hồi "${g.label}" của ${p.full_name}?`) && run(() => api('POST', `/api/scope/grants/${g.id}/revoke`))}>✕</button>
                  </span>
                ))}
                {grantFor?.userId === p.id ? (
                  <div className="row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                    <select value={grantFor.ruleId} onChange={(e) => setGrantFor({ ...grantFor, ruleId: e.target.value })}>
                      <option value="">— Thuốc / can thiệp —</option>
                      {data.rules.filter((r) => r.active && !p.grants.some((g) => g.rule_id === r.id)).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                    <label className="small">Đến ngày <input type="date" value={grantFor.expiresOn} onChange={(e) => setGrantFor({ ...grantFor, expiresOn: e.target.value })} /></label>
                    <input placeholder="Căn cứ (lớp đào tạo, quyết định...)" value={grantFor.note} onChange={(e) => setGrantFor({ ...grantFor, note: e.target.value })} />
                    <button className="primary small" disabled={!grantFor.ruleId} onClick={() => run(async () => {
                      await api('POST', '/api/scope/grants', { userId: p.id, ruleId: Number(grantFor.ruleId), expiresOn: grantFor.expiresOn || null, note: grantFor.note || null });
                      setGrantFor(null);
                    })}>Cấp</button>
                    <button className="ghost small" onClick={() => setGrantFor(null)}>Hủy</button>
                  </div>
                ) : <button className="ghost small" onClick={() => setGrantFor({ userId: p.id, ruleId: '', expiresOn: '', note: '' })}>+ Cấp riêng</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      <div className="grid2">
        <div className="panel">
          <h3>Danh mục vai trò trong kíp</h3>
          <table><tbody>{roles.map((r) => (
            <tr key={r.name} style={r.active ? undefined : { opacity: 0.5 }}>
              <td>{r.name}</td>
              <td className="right"><button className="ghost small" onClick={() => run(() => api('PATCH', `/api/crew-roles/${encodeURIComponent(r.name)}`, { active: !r.active }))}>{r.active ? 'Ngưng dùng' : 'Dùng lại'}</button></td>
            </tr>
          ))}</tbody></table>
          <div className="row" style={{ marginTop: 6 }}>
            <input placeholder="Vai trò mới" value={newRole} onChange={(e) => setNewRole(e.target.value)} />
            <button className="primary" disabled={newRole.trim().length < 2} onClick={() => run(async () => { await api('POST', '/api/crew-roles', { name: newRole.trim() }); setNewRole(''); })}>Thêm</button>
          </div>
        </div>
        <div className="panel" style={{ overflowX: 'auto' }}>
          <h3>Danh mục cận lâm sàng tại chỗ</h3>
          <table>
            <thead><tr><th>Tên</th><th>Đơn vị</th><th>BT thấp</th><th>BT cao</th><th>Dùng</th></tr></thead>
            <tbody>{labs.map((l) => (
              <tr key={l.code} style={l.active ? undefined : { opacity: 0.5 }}>
                <td><input defaultValue={l.name} onBlur={(e) => e.target.value !== l.name && run(() => api('PATCH', `/api/lab-types/${l.code}`, { name: e.target.value }))} /></td>
                <td><input style={{ width: 70 }} defaultValue={l.unit ?? ''} onBlur={(e) => e.target.value !== (l.unit ?? '') && run(() => api('PATCH', `/api/lab-types/${l.code}`, { unit: e.target.value || null }))} /></td>
                {(['normal_low', 'normal_high'] as const).map((k) => (
                  <td key={k}><input style={{ width: 60 }} inputMode="decimal" defaultValue={l[k] ?? ''} onBlur={(e) => {
                    const v = e.target.value === '' ? null : Number(e.target.value.replace(',', '.'));
                    if (v !== l[k] && (v === null || Number.isFinite(v))) run(() => api('PATCH', `/api/lab-types/${l.code}`, { [k === 'normal_low' ? 'normalLow' : 'normalHigh']: v }));
                  }} /></td>
                ))}
                <td><input type="checkbox" checked={l.active} onChange={() => run(() => api('PATCH', `/api/lab-types/${l.code}`, { active: !l.active }))} /></td>
              </tr>
            ))}</tbody>
          </table>
          <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <input style={{ width: 90 }} placeholder="Mã (vd: crp)" value={newLab.code} onChange={(e) => setNewLab({ ...newLab, code: e.target.value.toLowerCase() })} />
            <input placeholder="Tên" value={newLab.name} onChange={(e) => setNewLab({ ...newLab, name: e.target.value })} />
            <input style={{ width: 70 }} placeholder="Đơn vị" value={newLab.unit} onChange={(e) => setNewLab({ ...newLab, unit: e.target.value })} />
            <input style={{ width: 60 }} placeholder="BT thấp" value={newLab.normalLow} onChange={(e) => setNewLab({ ...newLab, normalLow: e.target.value })} />
            <input style={{ width: 60 }} placeholder="BT cao" value={newLab.normalHigh} onChange={(e) => setNewLab({ ...newLab, normalHigh: e.target.value })} />
            <button className="primary" disabled={!/^[a-z0-9_]{2,30}$/.test(newLab.code) || newLab.name.trim().length < 2} onClick={() => run(async () => {
              const n = (v: string) => (v === '' ? null : Number(v.replace(',', '.')));
              await api('POST', '/api/lab-types', { code: newLab.code, name: newLab.name, unit: newLab.unit || null, normalLow: n(newLab.normalLow), normalHigh: n(newLab.normalHigh) });
              setNewLab({ code: '', name: '', unit: '', normalLow: '', normalHigh: '' });
            })}>Thêm</button>
          </div>
        </div>
      </div>

      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3>Ca có y lệnh qua bác sĩ trao đổi (30 ngày)</h3>
        {!consults.length ? <div className="small muted">Chưa có ca nào.</div> : (
          <table>
            <thead><tr><th>Phiếu</th><th>Xe</th><th>Giờ trao đổi</th><th>Bác sĩ</th><th>Hình thức</th><th>Cho</th><th>Ghi chú</th></tr></thead>
            <tbody>{consults.map((c, i) => (
              <tr key={`${c.id}-${i}`}>
                <td><a href={`/phieu/${c.id}`} target="_blank" rel="noreferrer">{c.transfer_number ?? c.id.slice(0, 8)}</a>{c.status === 'signed' ? '' : <span className="small muted"> (nháp)</span>}</td>
                <td>{c.vehicle_id ?? '—'}</td>
                <td className="small">{c.consult.at ? fmtTime(c.consult.at) : '—'}</td>
                <td>{c.consult.doctor}{c.consult.license ? <span className="small muted"> · {c.consult.license}</span> : null}</td>
                <td className="small">{({ dien_thoai: 'Điện thoại', video: 'Video', truc_tiep: 'Trực tiếp' } as Record<string, string>)[c.consult.mode] ?? '—'}</td>
                <td className="small">{(c.consult.items ?? []).map((k: string) => data.rules.find((r) => `${r.kind}:${r.ref}` === k)?.label ?? k).join(', ')}</td>
                <td className="small">{c.consult.note ?? ''}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
