import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, REVIEW_ROLES, type Ctx } from '../http.js';
import { CARE_LABELS, categoryOf, SCOPE_CATEGORY, scopeContext } from '../scope.js';

const CATEGORY = z.enum(Object.keys(SCOPE_CATEGORY) as [string, ...string[]]);

/**
 * Admin chỉnh phạm vi thực hiện (thuốc, can thiệp nào nhóm chức danh nào được tự làm), nhóm chức danh và vai trò
 * trong kíp của từng người, quyền cấp riêng cho từng người; danh mục cận lâm sàng. Kíp đọc để phiếu tự kiểm tra.
 */
export function registerScope(app: FastifyInstance, { pool }: Ctx) {
  const admin = { preHandler: guard('admin') };
  const anyone = { preHandler: guard() };

  app.get('/api/scope/context', { preHandler: guard('crew', 'calltaker', 'dispatcher', 'supervisor', 'qa', 'admin') }, async (req) => {
    const q = z.object({ transferId: z.string().uuid().optional() }).parse(req.query);
    return { ...(await scopeContext(pool, q.transferId ?? null, req.user.id)), categories: SCOPE_CATEGORY };
  });

  /* ---------- Danh sách giới hạn ---------- */
  app.get('/api/scope/rules', { preHandler: guard(...REVIEW_ROLES) }, async () => ({
    rules: await many(pool, `SELECT r.*, u.full_name AS updated_by_name,
                                    (SELECT count(*)::int FROM scope_grants g WHERE g.rule_id = r.id AND g.revoked_at IS NULL) AS grant_count
                               FROM scope_rules r LEFT JOIN users u ON u.id = r.updated_by ORDER BY r.kind DESC, r.label`),
    categories: SCOPE_CATEGORY,
    care: CARE_LABELS,
    drugs: await many(pool, `SELECT id, name FROM drugs WHERE active AND kind IN ('thuoc', 'dich_truyen') ORDER BY name`),
  }));

  app.post('/api/scope/rules', admin, async (req) => {
    const b = z.object({ kind: z.enum(['thuoc', 'can_thiep']), ref: z.string().min(1).max(60), allowed: z.array(CATEGORY).max(7), note: z.string().max(500).nullish() }).parse(req.body);
    return withTx(pool, async (tx) => {
      let label: string;
      if (b.kind === 'can_thiep') {
        label = CARE_LABELS[b.ref];
        if (!label) throw new HttpError(400, 'Không có ô can thiệp này trên phiếu');
      } else {
        const d = await one(tx, `SELECT name FROM drugs WHERE id = $1 AND kind IN ('thuoc', 'dich_truyen')`, [Number(b.ref) || 0]);
        if (!d) throw new HttpError(400, 'Không có thuốc này trong danh mục');
        label = d.name;
      }
      if (await one(tx, 'SELECT 1 FROM scope_rules WHERE kind = $1 AND ref = $2', [b.kind, b.ref])) throw new HttpError(409, `${label} đã có trong danh sách`);
      const r = await one(tx, `INSERT INTO scope_rules(kind, ref, label, allowed, note, updated_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [b.kind, b.ref, label, b.allowed, b.note ?? null, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'scope.rule_added', 'scope_rule', String(r.id), { label, allowed: b.allowed });
      return r;
    });
  });

  app.patch('/api/scope/rules/:id', admin, async (req) => {
    const id = z.object({ id: z.coerce.number().int() }).parse(req.params).id;
    const b = z.object({ allowed: z.array(CATEGORY).max(7).optional(), active: z.boolean().optional(), note: z.string().max(500).nullish() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const r = await one(tx, `UPDATE scope_rules SET allowed = coalesce($2, allowed), active = coalesce($3, active),
                                      note = CASE WHEN $5 THEN $4 ELSE note END, updated_by = $6, updated_at = now()
                                WHERE id = $1 RETURNING *`, [id, b.allowed ?? null, b.active ?? null, b.note ?? null, 'note' in b, req.user.id]);
      if (!r) throw new HttpError(404, 'Không tìm thấy dòng');
      await audit(tx, 'system', actorOf(req), 'scope.rule_changed', 'scope_rule', String(id), b);
      return r;
    });
  });

  /* ---------- Từng người: nhóm chức danh, vai trò trong kíp, quyền cấp riêng ---------- */
  app.get('/api/scope/people', admin, async () => {
    const rows = await many(pool, `
      SELECT u.id, u.username, u.full_name, u.title, u.role, u.scope_category, u.crew_roles, u.license_no,
             coalesce((SELECT json_agg(json_build_object('id', g.id, 'rule_id', g.rule_id, 'label', r.label, 'note', g.note, 'expires_on', g.expires_on) ORDER BY r.label)
                         FROM scope_grants g JOIN scope_rules r ON r.id = g.rule_id
                        WHERE g.user_id = u.id AND g.revoked_at IS NULL), '[]') AS grants
        FROM users u WHERE u.active AND u.role IN ('crew', 'supervisor') ORDER BY u.full_name`);
    return rows.map((r) => ({ ...r, category: categoryOf(r.scope_category, r.title) }));
  });

  app.patch('/api/users/:id/scope', admin, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ scopeCategory: CATEGORY.nullable().optional(), crewRoles: z.array(z.string().min(1).max(60)).max(20).nullable().optional() }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (b.crewRoles?.length) {
        const known = new Set((await many(tx, 'SELECT name FROM crew_roles')).map((r) => r.name));
        const bad = b.crewRoles.filter((r) => !known.has(r));
        if (bad.length) throw new HttpError(400, `Vai trò chưa có trong danh mục: ${bad.join(', ')}`);
      }
      const u = await one(tx, `UPDATE users SET scope_category = CASE WHEN $2 THEN $3 ELSE scope_category END,
                                      crew_roles = CASE WHEN $4 THEN $5::text[] ELSE crew_roles END
                                WHERE id = $1 RETURNING id, scope_category, crew_roles`,
      [id, 'scopeCategory' in b, b.scopeCategory ?? null, 'crewRoles' in b, b.crewRoles?.length ? b.crewRoles : null]);
      if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản');
      await audit(tx, 'system', actorOf(req), 'scope.person_changed', 'user', id, b);
      return u;
    });
  });

  app.post('/api/scope/grants', admin, async (req) => {
    const b = z.object({ userId: z.string().uuid(), ruleId: z.number().int(), note: z.string().max(500).nullish(), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (!await one(tx, 'SELECT 1 FROM scope_rules WHERE id = $1', [b.ruleId])) throw new HttpError(404, 'Không tìm thấy dòng trong danh sách giới hạn');
      if (await one(tx, 'SELECT 1 FROM scope_grants WHERE user_id = $1 AND rule_id = $2 AND revoked_at IS NULL', [b.userId, b.ruleId])) throw new HttpError(409, 'Người này đã được cấp mục này');
      const g = await one(tx, `INSERT INTO scope_grants(user_id, rule_id, note, expires_on, granted_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [b.userId, b.ruleId, b.note ?? null, b.expiresOn ?? null, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'scope.granted', 'user', b.userId, { ruleId: b.ruleId, expiresOn: b.expiresOn });
      return g;
    });
  });

  app.post('/api/scope/grants/:id/revoke', admin, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    await withTx(pool, async (tx) => {
      const g = await one(tx, 'UPDATE scope_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING user_id, rule_id', [id]);
      if (!g) throw new HttpError(404, 'Không tìm thấy quyền đang hiệu lực');
      await audit(tx, 'system', actorOf(req), 'scope.revoked', 'user', g.user_id, { ruleId: g.rule_id });
    });
    return { ok: true };
  });

  /** Ca có y lệnh qua bác sĩ trao đổi: để quản lý chất lượng rà soát */
  app.get('/api/scope/consults', { preHandler: guard(...REVIEW_ROLES) }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }).parse(req.query);
    return many(pool, `
      SELECT t.id, t.transfer_number, t.status, t.signed_at, t.vehicle_id, c.value AS consult
        FROM transfers t, jsonb_array_elements(coalesce(t.epcr->'consults', '[]')) c
       WHERE t.created_at >= now() - make_interval(days => $1) ORDER BY t.created_at DESC LIMIT 500`, [q.days]);
  });

  /* ---------- Vai trò trong kíp ---------- */
  /** mine=1: vai trò người đang đăng nhập được nhận khi vào ca (admin quy định; để trống = mọi vai trò đang dùng) */
  app.get('/api/crew-roles', anyone, async (req) => {
    if ((req.query as { mine?: string }).mine !== '1') return many(pool, 'SELECT * FROM crew_roles ORDER BY sort, name');
    return many(pool, `SELECT r.* FROM crew_roles r, users u WHERE u.id = $1 AND r.active AND (u.crew_roles IS NULL OR r.name = ANY(u.crew_roles))
                        ORDER BY r.sort, r.name`, [req.user.id]);
  });

  app.post('/api/crew-roles', admin, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(60), sort: z.number().int().default(50) }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (await one(tx, 'SELECT 1 FROM crew_roles WHERE lower(name) = lower($1)', [b.name])) throw new HttpError(409, `Vai trò ${b.name} đã có`);
      const r = await one(tx, 'INSERT INTO crew_roles(name, sort) VALUES ($1,$2) RETURNING *', [b.name, b.sort]);
      await audit(tx, 'system', actorOf(req), 'crew_role.added', 'crew_role', b.name);
      return r;
    });
  });

  app.patch('/api/crew-roles/:name', admin, async (req) => {
    const name = z.object({ name: z.string().min(1) }).parse(req.params).name;
    const b = z.object({ active: z.boolean().optional(), sort: z.number().int().optional() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const r = await one(tx, 'UPDATE crew_roles SET active = coalesce($2, active), sort = coalesce($3, sort) WHERE name = $1 RETURNING *', [name, b.active ?? null, b.sort ?? null]);
      if (!r) throw new HttpError(404, 'Không tìm thấy vai trò');
      await audit(tx, 'system', actorOf(req), 'crew_role.changed', 'crew_role', name, b);
      return r;
    });
  });

  /* ---------- Danh mục cận lâm sàng tại chỗ ---------- */
  app.get('/api/lab-types', anyone, async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    return many(pool, `SELECT code, name, unit, normal_low::float, normal_high::float, sort, active FROM lab_types ${all ? '' : 'WHERE active'} ORDER BY sort, name`);
  });

  const labBody = { name: z.string().trim().min(2).max(120), unit: z.string().trim().max(30).nullish(), normalLow: z.number().nullish(), normalHigh: z.number().nullish(), sort: z.number().int().optional() };
  app.post('/api/lab-types', admin, async (req) => {
    const b = z.object({ code: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,30}$/), ...labBody }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (await one(tx, 'SELECT 1 FROM lab_types WHERE code = $1', [b.code])) throw new HttpError(409, `Mã ${b.code} đã có`);
      const r = await one(tx, `INSERT INTO lab_types(code, name, unit, normal_low, normal_high, sort) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [b.code, b.name, b.unit ?? null, b.normalLow ?? null, b.normalHigh ?? null, b.sort ?? 50]);
      await audit(tx, 'system', actorOf(req), 'lab_type.added', 'lab_type', b.code);
      return r;
    });
  });

  app.patch('/api/lab-types/:code', admin, async (req) => {
    const code = z.object({ code: z.string().min(1) }).parse(req.params).code;
    const b = z.object({ ...labBody, name: labBody.name.optional(), active: z.boolean().optional() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const r = await one(tx, `UPDATE lab_types SET name = coalesce($2, name), unit = CASE WHEN $8 THEN $3 ELSE unit END,
                                      normal_low = CASE WHEN $9 THEN $4 ELSE normal_low END, normal_high = CASE WHEN $10 THEN $5 ELSE normal_high END,
                                      sort = coalesce($6, sort), active = coalesce($7, active)
                                WHERE code = $1 RETURNING *`,
      [code, b.name ?? null, b.unit ?? null, b.normalLow ?? null, b.normalHigh ?? null, b.sort ?? null, b.active ?? null, 'unit' in b, 'normalLow' in b, 'normalHigh' in b]);
      if (!r) throw new HttpError(404, 'Không tìm thấy loại xét nghiệm');
      await audit(tx, 'system', actorOf(req), 'lab_type.changed', 'lab_type', code, b);
      return r;
    });
  });
}
