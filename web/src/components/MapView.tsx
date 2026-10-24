import L from 'leaflet';
import { useEffect } from 'react';
import { CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';

/** Bản đồ nền OpenStreetMap; sau go-live thay bằng dịch vụ bản đồ Việt Nam có địa chỉ hẻm ngõ (mục 12.1) */
const TILE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTR = '&copy; OpenStreetMap';
export const DEFAULT_CENTER: [number, number] = [10.7769, 106.7009];

const sceneIcon = L.divIcon({
  className: '',
  html: '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#d0201b;transform:rotate(-45deg);border:3px solid #fff;box-shadow:0 1px 4px #0008"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 22],
});

function ClickToPick({ onPick }: { onPick?: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick?.(e.latlng.lat, e.latlng.lng) });
  return null;
}

function Recenter({ center }: { center: [number, number] | null }) {
  const map = useMap();
  useEffect(() => { if (center) map.setView(center, Math.max(map.getZoom(), 14)); }, [center?.[0], center?.[1]]);
  return null;
}

export interface MapVehicle { id: string; lat: number | null; lng: number | null; status: string }

const STATUS_COLOR: Record<string, string> = {
  S1: '#1d8a4a', S2: '#1d8a4a', S3: '#e46c0a', S4: '#e46c0a', S5: '#d0201b', S6: '#d0201b', S7: '#d0201b', S8: '#b7791f', S9: '#7a8796',
};

export function MapView({ scene, vehicles = [], onPick, className = 'map-small', zoom = 13 }: {
  scene?: { lat: number; lng: number } | null; vehicles?: MapVehicle[]; onPick?: (lat: number, lng: number) => void; className?: string; zoom?: number;
}) {
  const center: [number, number] = scene ? [scene.lat, scene.lng] : DEFAULT_CENTER;
  return (
    <div className={className}>
      <MapContainer center={center} zoom={zoom} style={{ height: '100%', width: '100%' }}>
        <TileLayer url={TILE} attribution={ATTR} />
        <ClickToPick onPick={onPick} />
        <Recenter center={scene ? [scene.lat, scene.lng] : null} />
        {scene && <Marker position={[scene.lat, scene.lng]} icon={sceneIcon} />}
        {vehicles.filter((v) => v.lat != null && v.lng != null).map((v) => (
          <CircleMarker key={v.id} center={[v.lat!, v.lng!]} radius={9} pathOptions={{ color: '#fff', weight: 2, fillColor: STATUS_COLOR[v.status], fillOpacity: 1 }}>
            <Tooltip permanent direction="right" offset={[8, 0]}>{v.id} · {v.status}</Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
