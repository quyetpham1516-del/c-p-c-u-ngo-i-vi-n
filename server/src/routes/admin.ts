import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx, type Queryable } from '../db.js';
import { checkAccount, normalizeTaxCode, sealCccd } from '../accounts.js';
import { hashPassword } from '../crypto.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx } from '../http.js';

const KIND = z.enum(['tru_so', 'tram', 'kho_trung_tam', 'diem_su_kien']);
const stationBody = {
  name: z.string().trim().min(2).max(120),
  kind: KIND,
  address: z.string().trim().max(300).nullish(),
  phone: z.string().trim().max(30).nullish(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
};

/**
 * Quản trị điểm/trạm và phân điểm: chỉ tài khoản admin quyết định có những điểm nào, xe nào đóng ở điểm nào,
 * nhân viên làm ở điểm nào. Kho thuốc, xe, kíp đều gắn với một điểm.
 */
export function registerAdmin(app: FastifyInstance, { pool, hub }: Ctx) {
  const admin = { preHandler: guard('admin') };

  app.get('/api/stations', { preHandler: guard() }, async (req) => {
    const all = req.user.role === 'admin' && (req.query as { all?: string }).all === '1';
    return many(pool, `
      SELECT s.*, (SELECT full_name FROM users WHERE id = s.manager_id) AS manager_name, (SELECT full_name FROM users WHERE id = s.deputy_id) AS deputy_name,
             (SELECT count(*)::int FROM vehicles v WHERE v.station_id = s.id) AS vehicle_count,
             (SELECT count(*)::int FROM users u WHERE u.station_id = s.id AND u.active) AS staff_count,
             (SELECT coalesce(sum(qty), 0)::float FROM stock_lots l WHERE l.station_id = s.id) AS stock_qty
        FROM stations s WHERE $1 OR s.active ORDER BY s.active DESC, (s.kind = 'tru_so') DESC, s.id`, [all]);
  });

  app.post('/api/stations', admin, async (req) => {
    const b = z.object({ id: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, 'Mã điểm chỉ gồm chữ, số, gạch ngang (2–20 ký tự)'), ...stationBody }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (await one(tx, 'SELECT 1 FROM stations WHERE id = $1', [b.id])) throw new HttpError(409, `Mã điểm ${b.id} đã có`);
      const s = await one(tx, `INSERT INTO stations(id, name, kind, address, phone, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.id, b.name, b.kind, b.address ?? null, b.phone ?? null, b.lat, b.lng]);
      await audit(tx, 'system', actorOf(req), 'station.created', 'station', b.id, b);
      return s;
    });
  });

  app.patch('/api/stations/:id', admin, async (req) => {
    const id = z.object({ id: z.string() }).parse(req.params).id;
    const b = z.object({
      name: stationBody.name.optional(), kind: KIND.optional(), address: stationBody.address, phone: stationBody.phone,
      lat: stationBody.lat.optional(), lng: stationBody.lng.optional(), active: z.boolean().optional(),
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      const cur = await one(tx, 'SELECT * FROM stations WHERE id = $1 FOR UPDATE', [id]);
      if (!cur) throw new HttpError(404, 'Không tìm thấy điểm');
      if (b.active === false) {
        const v = await one(tx, 'SELECT count(*)::int AS n FROM vehicles WHERE station_id = $1', [id]);
        if (v.n) throw new HttpError(409, `Điểm ${id} còn ${v.n} xe: chuyển xe sang điểm khác trước khi tạm ngưng`);
      }
      const s = await one(tx, `
        UPDATE stations SET name = coalesce($2, name), kind = coalesce($3, kind), address = CASE WHEN $4::boolean THEN $5 ELSE address END,
               phone = CASE WHEN $6::boolean THEN $7 ELSE phone END, lat = coalesce($8, lat), lng = coalesce($9, lng), active = coalesce($10, active)
         WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.kind ?? null, b.address !== undefined, b.address ?? null, b.phone !== undefined, b.phone ?? null,
        b.lat ?? null, b.lng ?? null, b.active ?? null]);
      await audit(tx, 'system', actorOf(req), 'station.updated', 'station', id, b);
      return s;
    });
  });

  /** Quản lý điểm và người thay: chọn trong nhân viên đang làm ở điểm đó */
  app.put('/api/stations/:id/managers', admin, async (req) => {
    const id = z.object({ id: z.string() }).parse(req.params).id;
    const b = z.object({ managerId: z.string().uuid().nullable(), deputyId: z.string().uuid().nullable() }).parse(req.body);
    if (b.managerId && b.managerId === b.deputyId) throw new HttpError(400, 'Quản lý điểm và người thay phải là hai người khác nhau');
    return withTx(pool, async (tx) => {
      if (!(await one(tx, 'SELECT 1 FROM stations WHERE id = $1 FOR UPDATE', [id]))) throw new HttpError(404, 'Không tìm thấy điểm');
      for (const uid of [b.managerId, b.deputyId].filter(Boolean)) {
        const u = await one(tx, 'SELECT full_name, station_id, active, role FROM users WHERE id = $1', [uid]);
        if (!u || !u.active || u.role === 'hospital') throw new HttpError(400, 'Tài khoản không hợp lệ hoặc đã khóa');
        if (u.station_id !== id) throw new HttpError(400, `${u.full_name} chưa được phân làm ở điểm ${id}: phân điểm trước rồi mới chọn làm quản lý`);
      }
      const s = await one(tx, 'UPDATE stations SET manager_id = $2, deputy_id = $3 WHERE id = $1 RETURNING *', [id, b.managerId, b.deputyId]);
      await audit(tx, 'system', actorOf(req), 'station.managers', 'station', id, b);
      return s;
    });
  });

  /** Chuyển xe sang điểm khác: chỉ khi xe không đang làm nhiệm vụ */
  app.patch('/api/vehicles/:id/station', admin, async (req) => {
    const id = z.object({ id: z.string() }).parse(req.params).id;
    const b = z.object({ stationId: z.string().min(1) }).parse(req.body);
    await withTx(pool, async (tx) => {
      const v = await one(tx, 'SELECT * FROM vehicles WHERE id = $1 FOR UPDATE', [id]);
      if (!v) throw new HttpError(404, 'Không tìm thấy xe');
      if (!['S1', 'S2', 'S9'].includes(v.status) || v.current_incident_id) throw new HttpError(409, `Xe ${id} đang làm nhiệm vụ (${v.status}), chưa chuyển điểm được`);
      const s = await one(tx, 'SELECT active FROM stations WHERE id = $1', [b.stationId]);
      if (!s?.active) throw new HttpError(409, 'Điểm không tồn tại hoặc đang tạm ngưng');
      await tx.query('UPDATE vehicles SET station_id = $2 WHERE id = $1', [id, b.stationId]);
      await audit(tx, 'system', actorOf(req), 'vehicle.station_changed', 'vehicle', id, { from: v.station_id, to: b.stationId });
    });
    await hub.publish({ type: 'vehicle', id });
    return { ok: true };
  });

  app.get('/api/users', admin, async () =>
    many(pool, `SELECT u.id, u.username, u.full_name, u.title, u.role, u.active, u.license_no, u.station_id, s.name AS station_name, u.sso_linked_at,
                  u.hospital_id, h.name AS hospital_name, u.account_type, u.tax_code, u.cccd_last4
                  FROM users u LEFT JOIN stations s ON s.id = u.station_id LEFT JOIN hospitals h ON h.id = u.hospital_id ORDER BY u.role, u.username`));

  /** Phân điểm làm việc cho nhân viên (để trống = làm được mọi điểm) */
  app.patch('/api/users/:id/station', admin, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ stationId: z.string().min(1).nullable() }).parse(req.body);
    await withTx(pool, async (tx) => {
      if (b.stationId) {
        const s = await one(tx, 'SELECT active FROM stations WHERE id = $1', [b.stationId]);
        if (!s?.active) throw new HttpError(409, 'Điểm không tồn tại hoặc đang tạm ngưng');
      }
      const u = await one(tx, 'UPDATE users SET station_id = $2 WHERE id = $1 RETURNING username', [id, b.stationId]);
      if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản');
      await audit(tx, 'system', actorOf(req), 'user.station_changed', 'user', id, b);
    });
    return { ok: true };
  });

  /* ---------- Tài khoản: admin tạo, đổi vai trò, khóa, đặt lại mật khẩu ---------- */
  const ROLE = z.enum(['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director', 'hospital']);
  const password = z.string().min(10, 'Mật khẩu dài ít nhất 10 ký tự').max(200);

  /** Tài khoản bệnh viện phải gắn đúng một bệnh viện trong danh mục; vai trò khác không gắn */
  async function hospitalFor(tx: Queryable, role: string, hospitalId: number | null | undefined) {
    if (role !== 'hospital') return null;
    if (!hospitalId) throw new HttpError(400, 'Tài khoản bệnh viện phải chọn bệnh viện');
    const h = await one(tx, 'SELECT active FROM hospitals WHERE id = $1', [hospitalId]);
    if (!h?.active) throw new HttpError(409, 'Bệnh viện không có trong danh mục hoặc đang ngưng');
    return hospitalId;
  }

  app.post('/api/users', admin, async (req) => {
    const b = z.object({
      username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'Tên đăng nhập 3–40 ký tự: chữ thường, số, . _ -'),
      fullName: z.string().trim().min(2).max(120), role: ROLE, title: z.string().trim().max(80).nullish(),
      licenseNo: z.string().trim().max(60).nullish(), stationId: z.string().nullish(), password,
      hospitalId: z.number().int().positive().nullish(),
      accountType: z.enum(['ca_nhan', 'to_chuc']).default('ca_nhan'), taxCode: z.string().max(20).nullish(), cccd: z.string().max(20).nullish(),
    }).parse(req.body);
    const taxCode = normalizeTaxCode(b.taxCode);
    checkAccount({ accountType: b.accountType, title: b.title, licenseNo: b.licenseNo, taxCode, hasCccd: !!b.cccd?.trim(), creating: true });
    return withTx(pool, async (tx) => {
      if (await one(tx, 'SELECT 1 FROM users WHERE username = $1', [b.username])) throw new HttpError(409, `Tên đăng nhập ${b.username} đã có`);
      const hospitalId = await hospitalFor(tx, b.role, b.hospitalId);
      const id = b.cccd?.trim() ? await sealCccd(tx, b.cccd, null) : null;
      const u = await one(tx, `INSERT INTO users(username, full_name, role, title, license_no, station_id, password_hash, hospital_id, account_type, tax_code, cccd_enc, cccd_last4, cccd_hash)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                               RETURNING id, username, full_name, role, title, station_id, active, hospital_id, account_type, tax_code, cccd_last4`,
      [b.username, b.fullName, b.role, b.title ?? null, b.licenseNo ?? null, b.role === 'hospital' ? null : b.stationId ?? null, hashPassword(b.password), hospitalId,
        b.accountType, taxCode, id?.enc ?? null, id?.last4 ?? null, id?.hash ?? null]);
      await audit(tx, 'system', actorOf(req), 'user.created', 'user', u.id, { username: b.username, role: b.role, accountType: b.accountType });
      return u;
    });
  });

  /** Ghi, sửa số căn cước của tài khoản cá nhân (mã hóa, chỉ hiện 4 số cuối). Thông tin định danh nên quản trị ghi thẳng, không qua đề xuất. */
  app.put('/api/users/:id/cccd', admin, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ cccd: z.string().max(20) }).parse(req.body);
    return withTx(pool, async (tx) => {
      const cur = await one(tx, 'SELECT account_type FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (!cur) throw new HttpError(404, 'Không tìm thấy tài khoản');
      if (cur.account_type !== 'ca_nhan') throw new HttpError(400, 'Tài khoản tổ chức không ghi số căn cước');
      const c = await sealCccd(tx, b.cccd, id);
      await tx.query('UPDATE users SET cccd_enc = $2, cccd_last4 = $3, cccd_hash = $4 WHERE id = $1', [id, c.enc, c.last4, c.hash]);
      await audit(tx, 'system', actorOf(req), 'user.cccd_set', 'user', id, { last4: c.last4 });
      return { ok: true, cccdLast4: c.last4 };
    });
  });

  app.patch('/api/users/:id', admin, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({
      fullName: z.string().trim().min(2).max(120).optional(), role: ROLE.optional(), title: z.string().trim().max(80).nullish(),
      licenseNo: z.string().trim().max(60).nullish(), active: z.boolean().optional(),
      hospitalId: z.number().int().positive().nullish(), taxCode: z.string().max(20).nullish(),
    }).parse(req.body);
    if (id === req.user.id && (b.active === false || (b.role && b.role !== 'admin'))) throw new HttpError(409, 'Không tự khóa hoặc tự bỏ quyền quản trị của chính mình');
    return withTx(pool, async (tx) => {
      const cur = await one(tx, 'SELECT role, hospital_id, account_type, title, license_no, tax_code, cccd_hash FROM users WHERE id = $1', [id]);
      if (!cur) throw new HttpError(404, 'Không tìm thấy tài khoản');
      const taxCode = 'taxCode' in b ? normalizeTaxCode(b.taxCode) : cur.tax_code;
      if (b.title !== undefined || b.licenseNo !== undefined || b.taxCode !== undefined) {
        checkAccount({ accountType: cur.account_type, title: 'title' in b ? b.title : cur.title, licenseNo: 'licenseNo' in b ? b.licenseNo : cur.license_no,
          taxCode, hasCccd: !!cur.cccd_hash, creating: false });
      }
      const role = b.role ?? cur.role;
      const hospitalId = await hospitalFor(tx, role, 'hospitalId' in b ? b.hospitalId : cur.hospital_id);
      const u = await one(tx, `UPDATE users SET full_name = coalesce($2, full_name), role = coalesce($3, role),
                                      title = CASE WHEN $6 THEN $4 ELSE title END, license_no = CASE WHEN $7 THEN $5 ELSE license_no END,
                                      active = coalesce($8, active), hospital_id = $9, tax_code = $10,
                                      station_id = CASE WHEN $3 = 'hospital' THEN NULL ELSE station_id END
                                WHERE id = $1 RETURNING id, username, full_name, role, title, station_id, active, hospital_id, account_type, tax_code, cccd_last4`,
      [id, b.fullName ?? null, b.role ?? null, b.title ?? null, b.licenseNo ?? null, 'title' in b, 'licenseNo' in b, b.active ?? null, hospitalId, taxCode]);
      if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản');
      if (b.active === false) await tx.query('UPDATE crew_shifts SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [id]);
      await audit(tx, 'system', actorOf(req), 'user.updated', 'user', id, b);
      return u;
    });
  });

  app.post('/api/users/:id/password', admin, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ password }).parse(req.body);
    await withTx(pool, async (tx) => {
      const u = await one(tx, 'UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id', [id, hashPassword(b.password)]);
      if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản');
      await audit(tx, 'system', actorOf(req), 'user.password_reset', 'user', id);
    });
    return { ok: true };
  });

  /** Gỡ nối tài khoản đăng nhập một lần (đổi người, nối nhầm): lần đăng nhập SSO sau sẽ nối lại theo tên đăng nhập */
  app.post('/api/users/:id/sso-unlink', admin, async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    await withTx(pool, async (tx) => {
      const u = await one(tx, 'UPDATE users SET sso_issuer = NULL, sso_subject = NULL, sso_linked_at = NULL WHERE id = $1 RETURNING id', [id]);
      if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản');
      await audit(tx, 'system', actorOf(req), 'user.sso_unlinked', 'user', id);
    });
    return { ok: true };
  });
}
