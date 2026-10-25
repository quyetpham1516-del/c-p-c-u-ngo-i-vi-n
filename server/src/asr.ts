import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { many } from './db.js';
import { recordingInfo } from './telephony.js';

/**
 * Chép lời cuộc gọi từ ghi âm bằng máy chép lời đơn vị tự cài trong mạng nội bộ (whisper.cpp server, faster-whisper-server, LocalAI...).
 * Giao tiếp chuẩn POST {MEDONE_ASR_URL}/audio/transcriptions (multipart: file, model, language). Ghi âm không gửi ra dịch vụ bên ngoài
 * trừ khi quản trị cố ý đặt địa chỉ ngoài. Không cấu hình thì không chép lời.
 */
export const ASR_MAX_ATTEMPTS = 3;

export function asrConfig() {
  const url = process.env.MEDONE_ASR_URL?.trim().replace(/\/$/, '');
  if (!url) return null;
  return {
    url, key: process.env.MEDONE_ASR_KEY?.trim() || null,
    model: process.env.MEDONE_ASR_MODEL?.trim() || 'whisper-1',
    language: process.env.MEDONE_ASR_LANGUAGE?.trim() || 'vi',
  };
}

/** Đưa cuộc gọi có ghi âm vào hàng chép lời (gọi khi gác máy, hoặc khi QLCL bấm chép lại) */
export async function queueTranscript(pool: pg.Pool | pg.PoolClient, callId: string, force = false) {
  if (!asrConfig()) return false;
  const r = await pool.query(`UPDATE calls SET transcript_status = 'cho', transcript_attempts = 0, transcript_error = NULL
                               WHERE id = $1 AND recording_file IS NOT NULL AND ($2 OR transcript_status IS NULL) RETURNING id`, [callId, force]);
  return (r.rowCount ?? 0) > 0;
}

async function transcribe(cfg: NonNullable<ReturnType<typeof asrConfig>>, path: string, name: string, doFetch: typeof fetch) {
  const form = new FormData();
  form.append('file', new Blob([await readFile(path)]), name);
  form.append('model', cfg.model);
  form.append('language', cfg.language);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const res = await doFetch(`${cfg.url}/audio/transcriptions`, {
    method: 'POST', body: form,
    headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : {},
    // Cuộc gọi dài trên máy không có GPU có thể chép lâu
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json() as any;
  const text = typeof j?.text === 'string' ? j.text.trim() : null;
  if (text == null) throw new Error('Máy chép lời trả kết quả không có trường text');
  return text;
}

/** Chép lời các cuộc gọi đang chờ (mỗi lượt vài cuộc, cuộc cũ trước) */
export async function transcribePending(pool: pg.Pool, cfg = asrConfig(), doFetch: typeof fetch = fetch, limit = 3) {
  if (!cfg) return { done: 0, failed: 0 };
  const rows = await many(pool, `UPDATE calls SET transcript_attempts = transcript_attempts + 1
                                  WHERE id IN (SELECT id FROM calls WHERE transcript_status = 'cho' AND transcript_attempts < $1
                                                ORDER BY ringing_at LIMIT $2 FOR UPDATE SKIP LOCKED)
                                  RETURNING id, recording_file, transcript_attempts`, [ASR_MAX_ATTEMPTS, limit]);
  let done = 0; let failed = 0;
  for (const c of rows) {
    try {
      const info = await recordingInfo(c.recording_file);
      if (!info) throw new Error('Không tìm thấy tệp ghi âm');
      const text = await transcribe(cfg, info.path, c.recording_file, doFetch);
      await pool.query(`UPDATE calls SET transcript = $2, transcript_status = 'xong', transcript_at = now(), transcript_model = $3, transcript_error = NULL WHERE id = $1`,
        [c.id, text, cfg.model]);
      done++;
    } catch (e) {
      const last = c.transcript_attempts >= ASR_MAX_ATTEMPTS;
      await pool.query(`UPDATE calls SET transcript_status = $2, transcript_error = $3 WHERE id = $1`,
        [c.id, last ? 'loi' : 'cho', String((e as Error).message).slice(0, 300)]);
      failed++;
    }
  }
  return { done, failed };
}

/** Chạy nền mỗi 20 giây khi có cấu hình máy chép lời */
export function startAsrWorker(pool: pg.Pool, log: (m: string) => void = console.log) {
  const cfg = asrConfig();
  if (!cfg) return null;
  log(`Chép lời cuộc gọi: đã bật (${cfg.url}, mô hình ${cfg.model}, ngôn ngữ ${cfg.language})`);
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await transcribePending(pool, cfg);
      if (r.done || r.failed) log(`Chép lời: xong ${r.done}, lỗi ${r.failed}`);
    } catch (e) { log(`Chép lời lỗi: ${(e as Error).message}`); } finally { busy = false; }
  }, 20_000);
  t.unref();
  return t;
}
