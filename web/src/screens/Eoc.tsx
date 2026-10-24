import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  api, fmtDuration, INFECTION_RISK, fmtTime, INCIDENT_STATUS, PRIORITY_LABEL, session, TIME_LABEL, useLive, useNow, VEHICLE_LABEL, type LiveEvent,
} from '../api';
import { FleetTable, type Board } from '../components/FleetTable';
import { HospitalPicker } from '../components/HospitalPicker';
import { MapView } from '../components/MapView';
import { FLAG_LABEL, TriageQuestions, type Protocol, type TriageResult } from '../components/Triage';

interface Call { id: string; phone: string; line: string; state: string; ringing_at: string; incident_id: string | null }
interface IncidentRow {
  id: string; code: string; source: string; status: string; address: string | null; chief_complaint: string | null;
  suggested_priority: string | null; final_priority: string | null; created_at: string; confirmed_at: string | null;
  vehicles: string[] | null; caller_phone: string | null;
}

const OPEN = new Set(['intake', 'awaiting_confirm', 'confirmed', 'dispatched', 'on_scene', 'transporting', 'at_hospital']);
const RANK: Record<string, number> = { P1: 5, P2: 4, P3: 3, P4: 2, HEN: 1 };
const OVERRIDE_REASONS = [
  'Thông tin mới từ người gọi',
  'Đánh giá của điều phối viên có kinh nghiệm',
  'Bác sĩ EOC chỉ định',
  'Không có xe loại đề xuất',
];
const DISPATCH_ROLES = ['dispatcher', 'supervisor', 'admin'];

export function useBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const load = useCallback(() => { api<Board>('GET', '/api/board').then(setBoard).catch(() => {}); }, []);
  const soon = useCallback(() => { clearTimeout(timer.current); timer.current = window.setTimeout(load, 250); }, [load]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  const onEvent = useCallback((e: LiveEvent) => {
    if (e.type === 'vehicle' || e.type === 'incident' || e.type === 'reconnected') soon();
    if (e.type === 'call') soon();
    if (e.type === 'vehicle.location') {
      setBoard((b) => b && { ...b, vehicles: b.vehicles.map((v) => (v.id === e.id ? { ...v, lat: e.lat, lng: e.lng } : v)) });
    }
  }, [soon]);
  return { board, onEvent };
}

export function Eoc() {
  const role = session.user?.role ?? 'calltaker';
  const canDispatch = DISPATCH_ROLES.includes(role);
  const [protocol, setProtocol] = useState<Protocol | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [abandoned, setAbandoned] = useState<Call[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const { board, onEvent: boardEvent } = useBoard();
  const now = useNow();

  const loadLists = useCallback(() => {
    api<Call[]>('GET', '/api/calls?state=ringing').then(setCalls).catch(() => {});
    api<Call[]>('GET', '/api/calls?state=abandoned').then(setAbandoned).catch(() => {});
    api<IncidentRow[]>('GET', '/api/incidents').then(setIncidents).catch(() => {});
  }, []);

  useEffect(() => {
    api<Protocol>('GET', '/api/protocol').then(setProtocol);
    loadLists();
  }, [loadLists]);

  const connected = useLive((e) => {
    boardEvent(e);
    if (e.type === 'reconnected') loadLists();
    if (e.type === 'call' && e.call) {
      const c = e.call as Call;
      setCalls((cs) => (c.state === 'ringing' ? (cs.some((x) => x.id === c.id) ? cs : [...cs, c]) : cs.filter((x) => x.id !== c.id)));
      if (c.state === 'abandoned') setAbandoned((a) => (a.some((x) => x.id === c.id) ? a : [...a, c]));
    }
    if (e.type === 'incident') {
      if (e.incident) {
        const inc = e.incident as IncidentRow;
        setIncidents((list) => {
          const others = list.filter((x) => x.id !== inc.id);
          return OPEN.has(inc.status) ? [inc, ...others] : others;
        });
      } else loadLists();
      if (e.id === selected) setVersion((v) => v + 1);
    }
  });

  const answer = async (c: Call) => {
    setError('');
    try {
      const inc = await api('POST', `/api/calls/${c.id}/answer`, {});
      setCalls((cs) => cs.filter((x) => x.id !== c.id));
      setSelected(inc.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const newFrom115 = async () => {
    const ref = prompt('Mã ca bên 115 (nếu có):') ?? '';
    const inc = await api('POST', '/api/incidents', { source: '115', sourceRef: ref || null });
    setSelected(inc.id);
  };

  const simulateCall = async () => {
    const phone = `09${Math.floor(10000000 + Math.random() * 89999999)}`;
    await api('POST', '/api/telephony/ring', { phone, line: '1800' });
  };

  const sorted = useMemo(() => [...incidents].sort((a, b) => {
    const pa = RANK[a.final_priority ?? a.suggested_priority ?? ''] ?? 0;
    const pb = RANK[b.final_priority ?? b.suggested_priority ?? ''] ?? 0;
    return pb - pa || a.created_at.localeCompare(b.created_at);
  }), [incidents]);

  // Cảnh báo cho trưởng ca (mục 5.6): P1 chờ xe > 60 giây, P2 > 3 phút
  const alerts = sorted.filter((i) => !i.vehicles?.length && i.confirmed_at && (
    (i.final_priority === 'P1' && now - new Date(i.confirmed_at).getTime() > 60_000)
    || (i.final_priority === 'P2' && now - new Date(i.confirmed_at).getTime() > 180_000)));
  const p2Waiting = sorted.filter((i) => i.final_priority === 'P2' && !i.vehicles?.length && i.confirmed_at).length;
  const oldestCall = calls[0] ? now - new Date(calls[0].ringing_at).getTime() : 0;

  return (
    <div className="eoc">
      <aside className="col">
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Cuộc gọi chờ <span className="badge">{calls.length}</span></h2>
            <span className="small"><span className={`live-dot ${connected ? 'on' : ''}`} />{connected ? 'Trực tuyến' : 'Mất kết nối'}</span>
          </div>
          {calls.length > 0 && <div className="small muted" style={{ margin: '4px 0' }}>Chờ lâu nhất {fmtDuration(oldestCall)}</div>}
          <div className="list" style={{ marginTop: 8, maxHeight: 260, overflow: 'auto' }}>
            {calls.map((c) => (
              <div key={c.id} className="item waiting row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <b className="mono">{c.phone}</b> <span className="badge">{c.line === '115' ? 'Từ 115' : '1800'}</span>
                  <div className="small muted mono">chờ {fmtDuration(now - new Date(c.ringing_at).getTime())}</div>
                </div>
                <button className="ok" onClick={() => answer(c)}>Nhận</button>
              </div>
            ))}
            {!calls.length && <div className="muted small">Không có cuộc gọi chờ</div>}
          </div>
          {error && <div className="error small">{error}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={newFrom115}>+ Ca từ 115</button>
            <button className="ghost small" onClick={simulateCall} title="Chỉ dùng khi thử nghiệm, chưa nối tổng đài">Giả lập cuộc gọi</button>
          </div>
        </div>

        {abandoned.length > 0 && (
          <div className="panel">
            <h3>Cần gọi lại (cuộc gọi bỏ dở)</h3>
            <div className="list">
              {abandoned.map((c) => (
                <div key={c.id} className="item row" style={{ justifyContent: 'space-between', cursor: 'default' }}>
                  <div><b className="mono">{c.phone}</b><div className="small muted">{fmtTime(c.ringing_at)}</div></div>
                  <button onClick={async () => { await api('POST', `/api/calls/${c.id}/callback-done`); setAbandoned((a) => a.filter((x) => x.id !== c.id)); }}>Đã gọi lại</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="panel">
          <h2>Ca đang mở <span className="badge">{sorted.length}</span></h2>
          <div className="list" style={{ maxHeight: 520, overflow: 'auto' }}>
            {sorted.map((i) => {
              const p = i.final_priority ?? i.suggested_priority;
              return (
                <div key={i.id} className={`item prio-${p ?? ''} ${selected === i.id ? 'sel' : ''}`} onClick={() => setSelected(i.id)}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <b className="mono">{i.code}</b>
                    <span className={`badge prio ${p ?? 'none'}`}>{p ?? '—'}{!i.final_priority && p ? '?' : ''}</span>
                  </div>
                  <div className="small">{i.address ?? <span className="muted">Chưa có địa chỉ</span>}</div>
                  <div className="small muted row" style={{ justifyContent: 'space-between' }}>
                    <span>{INCIDENT_STATUS[i.status]}{i.vehicles?.length ? ` · ${i.vehicles.join(', ')}` : ''}</span>
                    <span className="mono">{fmtDuration(now - new Date(i.created_at).getTime())}</span>
                  </div>
                </div>
              );
            })}
            {!sorted.length && <div className="muted small">Không có ca đang mở</div>}
          </div>
        </div>
      </aside>

      <section>
        {selected && protocol
          ? <IncidentWorkspace key={selected} id={selected} protocol={protocol} board={board} version={version} canDispatch={canDispatch} onClose={() => setSelected(null)} />
          : <div className="panel muted">Chọn một cuộc gọi chờ hoặc một ca để bắt đầu.</div>}
      </section>

      <aside className="col eoc-right">
        {(alerts.length > 0 || p2Waiting >= 3) && (
          <div className="col">
            {alerts.map((a) => (
              <div key={a.id} className="alert red" onClick={() => setSelected(a.id)} style={{ cursor: 'pointer' }}>
                {a.final_priority} {a.code} chờ xe {fmtDuration(now - new Date(a.confirmed_at!).getTime())}
              </div>
            ))}
            {p2Waiting >= 3 && <div className="alert amber">{p2Waiting} ca P2 đang chờ xe: cân nhắc kích hoạt kế hoạch tăng cường</div>}
          </div>
        )}
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Đội xe</h2>
            <Link href="/bang-xe" className="small">Mở bảng lớn</Link>
          </div>
          <FleetTable board={board} compact />
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function IncidentWorkspace({ id, protocol, board, version, canDispatch, onClose }: {
  id: string; protocol: Protocol; board: Board | null; version: number; canDispatch: boolean; onClose: () => void;
}) {
  const [inc, setInc] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [group, setGroup] = useState<string | null>(null);
  const [result, setResult] = useState<TriageResult | null>(null);
  const [suggest, setSuggest] = useState<any>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<any>({});
  const now = useNow();

  const load = useCallback(async () => {
    const d = await api('GET', `/api/incidents/${id}`);
    setInc(d);
    setResult(d.triage);
    return d;
  }, [id]);

  useEffect(() => {
    load().then((d) => {
      setAnswers(d.triage_answers ?? {});
      setGroup(d.chief_complaint ?? null);
      setForm({
        address: d.address ?? '', addressNote: d.address_note ?? '', callbackPhone: d.callback_phone ?? '', callerName: d.caller_name ?? '',
        lat: d.lat, lng: d.lng, patientCount: d.patient_count, notes: d.notes ?? '', sourceRef: d.source_ref ?? '',
      });
    }).catch((e) => setError(e.message));
  }, [load]);

  useEffect(() => { if (version) load().catch(() => {}); }, [version, load]);

  useEffect(() => {
    if (inc?.confirmed_at && canDispatch) api('GET', `/api/incidents/${id}/suggest`).then(setSuggest).catch(() => {});
  }, [inc?.confirmed_at, inc?.status, board, id, canDispatch]);

  const run = async (fn: () => Promise<any>) => {
    setError('');
    try { const r = await fn(); await load(); return r; } catch (e) { setError((e as Error).message); }
  };

  const saveField = (patch: Record<string, unknown>) => run(() => api('PATCH', `/api/incidents/${id}`, patch));

  const onTriage = async (a: Record<string, string>, g: string | null) => {
    setAnswers(a);
    setGroup(g);
    try {
      const r = await api<TriageResult>('PUT', `/api/incidents/${id}/triage`, { answers: a, group: g });
      setResult(r);
    } catch (e) { setError((e as Error).message); }
  };

  if (!inc) return <div className="panel">{error || 'Đang tải…'}</div>;

  const t0 = inc.times.find((t: any) => t.code === 'T0')?.at;
  const closed = !OPEN.has(inc.status);
  const active = inc.assignments.filter((a: any) => !a.ended_at);

  return (
    <div className="col">
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            <h2 style={{ margin: 0 }} className="mono">{inc.code}</h2>
            <span className="badge">{inc.source === '115' ? `Nguồn: 115${inc.source_ref ? ` (${inc.source_ref})` : ''}` : 'Nguồn: 1800'}</span>
            <span className="badge">{INCIDENT_STATUS[inc.status]}</span>
          </div>
          <div className="row">
            {t0 && <span className="mono">⏱ {fmtDuration(now - new Date(t0).getTime())}</span>}
            <Link href={`/ca/${id}/truy-xuat`} className="small">Truy xuất ca</Link>
            <button className="ghost" onClick={onClose}>Đóng cửa sổ</button>
          </div>
        </div>
        <div className="times" style={{ marginTop: 8 }}>
          {Object.keys(TIME_LABEL).map((c) => {
            const t = inc.times.find((x: any) => x.code === c);
            return <div key={c} className={t ? 'done' : ''}><b>{c}</b>{TIME_LABEL[c]}<div className="mono">{t ? fmtTime(t.at) : '—'}</div></div>;
          })}
        </div>
        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>

      <div className="panel">
        <h3>1. Địa điểm và số gọi lại (hỏi trước mọi câu khác)</h3>
        <div className="grid2">
          <label className="field">Địa chỉ
            <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} onBlur={() => form.address !== (inc.address ?? '') && saveField({ address: form.address })} disabled={closed} />
          </label>
          <label className="field">Số gọi lại
            <input value={form.callbackPhone} onChange={(e) => setForm({ ...form, callbackPhone: e.target.value })} onBlur={() => form.callbackPhone !== (inc.callback_phone ?? '') && saveField({ callbackPhone: form.callbackPhone })} disabled={closed} />
          </label>
          <label className="field">Mô tả thêm (mốc, tầng, hẻm)
            <input value={form.addressNote} onChange={(e) => setForm({ ...form, addressNote: e.target.value })} onBlur={() => saveField({ addressNote: form.addressNote })} disabled={closed} />
          </label>
          <div className="grid2">
            <label className="field">Người gọi
              <input value={form.callerName} onChange={(e) => setForm({ ...form, callerName: e.target.value })} onBlur={() => saveField({ callerName: form.callerName })} disabled={closed} />
            </label>
            <label className="field">Số người bệnh
              <input type="number" min={1} value={form.patientCount ?? 1} onChange={(e) => setForm({ ...form, patientCount: Number(e.target.value) })} onBlur={() => saveField({ patientCount: form.patientCount })} disabled={closed} />
            </label>
          </div>
          <label className="field">Nguy cơ lây nhiễm (kíp mặc phòng hộ, khử khuẩn xe theo mức này)
            <select value={inc.infection_risk ?? ''} onChange={(e) => saveField({ infectionRisk: e.target.value || null })} disabled={closed}>
              <option value="">Không nghi lây nhiễm</option>
              {Object.entries(INFECTION_RISK).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
        <div className="small muted" style={{ margin: '6px 0' }}>Bấm lên bản đồ để đặt vị trí hiện trường{inc.lat != null ? ` (${inc.lat.toFixed(5)}, ${inc.lng.toFixed(5)})` : ''}.</div>
        <MapView scene={inc.lat != null ? { lat: inc.lat, lng: inc.lng } : null} vehicles={board?.vehicles ?? []}
          onPick={closed ? undefined : (lat, lng) => saveField({ lat, lng })} />
        {inc.duplicates?.length > 0 && (
          <div className="alert amber" style={{ marginTop: 8 }}>
            Có thể trùng ca:
            {inc.duplicates.map((d: any) => (
              <div key={d.id} className="row" style={{ marginTop: 4 }}>
                <b className="mono">{d.code}</b> {d.address} <span className="small muted">({d.reason})</span>
                {!closed && !active.length && (
                  <button onClick={() => run(() => api('POST', `/api/incidents/${id}/close`, { status: 'cancelled', reason: `Trùng ca ${d.code}`, duplicateOf: d.id }))}>Gộp vào ca này</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid2" style={{ alignItems: 'start' }}>
        <div className="panel">
          <h3>2. Phân loại theo bộ câu hỏi</h3>
          <TriageQuestions protocol={protocol} answers={answers} group={group} result={result} onChange={onTriage} disabled={closed} />
        </div>
        <div className="col suggest">
          <SuggestionCard result={result} inc={inc} />
          {!closed && <ConfirmCard inc={inc} result={result} run={run} id={id} />}
          {inc.confirmed_at && canDispatch && !closed && (
            <DispatchCard inc={inc} suggest={suggest} run={run} id={id} active={active} />
          )}
          {inc.outbox?.filter((o: any) => !o.sent_at).map((o: any) => (
            <div key={o.id} className="alert blue small">
              {o.topic === 'notify_115' ? 'Thông báo ca P1–P2 sang 115 tỉnh' : 'Chuyển ca sang 115'}: chưa có kết nối tự động, gọi đường nóng 115.
              {canDispatch && <div><button style={{ marginTop: 6 }} onClick={() => run(() => api('POST', `/api/outbox/${o.id}/mark-sent`))}>Đã báo 115 qua điện thoại</button></div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SuggestionCard({ result, inc }: { result: TriageResult | null; inc: any }) {
  if (!result?.priority) return <div className="panel muted">Trả lời câu hỏi sống còn để phần mềm đề xuất mã.</div>;
  return (
    <div className="panel">
      {result.earlyActivation && !inc.confirmed_at && (
        <div className="alert red" style={{ marginBottom: 8 }}>P1: xác nhận ngay và báo động xe gần nhất, không chờ hỏi hết.</div>
      )}
      <div className="row">
        <span className={`big-prio prio ${result.priority}`}>{result.priority}</span>
        <div>
          <div><b>{PRIORITY_LABEL[result.priority]}</b></div>
          <div>{VEHICLE_LABEL[result.vehicleType ?? 'NONE']} · {result.lights ? 'Đèn, còi' : 'Không đèn còi'}</div>
          <div className="small muted">Máy đề xuất{result.complete ? '' : ' (chưa hỏi xong)'}</div>
        </div>
      </div>
      {result.flags.length > 0 && (
        <div className="row" style={{ marginTop: 8 }}>{result.flags.map((f) => <span key={f} className="badge">{FLAG_LABEL[f] ?? f}</span>)}</div>
      )}
      {result.reasons.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="small">Vì sao ra mã này ({result.reasons.length})</summary>
          <ul className="small">{result.reasons.map((r) => <li key={r.questionId}>{r.answer}{r.priority ? ` → ${r.priority}` : ''}</li>)}</ul>
        </details>
      )}
      <div className="hr" />
      <h3>Hướng dẫn trước khi xe tới</h3>
      <ol className="instructions">{result.instructions.map((s) => <li key={s}>{s}</li>)}</ol>
    </div>
  );
}

function ConfirmCard({ inc, result, run, id }: { inc: any; result: TriageResult | null; run: (fn: () => Promise<any>) => Promise<any>; id: string }) {
  const [priority, setPriority] = useState<string>('');
  const [vehicle, setVehicle] = useState<string>('');
  const [lights, setLights] = useState(true);
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  const sp = result?.priority ?? '';
  const sv = result?.vehicleType ?? '';
  useEffect(() => {
    setPriority(inc.final_priority ?? sp);
    setVehicle(inc.final_vehicle_type ?? sv);
    setLights(inc.final_lights ?? result?.lights ?? false);
  }, [sp, sv, inc.final_priority, inc.final_vehicle_type]);
  if (!result?.priority) return null;
  const changed = priority !== sp || vehicle !== sv;
  const finalReason = reason === '__other' ? other : reason;
  const confirmed = !!inc.confirmed_at;
  return (
    <div className="panel">
      <h3>3. Xác nhận trước khi kích hoạt</h3>
      {confirmed && (
        <div className="alert green small" style={{ marginBottom: 8 }}>
          Đã xác nhận {inc.final_priority} · {VEHICLE_LABEL[inc.final_vehicle_type]} lúc {fmtTime(inc.confirmed_at)}
          {inc.override_reason && <> · đổi so với máy ({inc.suggested_priority}/{inc.suggested_vehicle_type}): {inc.override_reason}</>}
        </div>
      )}
      <div className="grid2">
        <label className="field">Mã ưu tiên
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}{k === sp ? ' (máy đề xuất)' : ''}</option>)}
          </select>
        </label>
        <label className="field">Loại xe
          <select value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
            {['ALS', 'BLS', 'MSU', 'ECMO', 'VC', 'NONE'].map((k) => <option key={k} value={k}>{VEHICLE_LABEL[k]}{k === sv ? ' (máy đề xuất)' : ''}</option>)}
          </select>
        </label>
      </div>
      <label className="row small" style={{ margin: '8px 0' }}>
        <input type="checkbox" checked={lights} onChange={(e) => setLights(e.target.checked)} /> Dùng đèn, còi
      </label>
      {changed && (
        <div className="col" style={{ marginBottom: 8 }}>
          <label className="field">Lý do đổi so với đề xuất (bắt buộc)
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">— Chọn lý do —</option>
              {OVERRIDE_REASONS.map((r) => <option key={r}>{r}</option>)}
              <option value="__other">Khác (ghi rõ)</option>
            </select>
          </label>
          {reason === '__other' && <input placeholder="Ghi rõ lý do" value={other} onChange={(e) => setOther(e.target.value)} />}
        </div>
      )}
      <button className={`big ${priority === 'P1' ? 'danger' : 'primary'}`} style={{ width: '100%', justifyContent: 'center' }}
        disabled={!priority || !vehicle || (changed && !finalReason.trim())}
        onClick={() => run(() => api('POST', `/api/incidents/${id}/confirm`, { priority, vehicleType: vehicle, lights, overrideReason: changed ? finalReason : null }))}>
        {confirmed ? 'Xác nhận lại' : `Xác nhận ${priority} và ${vehicle === 'NONE' ? 'chuyển tư vấn' : 'kích hoạt'}`}
      </button>
    </div>
  );
}

function DispatchCard({ inc, suggest, run, id, active }: { inc: any; suggest: any; run: (fn: () => Promise<any>) => Promise<any>; id: string; active: any[] }) {
  const [hospital, setHospital] = useState(inc.destination ?? '');
  const [department, setDepartment] = useState(inc.destination_department ?? '');
  const [note, setNote] = useState('');
  const limit = suggest?.limitKm ?? 5;
  const isSupervisor = ['supervisor', 'admin'].includes(session.user?.role ?? '');

  /** Giao xe; xe ngoài bán kính thì hỏi xác nhận trước (máy chủ cũng chặn nếu chưa xác nhận) */
  const assign = async (s: any) => {
    if (s.far && !confirm(`${s.vehicleId} cách hiện trường ${s.distanceKm} km, xa hơn ${limit} km.\nVẫn giao xe này?`)) return;
    await run(() => api('POST', `/api/incidents/${id}/assign`, { vehicleId: s.vehicleId, confirmFar: !!s.far }));
  };

  /** Tự kiểm tra xe rảnh và báo xe phù hợp gần nhất; xa hơn bán kính thì hỏi điều phối */
  const autoAssign = async () => {
    const r = await run(() => api('POST', `/api/incidents/${id}/auto-assign`, {}));
    if (!r) return;
    if (r.assigned) setNote(`Đã báo xe ${r.candidate.vehicleId} (cách ${r.distanceKm} km). Máy tính bảng của kíp đang đổ chuông.`);
    else if (confirm(`${r.message}`)) {
      await run(() => api('POST', `/api/incidents/${id}/assign`, { vehicleId: r.candidate.vehicleId, confirmFar: true }));
      setNote(`Đã giao xe ${r.candidate.vehicleId} (cách ${r.distanceKm} km, đã xác nhận xe xa).`);
    } else setNote(`Chưa giao: xe rảnh gần nhất ${r.candidate.vehicleId} cách ${r.distanceKm} km.`);
  };

  return (
    <div className="panel">
      <h3>4. Giao xe</h3>
      {active.map((a) => (
        <div key={a.id} className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <div><b>{a.vehicle_id}</b> <span className="small muted">giao {fmtTime(a.assigned_at)}</span> {a.acknowledged_at ? <span className="badge">Đã xác nhận {fmtTime(a.acknowledged_at)}</span> : <span className="badge" style={{ borderColor: 'var(--p1)' }}>Chưa xác nhận</span>}</div>
          <button className="ghost small" onClick={() => { const r = prompt('Lý do hủy giao xe:'); if (r) run(() => api('POST', `/api/incidents/${id}/unassign`, { vehicleId: a.vehicle_id, reason: r })); }}>Hủy</button>
        </div>
      ))}
      {suggest?.advice?.map((a: string) => <div key={a} className="alert amber small" style={{ marginBottom: 6 }}>{a}</div>)}
      {!active.length && isSupervisor && suggest?.advice?.some((a: string) => a.includes('thiếu thiết bị')) && (
        <div className="row" style={{ marginBottom: 6 }}>
          <button className="ghost small" onClick={() => {
            const vehicleId = prompt('Trưởng ca cho xe thiếu thiết bị đi. Mã xe:')?.trim();
            if (!vehicleId) return;
            const reason = prompt(`Lý do cho ${vehicleId} đi khi thiếu thiết bị (ghi vào nhật ký):`)?.trim();
            if (reason) run(() => api('POST', `/api/incidents/${id}/assign`, { vehicleId, equipmentOverride: reason, confirmFar: true }));
          }}>Trưởng ca cho xe thiếu thiết bị đi…</button>
        </div>
      )}
      {!active.length && (
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="primary" disabled={!suggest?.suggestions?.length || inc.lat == null} onClick={autoAssign}>Tự động báo xe rảnh gần nhất (≤ {limit} km)</button>
          {inc.lat == null && <span className="small muted">Cần chấm vị trí hiện trường trên bản đồ</span>}
        </div>
      )}
      {note && <div className="alert blue small" style={{ marginBottom: 6 }}>{note}</div>}
      <div className="small muted" style={{ marginBottom: 4 }}>Chỉ hiện xe đang rảnh (S1, S2) và đúng loại; xe đang bận không giao được.</div>
      <table>
        <tbody>
          {suggest?.suggestions?.slice(0, 6).map((s: any) => (
            <tr key={s.vehicleId}>
              <td><b>{s.vehicleId}</b> <span className="small muted">{s.type}</span>{s.note && <div className="small muted">{s.note}</div>}</td>
              <td className="mono small">{s.etaMin != null ? `~${s.etaMin} ph · ${s.distanceKm} km` : '—'} {s.far && <span className="badge far">xa hơn {limit} km</span>}</td>
              <td className="right"><button className={s.far ? '' : 'primary'} onClick={() => assign(s)}>Giao</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {suggest && !suggest.suggestions?.length && <div className="alert amber small">Không còn xe rảnh phù hợp. Đưa vào hàng chờ, rút xe ca thấp hơn hoặc chuyển 115.</div>}
      {suggest?.basis && <div className="small muted" style={{ marginTop: 4 }}>{suggest.basis}</div>}
      <div className="hr" />
      <div className="small muted">Bệnh viện đích và khoa nhận (kíp nhận được ngay, phiếu chuyển viện tự điền)</div>
      <HospitalPicker hospital={hospital} department={department} onChange={(h, d) => { setHospital(h); setDepartment(d); }} />
      <div className="row" style={{ marginTop: 6 }}>
        <button disabled={hospital.trim().length < 2} onClick={() => run(() => api('POST', `/api/incidents/${id}/prealert`, { hospital, department: department || null }))}>Báo trước BV</button>
        {inc.destination && <span className="small muted">Đã báo: {inc.destination}{inc.destination_department ? ` – ${inc.destination_department}` : ''}</span>}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="ghost" disabled={active.length > 0} onClick={() => { const r = prompt('Lý do chuyển ca sang 115:'); if (r) run(() => api('POST', `/api/incidents/${id}/transfer-115`, { reason: r })); }}>Chuyển 115</button>
        <button className="ghost" disabled={active.length > 0} onClick={() => { const r = prompt('Lý do đóng/hủy ca:'); if (r) run(() => api('POST', `/api/incidents/${id}/close`, { status: 'cancelled', reason: r })); }}>Hủy ca</button>
      </div>
    </div>
  );
}
