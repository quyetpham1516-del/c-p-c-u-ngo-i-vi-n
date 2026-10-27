import { audit, type Actor } from './audit.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';

/**
 * Kho tổng → kho điểm. Kho điểm lập phiếu lĩnh; kho tổng duyệt số phát, xuất theo hạn dùng sớm nhất trước (trừ kho tổng ngay);
 * kho điểm đếm và xác nhận số thực nhận (cộng vào kho điểm). Kho tổng cũng tự lập phiếu phát cho điểm dưới định mức tối thiểu.
 */

export const REQ_STATUS: Record<string, string> = {
  cho_duyet: 'Chờ kho tổng duyệt', da_duyet: 'Đã duyệt, chờ xuất', da_xuat: 'Đã xuất, chờ kho điểm nhận', da_nhan: 'Kho điểm đã nhận',
  tu_choi: 'Kho tổng từ chối', huy: 'Đã hủy',
};
const OPEN = ['cho_duyet', 'da_duyet', 'da_xuat'];

/** Kho tổng: theo cài đặt; chưa cài thì điểm loại "kho trung tâm", không có thì trụ sở */
export async function centralStation(q: Queryable): Promise<string | null> {
  const r = await one(q, `SELECT coalesce(
      (SELECT central_station_id FROM inventory_settings WHERE id = 1),
      (SELECT id FROM stations WHERE kind = 'kho_trung_tam' AND active ORDER BY id LIMIT 1),
      (SELECT id FROM stations WHERE kind = 'tru_so' AND active ORDER BY id LIMIT 1)) AS id`);
  return r?.id ?? null;
}

async function requireCentral(q: Queryable) {
  const c = await centralStation(q);
  if (!c) throw new HttpError(409, 'Chưa có kho tổng: quản trị chọn kho tổng trong cài đặt kho');
  return c;
}

async function newCode(tx: Tx) {
  const year = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 4);
  const n = await nextCounter(tx, 'requisition', year);
  return `PL-${year}-${String(n).padStart(5, '0')}`;
}

export async function notifyStation(tx: Tx, stationId: string, title: string, body: string | null, link = '/kho#phieu-linh', kind = 'requisition') {
  // Người làm ở điểm (kíp, dược) và trưởng bộ phận cấp cứu nhận thông báo; điểm không có trưởng điểm
  await tx.query(`
    INSERT INTO notifications(user_id, kind, title, body, link)
    SELECT DISTINCT u.id, $5, $2, $3, $4 FROM users u
     WHERE u.active AND ((u.station_id = $1 AND u.role IN ('crew', 'pharmacist', 'supervisor'))
        OR u.id IN (SELECT s.user_id FROM org_members m JOIN org_units o ON o.id = m.unit_id JOIN staff s ON s.id = m.staff_id
                     WHERE m.is_lead AND o.domain = 'kip' AND o.active AND s.user_id IS NOT NULL))`, [stationId, title, body, link, kind]);
}

export async function notifyCentral(tx: Tx, title: string, body: string | null, alsoAdmin = false, link = '/kho#phieu-linh', kind = 'requisition') {
  await tx.query(`INSERT INTO notifications(user_id, kind, title, body, link)
                  SELECT id, $5, $1, $2, $4 FROM users WHERE active AND role = ANY($3)`,
  [title, body, alsoAdmin ? ['pharmacist', 'admin'] : ['pharmacist'], link, kind]);
}

/** Số cần phát cho một điểm: định mức tối thiểu − tồn kho điểm còn hạn − hàng đang trên đường (phiếu chưa nhận) */
export async function shortages(q: Queryable, stationId: string) {
  return many(q, `
    SELECT d.id AS drug_id, d.name AS drug_name, d.unit, m.min_qty::float AS min_qty,
           coalesce((SELECT sum(l.qty) FROM stock_lots l WHERE l.station_id = m.station_id AND l.vehicle_id IS NULL
                      AND l.drug_id = m.drug_id AND l.expiry >= vn_today()), 0)::float AS on_hand,
           coalesce((SELECT sum(coalesce(rl.approved_qty, rl.requested_qty)) FROM stock_requisition_lines rl JOIN stock_requisitions r ON r.id = rl.requisition_id
                      WHERE r.station_id = m.station_id AND rl.drug_id = m.drug_id AND r.status = ANY($2)), 0)::float AS pending
      FROM stock_minimums m JOIN drugs d ON d.id = m.drug_id
     WHERE m.station_id = $1 AND d.active ORDER BY d.name`, [stationId, OPEN])
    .then((rows) => rows.map((r) => ({ ...r, need: Math.max(0, Math.ceil(r.min_qty - r.on_hand - r.pending)) })).filter((r) => r.need > 0));
}

export async function createRequisition(tx: Tx, actor: Actor, b: { stationId: string; lines: { drugId: number; qty: number }[]; note?: string | null; source?: 'kho_diem' | 'tu_dong' }) {
  const central = await requireCentral(tx);
  if (b.stationId === central) throw new HttpError(400, 'Kho tổng không lập phiếu lĩnh cho chính mình');
  const st = await one(tx, 'SELECT active FROM stations WHERE id = $1', [b.stationId]);
  if (!st?.active) throw new HttpError(409, 'Điểm không có hoặc đang tạm ngưng');
  if (new Set(b.lines.map((l) => l.drugId)).size !== b.lines.length) throw new HttpError(400, 'Mỗi mặt hàng ghi một dòng');
  const auto = b.source === 'tu_dong';
  const r = await one(tx, `INSERT INTO stock_requisitions(code, station_id, central_id, source, status, note, created_by, decided_by, decided_at)
                           VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8 THEN $7::uuid END, CASE WHEN $8 THEN now() END) RETURNING *`,
  [await newCode(tx), b.stationId, central, b.source ?? 'kho_diem', auto ? 'da_duyet' : 'cho_duyet', b.note ?? null, actor.id, auto]);
  for (const l of b.lines) {
    if (!(await one(tx, 'SELECT 1 FROM drugs WHERE id = $1 AND active', [l.drugId]))) throw new HttpError(400, 'Mặt hàng không có hoặc đã ngưng dùng');
    await tx.query('INSERT INTO stock_requisition_lines(requisition_id, drug_id, requested_qty, approved_qty) VALUES ($1,$2,$3,$4)',
      [r.id, l.drugId, l.qty, auto ? l.qty : null]);
  }
  await audit(tx, 'system', actor, auto ? 'requisition.auto_created' : 'requisition.created', 'stock_requisition', r.id, { code: r.code, stationId: b.stationId, lines: b.lines.length });
  if (auto) await notifyStation(tx, b.stationId, `Kho tổng sẽ phát bù định mức: ${r.code}`, `${b.lines.length} mặt hàng`);
  else await notifyCentral(tx, `Phiếu lĩnh ${r.code} của ${b.stationId} chờ duyệt`, `${b.lines.length} mặt hàng`);
  return r;
}

async function lockReq(tx: Tx, id: string) {
  const r = await one(tx, 'SELECT * FROM stock_requisitions WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw new HttpError(404, 'Không tìm thấy phiếu lĩnh');
  return r;
}

/** Kho tổng duyệt (có thể sửa số phát từng dòng, 0 = không phát) hoặc từ chối */
export async function decideRequisition(tx: Tx, actor: Actor, id: string, b: { approve: boolean; note?: string | null; lines?: { lineId: number; approvedQty: number }[] }) {
  const r = await lockReq(tx, id);
  if (r.status !== 'cho_duyet') throw new HttpError(409, 'Phiếu không còn chờ duyệt');
  if (!b.approve && !b.note?.trim()) throw new HttpError(400, 'Từ chối phải ghi lý do');
  if (b.approve) {
    await tx.query('UPDATE stock_requisition_lines SET approved_qty = requested_qty WHERE requisition_id = $1', [id]);
    for (const l of b.lines ?? []) {
      const u = await tx.query('UPDATE stock_requisition_lines SET approved_qty = $3 WHERE id = $2 AND requisition_id = $1', [id, l.lineId, l.approvedQty]);
      if (!u.rowCount) throw new HttpError(400, 'Dòng không thuộc phiếu này');
    }
    const any = await one(tx, 'SELECT 1 FROM stock_requisition_lines WHERE requisition_id = $1 AND approved_qty > 0', [id]);
    if (!any) throw new HttpError(400, 'Không có dòng nào được phát: dùng từ chối');
  }
  await tx.query(`UPDATE stock_requisitions SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
    [id, b.approve ? 'da_duyet' : 'tu_choi', actor.id, b.note ?? null]);
  await audit(tx, 'system', actor, b.approve ? 'requisition.approved' : 'requisition.rejected', 'stock_requisition', id, { code: r.code, note: b.note });
  await notifyStation(tx, r.station_id, `Phiếu lĩnh ${r.code} ${b.approve ? 'đã duyệt, chờ xuất' : 'bị từ chối'}`, b.note ?? null);
}

/** Xuất kho tổng: chọn lô còn hạn, hết hạn sớm nhất trước; thiếu hàng thì xuất phần có và ghi số thiếu. Trừ kho tổng ngay. */
export async function issueRequisition(tx: Tx, actor: Actor, id: string, witness?: string | null) {
  const r = await lockReq(tx, id);
  if (r.status !== 'da_duyet') throw new HttpError(409, 'Phiếu chưa duyệt hoặc đã xuất');
  const lines = await many(tx, `SELECT rl.*, d.name AS drug_name, d.controlled FROM stock_requisition_lines rl JOIN drugs d ON d.id = rl.drug_id
                                 WHERE rl.requisition_id = $1 AND rl.approved_qty > 0 ORDER BY d.name`, [id]);
  if (lines.some((l) => l.controlled) && !witness?.trim()) {
    throw new HttpError(409, `Có thuốc kiểm soát đặc biệt (${lines.filter((l) => l.controlled).map((l) => l.drug_name).join(', ')}): ghi người chứng kiến`);
  }
  const short: string[] = [];
  let issuedAny = false;
  for (const l of lines) {
    let left = Number(l.approved_qty);
    const lots = await many(tx, `SELECT id, lot, expiry, qty FROM stock_lots WHERE station_id = $1 AND vehicle_id IS NULL AND drug_id = $2
                                   AND qty > 0 AND expiry >= vn_today() ORDER BY expiry, received_at FOR UPDATE`, [r.central_id, l.drug_id]);
    for (const lot of lots) {
      if (left <= 0) break;
      const take = Math.min(left, Number(lot.qty));
      await tx.query('UPDATE stock_lots SET qty = qty - $2 WHERE id = $1', [lot.id, take]);
      await tx.query(`INSERT INTO stock_moves(lot_id, delta, reason, requisition_id, user_id, witness) VALUES ($1,$2,'xuat_kho_diem',$3,$4,$5)`,
        [lot.id, -take, id, actor.id, witness ?? null]);
      await tx.query('INSERT INTO stock_requisition_issues(line_id, from_lot_id, lot, expiry, qty) VALUES ($1,$2,$3,$4,$5)', [l.id, lot.id, lot.lot, lot.expiry, take]);
      left -= take; issuedAny = true;
    }
    if (left > 0) short.push(`${l.drug_name} thiếu ${left}`);
  }
  if (!issuedAny) throw new HttpError(409, 'Kho tổng không còn hàng còn hạn cho phiếu này');
  await tx.query(`UPDATE stock_requisitions SET status = 'da_xuat', issued_by = $2, issued_at = now(), witness = $3,
                         decision_note = CASE WHEN $4::text IS NULL THEN decision_note ELSE concat_ws(' · ', decision_note, $4::text) END WHERE id = $1`,
  [id, actor.id, witness ?? null, short.length ? `Kho tổng thiếu: ${short.join(', ')}` : null]);
  await audit(tx, 'system', actor, 'requisition.issued', 'stock_requisition', id, { code: r.code, short });
  await notifyStation(tx, r.station_id, `Kho tổng đã xuất ${r.code}: đếm và xác nhận khi nhận`, short.length ? `Thiếu: ${short.join(', ')}` : null);
  return { short };
}

/** Kho điểm xác nhận số thực nhận từng lô; nhận thiếu thì ghi chênh lệch, báo kho tổng và quản trị */
export async function receiveRequisition(tx: Tx, actor: Actor, id: string, b: { lines: { issueId: number; receivedQty: number }[]; note?: string | null }) {
  const r = await lockReq(tx, id);
  if (r.status !== 'da_xuat') throw new HttpError(409, 'Phiếu chưa xuất hoặc đã nhận');
  const issues = await many(tx, `SELECT i.*, rl.drug_id, d.name AS drug_name FROM stock_requisition_issues i
                                   JOIN stock_requisition_lines rl ON rl.id = i.line_id JOIN drugs d ON d.id = rl.drug_id
                                  WHERE rl.requisition_id = $1`, [id]);
  const given = new Map(b.lines.map((l) => [l.issueId, l.receivedQty]));
  const diffs: string[] = [];
  for (const i of issues) {
    const got = given.has(i.id) ? given.get(i.id)! : Number(i.qty);
    if (got > Number(i.qty)) throw new HttpError(400, `${i.drug_name} lô ${i.lot}: nhận nhiều hơn số xuất`);
    let toLot: string | null = null;
    if (got > 0) {
      const dst = await one(tx, `
        INSERT INTO stock_lots(station_id, vehicle_id, drug_id, lot, expiry, qty, supplier, received_by)
        VALUES ($1, NULL, $2, $3, $4, $5, 'Kho tổng', $6)
        ON CONFLICT (station_id, coalesce(vehicle_id, ''), drug_id, lot) DO UPDATE SET qty = stock_lots.qty + EXCLUDED.qty
        RETURNING id`, [r.station_id, i.drug_id, i.lot, i.expiry, got, actor.id]);
      toLot = dst.id;
      await tx.query(`INSERT INTO stock_moves(lot_id, delta, reason, requisition_id, user_id) VALUES ($1,$2,'nhan_kho_tong',$3,$4)`, [dst.id, got, id, actor.id]);
    }
    await tx.query('UPDATE stock_requisition_issues SET received_qty = $2, to_lot_id = $3 WHERE id = $1', [i.id, got, toLot]);
    if (got !== Number(i.qty)) diffs.push(`${i.drug_name} lô ${i.lot}: xuất ${Number(i.qty)}, nhận ${got}`);
  }
  if (diffs.length && !b.note?.trim()) throw new HttpError(400, 'Nhận khác số xuất: ghi lý do (vỡ, thiếu, nhầm lô...)');
  await tx.query(`UPDATE stock_requisitions SET status = 'da_nhan', received_by = $2, received_at = now(), receive_note = $3, discrepancy = $4 WHERE id = $1`,
    [id, actor.id, b.note ?? null, diffs.length > 0]);
  await audit(tx, 'system', actor, 'requisition.received', 'stock_requisition', id, { code: r.code, diffs });
  if (diffs.length) await notifyCentral(tx, `Kho điểm ${r.station_id} nhận ${r.code} không đủ`, `${diffs.join('; ')}. Lý do: ${b.note}`, true);
  return { diffs };
}

export async function cancelRequisition(tx: Tx, actor: Actor, id: string) {
  const r = await lockReq(tx, id);
  if (!['cho_duyet', 'da_duyet'].includes(r.status)) throw new HttpError(409, 'Chỉ hủy được phiếu chưa xuất');
  await tx.query(`UPDATE stock_requisitions SET status = 'huy', decided_at = coalesce(decided_at, now()) WHERE id = $1`, [id]);
  await audit(tx, 'system', actor, 'requisition.cancelled', 'stock_requisition', id, { code: r.code });
}

/** Kho tổng tự lập phiếu phát (đã duyệt sẵn) cho mọi điểm dưới định mức, bỏ qua điểm đang có phiếu chưa nhận */
export async function autoIssue(tx: Tx, actor: Actor) {
  const central = await requireCentral(tx);
  const stations = await many(tx, `SELECT DISTINCT m.station_id FROM stock_minimums m JOIN stations s ON s.id = m.station_id
                                    WHERE s.active AND m.station_id <> $1 ORDER BY 1`, [central]);
  const created: { code: string; stationId: string; lines: number }[] = [];
  for (const s of stations) {
    const need = await shortages(tx, s.station_id);
    if (!need.length) continue;
    const r = await createRequisition(tx, actor, { stationId: s.station_id, source: 'tu_dong', lines: need.map((n) => ({ drugId: n.drug_id, qty: n.need })), note: 'Tự phát bù định mức tối thiểu' });
    created.push({ code: r.code, stationId: s.station_id, lines: need.length });
  }
  return created;
}
