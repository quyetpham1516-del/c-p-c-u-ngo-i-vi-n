import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { DOMAIN_LABEL, GOVERNED, governanceEnforced, leadDomains } from '../governance.js';
import { actorOf, guard, type Ctx, type TokenUser } from '../http.js';

/** Phiếu đề xuất thay đổi: trưởng nhóm xem phiếu của mình, quản trị và Ban Giám đốc xem tất cả; chỉ quản trị duyệt */
export function registerGovernance(app: FastifyInstance, { pool }: Ctx) {
  app.get('/api/governance', { preHandler: guard() }, async (req) => ({
    enforced: await governanceEnforced(pool),
    settings: await one(pool, `SELECT g.enforced, g.enforced_at, u.full_name AS enforced_by_name FROM governance_settings g LEFT JOIN users u ON u.id = g.enforced_by`),
    myDomains: (await leadDomains(pool, req.user.id)).map((d) => ({ ...d, label: DOMAIN_LABEL[d.domain] })),
    governed: GOVERNED.map((g) => ({ route: g.route, label: g.label, domain: g.domain, domainLabel: DOMAIN_LABEL[g.domain] })),
    pending: req.user.role === 'admin' ? (await one(pool, `SELECT count(*)::int AS n FROM change_requests WHERE status = 'cho_duyet'`))?.n ?? 0 : undefined,
  }));

  /** Khóa cấu hình. Chưa khóa: quản trị bật được. Đã khóa: thao tác này cũng phải qua đề xuất (Ban Giám đốc đề xuất, quản trị duyệt) */
  app.put('/api/governance', { preHandler: guard('admin', 'director') }, async (req) => {
    const b = z.object({ enforced: z.boolean() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const row = await one(tx, `UPDATE governance_settings SET enforced = $1, enforced_at = CASE WHEN $1 THEN now() ELSE NULL END,
                                        enforced_by = CASE WHEN $1 THEN $2::uuid ELSE NULL END WHERE id = 1 RETURNING *`, [b.enforced, req.user.id]);
      await audit(tx, 'system', actorOf(req), b.enforced ? 'governance.enforced' : 'governance.released', 'governance', '1');
      return row;
    });
  });

  const LIST = `
    SELECT c.id, c.code, c.route, c.label, c.method, c.url, c.body, c.before, c.domain, c.reason, c.status, c.proposed_at, c.decided_at,
           c.decision_note, c.error, c.result, p.full_name AS proposed_by_name, d.full_name AS decided_by_name, o.name AS unit_name, c.proposed_by
      FROM change_requests c JOIN users p ON p.id = c.proposed_by LEFT JOIN users d ON d.id = c.decided_by LEFT JOIN org_units o ON o.id = c.unit_id`;

  app.get('/api/change-requests', { preHandler: guard() }, async (req) => {
    const q = z.object({ status: z.enum(['cho_duyet', 'dang_ap_dung', 'da_duyet', 'tu_choi', 'rut_lai', 'loi']).optional() }).parse(req.query);
    const all = ['admin', 'director'].includes(req.user.role);
    const rows = await many(pool, `${LIST} WHERE ($1::text IS NULL OR c.status = $1) AND ($2 OR c.proposed_by = $3)
                                   ORDER BY (c.status = 'cho_duyet') DESC, c.proposed_at DESC LIMIT 300`, [q.status ?? null, all, req.user.id]);
    return rows.map((r) => ({ ...r, domainLabel: DOMAIN_LABEL[r.domain as keyof typeof DOMAIN_LABEL] ?? r.domain }));
  });

  async function load(id: string) {
    const c = await one(pool, `${LIST} WHERE c.id = $1`, [id]);
    if (!c) throw new HttpError(404, 'Không tìm thấy đề xuất');
    return c;
  }
  const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;

  /** Người đề xuất sửa lý do khi phiếu còn chờ */
  app.patch('/api/change-requests/:id', { preHandler: guard() }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ reason: z.string().trim().max(1000) }).parse(req.body);
    const r = await pool.query(`UPDATE change_requests SET reason = $3 WHERE id = $1 AND proposed_by = $2 AND status = 'cho_duyet'`, [id, req.user.id, b.reason || null]);
    if (!r.rowCount) throw new HttpError(409, 'Chỉ người đề xuất sửa được, khi phiếu còn chờ duyệt');
    return load(id);
  });

  app.post('/api/change-requests/:id/withdraw', { preHandler: guard() }, async (req) => {
    const id = idParam(req.params);
    await withTx(pool, async (tx) => {
      const r = await tx.query(`UPDATE change_requests SET status = 'rut_lai', decided_at = now() WHERE id = $1 AND proposed_by = $2 AND status = 'cho_duyet'`, [id, req.user.id]);
      if (!r.rowCount) throw new HttpError(409, 'Chỉ người đề xuất rút được, khi phiếu còn chờ duyệt');
      await audit(tx, 'system', actorOf(req), 'change_request.withdrawn', 'change_request', id);
    });
    return load(id);
  });

  /**
   * Quản trị duyệt hoặc từ chối. Duyệt: hệ thống chạy đúng thao tác đã đề xuất (vé có mã đề xuất, nhân danh người duyệt),
   * kết quả hoặc lỗi lưu vào phiếu; lỗi thì phiếu ở trạng thái "lỗi", không thay đổi gì.
   */
  app.post('/api/change-requests/:id/decide', { preHandler: guard('admin') }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ approve: z.boolean(), note: z.string().trim().max(1000).optional() }).parse(req.body);
    if (!b.approve && !b.note) throw new HttpError(400, 'Từ chối thì ghi lý do');
    const c = await withTx(pool, async (tx) => {
      const cur = await one(tx, 'SELECT * FROM change_requests WHERE id = $1 FOR UPDATE', [id]);
      if (!cur) throw new HttpError(404, 'Không tìm thấy đề xuất');
      if (cur.status !== 'cho_duyet') throw new HttpError(409, 'Đề xuất không còn chờ duyệt');
      if (cur.proposed_by === req.user.id) throw new HttpError(409, 'Không tự duyệt đề xuất của chính mình');
      await tx.query(`UPDATE change_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
        [id, b.approve ? 'dang_ap_dung' : 'tu_choi', req.user.id, b.note ?? null]);
      await audit(tx, 'system', actorOf(req), b.approve ? 'change_request.approved' : 'change_request.rejected', 'change_request', id, { code: cur.code, note: b.note });
      return cur;
    });
    let status = 'tu_choi'; let error: string | null = null; let result: unknown = null;
    if (b.approve) {
      const u = req.user as TokenUser;
      const token = app.jwt.sign({ id: u.id, username: u.username, name: u.name, role: u.role, cr: id });
      const res = await app.inject({ method: c.method, url: c.url, payload: c.body ?? undefined, headers: { authorization: `Bearer ${token}` } });
      const json = res.body ? (() => { try { return res.json(); } catch { return res.body; } })() : null;
      if (res.statusCode < 300) { status = 'da_duyet'; result = json; } else { status = 'loi'; error = (json as any)?.error ?? `Lỗi ${res.statusCode}`; }
      await pool.query('UPDATE change_requests SET status = $2, result = $3, error = $4 WHERE id = $1', [id, status, JSON.stringify(result), error]);
    }
    await pool.query(`INSERT INTO notifications(user_id, kind, title, body, link) VALUES ($1, 'change_request', $2, $3, '/ca-nhan#de-xuat-' || $4)`,
      [c.proposed_by, `Đề xuất ${c.code} ${({ da_duyet: 'đã được duyệt và áp dụng', tu_choi: 'bị từ chối', loi: 'được duyệt nhưng áp dụng bị lỗi' } as Record<string, string>)[status]}`,
        b.note ?? error ?? c.label, c.id]);
    return load(id);
  });
}
