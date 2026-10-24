import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Brand } from '../Logo';

const QUESTIONS: [key: 'overall' | 'timeliness' | 'attitude' | 'care', label: string][] = [
  ['overall', 'Quý khách hài lòng chung với dịch vụ ở mức nào?'],
  ['timeliness', 'Xe đến có kịp thời không?'],
  ['attitude', 'Thái độ của nhân viên (điều phối, kíp xe)?'],
  ['care', 'Chăm sóc, xử trí cho người bệnh?'],
];

/** Khảo sát hài lòng sau ca (QLCL-08): mở từ tin nhắn, không cần đăng nhập */
export function Survey() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<{ incidentCode: string; date: string; answered: boolean } | null>(null);
  const [score, setScore] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [done, setDone] = useState<null | { followUp: boolean }>(null);
  const [error, setError] = useState('');
  useEffect(() => { api('GET', `/api/public/survey/${encodeURIComponent(token)}`).then(setInfo).catch((e) => setError(e.message)); }, [token]);
  const send = async () => {
    setError('');
    try { setDone(await api('POST', `/api/public/survey/${encodeURIComponent(token)}`, { ...score, comment: comment || null })); } catch (e) { setError((e as Error).message); }
  };
  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: 16 }} className="col">
      <Brand />
      {error && <div className="error">{error}</div>}
      {info && !done && !info.answered && (
        <div className="panel col">
          <h2 style={{ margin: 0 }}>Đánh giá chất lượng phục vụ</h2>
          <div className="small muted">Ca {info.incidentCode}, ngày {new Date(info.date).toLocaleDateString('vi-VN')}. Mất khoảng 30 giây.</div>
          {QUESTIONS.map(([k, label]) => (
            <div key={k} className="col" style={{ gap: 4 }}>
              <b>{label}</b>
              <div className="row">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} className={score[k] === n ? 'primary' : ''} style={{ minWidth: 48 }} onClick={() => setScore({ ...score, [k]: n })}>{n}</button>
                ))}
              </div>
            </div>
          ))}
          <div className="small muted">1 = rất không hài lòng, 5 = rất hài lòng</div>
          <label className="field">Góp ý thêm (không bắt buộc)<textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          <button className="primary big" disabled={!score.overall} onClick={send}>Gửi đánh giá</button>
        </div>
      )}
      {(done || info?.answered) && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Cảm ơn quý khách</h2>
          <p>{done?.followUp ? 'Medone rất tiếc vì trải nghiệm chưa tốt. Bộ phận chăm sóc khách hàng sẽ liên hệ lại trong 48 giờ.' : 'Ý kiến của quý khách giúp Medone phục vụ tốt hơn.'}</p>
        </div>
      )}
    </div>
  );
}
