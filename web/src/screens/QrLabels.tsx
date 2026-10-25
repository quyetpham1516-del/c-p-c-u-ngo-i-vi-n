import qrcode from 'qrcode-generator';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '../api';

interface Label { id: string; code: string; qr: string; name: string; line: string }

/** Tem QR in trên giấy A4 (3 cột), mỗi tem: mã QR 26 mm, mã tài sản, tên, số seri và nơi đặt. Quét tem mở trang /tb/<mã> */
export function QrLabels() {
  const q = useSearchParams();
  const kind = q.get('loai') === 'dc' ? 'dc' : 'tb';
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const ids = q.get('ids')?.split(',').filter(Boolean);
    const filter = new URLSearchParams(['stationId', 'vehicleId', 'status'].flatMap((k) => (q.get(k) ? [[k, q.get(k)!]] : [])));
    const keep = (id: string) => !ids || ids.includes(id);
    const load = kind === 'tb'
      ? api<any[]>('GET', `/api/equipment?${filter}`).then((rows) => rows.filter((e) => keep(e.id)).map((e) => ({
        id: e.id, code: e.asset_code, qr: e.qr_code, name: e.type_name, line: `SN ${e.serial} · ${e.vehicle_id ?? `kho ${e.station_id}`}`,
      })))
      : api<any[]>('GET', `/api/instrument-sets?${filter}`).then((rows) => rows.filter((s) => keep(s.id)).map((s) => ({
        id: s.id, code: s.code, qr: s.qr_code, name: s.name, line: `Bộ dụng cụ · ${s.vehicle_id ?? `kho ${s.station_id}`}`,
      })));
    load.then((l) => setLabels(l.sort((a, b) => a.code.localeCompare(b.code, 'vi', { numeric: true })))).catch((e) => setError(e.message));
  }, [q, kind]);
  const svg = (text: string) => {
    const c = qrcode(0, 'M');
    c.addData(text);
    c.make();
    return c.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
  };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <div className="col">
      <div className="row no-print">
        <h2 style={{ margin: 0 }}>In tem QR {kind === 'tb' ? 'thiết bị' : 'bộ dụng cụ'}</h2>
        <button className="primary" disabled={!labels?.length} onClick={() => window.print()}>In ({labels?.length ?? 0} tem)</button>
      </div>
      <div className="small muted no-print">
        Tem chứa đường dẫn {origin}/tb/… — điện thoại phải truy cập được địa chỉ này (cùng mạng nội bộ hoặc tên miền của Medone) thì quét mới mở được.
        In khổ A4, tỷ lệ 100%, rồi cắt theo viền đứt và dán lên thiết bị.
      </div>
      {/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin) && <div className="alert amber no-print">
        Trang đang mở bằng "localhost": tem in ra điện thoại sẽ không mở được. Hãy mở trang này bằng địa chỉ IP mạng nội bộ của máy chủ (ví dụ http://192.168.x.x:3000) hoặc tên miền của Medone rồi mới in.
      </div>}
      {error && <div className="alert red">{error}</div>}
      <div className="qr-sheet">
        {labels?.map((l) => (
          <div key={l.id} className="qr-label">
            <div className="qr-img" dangerouslySetInnerHTML={{ __html: svg(`${origin}/tb/${l.qr}`) }} />
            <div className="qr-text">
              <b className="mono">{l.code}</b>
              <div>{l.name}</div>
              <div className="qr-small">{l.line}</div>
              <div className="qr-small">Medone · Quét: hướng dẫn sử dụng, kiểm tra, báo hỏng</div>
            </div>
          </div>
        ))}
      </div>
      {labels && !labels.length && <div className="small muted">Không có {kind === 'tb' ? 'thiết bị' : 'bộ dụng cụ'} nào.</div>}
    </div>
  );
}
