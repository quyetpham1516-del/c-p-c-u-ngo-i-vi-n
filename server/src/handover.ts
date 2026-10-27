import { audit, type Actor } from './audit.js';
import { many, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';
import { vehicleParStatus } from './stock.js';

/**
 * Bàn giao xe giữa hai kíp. Biên bản tự mở khi kíp mới nhận ca trên xe vừa có kíp khác trong 12 giờ qua.
 * Người giao (kíp cũ) đếm, ghi tình trạng rồi ký; người nhận (kíp mới) xem, ghi ý kiến rồi ký: biên bản khóa.
 * Người giao, người nhận là người ở vị trí đã cài (mặc định Trưởng kíp); kíp không có vị trí đó thì ai trong kíp cũng ký được.
 * Quá hạn (mặc định 30 phút sau lúc nhắc) mà chưa khóa, xe không có ca và không vừa đi ca về trong khoảng đó, thì xe bị khóa.
 */

export const HANDOVER_STATUS: Record<string, string> = { cho_giao: 'Chờ kíp cũ giao', cho_nhan: 'Chờ kíp mới nhận', da_khoa: 'Đã bàn giao' };
const CONDITION = ['tot', 'thieu', 'hong', 'het_han'] as const;
export type Condition = (typeof CONDITION)[number];

async function settings(q: Queryable) {
  return (await one(q, 'SELECT position, grace_minutes FROM handover_settings WHERE id = 1')) ?? { position: 'Trưởng kíp', grace_minutes: 30 };
}

/** Gọi khi một người nhận ca trên xe: mở biên bản nếu xe vừa có kíp khác, hoặc thêm người vào kíp nhận của biên bản đang mở */
export async function onShiftStarted(tx: Tx, userId: string, vehicleId: string) {
  const open = await one(tx, `SELECT id, outgoing, incoming FROM vehicle_handovers WHERE vehicle_id = $1 AND status <> 'da_khoa' FOR UPDATE`, [vehicleId]);
  if (open) {
    if (!open.outgoing.includes(userId) && !open.incoming.includes(userId)) {
      await tx.query('UPDATE vehicle_handovers SET incoming = array_append(incoming, $2) WHERE id = $1', [open.id, userId]);
    }
    return open.id as string;
  }
  // Vừa bàn giao xong trong 2 giờ: người đến muộn của kíp mới, ghi thêm vào kíp nhận
  const recent = await one(tx, `SELECT id, outgoing, incoming FROM vehicle_handovers WHERE vehicle_id = $1 AND created_at > now() - interval '2 hours'
                                 ORDER BY created_at DESC LIMIT 1`, [vehicleId]);
  if (recent) {
    if (!recent.outgoing.includes(userId) && !recent.incoming.includes(userId)) {
      await tx.query('UPDATE vehicle_handovers SET incoming = array_append(incoming, $2) WHERE id = $1', [recent.id, userId]);
    }
    return null;
  }
  // Người vừa làm trên xe này trong 12 giờ qua là cùng kíp cũ (đăng nhập lại), không mở biên bản
  const mine = await one(tx, `SELECT 1 FROM crew_shifts WHERE user_id = $1 AND vehicle_id = $2 AND ended_at > now() - interval '12 hours'`, [userId, vehicleId]);
  if (mine) return null;
  const prev = await many(tx, `SELECT DISTINCT user_id FROM crew_shifts
                                WHERE vehicle_id = $1 AND user_id <> $2
                                  AND (ended_at IS NULL OR ended_at > now() - interval '12 hours')
                                  -- người đã giao xe trong 12 giờ qua thì không giao lại
                                  AND NOT EXISTS (SELECT 1 FROM vehicle_handovers h WHERE h.vehicle_id = $1 AND h.status = 'da_khoa'
                                                   AND h.created_at > now() - interval '12 hours' AND crew_shifts.user_id = ANY(h.outgoing))`, [vehicleId, userId]);
  if (!prev.length) return null;
  const h = await one(tx, `INSERT INTO vehicle_handovers(vehicle_id, outgoing, incoming) VALUES ($1,$2,$3) RETURNING id`, [vehicleId, prev.map((p) => p.user_id), [userId]]);
  const s = await settings(tx);
  await tx.query(`INSERT INTO notifications(user_id, kind, title, body, link) SELECT unnest($1::uuid[]), 'handover', $2, $3, '/kip#ban-giao'`,
    [[...prev.map((p) => p.user_id), userId], `Bàn giao xe ${vehicleId}`, `Kíp cũ đếm, ghi tình trạng và ký; kíp mới ký nhận. Quá ${s.grace_minutes} phút chưa xong (khi không có ca) thì xe bị khóa.`]);
  await audit(tx, 'system', { id: userId, name: 'Kíp' }, 'handover.opened', 'vehicle', vehicleId, { handoverId: h.id });
  return h.id as string;
}

/** Xe đang bị khóa vì chưa bàn giao: lý do, hoặc null */
export async function handoverBlocks(q: Queryable, vehicleIds?: string[]): Promise<Record<string, string>> {
  const rows = await many(q, `
    SELECT h.vehicle_id, h.status, h.reminded_at
      FROM vehicle_handovers h, handover_settings s
     WHERE h.status <> 'da_khoa' AND ($1::text[] IS NULL OR h.vehicle_id = ANY($1))
       AND now() > h.reminded_at + make_interval(mins => s.grace_minutes)
       AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.vehicle_id = h.vehicle_id AND a.ended_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.vehicle_id = h.vehicle_id AND a.ended_at > now() - make_interval(mins => s.grace_minutes))`,
  [vehicleIds ?? null]);
  return Object.fromEntries(rows.map((r) => [r.vehicle_id, `chưa ký bàn giao ca (${HANDOVER_STATUS[r.status].toLowerCase()})`]));
}

/** Trên xe có gì để bàn giao: thuốc, vật tư theo cơ số chuẩn và thiết bị đang lắp */
async function snapshot(q: Queryable, vehicleId: string) {
  const par = await vehicleParStatus(q, vehicleId);
  const equipment = await many(q, `SELECT e.id, t.name, e.serial, e.status FROM equipment e JOIN equipment_types t ON t.id = e.type_id
                                    WHERE e.vehicle_id = $1 AND e.status <> 'thanh_ly' ORDER BY t.name, e.serial`, [vehicleId]);
  return {
    items: par.items.map((i) => ({ drugId: i.drug_id, name: i.drug_name, unit: i.unit, par: i.par, book: i.on_vehicle })),
    equipment: equipment.map((e) => ({ id: e.id, name: e.name, serial: e.serial, status: e.status })),
  };
}

export async function handoverDetail(q: Queryable, id: string) {
  const h = await one(q, `SELECT h.*, gu.full_name AS giver_name, ru.full_name AS receiver_name,
                                 (SELECT json_agg(json_build_object('id', u.id, 'name', u.full_name)) FROM users u WHERE u.id = ANY(h.outgoing)) AS outgoing_people,
                                 (SELECT json_agg(json_build_object('id', u.id, 'name', u.full_name)) FROM users u WHERE u.id = ANY(h.incoming)) AS incoming_people
                            FROM vehicle_handovers h LEFT JOIN users gu ON gu.id = h.giver_id LEFT JOIN users ru ON ru.id = h.receiver_id WHERE h.id = $1`, [id]);
  if (!h) throw new HttpError(404, 'Không tìm thấy biên bản bàn giao');
  const s = await settings(q);
  const draft = h.status === 'cho_giao' && !h.items.length ? await snapshot(q, h.vehicle_id) : null;
  const dueAt = new Date(new Date(h.reminded_at).getTime() + s.grace_minutes * 60_000);
  const blocked = (await handoverBlocks(q, [h.vehicle_id]))[h.vehicle_id] ?? null;
  return { ...h, ...(draft ? { items: draft.items, equipment: draft.equipment } : {}), dueAt, blocked, position: s.position, statusLabel: HANDOVER_STATUS[h.status] };
}

/** Ai được ký phía mình: người ở vị trí đã cài đang (hoặc vừa) nhận ca trên xe; phía đó không có ai ở vị trí này thì ai trong phía đó cũng được */
async function canSign(q: Queryable, h: any, userId: string, side: 'outgoing' | 'incoming') {
  const people: string[] = h[side];
  if (!people.includes(userId)) return false;
  const s = await settings(q);
  const atPosition = await many(q, `SELECT DISTINCT user_id FROM crew_shifts WHERE vehicle_id = $1 AND user_id = ANY($2) AND crew_role = $3
                                      AND (ended_at IS NULL OR ended_at > now() - interval '12 hours')`, [h.vehicle_id, people, s.position]);
  return !atPosition.length || atPosition.some((p) => p.user_id === userId);
}

export async function giveHandover(tx: Tx, actor: Actor, id: string, b: {
  items: { drugId: number; counted: number; condition: Condition; note?: string | null }[];
  equipment: { id: string; condition: Condition; note?: string | null }[]; note?: string | null;
}) {
  const h = await one(tx, 'SELECT * FROM vehicle_handovers WHERE id = $1 FOR UPDATE', [id]);
  if (!h) throw new HttpError(404, 'Không tìm thấy biên bản bàn giao');
  if (h.status !== 'cho_giao') throw new HttpError(409, 'Kíp cũ đã ký giao');
  if (!(await canSign(tx, h, actor.id!, 'outgoing'))) throw new HttpError(403, 'Người giao là người ở vị trí phụ trách bàn giao của kíp cũ');
  const snap = await snapshot(tx, h.vehicle_id);
  const byDrug = new Map(b.items.map((i) => [i.drugId, i]));
  const missing = snap.items.filter((i) => !byDrug.has(i.drugId));
  if (missing.length) throw new HttpError(400, `Còn ${missing.length} mặt hàng chưa đếm (${missing.slice(0, 3).map((m) => m.name).join(', ')}...)`);
  const byEq = new Map(b.equipment.map((e) => [e.id, e]));
  if (snap.equipment.some((e) => !byEq.has(e.id))) throw new HttpError(400, 'Còn thiết bị chưa ghi tình trạng');
  const items = snap.items.map((i) => ({ ...i, counted: byDrug.get(i.drugId)!.counted, condition: byDrug.get(i.drugId)!.condition, note: byDrug.get(i.drugId)!.note ?? null }));
  const equipment = snap.equipment.map((e) => ({ ...e, condition: byEq.get(e.id)!.condition, note: byEq.get(e.id)!.note ?? null }));
  const issues = items.filter((i) => i.condition !== 'tot' || i.counted !== i.book).length + equipment.filter((e) => e.condition !== 'tot').length;
  if (issues && !b.note?.trim()) throw new HttpError(400, 'Có mặt hàng lệch số hoặc không tốt: ghi chú khi giao');
  await tx.query(`UPDATE vehicle_handovers SET status = 'cho_nhan', items = $2, equipment = $3, giver_id = $4, giver_note = $5, giver_signed_at = now() WHERE id = $1`,
    [id, JSON.stringify(items), JSON.stringify(equipment), actor.id, b.note ?? null]);
  await audit(tx, 'system', actor, 'handover.given', 'vehicle', h.vehicle_id, { handoverId: id, issues });
  await tx.query(`INSERT INTO notifications(user_id, kind, title, body, link) SELECT unnest($1::uuid[]), 'handover', $2, $3, '/kip#ban-giao'`,
    [h.incoming, `Kíp cũ đã ký giao xe ${h.vehicle_id}: xem và ký nhận`, issues ? `${issues} mục cần chú ý` : null]);
  return { issues };
}

export async function receiveHandover(tx: Tx, actor: Actor, id: string, b: { agree: boolean; note?: string | null }) {
  const h = await one(tx, 'SELECT * FROM vehicle_handovers WHERE id = $1 FOR UPDATE', [id]);
  if (!h) throw new HttpError(404, 'Không tìm thấy biên bản bàn giao');
  if (h.status !== 'cho_nhan') throw new HttpError(409, h.status === 'da_khoa' ? 'Biên bản đã khóa' : 'Kíp cũ chưa ký giao');
  if (!(await canSign(tx, h, actor.id!, 'incoming'))) throw new HttpError(403, 'Người nhận là người ở vị trí phụ trách bàn giao của kíp mới');
  if (!b.agree && !b.note?.trim()) throw new HttpError(400, 'Không đồng ý số liệu thì ghi rõ chỗ khác');
  await tx.query(`UPDATE vehicle_handovers SET status = 'da_khoa', receiver_id = $2, receiver_note = $3, receiver_signed_at = now() WHERE id = $1`,
    [id, actor.id, b.agree ? b.note ?? null : `Không đồng ý: ${b.note}`]);
  await audit(tx, 'system', actor, 'handover.locked', 'vehicle', h.vehicle_id, { handoverId: id, agree: b.agree });
  if (!b.agree) {
    await tx.query(`INSERT INTO notifications(user_id, kind, title, body, link)
                    SELECT id, 'handover', $1, $2, '/bang-xe' FROM users WHERE active AND role IN ('supervisor', 'pharmacist')`,
    [`Bàn giao xe ${h.vehicle_id}: kíp nhận không đồng ý số liệu`, b.note]);
  }
}
