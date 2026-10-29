import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx, type Tx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';

/** Lập ca trực: điều phối viên (không phải người tiếp nhận cuộc gọi), trưởng ca */
const DUTY_EDIT: Role[] = ['dispatcher', 'supervisor'];
const DUTY_VIEW: Role[] = ['calltaker', 'dispatcher', 'supervisor', 'admin', 'director', 'crew'];

const Body = z.object({
  vehicleId: z.string().min(1),
  stationId: z.string().min(1).nullish(),
  place: z.string().trim().max(200).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(1000).nullish(),
  equipment: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  members: z.array(z.object({ userId: z.string().uuid(), position: z.string().trim().min(1).max(60) })).max(10).default([]),
}).refine((b) => b.stationId || b.place, 'Chọn điểm trực hoặc ghi vị trí trực tạm').refine((b) => new Date(b.endsAt) > new Date(b.startsAt), 'Giờ kết thúc phải sau giờ bắt đầu');
type DutyBody = z.infer<typeof Body>;

/**
 * Ca trực do điều phối viên lập: xe nào trực ở đâu (điểm có sẵn hoặc vị trí tạm như sân vận động, ngã tư), trong khoảng giờ nào,
 * ai ở vị trí nào trong kíp, mang thêm thiết bị gì. Người trong ca trực đăng nhập ca trên xe đó thì không bị giới hạn theo điểm.
 */
export function registerDuty(app: FastifyInstance, { pool }: Ctx) {
  async function validate(tx: Tx, b: DutyBody, exceptId: string | null) {
    if (!(await one(tx, 'SELECT 1 FROM vehicles WHERE id = $1', [b.vehicleId]))) throw new HttpError(404, 'Không tìm thấy xe');
    if (b.stationId && !(await one(tx, 'SELECT 1 FROM stations WHERE id = $1 AND active', [b.stationId]))) throw new HttpError(409, 'Điểm không tồn tại hoặc đang tạm ngưng');
    const clash = await one(tx, `SELECT 1 FROM duty_posts WHERE vehicle_id = $1 AND status = 'ke_hoach' AND ($4::uuid IS NULL OR id <> $4)
                                   AND tstzrange(starts_at, ends_at) && tstzrange($2::timestamptz, $3::timestamptz)`, [b.vehicleId, b.startsAt, b.endsAt, exceptId]);
    if (clash) throw new HttpError(409, `Xe ${b.vehicleId} đã có ca trực trùng giờ`);
    const roles = new Set((await many(tx, 'SELECT name FROM crew_roles WHERE active')).map((r) => r.name));
    for (const m of b.members) {
      if (!roles.has(m.position)) throw new HttpError(400, `Vị trí "${m.position}" không có trong danh mục vị trí trong kíp`);
      const u = await one(tx, `SELECT full_name, role, active FROM users WHERE id = $1`, [m.userId]);
      if (!u?.active || u.role !== 'crew') throw new HttpError(400, 'Chỉ xếp được nhân viên kíp đang làm việc');
      const busy = await one(tx, `SELECT p.vehicle_id FROM duty_post_members m JOIN duty_posts p ON p.id = m.post_id
                                   WHERE m.user_id = $1 AND p.status = 'ke_hoach' AND ($4::uuid IS NULL OR p.id <> $4)
                                     AND tstzrange(p.starts_at, p.ends_at) && tstzrange($2::timestamptz, $3::timestamptz)`, [m.userId, b.startsAt, b.endsAt, exceptId]);
      if (busy) throw new HttpError(409, `${u.full_name} đã có ca trực trùng giờ trên xe ${busy.vehicle_id}`);
    }
    if (new Set(b.members.map((m) => m.userId)).size !== b.members.length) throw new HttpError(400, 'Một người chỉ xếp một vị trí');
  }

  async function save(tx: Tx, id: string, b: DutyBody) {
    await tx.query('DELETE FROM duty_post_members WHERE post_id = $1', [id]);
    for (const m of b.members) await tx.query('INSERT INTO duty_post_members(post_id, user_id, position) VALUES ($1,$2,$3)', [id, m.userId, m.position]);
  }

  app.get('/api/duty-posts', { preHandler: guard(...DUTY_VIEW) }, async (req) => {
    const q = z.object({ from: z.string().optional(), to: z.string().optional(), mine: z.enum(['1']).optional() }).parse(req.query);
    return many(pool, `
      SELECT p.*, s.name AS station_name, v.type AS vehicle_type, u.full_name AS created_by_name,
             coalesce((SELECT json_agg(json_build_object('userId', m.user_id, 'position', m.position, 'name', mu.full_name, 'title', mu.title)
                                ORDER BY cr.sort NULLS LAST, mu.full_name)
                         FROM duty_post_members m JOIN users mu ON mu.id = m.user_id LEFT JOIN crew_roles cr ON cr.name = m.position
                        WHERE m.post_id = p.id), '[]') AS members
        FROM duty_posts p JOIN vehicles v ON v.id = p.vehicle_id LEFT JOIN stations s ON s.id = p.station_id LEFT JOIN users u ON u.id = p.created_by
       WHERE p.status = 'ke_hoach' AND p.ends_at >= coalesce($1::timestamptz, now() - interval '12 hours')
         AND p.starts_at <= coalesce($2::timestamptz, now() + interval '7 days')
         AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM duty_post_members m WHERE m.post_id = p.id AND m.user_id = $3))
       ORDER BY p.starts_at, p.vehicle_id`, [q.from ?? null, q.to ?? null, q.mine || req.user.role === 'crew' ? req.user.id : null]);
  });

  app.post('/api/duty-posts', { preHandler: guard(...DUTY_EDIT) }, async (req) => {
    const b = Body.parse(req.body);
    return withTx(pool, async (tx) => {
      await validate(tx, b, null);
      const p = await one(tx, `INSERT INTO duty_posts(vehicle_id, station_id, place, lat, lng, starts_at, ends_at, note, equipment, created_by)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.vehicleId, b.stationId ?? null, b.place ?? null, b.lat ?? null, b.lng ?? null, b.startsAt, b.endsAt, b.note ?? null, b.equipment, req.user.id]);
      await save(tx, p.id, b);
      await audit(tx, 'system', actorOf(req), 'duty_post.created', 'duty_post', p.id, { vehicleId: b.vehicleId, place: b.place ?? b.stationId, members: b.members.length });
      for (const m of b.members) {
        await tx.query(`INSERT INTO notifications(user_id, kind, title, body, link) VALUES ($1, 'duty_post', $2, $3, '/kip')`,
          [m.userId, `Ca trực trên xe ${b.vehicleId}: ${m.position}`, `${b.place ?? b.stationId}, từ ${b.startsAt}`]);
      }
      return p;
    });
  });

  app.put('/api/duty-posts/:id', { preHandler: guard(...DUTY_EDIT) }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = Body.parse(req.body);
    return withTx(pool, async (tx) => {
      const cur = await one(tx, `SELECT status FROM duty_posts WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur) throw new HttpError(404, 'Không tìm thấy ca trực');
      if (cur.status !== 'ke_hoach') throw new HttpError(409, 'Ca trực đã hủy');
      await validate(tx, b, id);
      const p = await one(tx, `UPDATE duty_posts SET vehicle_id = $2, station_id = $3, place = $4, lat = $5, lng = $6, starts_at = $7, ends_at = $8, note = $9, equipment = $10
                                WHERE id = $1 RETURNING *`,
      [id, b.vehicleId, b.stationId ?? null, b.place ?? null, b.lat ?? null, b.lng ?? null, b.startsAt, b.endsAt, b.note ?? null, b.equipment]);
      await save(tx, id, b);
      await audit(tx, 'system', actorOf(req), 'duty_post.updated', 'duty_post', id, { members: b.members.length });
      return p;
    });
  });

  app.post('/api/duty-posts/:id/cancel', { preHandler: guard(...DUTY_EDIT) }, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    await withTx(pool, async (tx) => {
      const r = await tx.query(`UPDATE duty_posts SET status = 'huy' WHERE id = $1 AND status = 'ke_hoach'`, [id]);
      if (!r.rowCount) throw new HttpError(409, 'Ca trực không còn hiệu lực');
      await audit(tx, 'system', actorOf(req), 'duty_post.cancelled', 'duty_post', id);
    });
    return { ok: true };
  });

  /* ---------- Nhiệm vụ từng vị trí trong kíp ---------- */
  const PHASE = z.enum(['dau_ca', 'hien_truong', 'sau_ca']);
  const tasksOf = (q: Tx | typeof pool, positions: string[] | null) => many(q, `
    SELECT r.name AS position, r.sort,
           coalesce((SELECT json_agg(json_build_object('phase', t.phase, 'task', t.task) ORDER BY t.phase, t.sort, t.id)
                       FROM crew_duty_tasks t WHERE t.position = r.name), '[]') AS tasks
      FROM crew_roles r WHERE r.active AND ($1::text[] IS NULL OR r.name = ANY($1)) ORDER BY r.sort, r.name`, [positions]);

  app.get('/api/duty-tasks', { preHandler: guard() }, async () => tasksOf(pool, null));

  /** Việc của tôi: theo vị trí đang nhận ca trên xe, hoặc vị trí được xếp trong ca trực sắp tới */
  app.get('/api/duty-tasks/mine', { preHandler: guard() }, async (req) => {
    const s = await one(pool, `SELECT crew_role AS position, vehicle_id FROM crew_shifts WHERE user_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`, [req.user.id])
      ?? await one(pool, `SELECT m.position, p.vehicle_id FROM duty_post_members m JOIN duty_posts p ON p.id = m.post_id
                           WHERE m.user_id = $1 AND p.status = 'ke_hoach' AND p.ends_at > now() ORDER BY p.starts_at LIMIT 1`, [req.user.id]);
    if (!s) return { position: null, vehicleId: null, tasks: [] };
    const [row] = await tasksOf(pool, [s.position]);
    return { position: s.position, vehicleId: s.vehicle_id, tasks: row?.tasks ?? [] };
  });

  /** Thay cả danh sách việc của một vị trí. Đã khóa cấu hình thì trưởng nhóm kíp đề xuất, quản trị duyệt. */
  app.put('/api/duty-tasks/:position', { preHandler: guard('admin') }, async (req) => {
    const position = z.object({ position: z.string().min(1).max(60) }).parse(req.params).position;
    const b = z.object({ tasks: z.array(z.object({ phase: PHASE, task: z.string().trim().min(2).max(300) })).max(60) }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (!(await one(tx, 'SELECT 1 FROM crew_roles WHERE name = $1', [position]))) throw new HttpError(404, `Không có vị trí "${position}"`);
      await tx.query('DELETE FROM crew_duty_tasks WHERE position = $1', [position]);
      let i = 0;
      for (const t of b.tasks) await tx.query('INSERT INTO crew_duty_tasks(position, phase, sort, task) VALUES ($1,$2,$3,$4)', [position, t.phase, ++i, t.task]);
      await audit(tx, 'system', actorOf(req), 'duty_tasks.updated', 'crew_role', position, { count: b.tasks.length });
      return (await tasksOf(tx, [position]))[0];
    });
  });

  /** Danh sách để xếp ca: nhân viên kíp đang làm, xe, vị trí trong kíp */
  app.get('/api/duty/options', { preHandler: guard(...DUTY_VIEW) }, async () => ({
    crew: await many(pool, `SELECT id, full_name, title, station_id, crew_roles FROM users WHERE role = 'crew' AND active ORDER BY full_name`),
    vehicles: await many(pool, `SELECT id, plate, type, station_id, status FROM vehicles ORDER BY id`),
    positions: (await many(pool, `SELECT name FROM crew_roles WHERE active ORDER BY sort, name`)).map((r) => r.name),
  }));

  /** Bảng giá áp cho ca trực, để điều phối viên báo giá: chỉ giá, không có số liệu thu chi */
  app.get('/api/duty/prices', { preHandler: guard('calltaker', 'dispatcher', 'supervisor', 'admin', 'director', 'accountant') }, async () => ({
    priceLists: await many(pool, `SELECT id, name, vehicle_type, base_fee, base_km, per_km, wait_per_hour, night_surcharge_pct, effective_from
                                    FROM price_lists WHERE active ORDER BY vehicle_type, effective_from DESC`),
    services: await many(pool, `SELECT id, code, name, unit, price, care_key, lab_type FROM service_prices WHERE active ORDER BY sort, name`),
  }));
}

/** Ca trực đang hiệu lực của một người trên một xe (để đăng nhập ca không bị giới hạn theo điểm, gợi ý vị trí trong kíp) */
export async function activeDutyFor(tx: Tx, userId: string, vehicleId: string) {
  return one(tx, `SELECT p.id, m.position FROM duty_post_members m JOIN duty_posts p ON p.id = m.post_id
                   WHERE m.user_id = $1 AND p.vehicle_id = $2 AND p.status = 'ke_hoach'
                     AND now() BETWEEN p.starts_at - interval '1 hour' AND p.ends_at`, [userId, vehicleId]);
}
