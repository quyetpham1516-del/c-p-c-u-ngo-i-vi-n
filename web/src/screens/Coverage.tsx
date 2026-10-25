import L from 'leaflet';
import { useEffect, useMemo, useState } from 'react';
import { CircleMarker, MapContainer, Marker, Rectangle, TileLayer, Tooltip } from 'react-leaflet';
import { api, VEHICLE_LABEL } from '../api';
import { DEFAULT_CENTER } from '../components/MapView';

const TILE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const css = (v: string, fb: string) => (typeof window === 'undefined' ? fb : getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fb);
const pinIcon = (n: number) => L.divIcon({
  className: '',
  html: `<div style="width:26px;height:26px;border-radius:50%;background:#2563eb;color:#fff;border:3px solid #fff;box-shadow:0 1px 4px #0008;font:700 13px/20px system-ui;text-align:center">${n}</div>`,
  iconSize: [26, 26], iconAnchor: [13, 13],
});
const stationIcon = L.divIcon({
  className: '',
  html: '<div style="width:14px;height:14px;background:#334155;border:2px solid #fff;box-shadow:0 1px 3px #0008"></div>',
  iconSize: [14, 14], iconAnchor: [7, 7],
});

/** Bản đồ vùng phủ (mục 12.5, 12.7): ô nào xe tới kịp trong chỉ tiêu, ô nào bị hở, ca thật nằm ở đâu, nên đặt thêm xe ở đâu */
export function Coverage() {
  const [meta, setMeta] = useState<any>(null);
  const [f, setF] = useState({ scenario: 'hien_tai', group: 'cap_cuu', target: 15, days: 90, priorities: 'tat_ca' });
  const [exclude, setExclude] = useState<string[]>([]);
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('GET', '/api/coverage/meta').then(setMeta).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    setBusy(true);
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)])), exclude: exclude.join(',') });
    api('GET', `/api/coverage?${qs}`).then((r) => { setD(r); setError(''); }).catch((e) => setError(e.message)).finally(() => setBusy(false));
  }, [f, exclude.join(',')]);

  const colors = useMemo(() => ({ ok: css('--ok', '#1d8a4a'), warn: css('--p2', '#e46c0a'), bad: css('--p1', '#d0201b'), none: '#7a8796' }), []);
  const colorOf = (m: number | null) => m == null ? colors.none : m <= f.target ? colors.ok : m <= f.target * 1.5 ? colors.warn : colors.bad;
  const s = d?.summary;
  const center: [number, number] = d?.area ? [(d.area.south + d.area.north) / 2, (d.area.west + d.area.east) / 2] : DEFAULT_CENTER;
  const toggle = (id: string) => setExclude(exclude.includes(id) ? exclude.filter((x) => x !== id) : [...exclude, id]);

  return (
    <div className="col">
      <div className="row"><h2 style={{ margin: 0 }}>Vùng phủ</h2>{busy && <span className="small muted">Đang tính…</span>}</div>
      {error && <div className="error">{error}</div>}
      {meta && <div className="panel row" style={{ flexWrap: 'wrap' }}>
        <select value={f.scenario} onChange={(e) => setF({ ...f, scenario: e.target.value })}>
          {Object.entries(meta.scenarios).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}
        </select>
        <select value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })}>
          {Object.entries(meta.groups).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}
        </select>
        <label className="row small">Chỉ tiêu tới nơi
          <select value={f.target} onChange={(e) => setF({ ...f, target: Number(e.target.value) })}>
            {[8, 10, 12, 15, 20, 30].map((m) => <option key={m} value={m}>{m} phút</option>)}
          </select>
        </label>
        <label className="row small">Nhu cầu
          <select value={f.priorities} onChange={(e) => setF({ ...f, priorities: e.target.value })}>
            {Object.entries(meta.priorities).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}
          </select>
          <select value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })}>
            {[30, 90, 180, 365].map((n) => <option key={n} value={n}>{n} ngày qua</option>)}
          </select>
        </label>
      </div>}

      {s && <div className="grid4">
        <div className="panel small">Xe đang tính<br /><b style={{ fontSize: 22 }}>{s.sources}</b></div>
        <div className="panel small">Diện tích tới kịp trong {f.target} phút<br /><b style={{ fontSize: 22 }}>{s.areaCoveredPct}%</b></div>
        <div className="panel small">Ca nằm trong vùng tới kịp<br /><b style={{ fontSize: 22 }}>{s.demandCoveredPct == null ? '—' : `${s.demandCoveredPct}%`}</b>
          <span className="muted"> {s.demandCovered}/{s.demand} ca</span></div>
        <div className="panel small">Ô lưới<br /><b style={{ fontSize: 22 }}>{d.cellKm} km</b><span className="muted"> · {s.cells} ô</span></div>
      </div>}
      {s && s.sources === 0 && <div className="alert red">Không có xe nào trong kịch bản này: toàn bộ địa bàn đang bị hở.</div>}

      <div className="map-big" style={{ height: 560 }}>
        <MapContainer key={d?.area ? 'a' : 'b'} center={center} zoom={11}
          bounds={d?.area ? [[d.area.south, d.area.west], [d.area.north, d.area.east]] : undefined} style={{ height: '100%', width: '100%' }}>
          <TileLayer url={TILE} attribution="&copy; OpenStreetMap" />
          {d?.cells.map((c: any, k: number) => (
            <Rectangle key={k} bounds={[[c.lat - d.dLat / 2, c.lng - d.dLng / 2], [c.lat + d.dLat / 2, c.lng + d.dLng / 2]]}
              pathOptions={{ stroke: false, fillColor: colorOf(c.minutes), fillOpacity: 0.28 }}>
              <Tooltip sticky>{c.minutes == null ? 'Không có xe' : `${c.minutes} phút · xe ${c.by}`}{c.demand > 0 && ` · ${c.demand} ca`}</Tooltip>
            </Rectangle>
          ))}
          {d?.cells.filter((c: any) => c.demand > 0).map((c: any, k: number) => (
            <CircleMarker key={`d${k}`} center={[c.lat, c.lng]} radius={Math.min(12, 3 + Math.sqrt(c.demand) * 2)}
              pathOptions={{ color: '#fff', weight: 1, fillColor: '#111827', fillOpacity: 0.75 }}>
              <Tooltip>{c.demand} ca · {c.minutes == null ? 'không có xe' : `${c.minutes} phút`}</Tooltip>
            </CircleMarker>
          ))}
          {d?.stations.map((st: any) => <Marker key={st.id} position={[st.lat, st.lng]} icon={stationIcon}><Tooltip>{st.name}</Tooltip></Marker>)}
          {d?.sources.map((v: any) => (
            <CircleMarker key={v.id} center={[v.lat, v.lng]} radius={8} pathOptions={{ color: '#fff', weight: 2, fillColor: colors.ok, fillOpacity: 1 }}>
              <Tooltip permanent direction="right" offset={[8, 0]}>{v.id}</Tooltip>
            </CircleMarker>
          ))}
          {d?.suggestions.map((p: any, k: number) => (
            <Marker key={`s${k}`} position={[p.lat, p.lng]} icon={pinIcon(k + 1)}><Tooltip>Gợi ý {k + 1}: đặt xe ở đây phủ thêm {p.gain} ca ({p.gainPct}%)</Tooltip></Marker>
          ))}
        </MapContainer>
      </div>
      <div className="row small" style={{ flexWrap: 'wrap' }}>
        <span className="badge green">≤ {f.target} phút: tới kịp</span>
        <span className="badge amber">{f.target}–{Math.round(f.target * 1.5)} phút</span>
        <span className="badge red">&gt; {Math.round(f.target * 1.5)} phút: vùng bị hở</span>
        <span className="badge">Chấm đen: ca đã xảy ra</span>
        <span className="badge">Số xanh: gợi ý chỗ đặt xe</span>
      </div>

      <div className="grid2">
        <div className="panel col">
          <b>Giả định xe đi làm nhiệm vụ</b>
          <span className="small muted">Bỏ chọn một xe để xem nếu xe đó đi thì hở chỗ nào.</span>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {d?.vehicles.map((v: any) => (
              <label key={v.id} className="row small" title={VEHICLE_LABEL[v.type] ?? v.type} style={{ opacity: v.used || exclude.includes(v.id) ? 1 : 0.5 }}>
                <input type="checkbox" checked={!exclude.includes(v.id)} disabled={!v.used && !exclude.includes(v.id)} onChange={() => toggle(v.id)} />
                {v.id} <span className="muted">{v.status}{!v.used && !exclude.includes(v.id) ? ' · không tính' : ''}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="panel col">
          <b>Gợi ý đặt xe tạm trú</b>
          {d?.suggestions.length ? (
            <table className="small"><thead><tr><th>#</th><th>Tọa độ</th><th>Phủ thêm</th></tr></thead>
              <tbody>{d.suggestions.map((p: any, k: number) => (
                <tr key={k}><td>{k + 1}</td><td>{p.lat.toFixed(4)}, {p.lng.toFixed(4)}</td><td>{p.gain} ca ({p.gainPct}%)</td></tr>
              ))}</tbody></table>
          ) : <span className="small muted">Mọi ca đều nằm trong vùng tới kịp, hoặc chưa có dữ liệu ca có tọa độ.</span>}
          <span className="small muted">Chọn lần lượt chỗ phủ thêm nhiều ca nhất (gợi ý 2 tính sau khi đã đặt xe ở gợi ý 1).</span>
        </div>
      </div>
      <div className="small muted">
        Thời gian là ước tính theo khoảng cách (hệ số đường 1,4; 30 km/h nội đô; cộng 1 phút xuất phát), giống phần gợi ý xe; chưa có giao thông.
        Không tính xe thiếu thiết bị bắt buộc, quá hạn đăng kiểm và xe trực giờ hành chính lúc ngoài giờ.
      </div>
    </div>
  );
}
