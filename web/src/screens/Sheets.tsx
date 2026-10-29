import { useEffect, useState } from 'react';
import { api, download, session } from '../api';

const ACTION: Record<string, [string, string]> = { them: ['Thêm', 'green'], sua: ['Sửa', 'amber'] };

const fileToBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('Không đọc được tệp'));
  r.readAsDataURL(f);
});

/**
 * File mẫu Excel: tải về kèm dữ liệu đang dùng, sửa, nạp lên để xem dòng thêm, sửa, lỗi; bấm "Áp dụng" mới ghi.
 * Đã khóa cấu hình: trưởng nhóm đúng mảng bấm "Áp dụng" thì thành đề xuất, quản trị duyệt.
 */
export function Sheets() {
  const role = session.user?.role ?? '';
  const [sheets, setSheets] = useState<any[]>([]);
  const [gov, setGov] = useState<any>(null);
  const [key, setKey] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<any[]>('GET', '/api/sheets').then((s) => { setSheets(s); setKey((k) => k || s[0]?.key || ''); }).catch((e) => setError(e.message));
    api('GET', '/api/governance').then(setGov).catch(() => {});
  }, []);
  const sheet = sheets.find((s) => s.key === key);
  const myDomains = new Set((gov?.myDomains ?? []).map((d: any) => d.domain));
  const canApply = !!sheet && !!gov && (gov.enforced ? myDomains.has(sheet.domain) || myDomains.has('ban_giam_doc') : role === 'admin');

  const upload = async (f: File | undefined) => {
    if (!f || !sheet) return;
    setError(''); setMsg(''); setResult(null); setBusy(true);
    try { setResult(await api('POST', `/api/sheets/${sheet.key}/parse`, { fileBase64: await fileToBase64(f) })); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const apply = async () => {
    setError(''); setMsg(''); setBusy(true);
    try {
      const r = await api('POST', `/api/sheets/${sheet.key}/apply`, { rows: result.changes });
      setMsg(r?.proposal ? `Đã gửi đề xuất ${r.code}, chờ quản trị duyệt` : `Đã áp dụng: thêm ${r.inserted}, sửa ${r.updated}`);
      setResult(null);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const cols: string[] = result?.changes?.length ? Object.keys(result.changes[0]).filter((k) => k !== '_action') : [];

  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>File mẫu Excel</h2>
      <div className="panel col">
        <div className="small muted">Tải file mẫu (kèm dữ liệu đang dùng), sửa trên Excel rồi nạp lên. Nạp lên chỉ so với dữ liệu hiện tại, bấm "Áp dụng" mới ghi.
          {gov?.enforced ? ' Đã khóa cấu hình: trưởng nhóm đúng mảng bấm Áp dụng thì thành đề xuất chờ quản trị duyệt.' : ' Chưa khóa cấu hình: quản trị áp dụng thẳng.'}</div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select value={key} onChange={(e) => { setKey(e.target.value); setResult(null); setMsg(''); }}>
            {sheets.map((s) => <option key={s.key} value={s.key}>{s.label} ({s.domainLabel})</option>)}
          </select>
          {sheet && <button onClick={() => download(`/api/sheets/${sheet.key}/template`, `mau-${sheet.key}.xlsx`).catch((e) => setError(e.message))}>Tải file mẫu</button>}
          <label className="row small" style={{ gap: 6 }}>Nạp lên
            <input type="file" accept=".xlsx" disabled={busy} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} /></label>
        </div>
        {error && <div className="error">{error}</div>}
        {msg && <div className="alert green">{msg}</div>}
      </div>

      {result && (
        <div className="panel col">
          <div><b>{result.changes.length}</b> dòng thay đổi · {result.unchanged} dòng giữ nguyên · {result.errors.length > 0
            ? <span style={{ color: 'var(--danger)' }}>{result.errors.length} dòng lỗi (không áp dụng)</span> : 'không có dòng lỗi'}</div>
          {result.errors.length > 0 && (
            <ul className="small" style={{ margin: 0 }}>{result.errors.slice(0, 50).map((e: any) => <li key={e.row}>Dòng {e.row}: {e.error}</li>)}</ul>
          )}
          {result.changes.length > 0 && (
            <div style={{ overflowX: 'auto', maxHeight: 420 }}>
              <table className="small">
                <thead><tr><th /> {cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{result.changes.map((r: any, i: number) => (
                  <tr key={i}><td><span className={`badge ${ACTION[r._action]?.[1] ?? ''}`}>{ACTION[r._action]?.[0] ?? r._action}</span></td>
                    {cols.map((c) => <td key={c}>{r[c] === true ? 'Có' : r[c] === false ? 'Không' : r[c] ?? ''}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <div className="row">
            <button className="primary" disabled={busy || !result.changes.length || !canApply} onClick={apply}>
              {gov?.enforced ? 'Gửi đề xuất áp dụng' : 'Áp dụng'} {result.changes.length} dòng</button>
            <button className="ghost" onClick={() => setResult(null)}>Thôi</button>
            {!canApply && <span className="small muted">{gov?.enforced ? `Chỉ trưởng nhóm ${sheet?.domainLabel} gửi đề xuất được.` : 'Chỉ quản trị áp dụng khi chưa khóa cấu hình.'}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
