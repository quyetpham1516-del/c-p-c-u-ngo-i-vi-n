import { audit, type Actor } from './audit.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';

/**
 * Kho thuốc theo số lô (QL-13, QLCL-16): kho điểm → cơ số xe → người bệnh.
 * Mỗi lô nằm ở kho của một điểm (vehicle_id rỗng) hoặc trên một xe của điểm đó. Mọi thay đổi số lượng ghi vào stock_moves;
 * chuyển giữa các nơi (cấp xe, trả kho, điều chuyển) đi qua phiếu kho; kiểm kê có chênh lệch và hủy thuốc phải được người thứ hai duyệt.
 */

export const VOUCHER_LABEL: Record<string, string> = {
  cap_xe: 'Cấp cơ số xe', tra_kho: 'Xe trả kho', dieu_chuyen: 'Điều chuyển giữa điểm', kiem_ke: 'Kiểm kê', huy: 'Hủy thuốc',
};

/** Ai được duyệt phiếu kiểm kê, hủy thuốc (người duyệt phải khác người lập) */
export const STOCK_APPROVERS = ['supervisor', 'admin', 'director'];

const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

export async function receiveStock(tx: Tx, actor: Actor, b: {
  stationId: string; drugId?: number | null; drugName?: string | null; unit?: string | null;
  lot: string; expiry: string; qty: number; supplier?: string | null;
}) {
  const station = await one(tx, 'SELECT id, active FROM stations WHERE id = $1', [b.stationId]);
  if (!station) throw new HttpError(404, 'Không tìm thấy điểm');
  if (!station.active) throw new HttpError(409, `Điểm ${b.stationId} đang tạm ngưng, không nhập kho được`);
  if (b.expiry < today()) throw new HttpError(409, `Lô ${b.lot} đã hết hạn (${b.expiry}), không nhập kho`);
  let drugId = b.drugId ?? null;
  if (!drugId) {
    const name = b.drugName?.trim();
    if (!name) throw new HttpError(400, 'Chọn thuốc hoặc nhập tên thuốc mới');
    const d = await one(tx, `INSERT INTO drugs(name, unit) VALUES ($1, $2)
                             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name, b.unit?.trim() || 'ống']);
    drugId = d.id;
  }
  const lotCode = b.lot.trim();
  const existing = await one(tx, 'SELECT * FROM stock_lots WHERE station_id = $1 AND vehicle_id IS NULL AND drug_id = $2 AND lot = $3 FOR UPDATE', [b.stationId, drugId, lotCode]);
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

/** Chuyển một phần lô sang nơi khác: trừ lô nguồn, cộng vào lô cùng số lô, hạn dùng ở nơi nhận */
async function moveLot(tx: Tx, actor: Actor, lotId: string, qty: number, to: { stationId: string; vehicleId: string | null },
  reason: string, voucherId: string) {
  const src = await one(tx, 'SELECT * FROM stock_lots WHERE id = $1 FOR UPDATE', [lotId]);
  if (!src) throw new HttpError(404, 'Không tìm thấy lô thuốc');
  if (Number(src.qty) < qty) throw new HttpError(409, `Lô ${src.lot} chỉ còn ${Number(src.qty)}, không đủ ${qty}`);
  await tx.query('UPDATE stock_lots SET qty = qty - $2 WHERE id = $1', [lotId, qty]);
  const dst = await one(tx, `
    INSERT INTO stock_lots(station_id, vehicle_id, drug_id, lot, expiry, qty, supplier, received_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (station_id, coalesce(vehicle_id, ''), drug_id, lot) DO UPDATE SET qty = stock_lots.qty + EXCLUDED.qty
    RETURNING id`, [to.stationId, to.vehicleId, src.drug_id, src.lot, src.expiry, qty, src.supplier, actor.id]);
  await tx.query(`INSERT INTO stock_moves(lot_id, delta, reason, voucher_id, user_id) VALUES ($1,$2,$3,$4,$5), ($6,$7,$3,$4,$5)`,
    [lotId, -qty, reason, voucherId, actor.id, dst.id, qty]);
  return dst.id as string;
}

async function newVoucher(tx: Tx, actor: Actor, v: {
  kind: string; status: 'cho_duyet' | 'da_duyet'; stationId: string; vehicleId?: string | null; toStationId?: string | null;
  note?: string | null; witness?: string | null;
}) {
  const year = today().slice(0, 4);
  const n = await nextCounter(tx, `voucher_${v.kind}`, year);
  const prefix = { cap_xe: 'CX', tra_kho: 'TK', dieu_chuyen: 'DC', kiem_ke: 'KK', huy: 'HU' }[v.kind];
  return one(tx, `INSERT INTO stock_vouchers(code, kind, status, station_id, vehicle_id, to_station_id, note, witness, created_by,
                                             decided_by, decided_at)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $3 = 'da_duyet' THEN $9::uuid END, CASE WHEN $3 = 'da_duyet' THEN now() END)
                  RETURNING *`,
  [`${prefix}-${year}-${String(n).padStart(5, '0')}`, v.kind, v.status, v.stationId, v.vehicleId ?? null, v.toStationId ?? null,
    v.note ?? null, v.witness ?? null, actor.id]);
}

async function lotsWithDrug(tx: Tx, ids: string[]) {
  return many(tx, `SELECT l.*, d.name AS drug_name, d.controlled FROM stock_lots l JOIN drugs d ON d.id = l.drug_id WHERE l.id = ANY($1) FOR UPDATE OF l`, [ids]);
}

function requireWitness(lots: { controlled: boolean; drug_name: string }[], witness?: string | null) {
  const c = lots.filter((l) => l.controlled);
  if (c.length && !witness?.trim()) {
    throw new HttpError(409, `Có thuốc kiểm soát đặc biệt (${[...new Set(c.map((l) => l.drug_name))].join(', ')}): phải ghi người chứng kiến`);
  }
}

/* ---------- Cơ số xe ---------- */

/** Thuốc trên xe so với cơ số chuẩn theo loại xe; lô hết hạn không tính */
export async function vehicleParStatus(q: Queryable, vehicleId: string) {
  const v = await one(q, 'SELECT id, type, station_id FROM vehicles WHERE id = $1', [vehicleId]);
  if (!v) throw new HttpError(404, 'Không tìm thấy xe');
  const rows = await many(q, `
    SELECT d.id AS drug_id, d.name AS drug_name, d.unit, d.controlled, p.qty::float AS par,
           coalesce((SELECT sum(l.qty) FROM stock_lots l WHERE l.vehicle_id = $1 AND l.drug_id = d.id AND l.expiry >= current_date), 0)::float AS on_vehicle,
           coalesce((SELECT sum(l.qty) FROM stock_lots l WHERE l.station_id = $3 AND l.vehicle_id IS NULL AND l.drug_id = d.id AND l.expiry >= current_date), 0)::float AS in_station
      FROM par_levels p JOIN drugs d ON d.id = p.drug_id
     WHERE p.vehicle_type = $2 ORDER BY d.name`, [vehicleId, v.type, v.station_id]);
  const items = rows.map((r) => ({ ...r, missing: Math.max(0, r.par - r.on_vehicle) }));
  return { vehicleId, type: v.type, stationId: v.station_id, items, short: items.filter((i) => i.missing > 0).length };
}

/**
 * Bù cơ số xe từ kho điểm (đầu ca hoặc sau ca): mỗi thuốc thiếu so với cơ số chuẩn được lấy từ các lô của kho điểm,
 * lô hết hạn sớm nhất trước. Không đủ trong kho thì bù được bao nhiêu hay bấy nhiêu và báo phần còn thiếu.
 */
export async function restockVehicle(tx: Tx, actor: Actor, vehicleId: string, witness?: string | null) {
  const par = await vehicleParStatus(tx, vehicleId);
  const plan: { lotId: string; qty: number; drug: string; controlled: boolean }[] = [];
  const unfilled: { drug: string; missing: number }[] = [];
  for (const it of par.items.filter((i) => i.missing > 0)) {
    let need = it.missing;
    const lots = await many(tx, `SELECT id, qty::float FROM stock_lots
                                  WHERE station_id = $1 AND vehicle_id IS NULL AND drug_id = $2 AND qty > 0 AND expiry >= current_date
                                  ORDER BY expiry, received_at`, [par.stationId, it.drug_id]);
    for (const l of lots) {
      if (need <= 0) break;
      const take = Math.min(need, l.qty);
      plan.push({ lotId: l.id, qty: take, drug: it.drug_name, controlled: it.controlled });
      need -= take;
    }
    if (need > 0) unfilled.push({ drug: it.drug_name, missing: need });
  }
  if (!plan.length) return { voucher: null, lines: 0, unfilled };
  requireWitness(plan.map((p) => ({ controlled: p.controlled, drug_name: p.drug })), witness);
  const voucher = await newVoucher(tx, actor, { kind: 'cap_xe', status: 'da_duyet', stationId: par.stationId, vehicleId, witness, note: 'Bù cơ số theo chuẩn' });
  for (const p of plan) {
    await tx.query('INSERT INTO stock_voucher_lines(voucher_id, lot_id, qty) VALUES ($1,$2,$3)', [voucher.id, p.lotId, p.qty]);
    await moveLot(tx, actor, p.lotId, p.qty, { stationId: par.stationId, vehicleId }, 'cap_xe', voucher.id);
  }
  await audit(tx, 'system', actor, 'stock.vehicle_restocked', 'vehicle', vehicleId, { voucher: voucher.code, lines: plan.length, unfilled });
  return { voucher, lines: plan.length, unfilled };
}

/** Xe trả thuốc về kho điểm (đổi lô cận hạn, thay xe...) */
export async function returnFromVehicle(tx: Tx, actor: Actor, vehicleId: string, lines: { lotId: string; qty: number }[], witness?: string | null, note?: string | null) {
  const lots = await lotsWithDrug(tx, lines.map((l) => l.lotId));
  for (const l of lines) {
    const lot = lots.find((x) => x.id === l.lotId);
    if (!lot || lot.vehicle_id !== vehicleId) throw new HttpError(409, 'Lô không nằm trên xe này');
  }
  requireWitness(lots, witness);
  const stationId = lots[0].station_id;
  const voucher = await newVoucher(tx, actor, { kind: 'tra_kho', status: 'da_duyet', stationId, vehicleId, witness, note });
  for (const l of lines) {
    await tx.query('INSERT INTO stock_voucher_lines(voucher_id, lot_id, qty) VALUES ($1,$2,$3)', [voucher.id, l.lotId, l.qty]);
    await moveLot(tx, actor, l.lotId, l.qty, { stationId, vehicleId: null }, 'tra_kho', voucher.id);
  }
  await audit(tx, 'system', actor, 'stock.vehicle_returned', 'stock_voucher', voucher.id, { code: voucher.code, vehicleId });
  return voucher;
}

/** Điều chuyển thuốc giữa hai kho điểm */
export async function transferBetweenStations(tx: Tx, actor: Actor, fromStation: string, toStation: string, lines: { lotId: string; qty: number }[],
  witness?: string | null, note?: string | null) {
  if (fromStation === toStation) throw new HttpError(400, 'Điểm nhận phải khác điểm xuất');
  const to = await one(tx, 'SELECT active FROM stations WHERE id = $1', [toStation]);
  if (!to) throw new HttpError(404, 'Không tìm thấy điểm nhận');
  if (!to.active) throw new HttpError(409, `Điểm ${toStation} đang tạm ngưng`);
  const lots = await lotsWithDrug(tx, lines.map((l) => l.lotId));
  for (const l of lines) {
    const lot = lots.find((x) => x.id === l.lotId);
    if (!lot || lot.station_id !== fromStation || lot.vehicle_id) throw new HttpError(409, 'Lô không nằm trong kho điểm xuất');
  }
  requireWitness(lots, witness);
  const voucher = await newVoucher(tx, actor, { kind: 'dieu_chuyen', status: 'da_duyet', stationId: fromStation, toStationId: toStation, witness, note });
  for (const l of lines) {
    await tx.query('INSERT INTO stock_voucher_lines(voucher_id, lot_id, qty) VALUES ($1,$2,$3)', [voucher.id, l.lotId, l.qty]);
    await moveLot(tx, actor, l.lotId, l.qty, { stationId: toStation, vehicleId: null }, 'dieu_chuyen', voucher.id);
  }
  await audit(tx, 'system', actor, 'stock.transferred', 'stock_voucher', voucher.id, { code: voucher.code, fromStation, toStation });
  return voucher;
}

/**
 * Kiểm kê: ghi số đếm thực tế từng lô. Khớp sổ thì phiếu duyệt luôn; có chênh lệch thì chờ người thứ hai duyệt
 * mới điều chỉnh số lượng.
 */
export async function createStocktake(tx: Tx, actor: Actor, b: { stationId: string; vehicleId?: string | null; lines: { lotId: string; counted: number }[]; note?: string | null }) {
  const lots = await lotsWithDrug(tx, b.lines.map((l) => l.lotId));
  const rows = b.lines.map((l) => {
    const lot = lots.find((x) => x.id === l.lotId);
    if (!lot || lot.station_id !== b.stationId || (lot.vehicle_id ?? null) !== (b.vehicleId ?? null)) throw new HttpError(409, 'Lô không thuộc nơi đang kiểm kê');
    return { lotId: l.lotId, counted: l.counted, book: Number(lot.qty), diff: l.counted - Number(lot.qty) };
  });
  const hasDiff = rows.some((r) => r.diff !== 0);
  const voucher = await newVoucher(tx, actor, { kind: 'kiem_ke', status: hasDiff ? 'cho_duyet' : 'da_duyet', stationId: b.stationId, vehicleId: b.vehicleId, note: b.note });
  for (const r of rows) {
    await tx.query('INSERT INTO stock_voucher_lines(voucher_id, lot_id, qty, counted_qty, book_qty) VALUES ($1,$2,$3,$4,$5)', [voucher.id, r.lotId, r.diff, r.counted, r.book]);
  }
  await audit(tx, 'system', actor, 'stock.stocktake_created', 'stock_voucher', voucher.id, { code: voucher.code, diffs: rows.filter((r) => r.diff !== 0).length });
  return voucher;
}

/** Hủy thuốc hết hạn, vỡ, hỏng: lập phiếu, chờ duyệt rồi mới trừ kho */
export async function createDisposal(tx: Tx, actor: Actor, b: { stationId: string; lines: { lotId: string; qty: number }[]; note: string; witness?: string | null }) {
  const lots = await lotsWithDrug(tx, b.lines.map((l) => l.lotId));
  for (const l of b.lines) {
    const lot = lots.find((x) => x.id === l.lotId);
    if (!lot || lot.station_id !== b.stationId) throw new HttpError(409, 'Lô không thuộc điểm này');
    if (Number(lot.qty) < l.qty) throw new HttpError(409, `Lô ${lot.lot} chỉ còn ${Number(lot.qty)}`);
  }
  requireWitness(lots, b.witness);
  const voucher = await newVoucher(tx, actor, { kind: 'huy', status: 'cho_duyet', stationId: b.stationId, note: b.note, witness: b.witness });
  for (const l of b.lines) await tx.query('INSERT INTO stock_voucher_lines(voucher_id, lot_id, qty) VALUES ($1,$2,$3)', [voucher.id, l.lotId, l.qty]);
  await audit(tx, 'system', actor, 'stock.disposal_created', 'stock_voucher', voucher.id, { code: voucher.code });
  return voucher;
}

/** Duyệt hoặc từ chối phiếu kiểm kê/hủy thuốc; người duyệt phải khác người lập */
export async function decideVoucher(tx: Tx, actor: Actor, id: string, approve: boolean, note?: string | null) {
  const v = await one(tx, 'SELECT * FROM stock_vouchers WHERE id = $1 FOR UPDATE', [id]);
  if (!v) throw new HttpError(404, 'Không tìm thấy phiếu');
  if (v.status !== 'cho_duyet') throw new HttpError(409, 'Phiếu không ở trạng thái chờ duyệt');
  if (v.created_by === actor.id) throw new HttpError(403, 'Người lập phiếu không được tự duyệt (duyệt hai cấp)');
  if (approve) {
    const lines = await many(tx, 'SELECT * FROM stock_voucher_lines WHERE voucher_id = $1', [id]);
    for (const l of lines) {
      const delta = v.kind === 'huy' ? -Number(l.qty) : Number(l.qty);
      if (delta === 0) continue;
      const lot = await one(tx, 'UPDATE stock_lots SET qty = qty + $2 WHERE id = $1 AND qty + $2 >= 0 RETURNING id', [l.lot_id, delta]);
      if (!lot) throw new HttpError(409, 'Số lượng lô đã thay đổi từ lúc lập phiếu; kiểm kê lại');
      await tx.query('INSERT INTO stock_moves(lot_id, delta, reason, voucher_id, note, user_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [l.lot_id, delta, v.kind, id, note ?? v.note, actor.id]);
    }
  }
  await tx.query('UPDATE stock_vouchers SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1',
    [id, approve ? 'da_duyet' : 'tu_choi', actor.id, note ?? null]);
  await audit(tx, 'system', actor, approve ? 'stock.voucher_approved' : 'stock.voucher_rejected', 'stock_voucher', id, { code: v.code, kind: v.kind });
}

/* ---------- Dùng cho người bệnh ---------- */

/**
 * Các lô còn dùng được cho một xe: lô trên xe (cơ số) trước, sau đó lô ở kho điểm của xe;
 * trong mỗi nơi, lô hết hạn sớm nhất đứng trước (FEFO)
 */
export async function lotsForVehicle(q: Queryable, vehicleId: string) {
  return many(q, `
    SELECT l.id, l.lot, l.expiry, l.qty, d.id AS drug_id, d.name AS drug_name, d.unit, d.default_route, d.controlled,
           CASE WHEN l.vehicle_id IS NULL THEN 'kho' ELSE 'xe' END AS place
      FROM stock_lots l JOIN drugs d ON d.id = l.drug_id JOIN vehicles v ON v.id = $1
     WHERE (l.vehicle_id = v.id OR (l.vehicle_id IS NULL AND l.station_id = v.station_id))
       AND l.qty > 0 AND l.expiry >= current_date AND d.active
     ORDER BY d.name, (l.vehicle_id IS NULL), l.expiry, l.received_at`, [vehicleId]);
}

/**
 * Trừ kho khi ký phiếu: mỗi dòng thuốc có lotId thì trừ đúng số lượng đã dùng (mặc định 1 đơn vị).
 * Thuốc kiểm soát đặc biệt phải có người chứng kiến.
 */
export async function consumeForTransfer(tx: Tx, actor: Actor, transferId: string,
  medications: { name: string; lot?: string; lotId?: string; qty?: number; witness?: string }[]) {
  for (const m of medications) {
    if (!m.lotId) continue;
    const qty = m.qty && m.qty > 0 ? m.qty : 1;
    const info = await one(tx, 'SELECT d.controlled, d.name FROM stock_lots l JOIN drugs d ON d.id = l.drug_id WHERE l.id = $1', [m.lotId]);
    if (info?.controlled && !m.witness?.trim()) throw new HttpError(409, `${info.name} là thuốc kiểm soát đặc biệt: phải ghi người chứng kiến`);
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

/* ---------- Cảnh báo và đặt hàng ---------- */

/** Lô hết hạn còn tồn, lô sắp hết hạn, kho dưới định mức, xe thiếu cơ số, phiếu chờ duyệt */
export async function stockAlerts(q: Queryable, stationId: string | null, days = 90) {
  const [expired, expiring, belowMin, vehicles, pending] = await Promise.all([
    many(q, `SELECT l.id, l.station_id, l.vehicle_id, l.lot, l.expiry, l.qty::float, d.name AS drug_name, d.unit
               FROM stock_lots l JOIN drugs d ON d.id = l.drug_id
              WHERE l.qty > 0 AND l.expiry < current_date AND ($1::text IS NULL OR l.station_id = $1) ORDER BY l.expiry`, [stationId]),
    many(q, `SELECT l.id, l.station_id, l.vehicle_id, l.lot, l.expiry, l.qty::float, d.name AS drug_name, d.unit, (l.expiry - current_date) AS days_left
               FROM stock_lots l JOIN drugs d ON d.id = l.drug_id
              WHERE l.qty > 0 AND l.expiry >= current_date AND l.expiry < current_date + $2::int AND ($1::text IS NULL OR l.station_id = $1)
              ORDER BY l.expiry`, [stationId, days]),
    many(q, `SELECT m.station_id, d.id AS drug_id, d.name AS drug_name, d.unit, m.min_qty::float,
                    coalesce((SELECT sum(l.qty) FROM stock_lots l WHERE l.station_id = m.station_id AND l.vehicle_id IS NULL
                               AND l.drug_id = m.drug_id AND l.expiry >= current_date), 0)::float AS on_hand
               FROM stock_minimums m JOIN drugs d ON d.id = m.drug_id
              WHERE ($1::text IS NULL OR m.station_id = $1)`, [stationId]).then((r) => r.filter((x) => x.on_hand < x.min_qty)),
    many(q, `SELECT id FROM vehicles WHERE ($1::text IS NULL OR station_id = $1) ORDER BY id`, [stationId]),
    one(q, `SELECT count(*)::int AS n FROM stock_vouchers WHERE status = 'cho_duyet' AND ($1::text IS NULL OR station_id = $1)`, [stationId]),
  ]);
  const vehicleShort = [];
  for (const v of vehicles) {
    const s = await vehicleParStatus(q, v.id);
    if (s.short) vehicleShort.push({ vehicleId: v.id, short: s.short, items: s.items.filter((i) => i.missing > 0).map((i) => ({ drug: i.drug_name, missing: i.missing })) });
  }
  return { expired, expiring, belowMin, vehicleShort, pendingVouchers: pending?.n ?? 0 };
}

/**
 * Đề xuất đặt hàng tuần cho một điểm: lượng dùng 7 ngày qua (cho người bệnh, của cả kho điểm và xe thuộc điểm)
 * + định mức tối thiểu − tồn kho điểm còn hạn
 */
export async function orderSuggestion(q: Queryable, stationId: string) {
  const rows = await many(q, `
    WITH used AS (
      SELECT l.drug_id, -sum(m.delta) AS used
        FROM stock_moves m JOIN stock_lots l ON l.id = m.lot_id
       WHERE m.reason = 'dung_cho_nguoi_benh' AND m.at > now() - interval '7 days' AND l.station_id = $1
       GROUP BY l.drug_id),
    onhand AS (
      SELECT drug_id, sum(qty) AS qty FROM stock_lots
       WHERE station_id = $1 AND vehicle_id IS NULL AND expiry >= current_date GROUP BY drug_id)
    SELECT d.id AS drug_id, d.name AS drug_name, d.unit,
           coalesce(u.used, 0)::float AS used_7d, coalesce(m.min_qty, 0)::float AS min_qty, coalesce(o.qty, 0)::float AS on_hand
      FROM drugs d
      LEFT JOIN used u ON u.drug_id = d.id
      LEFT JOIN onhand o ON o.drug_id = d.id
      LEFT JOIN stock_minimums m ON m.station_id = $1 AND m.drug_id = d.id
     WHERE d.active AND (u.used IS NOT NULL OR m.min_qty IS NOT NULL)
     ORDER BY d.name`, [stationId]);
  return rows.map((r) => ({ ...r, order: Math.max(0, Math.ceil(r.used_7d + r.min_qty - r.on_hand)) })).filter((r) => r.order > 0);
}
