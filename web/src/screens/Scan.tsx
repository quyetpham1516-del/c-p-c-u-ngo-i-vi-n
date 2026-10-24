import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, session } from '../api';

const STATUS: Record<string, string> = { hoat_dong: 'Hoạt động', hong: 'Hỏng', bao_tri: 'Đang bảo trì', thanh_ly: 'Thanh lý' };
const SET_STATUS: Record<string, string> = { san_sang: 'Sẵn sàng', da_dung: 'Đã dùng, chờ tiệt khuẩn', dang_tiet_khuan: 'Đang tiệt khuẩn', hong: 'Hỏng' };
const EVENT: Record<string, string> = {
  nhap: 'Nhập', kiem_tra: 'Kiểm tra đầu ca', ve_sinh: 'Vệ sinh', bao_duong: 'Bảo dưỡng', kiem_dinh: 'Kiểm định', hieu_chuan: 'Hiệu chuẩn',
  bao_hong: 'Báo hỏng', sua_xong: 'Sửa xong', dieu_chuyen: 'Điều chuyển', thanh_ly: 'Thanh lý',
};
const at = (s: string) => new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const vnToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/** Ô nhập mã tem (mã QR, mã tài sản TB-xxxx, số seri, mã bộ dụng cụ); máy hỗ trợ thì quét bằng camera ngay trên trang */
export function QrLookup() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window;
  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
        while (!stop) {
          const found = await detector.detect(video.current).catch(() => []);
          if (found.length) { open(found[0].rawValue); return; }
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch { setErr('Không mở được camera. Dùng camera của điện thoại để quét tem.'); setScanning(false); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [scanning]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    // Tem chứa đường dẫn đầy đủ .../tb/<mã>; nhập tay thì là mã
    const m = v.match(/\/tb\/([^/?#\s]+)/);
    setScanning(false);
    router.push(`/tb/${encodeURIComponent(m ? m[1] : v)}`);
  };
  return (
    <div className="col" style={{ gap: 4 }}>
      <form className="row" style={{ gap: 4 }} onSubmit={(e) => { e.preventDefault(); open(code); }}>
        <input placeholder="Mã tem, TB-0001, số seri…" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 200 }} />
        <button type="submit">Mở</button>
        {canScan && <button type="button" onClick={() => { setErr(''); setScanning(!scanning); }}>{scanning ? 'Tắt camera' : 'Quét QR'}</button>}
      </form>
      {err && <span className="small error">{err}</span>}
      {scanning && <video ref={video} muted playsInline style={{ width: 260, borderRadius: 8, border: '1px solid var(--line)' }} />}
    </div>
  );
}

/** Trang mở ra khi quét tem QR dán trên thiết bị hoặc bộ dụng cụ (/tb/<mã>) */
export function Scan() {
  const { code } = useParams<{ code: string }>();
  const [target, setTarget] = useState<{ kind: string; id: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setTarget(null); setError('');
    api<{ kind: string; id: string }>('GET', `/api/qr/${encodeURIComponent(decodeURIComponent(code))}`).then(setTarget).catch((e) => setError(e.message));
  }, [code]);
  return (
    <div className="col" style={{ maxWidth: 720, margin: '0 auto', width: '100%' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Tra cứu tem QR</h2><QrLookup /></div>
      {error && <div className="alert red">{error}</div>}
      {target?.kind === 'equipment' && <EquipmentCard id={target.id} />}
      {target?.kind === 'instrument_set' && <SetCard id={target.id} />}
    </div>
  );
}

function EquipmentCard({ id }: { id: string }) {
  const role = session.user?.role ?? '';
  const canManage = ['technician', 'supervisor', 'admin'].includes(role);
  const [e, setE] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [act, setAct] = useState<string | null>(null);
  const [f, setF] = useState({ note: '', certNo: '', nextDue: '' });
  const [manual, setManual] = useState<{ manualText: string; manualUrl: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const load = async () => {
    const [x, ev] = await Promise.all([api('GET', `/api/equipment/${id}`), api<any[]>('GET', `/api/equipment/${id}/events`)]);
    setE(x); setEvents(ev);
  };
  useEffect(() => { load().catch((x) => setError(x.message)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!e) return error ? <div className="alert red">{error}</div> : null;
  const crewOk = role === 'crew' ? e.onMyVehicle : role === 'ipc';
  const actions: [string, string][] = [
    ...((canManage || crewOk) && e.status === 'hoat_dong' ? [['kiem_tra', 'Kiểm tra đầu ca: hoạt động tốt'] as [string, string]] : []),
    ...(canManage || crewOk ? [['ve_sinh', 'Ghi vệ sinh'] as [string, string], ['bao_hong', 'Báo hỏng'] as [string, string]] : []),
    ...(canManage ? [['bao_duong', 'Bảo dưỡng'], ['kiem_dinh', 'Kiểm định'], ['hieu_chuan', 'Hiệu chuẩn'], ...(e.status !== 'hoat_dong' ? [['sua_xong', 'Sửa xong']] : [])] as [string, string][] : []),
  ];
  const send = async (kind: string) => {
    setError(''); setMsg('');
    try {
      await api('POST', `/api/equipment/${id}/events`, { kind, note: f.note || null, certNo: f.certNo || null, nextDue: f.nextDue || null });
      setMsg(`Đã ghi: ${EVENT[kind]}`); setAct(null); setF({ note: '', certNo: '', nextDue: '' }); await load();
    } catch (x) { setError((x as Error).message); }
  };
  const saveManual = async () => {
    setError('');
    try { await api('PATCH', `/api/equipment/${id}`, { manualText: manual!.manualText || null, manualUrl: manual!.manualUrl || null }); setManual(null); await load(); setMsg('Đã lưu hướng dẫn sử dụng'); }
    catch (x) { setError((x as Error).message); }
  };
  const due = (label: string, v: string | null) => v && <div>{label}: <b className="mono" style={v < vnToday() ? { color: 'var(--p1)' } : undefined}>{v}</b>{v < vnToday() ? ' (quá hạn)' : ''}</div>;
  return (
    <>
      <div className="panel col" style={{ gap: 6 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div><div className="mono small muted">{e.asset_code} · SN {e.serial}</div><h3 style={{ margin: 0, textTransform: 'none', color: 'var(--text)', fontSize: 18 }}>{e.type_name}</h3>{e.model && <div className="small muted">{e.model}</div>}</div>
          <span className={`badge ${e.status !== 'hoat_dong' || e.overdue ? 'far' : ''}`} style={{ fontSize: 14 }}>{STATUS[e.status]}{e.overdue ? ', quá hạn kiểm định' : ''}</span>
        </div>
        <div className="small">Nơi đặt: <b>{e.vehicle_id ? `xe ${e.vehicle_id}` : 'kho'}</b> · {e.station_name}</div>
        <div className="small">{due('Bảo dưỡng', e.next_maintenance)}{due('Kiểm định', e.next_inspection)}{due('Hiệu chuẩn', e.next_calibration)}
          <div>Kiểm tra đầu ca gần nhất: {e.last_check ? at(e.last_check) : 'chưa có'}</div></div>
        {role === 'crew' && !e.onMyVehicle && <div className="small muted">Thiết bị không nằm trên xe bạn đang trực: chỉ xem.</div>}
      </div>
      {(e.manual_text || e.manual_url || canManage) && (
        <div className="panel col" style={{ gap: 4 }}>
          <b>Hướng dẫn sử dụng</b>
          {!manual && <>
            {e.manual_text ? <div style={{ whiteSpace: 'pre-wrap' }}>{e.manual_text}</div> : <div className="small muted">Chưa có hướng dẫn.</div>}
            {e.manual_url && <a href={e.manual_url} target="_blank" rel="noreferrer">Tài liệu hướng dẫn đầy đủ</a>}
            {canManage && <div><button className="ghost small" onClick={() => setManual({ manualText: e.manual_text ?? '', manualUrl: e.manual_url ?? '' })}>Sửa hướng dẫn</button></div>}
          </>}
          {manual && <>
            <textarea rows={5} value={manual.manualText} onChange={(x) => setManual({ ...manual, manualText: x.target.value })} placeholder="Các bước sử dụng, kiểm tra trước ca, lưu ý an toàn" />
            <input value={manual.manualUrl} onChange={(x) => setManual({ ...manual, manualUrl: x.target.value })} placeholder="Đường dẫn tài liệu (https://…)" />
            <div className="row"><button className="primary" onClick={saveManual}>Lưu</button><button className="ghost" onClick={() => setManual(null)}>Hủy</button></div>
          </>}
        </div>
      )}
      {msg && <div className="alert green">{msg}</div>}
      {error && <div className="alert red">{error}</div>}
      {actions.length > 0 && e.status !== 'thanh_ly' && (
        <div className="panel col">
          <div className="row" style={{ gap: 6 }}>{actions.map(([k, label]) => (
            <button key={k} className={`big ${k === 'kiem_tra' ? 'ok' : k === 'bao_hong' ? 'danger' : ''}`}
              onClick={() => (k === 'kiem_tra' ? send(k) : setAct(act === k ? null : k))}>{label}</button>))}</div>
          {act && (
            <div className="col">
              {['kiem_dinh', 'hieu_chuan'].includes(act) && <label className="field">Số giấy chứng nhận<input value={f.certNo} onChange={(x) => setF({ ...f, certNo: x.target.value })} /></label>}
              {['bao_duong', 'kiem_dinh', 'hieu_chuan'].includes(act) && <label className="field">Hạn kế tiếp (để trống = theo chu kỳ)<input type="date" value={f.nextDue} onChange={(x) => setF({ ...f, nextDue: x.target.value })} /></label>}
              <label className="field">{act === 'bao_hong' ? 'Mô tả hỏng hóc (bắt buộc)' : 'Ghi chú'}<textarea rows={2} value={f.note} onChange={(x) => setF({ ...f, note: x.target.value })} /></label>
              <div className="row"><button className="primary" onClick={() => send(act)}>Ghi {EVENT[act].toLowerCase()}</button></div>
            </div>
          )}
        </div>
      )}
      <div className="panel">
        <b>Lịch sử</b>
        <table style={{ marginTop: 6 }}><tbody>{events.slice(0, 30).map((x) => (
          <tr key={x.id}><td className="small mono">{at(x.at)}</td><td>{EVENT[x.kind] ?? x.kind}</td><td className="small">{x.note}{x.cert_no ? ` · GCN ${x.cert_no}` : ''}{x.next_due ? ` · hạn kế tiếp ${x.next_due}` : ''}</td><td className="small muted">{x.user_name}</td></tr>))}
          {!events.length && <tr><td className="small muted">Chưa có.</td></tr>}</tbody></table>
      </div>
    </>
  );
}

function SetCard({ id }: { id: string }) {
  const role = session.user?.role ?? '';
  const [s, setS] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const load = () => api('GET', `/api/instrument-sets/${id}`).then(setS);
  useEffect(() => { load().catch((x) => setError(x.message)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return error ? <div className="alert red">{error}</div> : null;
  const canUse = s.status === 'san_sang' && !s.sterile_expired && (role === 'crew' ? s.onMyVehicle : ['ipc', 'technician', 'supervisor', 'admin'].includes(role));
  const used = async () => {
    setError(''); setMsg('');
    try { await api('POST', `/api/instrument-sets/${id}/used`, {}); setMsg('Đã ghi bộ dụng cụ đã dùng; bộ chuyển sang chờ tiệt khuẩn.'); await load(); }
    catch (x) { setError((x as Error).message); }
  };
  return (
    <>
      <div className="panel col" style={{ gap: 6 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div><div className="mono small muted">{s.code}</div><h3 style={{ margin: 0, textTransform: 'none', color: 'var(--text)', fontSize: 18 }}>{s.name}</h3></div>
          <span className={`badge ${s.status !== 'san_sang' || s.sterile_expired ? 'far' : ''}`} style={{ fontSize: 14 }}>{SET_STATUS[s.status]}{s.sterile_expired ? ', hết hạn vô khuẩn' : ''}</span>
        </div>
        <div className="small">Nơi đặt: <b>{s.vehicle_id ? `xe ${s.vehicle_id}` : 'kho'}</b> · {s.station_name}</div>
        <div className="small">Hạn vô khuẩn: <b className="mono">{s.sterile_until ?? '—'}</b> · đã tiệt khuẩn {s.cycles} lần{s.last_incident_code ? ` · dùng gần nhất cho ca ${s.last_incident_code}` : ''}</div>
      </div>
      {msg && <div className="alert green">{msg}</div>}
      {error && <div className="alert red">{error}</div>}
      {canUse && <button className="big" onClick={used}>Đã dùng bộ này</button>}
      {s.status === 'san_sang' && s.sterile_expired && <div className="alert amber">Bộ đã hết hạn vô khuẩn: không dùng, chuyển tiệt khuẩn lại.</div>}
    </>
  );
}
