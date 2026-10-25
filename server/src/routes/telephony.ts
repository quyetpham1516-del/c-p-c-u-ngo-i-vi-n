import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { asrConfig, queueTranscript } from '../asr.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { many, one, withTx } from '../db.js';
import { HttpError, incidentScope, incidentSummary } from '../domain.js';
import { actorOf, EOC_ROLES, guard, REVIEW_ROLES, type Ctx, type Role } from '../http.js';
import { ari, ariStatus, channelExists, MIME, originate, recordingInfo, recordingPath, RECORDING_NAME, recordingsDir, takeCall, userForExtension } from '../telephony.js';

/** Khóa tổng đài; chấp nhận cả khi tiêu đề bị gửi lặp ("khóa, khóa") */
export const pbxKeyOk = (h: string | string[] | undefined) =>
  !!h && (Array.isArray(h) ? h : String(h).split(',')).some((x) => timingSafeEq(x.trim(), config.telephonyKey));
function timingSafeEq(a: string, b: string) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
const pbxId = z.string().trim().regex(/^[\w.-]{1,64}$/);
const ext = z.string().trim().regex(/^[0-9]{2,6}$/, 'Máy lẻ là 2–6 chữ số');
/** Nghe lại ghi âm: trưởng ca, QLCL, quản trị, Ban Giám đốc (mỗi lượt nghe ghi nhật ký) */
const LISTEN: Role[] = [...REVIEW_ROLES, 'director'];
const CALL_VIEW: Role[] = [...EOC_ROLES, 'qa', 'director'];

export function registerTelephony(app: FastifyInstance, { pool, hub }: Ctx) {
  const pushCall = async (id: string) => {
    const c = await one(pool, 'SELECT id, phone, line, state, direction, ringing_at, answered_at, ended_at, incident_id, operator_id, extension FROM calls WHERE id = $1', [id]);
    await hub.publish({ type: 'call', id, call: c });
  };
  const pushIncident = async (id: string) => hub.publish({ type: 'incident', id, incident: await incidentSummary(pool, id) });

  /** Chỉ tổng đài (có khóa MEDONE_TELEPHONY_KEY) gọi các webhook này */
  const pbxOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!pbxKeyOk(req.headers['x-medone-telephony-key'])) return reply.code(401).send({ error: 'Sai khóa tổng đài' });
  };

  /** Máy lẻ nhấc máy cuộc gọi trong hàng chờ: tự mở ca cho người đang dùng máy lẻ đó, màn hình của họ mở ca ngay */
  app.post('/api/telephony/answered', { preHandler: pbxOnly }, async (req) => {
    const b = z.object({ pbxId, ext }).parse(req.body);
    const call = await one(pool, 'SELECT id, state, operator_id FROM calls WHERE pbx_id = $1', [b.pbxId]);
    if (!call) throw new HttpError(404, 'Không có cuộc gọi này');
    if (call.state !== 'ringing') return { ok: true, already: true };
    const user = await userForExtension(pool, b.ext);
    if (!user) {
      // Máy lẻ chưa gán người: ghi nhận đã nhấc máy, điều phối gắn vào ca bằng tay
      await pool.query(`UPDATE calls SET state = 'answered', answered_at = now(), extension = $2 WHERE id = $1 AND state = 'ringing'`, [call.id, b.ext]);
      await pushCall(call.id);
      return { ok: true, incidentId: null, warning: `Máy lẻ ${b.ext} chưa gán cho nhân viên nào` };
    }
    const incidentId = await withTx(pool, (tx) => takeCall(tx, call.id, { id: user.id, name: user.name }, { extension: b.ext, via: 'tong_dai' }));
    await Promise.all([pushCall(call.id), pushIncident(incidentId), hub.publish({ type: 'call_taken', id: call.id, userId: user.id, incidentId })]);
    return { ok: true, incidentId };
  });

  /** Gác máy: cuộc gọi chưa ai nhấc là bỏ dở (vào danh sách gọi lại); lưu tệp ghi âm, độ dài, mã băm */
  app.post('/api/telephony/hangup', { preHandler: pbxOnly }, async (req) => {
    const b = z.object({
      pbxId, recording: z.string().trim().max(130).optional(), duration: z.coerce.number().int().min(0).max(86_400).optional(),
      cause: z.string().trim().max(40).optional(),
    }).parse(req.body);
    const call = await one(pool, 'SELECT * FROM calls WHERE pbx_id = $1', [b.pbxId]);
    if (!call) return { ok: false };
    const rec = b.recording && RECORDING_NAME.test(b.recording) ? await recordingInfo(b.recording) : null;
    const r = await one(pool, `
      UPDATE calls SET
        state = CASE WHEN state = 'ringing' THEN 'abandoned' WHEN state = 'answered' THEN 'ended' ELSE state END,
        ended_at = coalesce(ended_at, now()),
        duration_s = coalesce($2, CASE WHEN answered_at IS NOT NULL THEN extract(epoch FROM now() - answered_at)::int END),
        recording_file = coalesce($3, recording_file), recording_bytes = coalesce($4, recording_bytes), recording_sha256 = coalesce($5, recording_sha256),
        hangup_cause = $6
      WHERE id = $1 RETURNING id, state, incident_id`,
      [call.id, call.answered_at ? (b.duration ?? null) : 0, rec ? b.recording : null, rec?.bytes ?? null, rec?.sha256 ?? null, b.cause ?? null]);
    if (rec && r.incident_id) await withTx(pool, (tx) => audit(tx, incidentScope(r.incident_id), { id: null, name: 'Tổng đài' }, 'call.recorded', 'call', call.id, { file: b.recording, sha256: rec.sha256, bytes: rec.bytes }));
    // Cuộc gọi đã có người nghe và có ghi âm: đưa vào hàng chép lời (cuộc bỏ dở thường chỉ có nhạc chờ, không chép)
    if (rec && r.state === 'ended') await queueTranscript(pool, call.id);
    await pushCall(call.id);
    return { ok: true, state: r.state, recorded: !!rec };
  });

  /* ---------- Máy lẻ ---------- */

  app.get('/api/telephony/me', { preHandler: guard() }, async (req) => {
    const e = await one(pool, 'SELECT ext FROM sip_extensions WHERE user_id = $1', [req.user.id]);
    return { ext: e?.ext ?? null, canDial: !!ari() && !!e };
  });

  app.get('/api/telephony/extensions', { preHandler: guard('admin', 'supervisor') }, async () => ({
    extensions: await many(pool, `SELECT s.ext, s.label, s.user_id, u.full_name, u.role FROM sip_extensions s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.ext`),
    users: await many(pool, `SELECT id, full_name, role FROM users WHERE active AND role IN ('calltaker', 'dispatcher', 'supervisor', 'admin') ORDER BY full_name`),
    status: { ...(await ariStatus()), recordingsDir: !!recordingsDir(), asr: !!asrConfig() },
  }));

  app.put('/api/telephony/extensions/:ext', { preHandler: guard('admin', 'supervisor') }, async (req) => {
    const e = z.object({ ext }).parse(req.params).ext;
    const b = z.object({ userId: z.string().uuid().nullable(), label: z.string().trim().max(60).nullish() }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (b.userId) {
        const u = await one(tx, 'SELECT id, role FROM users WHERE id = $1 AND active', [b.userId]);
        if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản');
        if (!EOC_ROLES.includes(u.role)) throw new HttpError(422, 'Chỉ gán máy lẻ cho tiếp nhận, điều phối, trưởng ca, quản trị');
        await tx.query('UPDATE sip_extensions SET user_id = NULL WHERE user_id = $1 AND ext <> $2', [b.userId, e]);
      }
      const r = await one(tx, `INSERT INTO sip_extensions(ext, user_id, label) VALUES ($1,$2,$3)
                               ON CONFLICT (ext) DO UPDATE SET user_id = $2, label = $3 RETURNING *`, [e, b.userId, b.label ?? null]);
      await audit(tx, 'system', actorOf(req), 'telephony.extension_set', 'sip_extension', e, { userId: b.userId });
      return r;
    });
  });

  app.delete('/api/telephony/extensions/:ext', { preHandler: guard('admin', 'supervisor') }, async (req) => {
    const e = z.object({ ext }).parse(req.params).ext;
    await withTx(pool, async (tx) => {
      const r = await one(tx, 'DELETE FROM sip_extensions WHERE ext = $1 RETURNING ext', [e]);
      if (!r) throw new HttpError(404, 'Không có máy lẻ này');
      await audit(tx, 'system', actorOf(req), 'telephony.extension_removed', 'sip_extension', e);
    });
    return { ok: true };
  });

  /* ---------- Gọi ra, cuộc gọi của ca, ghi âm ---------- */

  /** Gọi lại người báo bằng một nút: máy lẻ của mình đổ chuông, nhấc máy là tổng đài quay số; cuộc gọi ra cũng được ghi âm */
  app.post('/api/telephony/call', { preHandler: guard(...EOC_ROLES) }, async (req) => {
    const b = z.object({
      phone: z.string().trim().transform((s) => s.replace(/[\s.-]/g, '')).pipe(z.string().regex(/^(\+?\d{3,15})$/, 'Số điện thoại không hợp lệ')),
      incidentId: z.string().uuid().nullish(), callbackOf: z.string().uuid().nullish(),
    }).parse(req.body);
    const mine = await one(pool, 'SELECT ext FROM sip_extensions WHERE user_id = $1', [req.user.id]);
    if (!mine) throw new HttpError(409, 'Bạn chưa được gán máy lẻ (quản trị gán ở trang Quản trị → Tổng đài)');
    if (!ari()) throw new HttpError(503, 'Chưa nối tổng đài để gọi ra');
    const call = await withTx(pool, async (tx) => {
      if (b.incidentId && !(await one(tx, 'SELECT id FROM incidents WHERE id = $1', [b.incidentId]))) throw new HttpError(404, 'Không tìm thấy ca');
      const c = await one(tx, `INSERT INTO calls(phone, line, direction, state, answered_at, operator_id, incident_id, extension)
                               VALUES ($1, '1800', 'out', 'answered', now(), $2, $3, $4) RETURNING *`, [b.phone, req.user.id, b.incidentId ?? null, mine.ext]);
      await tx.query('UPDATE calls SET pbx_id = id::text WHERE id = $1', [c.id]);
      await audit(tx, b.incidentId ? incidentScope(b.incidentId) : 'system', actorOf(req), 'call.dialed', 'call', c.id, { phone: b.phone, extension: mine.ext });
      return c;
    });
    try {
      await originate(mine.ext, b.phone, call.id, `Medone <${b.phone}>`);
    } catch (e) {
      await pool.query(`UPDATE calls SET state = 'ended', ended_at = now(), hangup_cause = 'originate_failed' WHERE id = $1`, [call.id]);
      throw e;
    }
    // Máy lẻ không nhấc máy thì tổng đài hủy kênh mà không qua kế hoạch quay số: kiểm tra lại để đóng cuộc gọi
    const check = async (left: number) => {
      const c = await one(pool, 'SELECT ended_at FROM calls WHERE id = $1', [call.id]).catch(() => null);
      if (!c || c.ended_at) return;
      const alive = await channelExists(call.id);
      if (alive === false) {
        await pool.query(`UPDATE calls SET state = 'ended', ended_at = now(), duration_s = 0, hangup_cause = 'khong_nhac_may' WHERE id = $1 AND ended_at IS NULL`, [call.id]);
        await pushCall(call.id);
      } else if (left > 0) setTimeout(() => void check(left - 1), 30_000).unref();
    };
    setTimeout(() => void check(240), 45_000).unref();
    if (b.callbackOf) await pool.query('UPDATE calls SET callback_done_at = now() WHERE id = $1 AND callback_done_at IS NULL', [b.callbackOf]);
    await pushCall(call.id);
    return { id: call.id, ext: mine.ext };
  });

  app.get('/api/incidents/:id/calls', { preHandler: guard(...CALL_VIEW) }, async (req) => many(pool, `
    SELECT c.id, c.phone, c.line, c.direction, c.state, c.ringing_at, c.answered_at, c.ended_at, c.duration_s, c.extension,
           (c.recording_file IS NOT NULL) AS has_recording, c.recording_bytes, u.full_name AS operator_name, c.transcript_status
      FROM calls c LEFT JOIN users u ON u.id = c.operator_id WHERE c.incident_id = $1 ORDER BY c.ringing_at`, [idParam(req.params)]));

  /** Nghe lại ghi âm: hỗ trợ tua (Range); kiểm tra tệp còn nguyên theo mã băm lúc gác máy */
  app.get('/api/calls/:id/recording', { preHandler: guard(...LISTEN) }, async (req, reply) => {
    const id = idParam(req.params);
    const c = await one(pool, 'SELECT id, incident_id, recording_file, recording_sha256 FROM calls WHERE id = $1', [id]);
    if (!c?.recording_file) throw new HttpError(404, 'Cuộc gọi không có ghi âm');
    const info = await recordingInfo(c.recording_file);
    if (!info) throw new HttpError(404, recordingPath(c.recording_file) ? 'Không tìm thấy tệp ghi âm (đã xóa hoặc chuyển đi)' : 'Chưa cấu hình thư mục ghi âm');
    const intact = !c.recording_sha256 || c.recording_sha256 === info.sha256;
    await withTx(pool, (tx) => audit(tx, c.incident_id ? incidentScope(c.incident_id) : 'system', actorOf(req), 'call.recording_played', 'call', id, { intact }));
    const ext = c.recording_file.split('.').pop()!;
    reply.header('content-type', MIME[ext] ?? 'application/octet-stream').header('accept-ranges', 'bytes')
      .header('x-recording-intact', intact ? '1' : '0').header('cache-control', 'no-store');
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, info.bytes - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), info.bytes - 1) : info.bytes - 1;
      if (start >= info.bytes || start > end) return reply.code(416).header('content-range', `bytes */${info.bytes}`).send();
      return reply.code(206).header('content-range', `bytes ${start}-${end}/${info.bytes}`).header('content-length', end - start + 1)
        .send(createReadStream(info.path, { start, end }));
    }
    return reply.header('content-length', info.bytes).send(createReadStream(info.path));
  });

  /** Lời thoại chép từ ghi âm: nhạy cảm như ghi âm nên cùng quyền nghe lại, mỗi lượt xem ghi nhật ký */
  app.get('/api/calls/:id/transcript', { preHandler: guard(...LISTEN) }, async (req) => {
    const id = idParam(req.params);
    const c = await one(pool, 'SELECT id, incident_id, transcript, transcript_status, transcript_at, transcript_model, transcript_error FROM calls WHERE id = $1', [id]);
    if (!c) throw new HttpError(404, 'Không có cuộc gọi này');
    if (c.transcript_status === 'xong') {
      await withTx(pool, (tx) => audit(tx, c.incident_id ? incidentScope(c.incident_id) : 'system', actorOf(req), 'call.transcript_viewed', 'call', id));
    }
    return { status: c.transcript_status, text: c.transcript, at: c.transcript_at, model: c.transcript_model, error: c.transcript_error, enabled: !!asrConfig() };
  });

  /** Chép lại (máy chép lời lỗi, hoặc đổi mô hình tốt hơn) */
  app.post('/api/calls/:id/transcript', { preHandler: guard(...LISTEN) }, async (req) => {
    const id = idParam(req.params);
    if (!asrConfig()) throw new HttpError(503, 'Chưa cài máy chép lời (MEDONE_ASR_URL)');
    if (!(await queueTranscript(pool, id, true))) throw new HttpError(404, 'Cuộc gọi không có ghi âm');
    return { ok: true, status: 'cho' };
  });

  /** QLCL tìm cuộc gọi theo lời thoại, ví dụ "ngừng thở", "co giật" */
  app.get('/api/calls/search', { preHandler: guard(...LISTEN) }, async (req) => {
    const q = z.object({ q: z.string().trim().min(2).max(100), days: z.coerce.number().int().min(1).max(3650).default(90) }).parse(req.query);
    const rows = await many(pool, `
      SELECT c.id, c.phone, c.direction, c.ringing_at, c.duration_s, c.incident_id, i.code AS incident_code,
             ts_headline('simple', c.transcript, plainto_tsquery('simple', $1), 'MaxFragments=2, MaxWords=18, MinWords=6, StartSel=«, StopSel=»') AS snippet
        FROM calls c LEFT JOIN incidents i ON i.id = c.incident_id
       WHERE c.transcript_status = 'xong' AND c.ringing_at > now() - make_interval(days => $2)
         AND to_tsvector('simple', coalesce(c.transcript, '')) @@ plainto_tsquery('simple', $1)
       ORDER BY c.ringing_at DESC LIMIT 100`, [q.q, q.days]);
    await withTx(pool, (tx) => audit(tx, 'system', actorOf(req), 'call.transcript_searched', 'call', null, { q: q.q, results: rows.length }));
    return rows;
  });

  /** Trạng thái tổng đài cho màn hình EOC */
  app.get('/api/telephony/status', { preHandler: guard(...CALL_VIEW) }, async () => ({ ...(await ariStatus()), recordingsDir: !!recordingsDir(), asr: !!asrConfig() }));
}
