import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { toCsv } from '../finance.js';
import {
  addRoster, CME_REQUIRED_HOURS, DOC_KIND, EXPIRY_WARN_DAYS, LEAVE_KIND, requiredDocs, SHIFT, staffCompliance, timesheet, TRAINING_KIND,
} from '../hr.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';

const HR: Role[] = ['hr', 'admin'];
const HR_VIEW: Role[] = ['hr', 'admin', 'director'];
const ROSTER_VIEW: Role[] = [...HR_VIEW, 'supervisor', 'dispatcher'];
const LEAVE_APPROVERS: Role[] = ['hr', 'director', 'supervisor'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const opt = (n = 500) => z.string().trim().max(n).nullish();
const idParam = (p: unknown, k = 'id') => z.object({ [k]: z.string().uuid() }).parse(p)[k] as string;
const vnToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

export function registerHr(app: FastifyInstance, { pool }: Ctx) {
  app.get('/api/hr/meta', { preHandler: guard() }, async () => ({
    docKinds: DOC_KIND, trainingKinds: TRAINING_KIND, shifts: SHIFT, leaveKinds: LEAVE_KIND, cmeRequiredHours: CME_REQUIRED_HOURS, expiryWarnDays: EXPIRY_WARN_DAYS,
  }));

  /* ---------- Hồ sơ ---------- */

  app.get('/api/hr/staff', { preHandler: guard(...HR_VIEW) }, async (req) => {
    const q = z.object({ status: z.enum(['dang_lam', 'tam_nghi', 'nghi_viec']).optional(), q: z.string().max(80).optional() }).parse(req.query);
    const rows = await many(pool, `
      SELECT s.*, u.username, u.role, u.active AS account_active
        FROM staff s LEFT JOIN users u ON u.id = s.user_id
       WHERE ($1::text IS NULL OR s.status = $1) AND ($2::text IS NULL OR vn_plain(s.full_name) LIKE '%' || vn_plain($2) || '%' OR s.code ILIKE '%' || $2 || '%')
       ORDER BY s.code`, [q.status ?? null, q.q ?? null]);
    for (const r of rows) Object.assign(r, await staffCompliance(pool, r.id));
    return rows;
  });

  const StaffBody = z.object({
    fullName: z.string().trim().min(2).max(120), title: opt(80), department: opt(80), stationId: z.string().nullish(),
    phone: opt(20), email: z.string().email().max(120).nullish().or(z.literal('').transform(() => null)), birthDate: date.nullish(), hireDate: date.nullish(),
    contractType: z.enum(['thu_viec', 'xac_dinh', 'khong_xac_dinh', 'cong_tac_vien']).nullish(), contractEnd: date.nullish(),
    status: z.enum(['dang_lam', 'tam_nghi', 'nghi_viec']).optional(), note: opt(1000),
  });
  const COLS: Record<string, string> = {
    fullName: 'full_name', title: 'title', department: 'department', stationId: 'station_id', phone: 'phone', email: 'email', birthDate: 'birth_date',
    hireDate: 'hire_date', contractType: 'contract_type', contractEnd: 'contract_end', status: 'status', note: 'note',
  };

  app.post('/api/hr/staff', { preHandler: guard(...HR) }, async (req) => {
    const b = StaffBody.parse(req.body);
    return withTx(pool, async (tx) => {
      const keys = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
      const s = await one(tx, `INSERT INTO staff(code, ${keys.map((k) => COLS[k]).join(', ')})
                               VALUES ('NV-' || lpad(nextval('staff_code_seq')::text, 4, '0'), ${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        keys.map((k) => (b as any)[k]));
      await audit(tx, 'system', actorOf(req), 'hr.staff_created', 'staff', s.id, { code: s.code });
      return s;
    });
  });

  app.patch('/api/hr/staff/:id', { preHandler: guard(...HR) }, async (req) => {
    const id = idParam(req.params);
    const b = StaffBody.partial().parse(req.body);
    const keys = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) return one(pool, 'SELECT * FROM staff WHERE id = $1', [id]);
    return withTx(pool, async (tx) => {
      const s = await one(tx, `UPDATE staff SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...keys.map((k) => (b as any)[k])]);
      if (!s) throw new HttpError(404, 'Không tìm thấy nhân viên');
      // Nghỉ việc thì khóa tài khoản đăng nhập
      if (b.status === 'nghi_viec' && s.user_id) await tx.query('UPDATE users SET active = false WHERE id = $1', [s.user_id]);
      await audit(tx, 'system', actorOf(req), 'hr.staff_updated', 'staff', id, b);
      return s;
    });
  });

  app.get('/api/hr/staff/:id', { preHandler: guard(...HR_VIEW) }, async (req) => {
    const id = idParam(req.params);
    const s = await one(pool, `SELECT s.*, u.username, u.role FROM staff s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = $1`, [id]);
    if (!s) throw new HttpError(404, 'Không tìm thấy nhân viên');
    const [docs, trainings, leave, roster] = await Promise.all([
      many(pool, `SELECT d.*, (d.expires_on < vn_today()) AS expired FROM staff_docs d WHERE staff_id = $1 ORDER BY kind, expires_on DESC NULLS LAST`, [id]),
      many(pool, 'SELECT * FROM trainings WHERE staff_id = $1 ORDER BY completed_on DESC', [id]),
      many(pool, 'SELECT * FROM leave_requests WHERE staff_id = $1 ORDER BY from_date DESC LIMIT 50', [id]),
      many(pool, `SELECT * FROM roster WHERE staff_id = $1 AND work_date >= vn_today() - 7 ORDER BY work_date LIMIT 60`, [id]),
    ]);
    const cme = await one(pool, `SELECT coalesce(sum(hours), 0)::float AS h FROM trainings WHERE staff_id = $1 AND kind = 'cme' AND completed_on > vn_today() - interval '5 years'`, [id]);
    return { ...s, docs, trainings, leave, roster, cmeHours: cme.h, required: requiredDocs(s.title), ...(await staffCompliance(pool, id)) };
  });

  app.post('/api/hr/staff/:id/docs', { preHandler: guard(...HR) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({
      kind: z.enum(Object.keys(DOC_KIND) as [string, ...string[]]), number: z.string().trim().min(1).max(60), issuer: opt(120),
      issuedOn: date.nullish(), expiresOn: date.nullish(), note: opt(),
    }).parse(req.body);
    if (b.issuedOn && b.expiresOn && b.expiresOn <= b.issuedOn) throw new HttpError(422, 'Ngày hết hạn phải sau ngày cấp');
    return withTx(pool, async (tx) => {
      const d = await one(tx, `INSERT INTO staff_docs(staff_id, kind, number, issuer, issued_on, expires_on, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, b.kind, b.number, b.issuer ?? null, b.issuedOn ?? null, b.expiresOn ?? null, b.note ?? null, req.user.id]);
      if (b.kind === 'gphn') await tx.query(`UPDATE users SET license_no = $2 WHERE id = (SELECT user_id FROM staff WHERE id = $1)`, [id, b.number]);
      await audit(tx, 'system', actorOf(req), 'hr.doc_added', 'staff', id, { kind: b.kind, number: b.number, expiresOn: b.expiresOn ?? null });
      return d;
    });
  });

  app.patch('/api/hr/docs/:id', { preHandler: guard(...HR) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ suspended: z.boolean().optional(), expiresOn: date.nullish(), note: opt() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const d = await one(tx, `UPDATE staff_docs SET suspended = coalesce($2, suspended), expires_on = CASE WHEN $5 THEN $3::date ELSE expires_on END,
                                      note = coalesce($4, note) WHERE id = $1 RETURNING *`,
        [id, b.suspended ?? null, b.expiresOn ?? null, b.note ?? null, b.expiresOn !== undefined]);
      if (!d) throw new HttpError(404, 'Không tìm thấy giấy tờ');
      await audit(tx, 'system', actorOf(req), b.suspended ? 'hr.doc_suspended' : 'hr.doc_updated', 'staff', d.staff_id, { kind: d.kind, ...b });
      return d;
    });
  });

  app.post('/api/hr/staff/:id/trainings', { preHandler: guard(...HR) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({
      course: z.string().trim().min(2).max(200), kind: z.enum(Object.keys(TRAINING_KIND) as [string, ...string[]]),
      hours: z.number().min(0).max(1000), completedOn: date, provider: opt(120), certificate: opt(60),
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      const t = await one(tx, `INSERT INTO trainings(staff_id, course, kind, hours, completed_on, provider, certificate, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, b.course, b.kind, b.hours, b.completedOn, b.provider ?? null, b.certificate ?? null, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'hr.training_added', 'staff', id, { course: b.course, hours: b.hours });
      return t;
    });
  });

  /** Giấy tờ hết hạn hoặc sắp hết hạn của nhân viên đang làm */
  app.get('/api/hr/expiring', { preHandler: guard(...HR_VIEW, 'supervisor') }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(EXPIRY_WARN_DAYS) }).parse(req.query);
    return many(pool, `
      SELECT d.id, d.kind, d.number, d.expires_on, d.suspended, (d.expires_on < vn_today()) AS expired, s.id AS staff_id, s.code, s.full_name, s.title, s.station_id
        FROM staff_docs d JOIN staff s ON s.id = d.staff_id
       WHERE s.status = 'dang_lam' AND (d.suspended OR d.expires_on < vn_today() + $1::int)
         AND NOT EXISTS (SELECT 1 FROM staff_docs n WHERE n.staff_id = d.staff_id AND n.kind = d.kind AND n.id <> d.id AND NOT n.suspended
                                                     AND (n.expires_on IS NULL OR n.expires_on >= vn_today() + $1::int))
       ORDER BY d.expires_on NULLS FIRST`, [q.days]);
  });

  /* ---------- Lịch trực, chấm công ---------- */

  app.get('/api/hr/roster', { preHandler: guard(...ROSTER_VIEW) }, async (req) => {
    const q = z.object({ from: date, to: date, stationId: z.string().optional() }).parse(req.query);
    return many(pool, `
      SELECT r.*, s.full_name, s.code, s.title FROM roster r JOIN staff s ON s.id = r.staff_id
       WHERE r.work_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR r.station_id = $3)
       ORDER BY r.work_date, r.shift, s.full_name`, [q.from, q.to, q.stationId ?? null]);
  });

  app.post('/api/hr/roster', { preHandler: guard(...HR, 'supervisor') }, async (req) => {
    const b = z.object({
      staffId: z.string().uuid(), workDate: date, shift: z.enum(['ngay', 'dem', 'truc_24', 'hanh_chinh']),
      stationId: z.string().nullish(), vehicleId: z.string().nullish(), note: opt(), override: z.boolean().optional(),
    }).parse(req.body);
    if (b.override && !b.note?.trim()) throw new HttpError(422, 'Xếp ca liền sau ca đêm/24 giờ phải ghi lý do');
    return withTx(pool, (tx) => addRoster(tx, actorOf(req), b));
  });

  app.delete('/api/hr/roster/:id', { preHandler: guard(...HR, 'supervisor') }, async (req) => {
    const id = idParam(req.params);
    return withTx(pool, async (tx) => {
      const r = await one(tx, 'DELETE FROM roster WHERE id = $1 RETURNING *', [id]);
      if (!r) throw new HttpError(404, 'Không tìm thấy ca');
      await audit(tx, 'system', actorOf(req), 'hr.roster_removed', 'staff', r.staff_id, { date: r.work_date, shift: r.shift });
      return { ok: true };
    });
  });

  app.get('/api/hr/timesheet', { preHandler: guard(...HR_VIEW, 'accountant') }, async (req, reply) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    const rows = await timesheet(pool, q.month);
    if (q.format === 'json') return rows;
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="bang-cong-${q.month}.csv"`);
    return toCsv([
      ['Mã NV', 'Họ tên', 'Chức danh', 'Điểm', 'Số ca theo lịch', 'Giờ theo lịch', 'Ca đêm/24h', 'Giờ trên xe', 'Giờ chấm công', 'Tổng giờ thực tế', 'Ngày nghỉ có duyệt'],
      ...rows.map((r) => [r.code, r.full_name, r.title, r.station_id, r.shifts, r.planned_hours, r.night_shifts, r.crew_hours, r.office_hours, r.actual_hours, r.leave_days]),
    ]);
  });

  /** Hồ sơ của chính mình: giấy tờ, lịch trực 14 ngày, chấm công đang mở */
  app.get('/api/hr/me', { preHandler: guard() }, async (req) => {
    const s = await one(pool, 'SELECT * FROM staff WHERE user_id = $1', [req.user.id]);
    if (!s) return { staff: null };
    const [docs, roster, open, leave] = await Promise.all([
      many(pool, `SELECT kind, number, expires_on, suspended, (expires_on < vn_today()) AS expired FROM staff_docs WHERE staff_id = $1 ORDER BY kind`, [s.id]),
      many(pool, `SELECT work_date, shift, station_id, vehicle_id FROM roster WHERE staff_id = $1 AND work_date BETWEEN vn_today() AND vn_today() + 14 ORDER BY work_date`, [s.id]),
      one(pool, `SELECT a.check_in, a.source, st.name AS station_name FROM attendance a LEFT JOIN stations st ON st.id = a.station_id
                  WHERE a.staff_id = $1 AND a.check_out IS NULL`, [s.id]),
      many(pool, 'SELECT * FROM leave_requests WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 20', [s.id]),
    ]);
    return { staff: s, docs, roster, openCheckIn: open?.check_in ?? null, openStation: open?.station_name ?? null, leave, ...(await staffCompliance(pool, s.id)) };
  });

  app.post('/api/hr/attendance/check', { preHandler: guard() }, async (req) => {
    return withTx(pool, async (tx) => {
      const s = await one(tx, 'SELECT id FROM staff WHERE user_id = $1', [req.user.id]);
      if (!s) throw new HttpError(409, 'Tài khoản chưa có hồ sơ nhân sự');
      // Bấm tay trên web: đánh dấu để nhân sự đối chiếu với chấm công QR tại trạm
      const open = await one(tx, `UPDATE attendance SET check_out = now(), source_out = 'web', flags = ARRAY(SELECT DISTINCT unnest(flags || '{thu_cong}'::text[]))
                                   WHERE staff_id = $1 AND check_out IS NULL RETURNING *`, [s.id]);
      if (open) {
        await audit(tx, 'system', actorOf(req), 'hr.check_out', 'staff', s.id);
        return { checkedIn: false, at: open.check_out };
      }
      const a = await one(tx, `INSERT INTO attendance(staff_id, check_in, flags) VALUES ($1, now(), '{thu_cong}') RETURNING *`, [s.id]);
      await audit(tx, 'system', actorOf(req), 'hr.check_in', 'staff', s.id);
      return { checkedIn: true, at: a.check_in };
    });
  });

  /* ---------- Nghỉ phép ---------- */

  app.get('/api/hr/leave', { preHandler: guard(...LEAVE_APPROVERS, 'admin') }, async (req) => {
    const q = z.object({ status: z.enum(['cho_duyet', 'da_duyet', 'tu_choi', 'huy']).optional() }).parse(req.query);
    return many(pool, `SELECT l.*, s.full_name, s.code, s.title, u.full_name AS decided_by_name
                         FROM leave_requests l JOIN staff s ON s.id = l.staff_id LEFT JOIN users u ON u.id = l.decided_by
                        WHERE ($1::text IS NULL OR l.status = $1) ORDER BY l.status = 'cho_duyet' DESC, l.from_date DESC LIMIT 300`, [q.status ?? null]);
  });

  app.post('/api/hr/leave', { preHandler: guard() }, async (req) => {
    const b = z.object({
      staffId: z.string().uuid().optional(), kind: z.enum(Object.keys(LEAVE_KIND) as [string, ...string[]]), fromDate: date, toDate: date, reason: opt(),
    }).parse(req.body);
    if (b.toDate < b.fromDate) throw new HttpError(422, 'Ngày kết thúc phải sau ngày bắt đầu');
    return withTx(pool, async (tx) => {
      let staffId = b.staffId;
      if (!staffId || !HR.includes(req.user.role)) {
        const s = await one(tx, 'SELECT id FROM staff WHERE user_id = $1', [req.user.id]);
        if (!s) throw new HttpError(409, 'Tài khoản chưa có hồ sơ nhân sự');
        staffId = s.id;
      }
      const overlap = await one(tx, `SELECT 1 FROM leave_requests WHERE staff_id = $1 AND status IN ('cho_duyet', 'da_duyet') AND from_date <= $3 AND to_date >= $2`,
        [staffId, b.fromDate, b.toDate]);
      if (overlap) throw new HttpError(409, 'Đã có đơn nghỉ trùng ngày');
      const l = await one(tx, `INSERT INTO leave_requests(staff_id, kind, from_date, to_date, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [staffId, b.kind, b.fromDate, b.toDate, b.reason ?? null, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'hr.leave_requested', 'staff', staffId!, { from: b.fromDate, to: b.toDate, kind: b.kind });
      return l;
    });
  });

  app.post('/api/hr/leave/:id/decide', { preHandler: guard(...LEAVE_APPROVERS) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ approve: z.boolean() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const l = await one(tx, `SELECT l.*, s.user_id FROM leave_requests l JOIN staff s ON s.id = l.staff_id WHERE l.id = $1 FOR UPDATE OF l`, [id]);
      if (!l) throw new HttpError(404, 'Không tìm thấy đơn');
      if (l.status !== 'cho_duyet') throw new HttpError(409, 'Đơn đã được xử lý');
      if (l.user_id === req.user.id) throw new HttpError(403, 'Không tự duyệt đơn nghỉ của mình');
      const clash = b.approve ? await many(tx, `SELECT work_date::text, shift FROM roster WHERE staff_id = $1 AND work_date BETWEEN $2 AND $3`, [l.staff_id, l.from_date, l.to_date]) : [];
      await tx.query('UPDATE leave_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1', [id, b.approve ? 'da_duyet' : 'tu_choi', req.user.id]);
      await audit(tx, 'system', actorOf(req), b.approve ? 'hr.leave_approved' : 'hr.leave_rejected', 'staff', l.staff_id, { from: l.from_date, to: l.to_date });
      return { ok: true, rosterClash: clash };
    });
  });

  app.get('/api/hr/summary', { preHandler: guard(...HR_VIEW) }, async () => {
    const today = vnToday();
    return one(pool, `
      SELECT (SELECT count(*) FROM staff WHERE status = 'dang_lam')::int AS active,
             (SELECT count(*) FROM leave_requests WHERE status = 'cho_duyet')::int AS leave_pending,
             (SELECT count(*) FROM leave_requests WHERE status = 'da_duyet' AND $1::date BETWEEN from_date AND to_date)::int AS on_leave_today,
             (SELECT count(*) FROM roster WHERE work_date = $1::date)::int AS rostered_today,
             (SELECT count(*) FROM staff WHERE status = 'dang_lam' AND contract_end BETWEEN vn_today() AND vn_today() + 30)::int AS contracts_ending`, [today]);
  });
}
