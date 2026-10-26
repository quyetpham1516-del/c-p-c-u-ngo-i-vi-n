import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtDuration, INFECTION_RISK, fmtTime, PRIORITY_LABEL, STATUS_LABEL, useLive, useNow } from '../api';
import { ParSheet } from '../components/ParSheet';
import { MciReport } from '../components/MciReport';
import { EpcrForm } from '../components/EpcrForm';
import { CrewSos } from '../components/Sos';
import { FLAG_LABEL } from '../components/Triage';
import { startAlarm, unlockAudio } from '../alarm';
import { allDrafts, loadDraft, saveDraft, startBackgroundSync, type Draft } from '../offline';

/** Các bước trên máy tính bảng; mỗi nút ghi một mốc thời gian (mục 5.2) */
const STEPS: { key: string; label: string; status?: string; milestone?: string; from: string[] }[] = [
  { key: 'S4', label: 'Xuất phát', status: 'S4', from: ['S3'] },
  { key: 'S5', label: 'Tới hiện trường', status: 'S5', from: ['S4'] },
  { key: 'T8', label: 'Tới bên người bệnh', milestone: 'T8', from: ['S5'] },
  { key: 'S6', label: 'Rời hiện trường, vận chuyển', status: 'S6', from: ['S5'] },
  { key: 'S7', label: 'Tới bệnh viện', status: 'S7', from: ['S6'] },
  { key: 'T13', label: 'Bàn giao xong', milestone: 'T13', from: ['S7'] },
  { key: 'S8', label: 'Bổ sung, khử khuẩn', status: 'S8', from: ['S5', 'S7'] },
  { key: 'S1', label: 'Sẵn sàng tại trạm', status: 'S1', from: ['S3', 'S4', 'S5', 'S6', 'S7', 'S8'] },
  { key: 'S2', label: 'Sẵn sàng ngoài trạm', status: 'S2', from: ['S3', 'S4', 'S5', 'S6', 'S7', 'S8'] },
];

export function Crew() {
  const [cur, setCur] = useState<any>(null);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [shiftForm, setShiftForm] = useState({ vehicleId: '', crewRole: '' });
  /** Vai trò trong kíp theo danh mục quản trị; người được quy định vai trò chỉ thấy các vai trò đó */
  const [crewRoles, setCrewRoles] = useState<string[]>([]);
  useEffect(() => {
    api<{ name: string }[]>('GET', '/api/crew-roles?mine=1').then((r) => {
      const names = r.map((x) => x.name);
      setCrewRoles(names);
      setShiftForm((f) => (names.includes(f.crewRole) ? f : { ...f, crewRole: names[0] ?? '' }));
    }).catch(() => {});
  }, []);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const now = useNow();
  const lastSent = useRef(0);

  const load = useCallback(async () => {
    try {
      const c = await api('GET', '/api/crew/current');
      setCur(c);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    load();
    startBackgroundSync();
    allDrafts().then(setDrafts);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    document.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); document.removeEventListener('pointerdown', unlockAudio); };
  }, [load]);

  // Lệnh mới chưa xác nhận: chuông + rung + thông báo lặp lại cho tới khi kíp bấm "Xác nhận lệnh"
  const pendingOrder = cur?.incident && !cur.incident.acknowledged ? cur.incident : null;
  useEffect(() => {
    if (!pendingOrder) return;
    return startAlarm(`Lệnh mới ${pendingOrder.priority}: ${pendingOrder.code}`, pendingOrder.address ?? 'Mở ứng dụng kíp để xác nhận');
  }, [pendingOrder?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (cur && !cur.shift) api('GET', '/api/crew/vehicles').then(setVehicles).catch(() => setVehicles([]));
  }, [cur]);

  useLive((e) => {
    if (!cur?.vehicle) return;
    if ((e.type === 'vehicle' && e.id === cur.vehicle.id) || (e.type === 'incident' && e.id === cur.incident?.id) || e.type === 'reconnected') load();
    if (e.type === 'incident' && !cur.incident) load();
  });

  // GPS: 5 giây/lần khi làm nhiệm vụ, 30 giây/lần khi trực (mục 6.1)
  useEffect(() => {
    if (!cur?.vehicle || !('geolocation' in navigator)) return;
    const onMission = !['S1', 'S2', 'S9'].includes(cur.vehicle.status);
    const every = onMission ? 5_000 : 30_000;
    const id = navigator.geolocation.watchPosition((p) => {
      if (Date.now() - lastSent.current < every) return;
      lastSent.current = Date.now();
      api('POST', `/api/vehicles/${cur.vehicle.id}/location`, {
        lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? null,
        speed: p.coords.speed != null && p.coords.speed >= 0 ? Math.round(p.coords.speed * 3.6) : null,
      }).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [cur?.vehicle?.id, cur?.vehicle?.status]);

  const act = async (fn: () => Promise<any>) => {
    setError('');
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };

  const openDraft = async (id: string, fallback?: Partial<Draft>) => {
    let d = await loadDraft(id);
    if (!d) {
      if (fallback?.number) {
        // Phiếu đã có trên máy chủ (tạo từ máy khác): tải về để xem
        const t = await api('GET', `/api/transfers/${id}`);
        d = { id, incidentId: t.incident_id, vehicleId: t.vehicle_id, patientId: t.patient_id, patientLabel: t.ba_number ? `${t.ba_number} · ${t.patient_name ?? ''}` : null,
          epcr: t.epcr, baseVersion: t.version, dirty: false, status: t.status, number: t.transfer_number, updatedAt: t.updated_at, syncedAt: t.updated_at };
        await saveDraft(d);
      } else return;
    }
    setDraft(d);
  };

  const newDraft = async () => {
    const inc = cur?.incident;
    const d: Draft = {
      id: crypto.randomUUID(), incidentId: inc?.id ?? null, vehicleId: cur?.vehicle?.id ?? null, patientId: null, patientLabel: null,
      epcr: {
        scene: { address: inc?.address ?? undefined },
        caller: { name: inc?.callerName ?? undefined, phone: inc?.callbackPhone ?? undefined },
        chiefComplaint: inc?.complaint ?? undefined,
        dispatch: { from115: inc?.source === '115' || undefined, firstAidGuided: inc ? true : undefined },
        // Bệnh viện, khoa điều phối đã báo trước: điền sẵn "Kính gửi" và "Đơn vị nhận bệnh"
        kinhGui: inc?.destination ?? undefined,
        disposition: {
          hospital: inc?.destination ?? undefined, department: inc?.destinationDepartment ?? undefined,
          toUnit: inc?.destination ? (inc.destinationDepartment ? `${inc.destinationDepartment} – ${inc.destination}` : inc.destination) : undefined,
          fromUnit: 'Medone' + (cur?.vehicle?.id ? ` – xe ${cur.vehicle.id}` : ''),
        },
        vitals: [], interventions: [], medications: [],
      },
      baseVersion: 0, dirty: true, status: 'draft', updatedAt: new Date().toISOString(),
    };
    await saveDraft(d);
    setDraft(d);
    setDrafts(await allDrafts());
    return d;
  };

  // Tới hiện trường (S5) trở đi: phiếu của ca tự mở (tạo mới nếu chưa có), xổ ra ở phần ABCDE, thuốc, can thiệp
  const autoOpened = useRef<string | null>(null);
  const curInc = cur?.incident;
  const curStatus = cur?.vehicle?.status;
  useEffect(() => {
    if (!curInc || !['S5', 'S6', 'S7'].includes(curStatus) || autoOpened.current === `inc:${curInc.id}`) return;
    (async () => {
      const local = (await allDrafts()).find((x) => x.incidentId === curInc.id && x.status !== 'signed');
      const server = curInc.transfers?.find((t: any) => t.status !== 'signed');
      autoOpened.current = `inc:${curInc.id}`;
      if (local) { autoOpened.current = local.id; setDraft(local); }
      else if (server) { autoOpened.current = server.id; await openDraft(server.id, { number: server.transfer_number }); }
      else if (!curInc.transfers?.length) { const d = await newDraft(); autoOpened.current = d.id; setDraft({ ...d }); }
    })().catch(() => {});
  }, [curInc?.id, curStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cur) return <div className="crew panel">{error || 'Đang tải…'}</div>;

  if (!cur.shift) {
    return (
      <div className="crew col">
        <div className="panel col">
          <h2>Đăng nhập ca trên xe</h2>
          <label className="field">Xe
            <select value={shiftForm.vehicleId} onChange={(e) => setShiftForm({ ...shiftForm, vehicleId: e.target.value })}>
              <option value="">— Chọn xe —</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.id} · {v.type}</option>)}
            </select>
          </label>
          <label className="field">Vai trò trên xe
            <select value={shiftForm.crewRole} onChange={(e) => setShiftForm({ ...shiftForm, crewRole: e.target.value })}>
              {crewRoles.map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
          {error && <div className="error">{error}</div>}
          <button className="primary big" disabled={!shiftForm.vehicleId || !shiftForm.crewRole} onClick={() => { unlockAudio(); act(async () => {
            const r = await api<{ warnings?: string[] }>('POST', '/api/crew/shift', shiftForm);
            if (r.warnings?.length) alert(`Đã nhận ca. Lưu ý hồ sơ: ${r.warnings.join('; ')}`);
          }); }}>Bắt đầu ca</button>
        </div>
        <OfflineDrafts drafts={drafts} onOpen={(d) => openDraft(d.id)} />
        {draft && <EpcrForm key={draft.id} draft={draft} onChange={() => allDrafts().then(setDrafts)} />}
      </div>
    );
  }

  const v = cur.vehicle;
  const inc = cur.incident;
  const doneTimes = new Set((inc?.times ?? []).map((t: any) => t.code));
  const atScene = ['S5', 'S6', 'S7', 'S8'].includes(v.status);

  return (
    <div className="crew col">
      {typeof window !== 'undefined' && !window.isSecureContext && (
        <SecureHint />
      )}
      <CrewSos />
      {!online && <div className="alert amber">Mất mạng: ePCR vẫn lưu trên máy và tự đồng bộ khi có mạng lại. Nút trạng thái cần mạng; dùng bộ đàm báo EOC.</div>}
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>{v.id} <span className="small muted">{v.type_label}</span></h2>
            <div><span className={`st ${v.status}`}>{v.status}</span> {STATUS_LABEL[v.status]} · {fmtDuration(now - new Date(v.status_since).getTime())}</div>
            <div className="small muted">{v.crew.map((c: any) => `${c.name} (${c.role})`).join(', ')}</div>
          </div>
          <button className="ghost" onClick={() => act(() => api('DELETE', '/api/crew/shift'))}>Kết thúc ca</button>
        </div>
      </div>

      {inc && !inc.acknowledged && (
        <div className="alert red order-alarm" role="alert">
          <b>LỆNH MỚI {inc.priority} · {inc.code}</b> {inc.address ?? ''}
          <button className="danger big" style={{ marginLeft: 12 }} onClick={() => act(() => api('POST', '/api/crew/ack'))}>Xác nhận lệnh</button>
        </div>
      )}
      {inc && (
        <div className="panel sticky-status">
          <div className="row small" style={{ justifyContent: 'space-between' }}>
            <span><span className={`st ${v.status}`}>{v.status}</span> {STATUS_LABEL[v.status]} · {fmtDuration(now - new Date(v.status_since).getTime())}</span>
            <span className="mono">{inc.code} · {inc.priority}</span>
          </div>
          <div className="status-grid" style={{ marginTop: 6 }}>
            {STEPS.filter((s) => s.from.includes(v.status)).map((s, i) => {
              const done = s.milestone ? doneTimes.has(s.milestone) : false;
              return (
                <button key={s.key} className={i === 0 && !done ? 'next' : ''} disabled={done}
                  onClick={() => act(() => (s.status ? api('POST', `/api/vehicles/${v.id}/status`, { status: s.status }) : api('POST', '/api/crew/milestone', { code: s.milestone })))}>
                  {s.label}{done ? ' ✓' : ''}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {inc ? (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="row">
              <span className={`big-prio prio ${inc.priority}`}>{inc.priority}</span>
              <div>
                <div className="mono"><b>{inc.code}</b></div>
                <div className="small">{PRIORITY_LABEL[inc.priority]} · {inc.lights ? 'Đèn, còi' : 'Không đèn còi'}</div>
              </div>
            </div>
            {!inc.acknowledged && <button className="danger big" onClick={() => act(() => api('POST', '/api/crew/ack'))}>Xác nhận lệnh</button>}
          </div>
          <div className="hr" />
          <div className="grid2">
            <div><div className="small muted">Địa chỉ</div><b>{inc.address ?? '—'}</b>{inc.addressNote && <div className="small">{inc.addressNote}</div>}</div>
            <div><div className="small muted">Số gọi lại</div>{inc.callbackPhone ? <a href={`tel:${inc.callbackPhone}`}><b>{inc.callbackPhone}</b></a> : '—'}</div>
            <div><div className="small muted">Tình trạng</div>{[inc.complaint, ...(inc.flags ?? []).map((f: string) => FLAG_LABEL[f] ?? f)].filter(Boolean).join(', ') || '—'} · {inc.patientCount} người</div>
            <div><div className="small muted">Bệnh viện đích</div>{inc.destination ?? '—'}{inc.destinationDepartment && <div className="small">{inc.destinationDepartment}</div>}</div>
          </div>
          {inc.lat != null && (
            <a className="btn" style={{ marginTop: 8 }} target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${inc.lat},${inc.lng}`}>Dẫn đường</a>
          )}
          {inc.notes && <div className="alert blue small" style={{ marginTop: 8 }}>{inc.notes}</div>}
          <a className="btn ghost" style={{ marginTop: 8 }} href={`/van-hanh?tab=${encodeURIComponent('Đông nạn nhân')}&ca=${inc.id}`}>Ghi nạn nhân (đông nạn nhân)</a>
          <label className="field" style={{ marginTop: 8, maxWidth: 360 }}>Nguy cơ lây nhiễm (quyết định mức khử khuẩn sau ca)
            <select value={inc.infectionRisk ?? ''} onChange={(e) => act(() => api('POST', '/api/crew/infection', { risk: e.target.value || null }))}>
              <option value="">Không nghi lây nhiễm</option>
              {Object.entries(INFECTION_RISK).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <div className="times" style={{ marginTop: 10 }}>
            {inc.times.sort((a: any, b: any) => a.at.localeCompare(b.at)).map((t: any) => <div key={t.code} className="done"><b>{t.code}</b><span className="mono">{fmtTime(t.at)}</span></div>)}
          </div>
        </div>
      ) : (
        <div className="panel">
          <div className="muted">Chưa có lệnh. Màn hình tự cập nhật khi EOC giao xe.</div>
          <div className="status-grid" style={{ marginTop: 10 }}>
            <button onClick={() => act(() => api('POST', `/api/vehicles/${v.id}/status`, { status: 'S1' }))} disabled={v.status === 'S1'}>Sẵn sàng tại trạm</button>
            <button onClick={() => act(() => api('POST', `/api/vehicles/${v.id}/status`, { status: 'S2' }))} disabled={v.status === 'S2'}>Sẵn sàng ngoài trạm</button>
            <button onClick={() => act(() => api('POST', `/api/vehicles/${v.id}/status`, { status: 'S8' }))} disabled={v.status === 'S8'}>Bổ sung, khử khuẩn</button>
            <button onClick={() => act(() => api('POST', `/api/vehicles/${v.id}/status`, { status: 'S9' }))} disabled={v.status === 'S9'}>Ngoài hoạt động</button>
          </div>
          <Odometer vehicleId={v.id} />
        </div>
      )}

      {!['S1', 'S2', 'S9'].includes(v.status) && (
        <div className="row">
          <button onClick={() => act(() => api('POST', `/api/vehicles/${v.id}/free-hint`, { minutes: 5 }))}>Báo EOC: rảnh trong 5 phút</button>
        </div>
      )}
      <div className="row">
        <span className="small">Cơ số: {v.supplies_ok ? 'Đủ' : `Thiếu ${v.supplies_note ?? ''}`}</span>
        <button className="ghost small" onClick={() => {
          const note = prompt('Thiếu vật tư gì? (để trống nếu đã đủ)');
          if (note !== null) act(() => api('POST', `/api/vehicles/${v.id}/supplies`, { ok: !note.trim(), note: note.trim() || null }));
        }}>Cập nhật cơ số</button>
      </div>
      {v.equipment_gaps && <div className="alert red">Xe đang thiếu thiết bị bắt buộc nên EOC không giao được: {v.equipment_gaps}. Báo kỹ thuật hoặc trưởng ca.</div>}
      {inc && ['S4', 'S5', 'S6', 'S7', 'S8'].includes(v.status) && <MciReport incidentId={inc.id} />}
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Phiếu chuyển viện (ePCR)</h2>
          {inc && atScene && <button onClick={newDraft}>+ Phiếu cho người bệnh khác</button>}
        </div>
        {inc && !atScene && (
          <div className="col small" style={{ marginTop: 8 }}>
            <div className="muted">Phiếu tự mở khi bấm <b>Tới hiện trường</b>. Thông tin tổng đài viên đã nhập sẽ được điền sẵn:</div>
            <div className="grid2">
              <div>Người gọi: <b>{inc.callerName ?? '—'}</b> · {inc.callbackPhone ?? '—'}</div>
              <div>Địa chỉ: <b>{inc.address ?? '—'}</b></div>
              <div>Lý do gọi: <b>{inc.complaint ?? '—'}</b>{inc.flags?.length ? ` (${inc.flags.map((f: string) => FLAG_LABEL[f] ?? f).join(', ')})` : ''}</div>
              <div>Ưu tiên: <b>{inc.priority}</b> · {inc.patientCount} người bệnh{inc.destination ? ` · BV dự kiến: ${inc.destination}` : ''}</div>
            </div>
          </div>
        )}
        {!inc && <div className="small muted" style={{ marginTop: 8 }}>Phiếu chỉ mở khi có ca bệnh và kíp đã tới hiện trường. Phiếu còn dở của các ca trước ở dưới.</div>}
        {inc && atScene && (
          <div className="list" style={{ marginTop: 8 }}>
            {inc.transfers?.map((t: any) => (
              <div key={t.id} className="item row" style={{ justifyContent: 'space-between' }} onClick={() => openDraft(t.id, { number: t.transfer_number })}>
                <span><b>{t.transfer_number}</b> {t.status === 'signed' ? '· đã ký' : '· nháp'}</span><span className="small muted">Mở</span>
              </div>
            ))}
          </div>
        )}
        <OfflineDrafts drafts={drafts.filter((d) => !inc?.transfers?.some((t: any) => t.id === d.id) && d.id !== draft?.id)} onOpen={(d) => openDraft(d.id)} />
      </div>
      {draft && <EpcrForm key={draft.id} draft={draft} initialTab={autoOpened.current === draft.id ? 'ABCDE và can thiệp' : undefined} onChange={() => allDrafts().then(setDrafts)} />}
      <VehicleKit vehicleId={v.id} incidentId={inc?.id ?? null} act={act} />
      <Disinfection vehicleId={v.id} status={v.status} refreshKey={error} />
      {error && <div className="error">{error}</div>}

    </div>
  );
}

/** Cơ số thuốc, thiết bị và bộ dụng cụ trên xe: kíp bù cơ số đầu ca, báo hỏng thiết bị, báo đã dùng bộ dụng cụ */
function VehicleKit({ vehicleId, incidentId, act }: { vehicleId: string; incidentId: string | null; act: (fn: () => Promise<any>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [par, setPar] = useState<any>(null);
  const [eq, setEq] = useState<any[]>([]);
  const [sets, setSets] = useState<any[]>([]);
  const load = useCallback(async () => {
    const q = encodeURIComponent(vehicleId);
    const [p, e, s] = await Promise.all([
      api('GET', `/api/stock/vehicle/${q}/par`), api<any[]>('GET', `/api/equipment?vehicleId=${q}`), api<any[]>('GET', `/api/instrument-sets?vehicleId=${q}`),
    ]);
    setPar(p); setEq(e); setSets(s);
  }, [vehicleId]);
  useEffect(() => { load().catch(() => {}); }, [load]);
  const short = par?.items?.filter((i: any) => i.missing > 0) ?? [];
  const restock = () => {
    const needWitness = short.some((i: any) => i.controlled);
    const witness = needWitness ? prompt('Có thuốc kiểm soát đặc biệt cần bù. Người chứng kiến:') : null;
    if (needWitness && !witness?.trim()) return;
    act(async () => {
      const r = await api('POST', `/api/stock/vehicle/${encodeURIComponent(vehicleId)}/restock`, { witness });
      await load();
      if (r.unfilled?.length) alert(`Kho điểm không đủ: ${r.unfilled.map((u: any) => `${u.drug} thiếu ${u.missing}`).join('; ')}. Báo kho.`);
    });
  };
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Cơ số thuốc, thiết bị, dụng cụ trên xe</b>
        <span className="row">
          {short.length > 0 ? <span className="badge far">Thiếu {short.length} mặt hàng</span> : par && <span className="badge">Đủ cơ số</span>}
          <button className="ghost small" onClick={() => setOpen(!open)}>{open ? 'Thu gọn' : 'Xem'}</button>
        </span>
      </div>
      {open && (
        <div className="col" style={{ marginTop: 8 }}>
          <div><button className="primary" disabled={!short.length} onClick={restock}>Bù cơ số từ kho điểm</button></div>
          <ParSheet items={par?.items ?? []} />
          <div className="small muted">Kiểm tra đầu ca: quét tem QR trên từng thiết bị bằng camera điện thoại (hoặc bấm tên thiết bị) rồi bấm "Kiểm tra đầu ca".</div>
          <table><tbody>{eq.map((e) => (
            <tr key={e.id}><td><a href={`/tb/${e.qr_code}`}>{e.type_name}</a><div className="small muted mono">{e.asset_code} · {e.serial}</div></td>
              <td>{e.status === 'hoat_dong' && !e.overdue ? <span className="badge">Hoạt động</span> : <span className="badge far">{e.status === 'hong' ? 'Hỏng' : e.overdue ? 'Quá hạn kiểm định' : e.status}</span>}</td>
              <td className="right">{e.status === 'hoat_dong' && <button className="ghost small" onClick={() => {
                const note = prompt(`Mô tả hỏng hóc của ${e.type_name} (${e.serial}):`);
                if (note?.trim()) act(async () => { await api('POST', `/api/equipment/${e.id}/events`, { kind: 'bao_hong', note }); await load(); });
              }}>Báo hỏng</button>}</td></tr>
          ))}</tbody></table>
          {sets.length > 0 && <table><tbody>{sets.map((s) => (
            <tr key={s.id}><td>{s.name}<div className="small muted mono">{s.code}</div></td>
              <td>{s.status === 'san_sang' && !s.sterile_expired ? <span className="badge">Sẵn sàng · HSD {s.sterile_until}</span> : <span className="badge far">{s.sterile_expired ? 'Hết hạn vô khuẩn' : s.status === 'da_dung' ? 'Chờ tiệt khuẩn' : s.status}</span>}</td>
              <td className="right">{s.status === 'san_sang' && <button className="ghost small" onClick={() => act(async () => {
                await api('POST', `/api/instrument-sets/${s.id}/used`, { incidentId }); await load();
              })}>Đã dùng</button>}</td></tr>
          ))}</tbody></table>}
        </div>
      )}
    </div>
  );
}

/** Phiếu khử khuẩn xe sau ca (KSNK-01): xe chưa ký phiếu đủ mức thì không báo sẵn sàng được */
function Disinfection({ vehicleId, status, refreshKey }: { vehicleId: string; status: string; refreshKey: string }) {
  const [meta, setMeta] = useState<{ levels: Record<string, string>; steps: Record<string, [string, string][]> } | null>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [form, setForm] = useState<{ incidentId: string | null; level: string; checklist: Record<string, boolean>; chemical: string; concentration: string; contactMinutes: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api<any[]>('GET', `/api/ipc/disinfections?status=cho_lam&vehicleId=${encodeURIComponent(vehicleId)}`).then(setPending).catch(() => {});
  }, [vehicleId]);
  useEffect(() => { api('GET', '/api/ipc/meta').then(setMeta).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, status, refreshKey]);
  const order = ['thuong_quy', 'tang_cuong', 'toan_dien'];
  const steps = form && meta ? order.slice(0, order.indexOf(form.level) + 1).flatMap((l) => meta.steps[l]) : [];
  const start = (incidentId: string | null, level: string) => { setMsg(''); setErr(''); setForm({ incidentId, level, checklist: {}, chemical: '', concentration: '', contactMinutes: '' }); };
  const sign = async () => {
    if (!form) return;
    setErr('');
    try {
      await api('POST', '/api/ipc/disinfections', {
        vehicleId, incidentId: form.incidentId, level: form.level, checklist: form.checklist, chemical: form.chemical,
        concentration: form.concentration || null, contactMinutes: form.contactMinutes ? Number(form.contactMinutes) : null,
      });
      setForm(null); setMsg('Đã ký phiếu khử khuẩn. Có thể báo xe sẵn sàng.'); load();
    } catch (e) { setErr((e as Error).message); }
  };
  if (!meta) return null;
  return (
    <div className="panel col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Khử khuẩn xe</b>
        {!form && <button className="ghost small" onClick={() => start(null, 'thuong_quy')}>Ghi khử khuẩn thường quy</button>}
      </div>
      {pending.map((d) => (
        <div key={d.id} className="alert red row" style={{ justifyContent: 'space-between' }}>
          <span>Ca {d.incident_code ?? '—'} cần khử khuẩn mức <b>{meta.levels[d.required_level]}</b> trước khi báo sẵn sàng.</span>
          {!form && <button className="primary small" onClick={() => start(d.incident_id, d.required_level)}>Làm phiếu</button>}
        </div>
      ))}
      {msg && <div className="alert green small">{msg}</div>}
      {form && (
        <div className="col">
          <label className="field">Mức<select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
            {order.map((l) => <option key={l} value={l}>{meta.levels[l]}</option>)}</select></label>
          {steps.map(([k, label]) => (
            <label key={k} className="row small"><input type="checkbox" checked={!!form.checklist[k]} onChange={(e) => setForm({ ...form, checklist: { ...form.checklist, [k]: e.target.checked } })} /> {label}</label>
          ))}
          <div className="grid3">
            <label className="field">Hóa chất<input value={form.chemical} onChange={(e) => setForm({ ...form, chemical: e.target.value })} placeholder="Cloramin B, Presept..." /></label>
            <label className="field">Nồng độ<input value={form.concentration} onChange={(e) => setForm({ ...form, concentration: e.target.value })} placeholder="0,5%" /></label>
            <label className="field">Thời gian tiếp xúc (phút)<input type="number" min={0} value={form.contactMinutes} onChange={(e) => setForm({ ...form, contactMinutes: e.target.value })} /></label>
          </div>
          {err && <div className="error">{err}</div>}
          <div className="row">
            <button className="primary" disabled={form.chemical.trim().length < 2 || steps.some(([k]) => !form.checklist[k])} onClick={sign}>Ký phiếu khử khuẩn</button>
            <button className="ghost" onClick={() => setForm(null)}>Hủy</button>
          </div>
        </div>
      )}
    </div>
  );
}

function OfflineDrafts({ drafts, onOpen }: { drafts: Draft[]; onOpen: (d: Draft) => void }) {
  if (!drafts.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small muted">Phiếu trên máy này</div>
      <div className="list">
        {drafts.slice(0, 10).map((d) => (
          <div key={d.id} className="item row" style={{ justifyContent: 'space-between' }} onClick={() => onOpen(d)}>
            <span><b>{d.number ?? 'Chưa cấp số'}</b> · {d.epcr?.patient?.fullName ?? d.patientLabel ?? 'Chưa rõ tên'} · {d.status === 'signed' ? 'đã ký' : 'nháp'}</span>
            <span className="small">{d.dirty ? <span style={{ color: 'var(--warn)' }}>chờ đồng bộ</span> : <span style={{ color: 'var(--ok)' }}>đã đồng bộ</span>}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Kíp ghi số km đồng hồ và đổ nhiên liệu, dùng để tính hạn bảo dưỡng theo km */
function Odometer({ vehicleId }: { vehicleId: string }) {
  const [f, setF] = useState<{ km: string; fuelLiters: string; fuelCost: string; note: string } | null>(null);
  const [msg, setMsg] = useState('');
  if (!f) return <div className="row" style={{ marginTop: 10 }}><button className="ghost" onClick={() => { setMsg(''); setF({ km: '', fuelLiters: '', fuelCost: '', note: '' }); }}>Ghi số km, đổ nhiên liệu</button>{msg && <span className="small">{msg}</span>}</div>;
  const n = (s: string) => (s ? Number(s.replace(/[^\d.]/g, '')) : null);
  return (
    <div className="grid2" style={{ marginTop: 10 }}>
      <label className="field">Số km đồng hồ<input inputMode="numeric" value={f.km} onChange={(e) => setF({ ...f, km: e.target.value.replace(/\D/g, '') })} /></label>
      <label className="field">Nhiên liệu (lít)<input inputMode="decimal" value={f.fuelLiters} onChange={(e) => setF({ ...f, fuelLiters: e.target.value })} /></label>
      <label className="field">Tiền nhiên liệu (đồng)<input inputMode="numeric" value={f.fuelCost} onChange={(e) => setF({ ...f, fuelCost: e.target.value.replace(/\D/g, '') })} /></label>
      <label className="field">Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Bắt buộc nếu tăng quá 3.000 km" /></label>
      <div className="row">
        {msg && <span className="small" style={{ color: 'var(--p1)' }}>{msg}</span>}
        <button className="primary" disabled={!f.km} onClick={async () => {
          try {
            await api('POST', `/api/ops/fleet/${vehicleId}/odometer`, { km: Number(f.km), fuelLiters: n(f.fuelLiters), fuelCost: n(f.fuelCost), note: f.note || null });
            setF(null); setMsg('Đã ghi số km');
          } catch (e) { setMsg((e as Error).message); }
        }}>Lưu</button>
        <button className="ghost" onClick={() => setF(null)}>Bỏ</button>
      </div>
    </div>
  );
}

/** Trang mở bằng http qua mạng: trình duyệt không cho lấy GPS. Chỉ đường sang địa chỉ https nếu máy chủ đã bật */
function SecureHint() {
  const [s, setS] = useState<{ httpsUrl: string | null; certHelpUrl: string | null } | null>(null);
  useEffect(() => { api<any>('GET', '/api/ops/server-name').then(setS).catch(() => {}); }, []);
  return (
    <div className="alert amber">
      Trình duyệt không cho lấy GPS khi mở trang bằng http qua mạng: xe sẽ không có lộ trình.
      {s?.httpsUrl ? <> Mở bằng <a href={`${s.httpsUrl}/kip`}>{s.httpsUrl}</a> (đăng nhập lại một lần). Máy chưa cài chứng chỉ thì làm theo <a href={s.certHelpUrl ?? '#'}>hướng dẫn cài chứng chỉ</a> trước.</> : ' Cần mở bằng địa chỉ https của trung tâm.'}
    </div>
  );
}
