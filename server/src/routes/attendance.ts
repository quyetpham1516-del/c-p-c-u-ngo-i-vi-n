import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import {
  checkLocation, FLAG, kioskKeyOk, makeToken, newKioskCredentials, parseToken, QR_STEP_S, qrStep, REPEAT_GUARD_S, stationQr, stationSecret, verifyToken,
} from '../attendance.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';

const HR: Role[] = ['hr', 'admin'];
const VIEW: Role[] = ['hr', 'admin', 'director', 'supervisor'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const stationParam = (p: unknown) => z.object({ id: z.string().min(1).max(32) }).parse(p).id;

export function registerAttendance(app: FastifyInstance, { pool }: Ctx) {
  app.get('/api/attendance/meta', { preHandler: guard() }, async () => ({ flags: FLAG, stepSeconds: QR_STEP_S, repeatGuardSeconds: REPEAT_GUARD_S }));

  /* ---------- Máy chiếu mã ở trạm: xác thực bằng khóa máy, không cần đăng nhập ---------- */

  app.get('/api/attendance/kiosk/:id', async (req) => {
    const id = stationParam(req.params);
    const st = await stationQr(pool, id);
    const key = req.headers['x-kiosk-key'];
    if (!st || !kioskKeyOk(st, typeof key === 'string' ? key : undefined)) {
      throw new HttpError(401, 'Máy chấm công chưa được cấp quyền hoặc khóa đã bị thay: nhờ nhân sự cấp lại đường dẫn', { code: 'KIOSK_KEY' });
    }
    if (!st.active) throw new HttpError(409, 'Trạm đang ngừng hoạt động');
    const step = qrStep();
    // Gần đây ở trạm này: chỉ tên rút gọn và giờ, để người vừa quét thấy mình đã được ghi
    const recent = await many(pool, `
      SELECT * FROM (
        SELECT s.full_name, 'vao' AS kind, a.check_in AS at FROM attendance a JOIN staff s ON s.id = a.staff_id
         WHERE a.station_id = $1 AND a.check_in > now() - interval '12 hours'
        UNION ALL
        SELECT s.full_name, 'ra', a.check_out FROM attendance a JOIN staff s ON s.id = a.staff_id
         WHERE a.out_station_id = $1 AND a.check_out > now() - interval '12 hours'
      ) x ORDER BY at DESC LIMIT 8`, [id]);
    return {
      station: { id: st.id, name: st.name },
      token: makeToken(stationSecret(st), st.id, step),
      refreshInMs: ((step + 1) * QR_STEP_S * 1000) - Date.now(),
      serverTime: new Date().toISOString(),
      recent: recent.map((r) => ({ name: shortName(r.full_name), kind: r.kind, at: r.at })),
    };
  });

  /* ---------- Nhân viên quét mã ---------- */

  app.post('/api/attendance/scan', { preHandler: guard() }, async (req) => {
    const b = z.object({
      token: z.string().max(80),
      lat: z.number().min(-90).max(90).nullish(),
      lng: z.number().min(-180).max(180).nullish(),
      accuracy: z.number().min(0).max(100_000).nullish(),
    }).parse(req.body);
    const t = parseToken(b.token);
    const st = t ? await stationQr(pool, t.stationId) : null;
    if (!t || !st || !verifyToken(stationSecret(st), t)) {
      throw new HttpError(422, 'Mã QR không đúng hoặc đã hết hạn: quét lại mã đang hiện trên máy ở trạm', { code: 'BAD_TOKEN' });
    }
    const s = await one(pool, `SELECT id, full_name FROM staff WHERE user_id = $1 AND status = 'dang_lam'`, [req.user.id]);
    if (!s) throw new HttpError(409, 'Tài khoản chưa có hồ sơ nhân sự đang làm việc');
    let loc;
    try {
      loc = checkLocation(st, b);
    } catch (e) {
      // Lưu vết lần bị từ chối vì vị trí: nhân sự xem được ai cố chấm công từ xa
      await withTx(pool, (tx) => audit(tx, 'system', actorOf(req), 'hr.qr_rejected', 'staff', s.id,
        { station: st.id, reason: (e as HttpError).details ?? null, accuracy: b.accuracy ?? null }));
      throw e;
    }
    return withTx(pool, async (tx) => {
      await tx.query('SELECT 1 FROM staff WHERE id = $1 FOR UPDATE', [s.id]);
      const last = await one(tx, `SELECT GREATEST(check_in, COALESCE(check_out, check_in)) AS at FROM attendance WHERE staff_id = $1 ORDER BY check_in DESC LIMIT 1`, [s.id]);
      if (last && Date.now() - new Date(last.at).getTime() < REPEAT_GUARD_S * 1000) {
        throw new HttpError(409, `Bạn vừa chấm công lúc ${vnTime(last.at)}: chờ ${REPEAT_GUARD_S / 60} phút nếu muốn đổi vào/ra`, { code: 'REPEAT' });
      }
      const open = await one(tx, 'SELECT * FROM attendance WHERE staff_id = $1 AND check_out IS NULL FOR UPDATE', [s.id]);
      if (open) {
        const flags = [...loc.flags, ...(open.station_id && open.station_id !== st.id ? ['ra_khac_tram'] : [])];
        const a = await one(tx, `UPDATE attendance SET check_out = now(), out_station_id = $2, out_distance_m = $3, source_out = 'qr',
                                        flags = ARRAY(SELECT DISTINCT unnest(flags || $4::text[])) WHERE id = $1 RETURNING *`,
          [open.id, st.id, loc.distance, flags]);
        await audit(tx, 'system', actorOf(req), 'hr.check_out', 'staff', s.id, { station: st.id, distance: loc.distance, source: 'qr', flags });
        return { checkedIn: false, at: a.check_out, since: a.check_in, station: { id: st.id, name: st.name }, distance: loc.distance, flags };
      }
      const a = await one(tx, `INSERT INTO attendance(staff_id, check_in, source, station_id, in_distance_m, in_accuracy_m, flags)
                               VALUES ($1, now(), 'qr', $2, $3, $4, $5) RETURNING *`, [s.id, st.id, loc.distance, loc.accuracy, loc.flags]);
      await audit(tx, 'system', actorOf(req), 'hr.check_in', 'staff', s.id, { station: st.id, distance: loc.distance, source: 'qr', flags: loc.flags });
      return { checkedIn: true, at: a.check_in, station: { id: st.id, name: st.name }, distance: loc.distance, flags: loc.flags };
    });
  });

  /* ---------- Nhân sự: cài đặt máy chấm công từng trạm, nhật ký ---------- */

  app.get('/api/attendance/stations', { preHandler: guard(...VIEW) }, async () => many(pool, `
    SELECT s.id, s.name, s.kind, s.active, a.station_id IS NOT NULL AS configured, a.radius_m, a.require_gps, a.updated_at, u.full_name AS updated_by_name,
           (SELECT count(*)::int FROM attendance x WHERE x.station_id = s.id AND x.check_out IS NULL) AS present,
           (SELECT count(*)::int FROM attendance x WHERE x.station_id = s.id AND (x.check_in AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = vn_today()) AS today
      FROM stations s LEFT JOIN station_attendance a ON a.station_id = s.id LEFT JOIN users u ON u.id = a.updated_by
     ORDER BY s.active DESC, s.id`));

  /** Cấp (hoặc cấp lại) máy chấm công cho trạm: khóa cũ hết hiệu lực ngay. Đường dẫn chỉ trả về một lần. */
  app.post('/api/attendance/stations/:id/kiosk', { preHandler: guard(...HR) }, async (req) => {
    const id = stationParam(req.params);
    const c = newKioskCredentials();
    return withTx(pool, async (tx) => {
      const st = await one(tx, 'SELECT id, name, active FROM stations WHERE id = $1', [id]);
      if (!st) throw new HttpError(404, 'Không tìm thấy trạm');
      if (!st.active) throw new HttpError(409, 'Trạm đang ngừng hoạt động');
      const prev = await one(tx, `INSERT INTO station_attendance(station_id, secret_enc, kiosk_key_hash, updated_by) VALUES ($1, $2, $3, $4)
                                   ON CONFLICT (station_id) DO UPDATE SET secret_enc = $2, kiosk_key_hash = $3, updated_by = $4, updated_at = now()
                                   RETURNING (xmax <> 0) AS replaced`, [id, c.secretEnc, c.keyHash, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'hr.kiosk_issued', 'station', id, { replaced: prev.replaced });
      // Khóa nằm sau dấu # nên trình duyệt không gửi lên máy chủ, không lọt vào nhật ký truy cập
      return { stationId: id, name: st.name, replaced: prev.replaced, kioskPath: `/may-cham-cong?tram=${encodeURIComponent(id)}#k=${c.key}` };
    });
  });

  app.patch('/api/attendance/stations/:id', { preHandler: guard(...HR) }, async (req) => {
    const id = stationParam(req.params);
    const b = z.object({ radiusM: z.number().int().min(50).max(5000).optional(), requireGps: z.boolean().optional() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const r = await one(tx, `UPDATE station_attendance SET radius_m = COALESCE($2, radius_m), require_gps = COALESCE($3, require_gps), updated_by = $4, updated_at = now()
                                WHERE station_id = $1 RETURNING station_id, radius_m, require_gps`, [id, b.radiusM ?? null, b.requireGps ?? null, req.user.id]);
      if (!r) throw new HttpError(404, 'Trạm chưa cấp máy chấm công');
      await audit(tx, 'system', actorOf(req), 'hr.kiosk_settings', 'station', id, b);
      return r;
    });
  });

  /** Thu hồi máy chấm công (mất máy tính bảng): mã cũ không còn được nhận */
  app.delete('/api/attendance/stations/:id/kiosk', { preHandler: guard(...HR) }, async (req) => {
    const id = stationParam(req.params);
    return withTx(pool, async (tx) => {
      const r = await one(tx, 'DELETE FROM station_attendance WHERE station_id = $1 RETURNING station_id', [id]);
      if (!r) throw new HttpError(404, 'Trạm chưa cấp máy chấm công');
      await audit(tx, 'system', actorOf(req), 'hr.kiosk_revoked', 'station', id);
      return { ok: true };
    });
  });

  app.get('/api/attendance/log', { preHandler: guard(...VIEW) }, async (req) => {
    const q = z.object({ date: date.optional(), stationId: z.string().max(32).optional(), flagged: z.enum(['1']).optional() }).parse(req.query);
    return many(pool, `
      SELECT a.id, a.check_in, a.check_out, a.source, a.source_out, a.station_id, a.out_station_id, a.in_distance_m, a.in_accuracy_m, a.out_distance_m, a.flags,
             s.code, s.full_name, s.title, s.station_id AS home_station, si.name AS station_name, so.name AS out_station_name,
             round(extract(epoch FROM (COALESCE(a.check_out, now()) - a.check_in)) / 3600, 2)::float8 AS hours
        FROM attendance a JOIN staff s ON s.id = a.staff_id
        LEFT JOIN stations si ON si.id = a.station_id LEFT JOIN stations so ON so.id = a.out_station_id
       WHERE (a.check_in AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = COALESCE($1::date, vn_today())
         AND ($2::text IS NULL OR a.station_id = $2 OR a.out_station_id = $2)
         AND ($3::text IS NULL OR cardinality(a.flags) > 0)
       ORDER BY a.check_in DESC LIMIT 500`, [q.date ?? null, q.stationId ?? null, q.flagged ?? null]);
  });
}

/** "Nguyễn Văn An" -> "Nguyễn V. An": đủ để người vừa quét nhận ra mình, không phơi cả họ tên trên màn hình chung */
function shortName(full: string) {
  const p = full.trim().split(/\s+/);
  if (p.length <= 2) return full;
  return [p[0], ...p.slice(1, -1).map((w) => `${w[0]}.`), p[p.length - 1]].join(' ');
}

const vnTime = (d: string | Date) => new Date(d).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
