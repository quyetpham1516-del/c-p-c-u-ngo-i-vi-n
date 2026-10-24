import { audit, type Actor } from './audit.js';
import { many, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';

/**
 * Kho thuốc theo số lô tại từng trạm (mục 7.5): nhập kho ghi số lô và hạn dùng; xe lấy thuốc từ kho trạm của mình;
 * khi ký phiếu chuyển viện, số lượng dùng cho người bệnh được trừ khỏi đúng lô đã chọn.
 */

export async function receiveStock(tx: Tx, actor: Actor, b: {
  stationId: string; drugId?: number | null; drugName?: string | null; unit?: string | null;
  lot: string; expiry: string; qty: number; supplier?: string | null;
}) {
  const station = await one(tx, 'SELECT id, active FROM stations WHERE id = $1', [b.stationId]);
  if (!station) throw new HttpError(404, 'Không tìm thấy điểm');
  if (!station.active) throw new HttpError(409, `Điểm ${b.stationId} đang tạm ngưng, không nhập kho được`);
  let drugId = b.drugId ?? null;
  if (!drugId) {
    const name = b.drugName?.trim();
    if (!name) throw new HttpError(400, 'Chọn thuốc hoặc nhập tên thuốc mới');
    const d = await one(tx, `INSERT INTO drugs(name, unit) VALUES ($1, $2)
                             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name, b.unit?.trim() || 'ống']);
    drugId = d.id;
  }
  const lotCode = b.lot.trim();
  const existing = await one(tx, 'SELECT * FROM stock_lots WHERE station_id = $1 AND drug_id = $2 AND lot = $3 FOR UPDATE', [b.stationId, drugId, lotCode]);
  let lot;
  if (existing) {
    if (existing.expiry !== b.expiry) throw new HttpError(409, `Lô ${lotCode} đã có trong kho với hạn dùng ${existing.expiry}, khác hạn vừa nhập`);
    lot = await one(tx, 'UPDATE stock_lots SET qty = qty + $2 WHERE id = $1 RETURNING *', [existing.id, b.qty]);
  } else {
    lot = await one(tx, `INSERT INTO stock_lots(station_id, drug_id, lot, expiry, qty, supplier, received_by)
                         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.stationId, drugId, lotCode, b.expiry, b.qty, b.supplier?.trim() || null, actor.id]);
  }
  await tx.query(`INSERT INTO stock_moves(lot_id, delta, reason, note, user_id) VALUES ($1, $2, 'nhap_kho', $3, $4)`,
    [lot.id, b.qty, b.supplier?.trim() || null, actor.id]);
  await audit(tx, 'system', actor, 'stock.received', 'stock_lot', lot.id, { stationId: b.stationId, drugId, lot: lotCode, expiry: b.expiry, qty: b.qty });
  return lot;
}

export async function adjustStock(tx: Tx, actor: Actor, lotId: string, delta: number, note: string) {
  const lot = await one(tx, 'SELECT * FROM stock_lots WHERE id = $1 FOR UPDATE', [lotId]);
  if (!lot) throw new HttpError(404, 'Không tìm thấy lô thuốc');
  if (Number(lot.qty) + delta < 0) throw new HttpError(409, `Lô ${lot.lot} chỉ còn ${lot.qty}`);
  await tx.query('UPDATE stock_lots SET qty = qty + $2 WHERE id = $1', [lotId, delta]);
  await tx.query(`INSERT INTO stock_moves(lot_id, delta, reason, note, user_id) VALUES ($1, $2, 'dieu_chinh', $3, $4)`, [lotId, delta, note, actor.id]);
  await audit(tx, 'system', actor, 'stock.adjusted', 'stock_lot', lotId, { delta, note });
}

/** Các lô còn dùng được ở kho trạm của xe, lô hết hạn sớm nhất đứng trước (FEFO) */
export async function lotsForVehicle(q: Queryable, vehicleId: string) {
  return many(q, `
    SELECT l.id, l.lot, l.expiry, l.qty, d.id AS drug_id, d.name AS drug_name, d.unit, d.default_route
      FROM stock_lots l JOIN drugs d ON d.id = l.drug_id JOIN vehicles v ON v.station_id = l.station_id
     WHERE v.id = $1 AND l.qty > 0 AND l.expiry >= current_date AND d.active
     ORDER BY d.name, l.expiry, l.received_at`, [vehicleId]);
}

/** Trừ kho khi ký phiếu: mỗi dòng thuốc có lotId thì trừ đúng số lượng đã dùng (mặc định 1 đơn vị) */
export async function consumeForTransfer(tx: Tx, actor: Actor, transferId: string, medications: { name: string; lot?: string; lotId?: string; qty?: number }[]) {
  for (const m of medications) {
    if (!m.lotId) continue;
    const qty = m.qty && m.qty > 0 ? m.qty : 1;
    const lot = await one(tx, 'UPDATE stock_lots SET qty = qty - $2 WHERE id = $1 AND qty >= $2 RETURNING id, lot', [m.lotId, qty]);
    if (!lot) {
      const cur = await one(tx, 'SELECT lot, qty FROM stock_lots WHERE id = $1', [m.lotId]);
      throw new HttpError(409, cur ? `Lô ${cur.lot} của ${m.name} chỉ còn ${cur.qty} trong kho, không đủ ${qty}` : `Không tìm thấy lô thuốc của ${m.name} trong kho`);
    }
    await tx.query(`INSERT INTO stock_moves(lot_id, delta, reason, transfer_id, user_id) VALUES ($1, $2, 'dung_cho_nguoi_benh', $3, $4)`,
      [m.lotId, -qty, transferId, actor.id]);
  }
  if (medications.some((m) => m.lotId)) {
    await audit(tx, 'system', actor, 'stock.consumed', 'transfer', transferId, {
      items: medications.filter((m) => m.lotId).map((m) => ({ lotId: m.lotId, lot: m.lot, qty: m.qty ?? 1 })),
    });
  }
}
