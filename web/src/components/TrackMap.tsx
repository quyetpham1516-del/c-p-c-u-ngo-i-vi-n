import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from 'react-leaflet';
import { DEFAULT_CENTER } from './MapView';

const COLORS = ['#d0201b', '#1f6feb', '#1d8a4a', '#b7791f', '#7a3fd1'];

/** Lộ trình GPS của các xe trong một ca, kèm điểm hiện trường */
export function TrackMap({ scene, tracks }: { scene: { lat: number | null; lng: number | null } | null; tracks: { vehicleId: string; points: { lat: number; lng: number; at: string }[] }[] }) {
  const all = tracks.flatMap((t) => t.points);
  const center: [number, number] = scene?.lat != null && scene.lng != null ? [scene.lat, scene.lng] : all[0] ? [all[0].lat, all[0].lng] : DEFAULT_CENTER;
  return (
    <MapContainer center={center} zoom={13} className="map-small" style={{ height: 380 }}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
      {tracks.map((t, i) => (
        <Polyline key={t.vehicleId} positions={t.points.map((p) => [p.lat, p.lng] as [number, number])} pathOptions={{ color: COLORS[i % COLORS.length], weight: 4 }}>
          <Tooltip sticky>{t.vehicleId}</Tooltip>
        </Polyline>
      ))}
      {tracks.map((t, i) => t.points[0] && (
        <CircleMarker key={`${t.vehicleId}-start`} center={[t.points[0].lat, t.points[0].lng]} radius={5} pathOptions={{ color: COLORS[i % COLORS.length], fillOpacity: 1 }}>
          <Tooltip>{t.vehicleId} bắt đầu {new Date(t.points[0].at).toLocaleTimeString('vi-VN')}</Tooltip>
        </CircleMarker>
      ))}
      {scene?.lat != null && scene.lng != null && (
        <CircleMarker center={[scene.lat, scene.lng]} radius={9} pathOptions={{ color: '#000', fillColor: '#ffd400', fillOpacity: 0.9 }}><Tooltip>Hiện trường</Tooltip></CircleMarker>
      )}
    </MapContainer>
  );
}
