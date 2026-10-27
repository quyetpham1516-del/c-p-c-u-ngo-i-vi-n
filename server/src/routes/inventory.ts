import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import {
  autoIssue, cancelRequisition, centralStation, createRequisition, decideRequisition, issueRequisition, receiveRequisition, REQ_STATUS, shortages,
} from '../inventory.js';

/** Kho tổng: dược và quản trị thao tác; Ban Giám đốc, kế toán, QLCL xem. Điều phối viên, tiếp nhận không xem kho tổng. */
const CENTRAL_MANAGE: Role[] = ['pharmacist', 'admin'];
const CENTRAL_VIEW: Role[] = [...CENTRAL_MANAGE, 'director', 'accountant', 'qa'];
/** Kho điểm: kíp làm ở điểm, trưởng ca lập phiếu lĩnh và xác nhận nhận hàng */
const STATION_WORK: Role[] = ['crew', 'supervisor', 'pharmacist', 'admin'];

export function registerInventory(app: FastifyInstance, { pool }: Ctx) {
  /** Kíp chỉ làm cho điểm mình được phân, hoặc điểm của xe mình đang nhận ca */
  async function assertStation(req: FastifyRequest, stationId: string) {
    if (req.user.role !== 'crew') return;
    const ok = await one(pool, `SELECT 1 FROM users u WHERE u.id = $1 AND (u.station_id = $2 OR EXISTS (
                                  SELECT 1 FROM crew_shifts cs JOIN vehicles v ON v.id = cs.vehicle_id WHERE cs.user_id = u.id AND cs.ended_at IS NULL AND v.station_id = $2))`,
    [req.user.id, stationId]);
    if (!ok) throw new HttpError(403, `Bạn không làm ở điểm ${stationId}`);
  }
  const idOf = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;

  app.get('/api/inventory/settings', { preHandler: guard(...CENTRAL_VIEW, 'supervisor', 'crew', 'dispatcher', 'calltaker') }, async () => {
    const s = await one(pool, `SELECT central_station_id, auto_issue, to_char(auto_issue_at, 'HH24:MI') AS auto_issue_at, last_auto_issue_on FROM inventory_settings WHERE id = 1`);
    const central = await centralStation(pool);
    return { ...s, central, centralName: central ? (await one(pool, 'SELECT name FROM stations WHERE id = $1', [central]))?.name : null, statuses: REQ_STATUS };
  });

  /** Chọn kho tổng, bật tự phát theo định mức. Đã khóa cấu hình thì trưởng nhóm kho đề xuất, quản trị duyệt. */
  app.put('/api/inventory/settings', { preHandler: guard('admin') }, async (req) => {
    const b = z.object({
      centralStationId: z.string().min(1).nullable(), autoIssue: z.boolean(), autoIssueAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (b.centralStationId && !(await one(tx, 'SELECT 1 FROM stations WHERE id = $1 AND active', [b.centralStationId]))) throw new HttpError(400, 'Điểm không có hoặc đang tạm ngưng');
      await tx.query('UPDATE inventory_settings SET central_station_id = $1, auto_issue = $2, auto_issue_at = $3::time WHERE id = 1', [b.centralStationId, b.autoIssue, b.autoIssueAt]);
      await audit(tx, 'system', actorOf(req), 'inventory.settings', 'inventory_settings', '1', b);
      return { ok: true };
    });
  });

  app.get('/api/requisitions', { preHandler: guard(...CENTRAL_VIEW, 'supervisor', 'crew') }, async (req) => {
    const q = z.object({ status: z.string().optional(), stationId: z.string().optional() }).parse(req.query);
    // Kíp chỉ thấy phiếu của điểm mình (điểm được phân hoặc điểm của xe đang nhận ca)
    const crewStations = req.user.role === 'crew'
      ? (await many(pool, `SELECT station_id FROM users WHERE id = $1 AND station_id IS NOT NULL
                           UNION SELECT v.station_id FROM crew_shifts cs JOIN vehicles v ON v.id = cs.vehicle_id WHERE cs.user_id = $1 AND cs.ended_at IS NULL`, [req.user.id])).map((r) => r.station_id)
      : null;
    return many(pool, `
      SELECT r.*, s.name AS station_name, uc.full_name AS created_by_name, ud.full_name AS decided_by_name, ui.full_name AS issued_by_name, ur.full_name AS received_by_name,
             (SELECT count(*)::int FROM stock_requisition_lines l WHERE l.requisition_id = r.id) AS line_count
        FROM stock_requisitions r JOIN stations s ON s.id = r.station_id
        LEFT JOIN users uc ON uc.id = r.created_by LEFT JOIN users ud ON ud.id = r.decided_by
        LEFT JOIN users ui ON ui.id = r.issued_by LEFT JOIN users ur ON ur.id = r.received_by
       WHERE ($1::text IS NULL OR r.status = $1) AND ($2::text IS NULL OR r.station_id = $2) AND ($3::text[] IS NULL OR r.station_id = ANY($3))
       ORDER BY (r.status IN ('cho_duyet', 'da_duyet', 'da_xuat')) DESC, r.created_at DESC LIMIT 300`, [q.status ?? null, q.stationId ?? null, crewStations]);
  });

  app.get('/api/requisitions/suggest', { preHandler: guard(...STATION_WORK, ...CENTRAL_VIEW) }, async (req) => {
    const q = z.object({ stationId: z.string().min(1) }).parse(req.query);
    await assertStation(req, q.stationId);
    return shortages(pool, q.stationId);
  });

  app.get('/api/requisitions/:id', { preHandler: guard(...CENTRAL_VIEW, 'supervisor', 'crew') }, async (req) => {
    const id = idOf(req.params);
    const r = await one(pool, `SELECT r.*, s.name AS station_name FROM stock_requisitions r JOIN stations s ON s.id = r.station_id WHERE r.id = $1`, [id]);
    if (!r) throw new HttpError(404, 'Không tìm thấy phiếu lĩnh');
    await assertStation(req, r.station_id);
    const lines = await many(pool, `
      SELECT l.id, l.drug_id, d.name AS drug_name, d.unit, l.requested_qty::float, l.approved_qty::float,
             coalesce((SELECT sum(qty) FROM stock_lots c WHERE c.station_id = $2 AND c.vehicle_id IS NULL AND c.drug_id = l.drug_id AND c.expiry >= vn_today()), 0)::float AS central_on_hand,
             coalesce((SELECT json_agg(json_build_object('id', i.id, 'lot', i.lot, 'expiry', i.expiry, 'qty', i.qty::float, 'receivedQty', i.received_qty::float) ORDER BY i.expiry)
                         FROM stock_requisition_issues i WHERE i.line_id = l.id), '[]') AS issues
        FROM stock_requisition_lines l JOIN drugs d ON d.id = l.drug_id WHERE l.requisition_id = $1 ORDER BY d.name`, [id, r.central_id]);
    // Tồn kho tổng chỉ hiện cho người được xem kho tổng
    if (!CENTRAL_VIEW.includes(req.user.role)) for (const l of lines) delete (l as any).central_on_hand;
    return { ...r, lines };
  });

  app.post('/api/requisitions', { preHandler: guard(...STATION_WORK) }, async (req) => {
    const b = z.object({
      stationId: z.string().min(1), note: z.string().trim().max(500).nullish(),
      lines: z.array(z.object({ drugId: z.number().int().positive(), qty: z.number().positive().max(100000) })).min(1).max(200),
    }).parse(req.body);
    await assertStation(req, b.stationId);
    return withTx(pool, (tx) => createRequisition(tx, actorOf(req), b));
  });

  app.post('/api/requisitions/:id/decide', { preHandler: guard(...CENTRAL_MANAGE) }, async (req) => {
    const id = idOf(req.params);
    const b = z.object({
      approve: z.boolean(), note: z.string().trim().max(500).nullish(),
      lines: z.array(z.object({ lineId: z.number().int(), approvedQty: z.number().min(0).max(100000) })).max(200).optional(),
    }).parse(req.body);
    await withTx(pool, (tx) => decideRequisition(tx, actorOf(req), id, b));
    return { ok: true };
  });

  app.post('/api/requisitions/:id/issue', { preHandler: guard(...CENTRAL_MANAGE) }, async (req) => {
    const id = idOf(req.params);
    const b = z.object({ witness: z.string().trim().max(120).nullish() }).parse(req.body ?? {});
    return withTx(pool, (tx) => issueRequisition(tx, actorOf(req), id, b.witness));
  });

  app.post('/api/requisitions/:id/receive', { preHandler: guard(...STATION_WORK) }, async (req) => {
    const id = idOf(req.params);
    const b = z.object({
      note: z.string().trim().max(500).nullish(),
      lines: z.array(z.object({ issueId: z.number().int(), receivedQty: z.number().min(0).max(100000) })).max(500).default([]),
    }).parse(req.body);
    const r = await one(pool, 'SELECT station_id, issued_by FROM stock_requisitions WHERE id = $1', [id]);
    if (!r) throw new HttpError(404, 'Không tìm thấy phiếu lĩnh');
    await assertStation(req, r.station_id);
    if (r.issued_by === req.user.id) throw new HttpError(403, 'Người xuất kho không tự xác nhận nhận hàng');
    return withTx(pool, (tx) => receiveRequisition(tx, actorOf(req), id, b));
  });

  app.post('/api/requisitions/:id/cancel', { preHandler: guard(...STATION_WORK) }, async (req) => {
    const id = idOf(req.params);
    const r = await one(pool, 'SELECT created_by, station_id FROM stock_requisitions WHERE id = $1', [id]);
    if (!r) throw new HttpError(404, 'Không tìm thấy phiếu lĩnh');
    if (!CENTRAL_MANAGE.includes(req.user.role) && r.created_by !== req.user.id) throw new HttpError(403, 'Chỉ người lập hoặc kho tổng hủy được');
    await withTx(pool, (tx) => cancelRequisition(tx, actorOf(req), id));
    return { ok: true };
  });

  /** Kho tổng bấm phát bù định mức ngay (ngoài lịch tự động hằng ngày) */
  app.post('/api/requisitions/auto', { preHandler: guard(...CENTRAL_MANAGE) }, async (req) =>
    ({ created: await withTx(pool, (tx) => autoIssue(tx, actorOf(req))) }));
}
