import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { audit } from './audit.js';
import { one, type Queryable, type Tx } from './db.js';
import { createIncident, getIncident, HttpError, incidentScope } from './domain.js';
import type { Actor } from './audit.js';

/**
 * Tổng đài SIP (Asterisk): tổng đài gọi webhook khi có cuộc gọi đến, khi máy lẻ nhấc máy và khi gác máy;
 * ghi âm bằng MixMonitor vào thư mục dùng chung với máy chủ (MEDONE_RECORDINGS_DIR). Gọi ra (gọi lại người báo)
 * qua ARI của Asterisk (MEDONE_ARI_URL, MEDONE_ARI_USER, MEDONE_ARI_PASSWORD). Không cấu hình thì phần mềm vẫn chạy:
 * điều phối bấm Nhận trên màn hình như trước.
 */

export const recordingsDir = () => process.env.MEDONE_RECORDINGS_DIR?.trim() || null;
export const ari = () => {
  const url = process.env.MEDONE_ARI_URL?.trim();
  const user = process.env.MEDONE_ARI_USER?.trim();
  const password = process.env.MEDONE_ARI_PASSWORD;
  return url && user && password ? { url: url.replace(/\/$/, ''), user, password } : null;
};

/** Tên tệp ghi âm hợp lệ: chỉ tên tệp (không đường dẫn), đuôi âm thanh */
export const RECORDING_NAME = /^[\w.-]{1,120}\.(wav|WAV|wav49|gsm|mp3|ogg)$/;

/** Đường dẫn tuyệt đối của tệp ghi âm, chặn thoát khỏi thư mục ghi âm */
export function recordingPath(name: string | null | undefined): string | null {
  const dir = recordingsDir();
  if (!dir || !name || !RECORDING_NAME.test(name)) return null;
  const root = resolve(dir);
  const p = resolve(root, name);
  return p.startsWith(root + sep) ? p : null;
}

export async function fileSha256(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export async function recordingInfo(name: string | null | undefined) {
  const p = recordingPath(name);
  if (!p || !existsSync(p)) return null;
  const size = statSync(p).size;
  // Tệp chỉ có phần đầu WAV (44 byte) là không ghi được tiếng nào: coi như không có ghi âm
  return size > 64 ? { path: p, bytes: size, sha256: await fileSha256(p) } : null;
}

export const MIME: Record<string, string> = { wav: 'audio/wav', WAV: 'audio/wav', wav49: 'audio/wav', gsm: 'audio/x-gsm', mp3: 'audio/mpeg', ogg: 'audio/ogg' };

/** Nhận cuộc gọi đang chờ: tạo ca mới (Mã ca tại T0 = lúc chuông reo) hoặc gắn vào ca đã có. Dùng cho nút Nhận và cho tổng đài báo nhấc máy. */
export async function takeCall(tx: Tx, callId: string, actor: Actor, opts: { attachTo?: string; extension?: string | null; via: 'web' | 'tong_dai' }) {
  const call = await one(tx, `SELECT * FROM calls WHERE id = $1 FOR UPDATE SKIP LOCKED`, [callId]);
  if (!call) throw new HttpError(409, 'Cuộc gọi đang được người khác nhận');
  if (call.state !== 'ringing') throw new HttpError(409, 'Cuộc gọi không còn chờ');
  let incidentId = opts.attachTo;
  if (incidentId) {
    await getIncident(tx, incidentId);
    await audit(tx, incidentScope(incidentId), actor, 'call.attached', 'call', callId, { phone: call.phone });
  } else {
    const inc = await createIncident(tx, actor, {
      source: call.line === '115' ? '115' : '1800', callerPhone: call.phone, t0: call.ringing_at, t1: new Date(),
    });
    incidentId = inc.id;
  }
  await tx.query(`UPDATE calls SET state = 'answered', answered_at = now(), operator_id = $2, incident_id = $3, extension = coalesce($4, extension) WHERE id = $1`,
    [callId, actor.id, incidentId, opts.extension ?? null]);
  if (opts.via === 'tong_dai') await audit(tx, incidentScope(incidentId!), actor, 'call.answered_on_phone', 'call', callId, { extension: opts.extension ?? null });
  return incidentId!;
}

export async function userForExtension(q: Queryable, ext: string) {
  return one(q, `SELECT u.id, u.full_name AS name, u.role FROM sip_extensions s JOIN users u ON u.id = s.user_id AND u.active WHERE s.ext = $1`, [ext]);
}

/** Gọi ra qua ARI: tổng đài đổ chuông máy lẻ của điều phối viên trước, nhấc máy thì quay số người báo */
export async function originate(ext: string, phone: string, channelId: string, callerId: string) {
  const a = ari();
  if (!a) throw new HttpError(503, 'Chưa nối tổng đài để gọi ra (thiếu MEDONE_ARI_URL, MEDONE_ARI_USER, MEDONE_ARI_PASSWORD)');
  const qs = new URLSearchParams({ endpoint: `PJSIP/${ext}`, extension: phone, context: 'medone-goi-ra', priority: '1', channelId, callerId, timeout: '30' });
  let res: Response;
  try {
    res = await fetch(`${a.url}/channels?${qs}`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${a.user}:${a.password}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ variables: { MEDONE_GOI_RA: '1' } }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(502, 'Không kết nối được tổng đài');
  }
  // ARI trả 500 khi không tạo được kênh tới máy lẻ: điện thoại chưa đăng nhập tổng đài
  if (res.status === 500 || res.status === 400) throw new HttpError(409, `Máy lẻ ${ext} chưa đăng nhập vào tổng đài (điện thoại tắt hoặc chưa cài tài khoản)`);
  if (!res.ok) throw new HttpError(502, `Tổng đài từ chối gọi ra (${res.status})`);
}

/** Kênh gọi ra còn trên tổng đài không (máy lẻ không nhấc, tổng đài hủy kênh thì không có webhook gác máy) */
export async function channelExists(channelId: string): Promise<boolean | null> {
  const a = ari();
  if (!a) return null;
  try {
    const res = await fetch(`${a.url}/channels/${encodeURIComponent(channelId)}`, {
      headers: { authorization: `Basic ${Buffer.from(`${a.user}:${a.password}`).toString('base64')}` }, signal: AbortSignal.timeout(4000),
    });
    return res.status === 404 ? false : res.ok ? true : null;
  } catch {
    return null;
  }
}

/** Tình trạng kết nối tổng đài cho trang quản trị */
export async function ariStatus() {
  const a = ari();
  if (!a) return { configured: false };
  try {
    const res = await fetch(`${a.url}/asterisk/info`, {
      headers: { authorization: `Basic ${Buffer.from(`${a.user}:${a.password}`).toString('base64')}` }, signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { configured: true, reachable: false, status: res.status };
    const j = await res.json() as any;
    return { configured: true, reachable: true, version: j?.system?.version ?? null };
  } catch {
    return { configured: true, reachable: false };
  }
}
