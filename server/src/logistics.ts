import { audit, type Actor } from './audit.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';
import { getSettings } from './finance.js';
import { orderSuggestion, receiveStock, STOCK_APPROVERS } from './stock.js';

/**
 * Hậu cần (giai đoạn Y): mua hàng theo đơn và nhận vào kho theo lô (QL-13), sổ thuốc kiểm soát đặc biệt (QLCL-16),
 * bình oxy, nhiệt độ nơi bảo quản thuốc, tài sản cố định và khấu hao, đồng phục và bảo hộ lao động.
 */

const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const year = () => today().slice(0, 4);
async function code(tx: Tx, name: string, prefix: string) {
  const n = await nextCounter(tx, name, year());
  return `${prefix}-${year()}-${String(n).padStart(5, '0')}`;
}

export { STOCK_APPROVERS };

/* ================= Mua hàng ================= */

export const PO_STATUS: Record<string, string> = {
  cho_duyet: 'Chờ duyệt', da_duyet: 'Đã duyệt, chờ hàng', dang_nhan: 'Đang nhận (thiếu)', da_nhan: 'Đã nhận đủ', tu_choi: 'Từ chối', huy: 'Đã hủy',
};

export async function createPurchaseOrder(tx: Tx, actor: Actor, b: {
  stationId: string; supplierId: string; expectedOn?: string | null; note?: string | null; proposalId?: string | null;
  lines: { drugId: number; qty: number; unitPrice: number }[];
}) {
  const station = await one(tx, 'SELECT id, active FROM stations WHERE id = $1', [b.stationId]);
  if (!station) throw new HttpError(404, 'Không tìm thấy điểm');
  if (!station.active) throw new HttpError(409, `Điểm ${b.stationId} đang tạm ngưng`);
  const sup = await one(tx, 'SELECT id, name, status FROM qm_suppliers WHERE id = $1', [b.supplierId]);
  if (!sup) throw new HttpError(404, 'Không tìm thấy nhà cung cấp');
  if (sup.status === 'ngung') throw new HttpError(409, `${sup.name} đã ngừng hợp tác (danh sách nhà cung cấp, Hệ thống CL)`);
  if (new Set(b.lines.map((l) => l.drugId)).size !== b.lines.length) throw new HttpError(400, 'Mỗi thuốc chỉ ghi một dòng');
  const drugs = await many(tx, 'SELECT id FROM drugs WHERE id = ANY($1) AND active', [b.lines.map((l) => l.drugId)]);
  if (drugs.length !== b.lines.length) throw new HttpError(409, 'Có thuốc không có trong danh mục hoặc đã ngừng dùng');
  const total = Math.round(b.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
  // Đơn từ ngưỡng duyệt chi trở lên phải gắn đề xuất chi mua sắm đã được duyệt (Tài chính → Đề xuất chi)
  const s = await getSettings(tx);
  if (total >= s.approvalThreshold) {
    if (!b.proposalId) throw new HttpError(409, `Tổng ${total.toLocaleString('vi-VN')} đ từ ngưỡng duyệt chi ${s.approvalThreshold.toLocaleString('vi-VN')} đ: gắn đề xuất chi mua sắm đã duyệt`);
    const p = await one(tx, 'SELECT status, amount, kind FROM proposals WHERE id = $1', [b.proposalId]);
    if (!p || !['da_duyet', 'da_chi'].includes(p.status)) throw new HttpError(409, 'Đề xuất chi chưa được duyệt');
    if (Number(p.amount) < total) throw new HttpError(409, `Đề xuất chi chỉ duyệt ${Number(p.amount).toLocaleString('vi-VN')} đ, nhỏ hơn tổng đơn`);
  }
  const po = await one(tx, `INSERT INTO purchase_orders(code, station_id, supplier_id, expected_on, note, total, proposal_id, created_by)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
  [await code(tx, 'purchase_order', 'DH'), b.stationId, b.supplierId, b.expectedOn ?? null, b.note ?? null, total, b.proposalId ?? null, actor.id]);
  for (const l of b.lines) {
    await tx.query('INSERT INTO purchase_order_lines(order_id, drug_id, qty, unit_price) VALUES ($1,$2,$3,$4)', [po.id, l.drugId, l.qty, l.unitPrice]);
  }
  await audit(tx, 'system', actor, 'logistics.po_created', 'purchase_order', po.id, { code: po.code, total, lines: b.lines.length });
  return po;
}

/** Duyệt hoặc từ chối đơn đặt hàng; người duyệt phải khác người lập */
export async function decidePurchaseOrder(tx: Tx, actor: Actor, id: string, approve: boolean, note?: string | null) {
  const po = await one(tx, 'SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
  if (!po) throw new HttpError(404, 'Không tìm thấy đơn đặt hàng');
  if (po.status !== 'cho_duyet') throw new HttpError(409, 'Đơn không ở trạng thái chờ duyệt');
  if (po.created_by === actor.id) throw new HttpError(403, 'Người lập đơn không được tự duyệt (duyệt hai cấp)');
  const status = approve ? 'da_duyet' : 'tu_choi';
  await tx.query('UPDATE purchase_orders SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1', [id, status, actor.id, note ?? null]);
  await audit(tx, 'system', actor, `logistics.po_${status}`, 'purchase_order', id, { code: po.code, note: note ?? null });
}

export async function cancelPurchaseOrder(tx: Tx, actor: Actor, role: string, id: string, note: string) {
  const po = await one(tx, 'SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
  if (!po) throw new HttpError(404, 'Không tìm thấy đơn đặt hàng');
  if (!['cho_duyet', 'da_duyet'].includes(po.status)) throw new HttpError(409, 'Chỉ hủy được đơn chưa nhận hàng');
  if (po.created_by !== actor.id && !STOCK_APPROVERS.includes(role)) throw new HttpError(403, 'Chỉ người lập hoặc người duyệt được hủy đơn');
  await tx.query(`UPDATE purchase_orders SET status = 'huy', decision_note = $2 WHERE id = $1`, [id, note]);
  await audit(tx, 'system', actor, 'logistics.po_cancelled', 'purchase_order', id, { code: po.code, note });
}

/**
 * Nhận hàng theo đơn đã duyệt: mỗi dòng nhận là một lô (số lô, hạn dùng) cộng vào kho điểm của đơn.
 * Không nhận quá số lượng đặt; nhận đủ mọi dòng thì đơn chuyển "Đã nhận đủ".
 */
export async function receivePurchaseOrder(tx: Tx, actor: Actor, id: string, b: {
  invoiceNo?: string | null; note?: string | null; lines: { lineId: number; lot?: string | null; expiry?: string | null; qty: number }[];
}) {
  const po = await one(tx, `SELECT o.*, s.name AS supplier_name FROM purchase_orders o JOIN qm_suppliers s ON s.id = o.supplier_id
                             WHERE o.id = $1 FOR UPDATE OF o`, [id]);
  if (!po) throw new HttpError(404, 'Không tìm thấy đơn đặt hàng');
  if (!['da_duyet', 'dang_nhan'].includes(po.status)) throw new HttpError(409, 'Chỉ nhận hàng cho đơn đã duyệt');
  const poLines = await many(tx, `SELECT pl.*, d.name AS drug_name FROM purchase_order_lines pl JOIN drugs d ON d.id = pl.drug_id
                                   WHERE pl.order_id = $1 FOR UPDATE OF pl`, [id]);
  const receipt = await one(tx, `INSERT INTO goods_receipts(code, order_id, invoice_no, note, received_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [await code(tx, 'goods_receipt', 'NK'), id, b.invoiceNo?.trim() || null, b.note ?? null, actor.id]);
  const adding = new Map<number, number>();
  for (const l of b.lines) {
    const pl = poLines.find((x) => Number(x.id) === l.lineId);
    if (!pl) throw new HttpError(409, 'Dòng hàng không thuộc đơn này');
    const sum = (adding.get(l.lineId) ?? 0) + l.qty;
    if (Number(pl.received_qty) + sum > Number(pl.qty)) {
      throw new HttpError(409, `${pl.drug_name}: đặt ${Number(pl.qty)}, đã nhận ${Number(pl.received_qty)}, không nhận thêm ${sum} (lập đơn bổ sung nếu nhà cung cấp giao dư)`);
    }
    adding.set(l.lineId, sum);
    const lot = await receiveStock(tx, actor, {
      stationId: po.station_id, drugId: pl.drug_id, lot: l.lot, expiry: l.expiry, qty: l.qty, supplier: po.supplier_name, receiptId: receipt.id,
    });
    await tx.query('INSERT INTO goods_receipt_lines(receipt_id, line_id, lot_id, qty) VALUES ($1,$2,$3,$4)', [receipt.id, l.lineId, lot.id, l.qty]);
  }
  for (const [lineId, qty] of adding) await tx.query('UPDATE purchase_order_lines SET received_qty = received_qty + $2 WHERE id = $1', [lineId, qty]);
  const left = await one(tx, 'SELECT count(*)::int AS n FROM purchase_order_lines WHERE order_id = $1 AND received_qty < qty', [id]);
  const status = left.n === 0 ? 'da_nhan' : 'dang_nhan';
  await tx.query('UPDATE purchase_orders SET status = $2 WHERE id = $1', [id, status]);
  await audit(tx, 'system', actor, 'logistics.po_received', 'purchase_order', id, { code: po.code, receipt: receipt.code, status });
  return { ...receipt, orderStatus: status };
}

/** Đề xuất đặt hàng của kho điểm kèm đơn giá lần mua gần nhất để lập đơn nhanh */
export async function purchaseSuggestion(q: Queryable, stationId: string) {
  const rows = await orderSuggestion(q, stationId);
  if (!rows.length) return rows;
  const prices = await many(q, `
    SELECT DISTINCT ON (pl.drug_id) pl.drug_id, pl.unit_price::float AS unit_price, o.supplier_id
      FROM purchase_order_lines pl JOIN purchase_orders o ON o.id = pl.order_id
     WHERE pl.drug_id = ANY($1) AND o.status NOT IN ('tu_choi', 'huy')
     ORDER BY pl.drug_id, o.created_at DESC`, [rows.map((r) => r.drug_id)]);
  return rows.map((r) => {
    const p = prices.find((x) => x.drug_id === r.drug_id);
    return { ...r, last_price: p?.unit_price ?? null, last_supplier_id: p?.supplier_id ?? null };
  });
}

/* ================= Sổ theo dõi thuốc kiểm soát đặc biệt ================= */

export const CONTROL_CLASS: Record<string, string> = { gay_nghien: 'Gây nghiện', huong_than: 'Hướng thần', tien_chat: 'Tiền chất' };
const MOVE_LABEL: Record<string, string> = {
  nhap_kho: 'Nhập kho', dung_cho_nguoi_benh: 'Dùng cho người bệnh', dieu_chinh: 'Điều chỉnh', dieu_chuyen: 'Điều chuyển', kiem_ke: 'Kiểm kê',
  huy: 'Hủy', cap_xe: 'Cấp cơ số xe', tra_kho: 'Xe trả kho',
};

/**
 * Sổ xuất nhập tồn thuốc kiểm soát đặc biệt của một điểm trong một tháng (gồm kho điểm và cơ số trên các xe của điểm).
 * Cấp cơ số xe, xe trả kho là chuyển nội bộ trong điểm nên không ghi thành dòng nhập/xuất. Mẫu sổ theo TT 20/2017/TT-BYT là bản nháp: dược sĩ phụ trách đối chiếu.
 */
export async function controlledLedger(q: Queryable, stationId: string, month: string) {
  const start = `${month}-01`;
  const startTs = new Date(`${start}T00:00:00+07:00`).getTime();
  const [y, m] = month.split('-').map(Number);
  const endTs = new Date(`${new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)}T00:00:00+07:00`).getTime();
  // Tồn hiện tại của điểm (kho + xe); lùi các biến động từ đầu tháng để ra tồn đầu kỳ, kể cả lô nhập trước khi có sổ
  const drugs = await many(q, `
    SELECT d.id, d.name, d.unit, d.control_class,
           coalesce((SELECT sum(l.qty) FROM stock_lots l WHERE l.drug_id = d.id AND l.station_id = $1), 0)::float AS current
      FROM drugs d WHERE d.controlled ORDER BY d.name`, [stationId]);
  const moves = await many(q, `
    SELECT m.id, m.at, m.reason, m.delta::float AS delta, m.note, m.witness AS move_witness, l.drug_id, l.lot, l.expiry, l.vehicle_id,
           v.code AS voucher_code, v.witness AS voucher_witness, t.transfer_number, r.code AS receipt_code, r.invoice_no, u.full_name AS user_name
      FROM stock_moves m JOIN stock_lots l ON l.id = m.lot_id JOIN drugs d ON d.id = l.drug_id
      LEFT JOIN stock_vouchers v ON v.id = m.voucher_id
      LEFT JOIN transfers t ON t.id = m.transfer_id
      LEFT JOIN goods_receipts r ON r.id = m.receipt_id
      LEFT JOIN users u ON u.id = m.user_id
     WHERE d.controlled AND l.station_id = $1 AND m.at >= $2::timestamptz AND m.reason NOT IN ('cap_xe', 'tra_kho')
     ORDER BY m.at, m.id`, [stationId, new Date(startTs).toISOString()]);
  return drugs.map((d) => {
    const mine = moves.filter((x) => x.drug_id === d.id);
    const inMonth = mine.filter((x) => new Date(x.at).getTime() < endTs);
    const after = mine.filter((x) => new Date(x.at).getTime() >= endTs).reduce((s, x) => s + x.delta, 0);
    const closing = d.current - after;
    const opening = closing - inMonth.reduce((s, x) => s + x.delta, 0);
    let balance = opening;
    const rows = inMonth.map((x) => {
      balance += x.delta;
      return {
        at: x.at, kind: MOVE_LABEL[x.reason] ?? x.reason, document: x.voucher_code ?? x.receipt_code ?? (x.transfer_number ? `Phiếu ${x.transfer_number}` : null),
        invoice: x.invoice_no, lot: x.lot, expiry: x.expiry, place: x.vehicle_id ?? 'Kho điểm',
        in: x.delta > 0 ? x.delta : 0, out: x.delta < 0 ? -x.delta : 0, balance, user: x.user_name, witness: x.move_witness ?? x.voucher_witness, note: x.note,
      };
    });
    return {
      drugId: d.id, drug: d.name, unit: d.unit, class: d.control_class, classLabel: CONTROL_CLASS[d.control_class] ?? 'Chưa phân loại',
      opening, totalIn: rows.reduce((s, r) => s + r.in, 0), totalOut: rows.reduce((s, r) => s + r.out, 0), closing, rows,
    };
  }).filter((x) => x.opening !== 0 || x.rows.length);
}

/* ================= Bình oxy ================= */

/** Áp suất dưới mức này (bar) thì cảnh báo thay bình; lưu lượng tham chiếu cho thở mask có túi */
export const O2_LOW_BAR = 50;
export const O2_REF_FLOW = 15;
export const O2_KIND: Record<string, string> = {
  nhap: 'Nhập bình', do_ap: 'Đo áp suất', gan_xe: 'Gắn lên xe', ve_kho: 'Về kho điểm', gui_nap: 'Gửi đi nạp', nhan_nap: 'Nhận bình đã nạp',
  kiem_dinh: 'Kiểm định', hong: 'Báo hỏng', thanh_ly: 'Thanh lý',
};

/** Lít oxy còn lại ≈ dung tích nước × áp suất (bar); phút dùng ở lưu lượng tham chiếu */
export const o2Remaining = (sizeL: number, bar: number | null) => {
  if (bar == null) return { liters: null, minutes: null };
  const liters = Math.round(sizeL * bar);
  return { liters, minutes: Math.floor(liters / O2_REF_FLOW) };
};

export async function addCylinder(tx: Tx, actor: Actor, b: {
  code: string; sizeL: number; stationId: string; fullBar?: number | null; pressureBar?: number | null; nextTestOn?: string | null; supplierId?: string | null; note?: string | null;
}) {
  const dup = await one(tx, 'SELECT 1 FROM o2_cylinders WHERE code = $1', [b.code]);
  if (dup) throw new HttpError(409, `Bình ${b.code} đã có`);
  const full = b.fullBar ?? 150;
  const bar = b.pressureBar ?? full;
  const c = await one(tx, `INSERT INTO o2_cylinders(code, size_l, station_id, full_bar, pressure_bar, status, next_test_on, supplier_id, note, last_filled_on)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $6 = 'day' THEN vn_today() END) RETURNING *`,
  [b.code, b.sizeL, b.stationId, full, bar, bar >= full * 0.9 ? 'day' : bar > 0 ? 'dang_dung' : 'rong', b.nextTestOn ?? null, b.supplierId ?? null, b.note ?? null]);
  await tx.query(`INSERT INTO o2_events(cylinder_id, kind, pressure_bar, user_id) VALUES ($1, 'nhap', $2, $3)`, [c.id, bar, actor.id]);
  await audit(tx, 'system', actor, 'logistics.o2_added', 'o2_cylinder', c.id, { code: b.code });
  return c;
}

/** Ghi một việc với bình: đo áp, gắn xe, về kho, gửi nạp, nhận nạp, kiểm định, báo hỏng, thanh lý */
export async function cylinderEvent(tx: Tx, actor: Actor, id: string, b: {
  kind: string; pressureBar?: number | null; vehicleId?: string | null; nextTestOn?: string | null; note?: string | null;
}) {
  const c = await one(tx, 'SELECT * FROM o2_cylinders WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw new HttpError(404, 'Không tìm thấy bình oxy');
  if (c.status === 'thanh_ly') throw new HttpError(409, 'Bình đã thanh lý');
  const full = Number(c.full_bar);
  const set: Record<string, unknown> = {};
  const statusFor = (bar: number) => (bar >= full * 0.9 ? 'day' : bar > 0 ? 'dang_dung' : 'rong');
  switch (b.kind) {
    case 'do_ap':
      if (b.pressureBar == null) throw new HttpError(400, 'Nhập áp suất đo được (bar)');
      if (c.status === 'gui_nap' || c.status === 'hong') throw new HttpError(409, 'Bình đang gửi nạp hoặc hỏng');
      set.pressure_bar = b.pressureBar; set.status = statusFor(b.pressureBar);
      break;
    case 'gan_xe': {
      if (!b.vehicleId) throw new HttpError(400, 'Chọn xe');
      if (!['day', 'dang_dung'].includes(c.status)) throw new HttpError(409, 'Chỉ gắn lên xe bình còn oxy, không hỏng');
      if (c.next_test_on && c.next_test_on < today()) throw new HttpError(409, `Bình ${c.code} quá hạn kiểm định (${c.next_test_on}), không gắn lên xe`);
      const v = await one(tx, 'SELECT id, station_id FROM vehicles WHERE id = $1', [b.vehicleId]);
      if (!v) throw new HttpError(404, 'Không tìm thấy xe');
      set.vehicle_id = v.id; set.station_id = v.station_id;
      if (b.pressureBar != null) { set.pressure_bar = b.pressureBar; set.status = statusFor(b.pressureBar); }
      break;
    }
    case 've_kho':
      set.vehicle_id = null;
      if (b.pressureBar != null) { set.pressure_bar = b.pressureBar; set.status = statusFor(b.pressureBar); }
      break;
    case 'gui_nap':
      if (c.status === 'hong') throw new HttpError(409, 'Bình hỏng: kiểm định hoặc thanh lý trước');
      set.vehicle_id = null; set.status = 'gui_nap';
      break;
    case 'nhan_nap': {
      if (c.status !== 'gui_nap' && c.status !== 'rong') throw new HttpError(409, 'Bình không ở trạng thái gửi nạp');
      const bar = b.pressureBar ?? full;
      set.pressure_bar = bar; set.status = statusFor(bar); set.last_filled_on = today();
      break;
    }
    case 'kiem_dinh':
      if (!b.nextTestOn) throw new HttpError(400, 'Nhập hạn kiểm định tiếp theo');
      set.next_test_on = b.nextTestOn;
      if (c.status === 'hong') set.status = 'rong';
      break;
    case 'hong':
      if (!b.note?.trim()) throw new HttpError(400, 'Ghi tình trạng hỏng');
      set.status = 'hong'; set.vehicle_id = null;
      break;
    case 'thanh_ly':
      if (!b.note?.trim()) throw new HttpError(400, 'Ghi lý do thanh lý');
      set.status = 'thanh_ly'; set.vehicle_id = null;
      break;
    default:
      throw new HttpError(400, 'Loại việc không hợp lệ');
  }
  const keys = Object.keys(set);
  if (keys.length) {
    await tx.query(`UPDATE o2_cylinders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => set[k])]);
  }
  await tx.query('INSERT INTO o2_events(cylinder_id, kind, pressure_bar, vehicle_id, note, user_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, b.kind, b.pressureBar ?? null, b.vehicleId ?? c.vehicle_id ?? null, b.note ?? null, actor.id]);
  await audit(tx, 'system', actor, `logistics.o2_${b.kind}`, 'o2_cylinder', id, { code: c.code, ...b });
  return one(tx, 'SELECT * FROM o2_cylinders WHERE id = $1', [id]);
}

export async function listCylinders(q: Queryable, stationId: string | null) {
  const rows = await many(q, `
    SELECT c.*, c.size_l::float AS size_l, c.pressure_bar::float AS pressure_bar, c.full_bar::float AS full_bar, s.name AS supplier_name,
           (SELECT max(at) FROM o2_events e WHERE e.cylinder_id = c.id AND e.kind = 'gui_nap') AS sent_at
      FROM o2_cylinders c LEFT JOIN qm_suppliers s ON s.id = c.supplier_id
     WHERE c.status <> 'thanh_ly' AND ($1::text IS NULL OR c.station_id = $1)
     ORDER BY c.vehicle_id NULLS LAST, c.code`, [stationId]);
  return rows.map((r) => ({ ...r, ...o2Remaining(r.size_l, r.pressure_bar) }));
}

/** Bình trên xe sắp cạn, bình sắp/quá hạn kiểm định, xe không có bình đầy, bình gửi nạp quá 7 ngày */
export async function o2Alerts(q: Queryable, stationId: string | null) {
  const cyl = await listCylinders(q, stationId);
  const soon = new Date(Date.now() + 7 * 3600_000 + 30 * 86400_000).toISOString().slice(0, 10);
  const vehicles = await many(q, `SELECT id FROM vehicles WHERE ($1::text IS NULL OR station_id = $1) ORDER BY id`, [stationId]);
  return {
    low: cyl.filter((c) => c.vehicle_id && c.pressure_bar != null && c.pressure_bar < O2_LOW_BAR),
    testDue: cyl.filter((c) => c.next_test_on && c.next_test_on <= soon && c.status !== 'hong'),
    vehiclesWithoutFull: vehicles.map((v) => v.id).filter((id) => !cyl.some((c) => c.vehicle_id === id && c.status === 'day')),
    atSupplierLong: cyl.filter((c) => c.status === 'gui_nap' && c.sent_at && Date.now() - new Date(c.sent_at).getTime() > 7 * 86400_000),
  };
}

/* ================= Nhiệt độ bảo quản ================= */

export const POINT_KIND: Record<string, string> = { kho: 'Kho thuốc', tu_thuoc: 'Tủ thuốc', tu_lanh: 'Tủ lạnh bảo quản', xe: 'Khoang thuốc trên xe' };
/** Ngưỡng mặc định: kho/tủ thường 15–30 °C, độ ẩm ≤ 75%; tủ lạnh 2–8 °C (cơ sở chỉnh từng nơi theo hướng dẫn của dược) */
export const POINT_DEFAULTS: Record<string, { min: number; max: number; hum: number | null }> = {
  kho: { min: 15, max: 30, hum: 75 }, tu_thuoc: { min: 15, max: 30, hum: 75 }, tu_lanh: { min: 2, max: 8, hum: null }, xe: { min: 15, max: 30, hum: null },
};
/** Ghi ít nhất 2 lần mỗi ngày: quá 12 giờ không có số đo thì nhắc */
export const TEMP_GAP_HOURS = 12;

export async function addReading(tx: Tx, actor: Actor, pointId: string, b: { tempC: number; humidity?: number | null; action?: string | null }) {
  const p = await one(tx, 'SELECT * FROM storage_points WHERE id = $1 AND active', [pointId]);
  if (!p) throw new HttpError(404, 'Không tìm thấy nơi bảo quản');
  const out = b.tempC < Number(p.min_c) || b.tempC > Number(p.max_c) || (p.max_humidity != null && b.humidity != null && b.humidity > Number(p.max_humidity));
  if (out && !b.action?.trim()) throw new HttpError(409, `Ngoài ngưỡng ${Number(p.min_c)}–${Number(p.max_c)} °C${p.max_humidity != null ? `, độ ẩm ≤ ${Number(p.max_humidity)}%` : ''}: ghi cách xử trí (chuyển thuốc, gọi kỹ thuật...)`);
  const r = await one(tx, `INSERT INTO temp_readings(point_id, temp_c, humidity, out_of_range, action, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [pointId, b.tempC, b.humidity ?? null, out, b.action?.trim() || null, actor.id]);
  if (out) await audit(tx, 'system', actor, 'logistics.temp_out_of_range', 'storage_point', pointId, { name: p.name, tempC: b.tempC, humidity: b.humidity ?? null });
  return r;
}

export async function tempAlerts(q: Queryable, stationId: string | null) {
  const [open, stale] = await Promise.all([
    many(q, `SELECT r.id, r.at, r.temp_c::float AS temp_c, r.humidity::float AS humidity, r.action, p.name, p.station_id, p.min_c::float AS min_c, p.max_c::float AS max_c,
                    u.full_name AS user_name
               FROM temp_readings r JOIN storage_points p ON p.id = r.point_id LEFT JOIN users u ON u.id = r.user_id
              WHERE r.out_of_range AND r.ack_at IS NULL AND ($1::text IS NULL OR p.station_id = $1) ORDER BY r.at`, [stationId]),
    many(q, `SELECT p.id, p.name, p.station_id, (SELECT max(at) FROM temp_readings r WHERE r.point_id = p.id) AS last_at
               FROM storage_points p
              WHERE p.active AND ($1::text IS NULL OR p.station_id = $1)
                AND NOT EXISTS (SELECT 1 FROM temp_readings r WHERE r.point_id = p.id AND r.at > now() - make_interval(hours => $2))
              ORDER BY p.station_id, p.name`, [stationId, TEMP_GAP_HOURS]),
  ]);
  return { outOfRange: open, noRecentReading: stale };
}

/* ================= Tài sản cố định ================= */

export const ASSET_CATEGORY: Record<string, string> = {
  xe: 'Xe cứu thương', thiet_bi_y_te: 'Thiết bị y tế', cntt: 'Máy tính, mạng', nha_cua: 'Nhà cửa, vật kiến trúc', noi_that: 'Nội thất', khac: 'Khác',
};

/** Số tháng tròn từ ngày ghi tăng đến ngày tính (khấu hao bắt đầu từ ngày ghi tăng, theo tháng tròn) */
export function monthsBetween(from: string, to: string) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const m = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  return Math.max(0, m);
}

/** Khấu hao đường thẳng: (nguyên giá − giá trị thu hồi) / số tháng sử dụng; dừng khi hết thời gian hoặc đã thanh lý */
export function depreciation(a: { cost: number; salvage: number; life_months: number; acquired_on: string; disposed_on?: string | null }, asOf: string) {
  const until = a.disposed_on && a.disposed_on < asOf ? a.disposed_on : asOf;
  const months = Math.min(a.life_months, monthsBetween(a.acquired_on, until));
  const monthly = (a.cost - a.salvage) / a.life_months;
  const accumulated = Math.round(monthly * months);
  return { monthsUsed: months, monthly: Math.round(monthly), accumulated, netBook: a.cost - accumulated, fullyDepreciated: months >= a.life_months };
}

export async function listAssets(q: Queryable, asOf: string, stationId: string | null) {
  const rows = await many(q, `
    SELECT a.*, a.cost::float AS cost, a.salvage::float AS salvage, e.serial AS equipment_serial
      FROM fixed_assets a LEFT JOIN equipment e ON e.id = a.equipment_id
     WHERE ($1::text IS NULL OR a.station_id = $1) AND a.acquired_on <= $2
     ORDER BY a.status, a.category, a.code`, [stationId, asOf]);
  const items = rows.map((r) => ({ ...r, ...depreciation(r, asOf) }));
  const live = items.filter((i) => i.status === 'dang_dung');
  return {
    asOf, items,
    totals: {
      cost: live.reduce((s, i) => s + i.cost, 0), accumulated: live.reduce((s, i) => s + i.accumulated, 0),
      netBook: live.reduce((s, i) => s + i.netBook, 0), monthly: live.filter((i) => !i.fullyDepreciated).reduce((s, i) => s + i.monthly, 0),
    },
  };
}

export async function addAsset(tx: Tx, actor: Actor, b: {
  name: string; category: string; stationId?: string | null; vehicleId?: string | null; equipmentId?: string | null;
  acquiredOn: string; cost: number; lifeMonths: number; salvage?: number | null; note?: string | null;
}) {
  if ((b.salvage ?? 0) >= b.cost) throw new HttpError(400, 'Giá trị thu hồi phải nhỏ hơn nguyên giá');
  if (b.acquiredOn > today()) throw new HttpError(400, 'Ngày ghi tăng không được ở tương lai');
  const a = await one(tx, `INSERT INTO fixed_assets(code, name, category, station_id, vehicle_id, equipment_id, acquired_on, cost, life_months, salvage, note, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
  [await code(tx, 'fixed_asset', 'TS'), b.name, b.category, b.stationId ?? null, b.vehicleId ?? null, b.equipmentId ?? null,
    b.acquiredOn, b.cost, b.lifeMonths, b.salvage ?? 0, b.note ?? null, actor.id]);
  await audit(tx, 'system', actor, 'logistics.asset_added', 'fixed_asset', a.id, { code: a.code, cost: b.cost, lifeMonths: b.lifeMonths });
  return a;
}

export async function disposeAsset(tx: Tx, actor: Actor, id: string, b: { disposedOn: string; note: string }) {
  const a = await one(tx, 'SELECT * FROM fixed_assets WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw new HttpError(404, 'Không tìm thấy tài sản');
  if (a.status === 'thanh_ly') throw new HttpError(409, 'Tài sản đã thanh lý');
  if (b.disposedOn < a.acquired_on) throw new HttpError(400, 'Ngày thanh lý trước ngày ghi tăng');
  await tx.query(`UPDATE fixed_assets SET status = 'thanh_ly', disposed_on = $2, disposal_note = $3 WHERE id = $1`, [id, b.disposedOn, b.note]);
  await audit(tx, 'system', actor, 'logistics.asset_disposed', 'fixed_asset', id, { code: a.code, ...b });
}

/* ================= Đồng phục, bảo hộ lao động ================= */

export function addMonths(date: string, months: number) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

export async function issuePpe(tx: Tx, actor: Actor, b: { userId: string; itemId: number; qty: number; size?: string | null; issuedOn: string; note?: string | null }) {
  const [u, item] = await Promise.all([
    one(tx, 'SELECT id, full_name, active FROM users WHERE id = $1', [b.userId]),
    one(tx, 'SELECT * FROM ppe_items WHERE id = $1 AND active', [b.itemId]),
  ]);
  if (!u || !u.active) throw new HttpError(404, 'Không tìm thấy nhân viên đang làm');
  if (!item) throw new HttpError(404, 'Không tìm thấy loại đồng phục/bảo hộ');
  const due = item.replace_months ? addMonths(b.issuedOn, item.replace_months) : null;
  const r = await one(tx, `INSERT INTO ppe_issues(user_id, item_id, qty, size, issued_on, due_on, note, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [b.userId, b.itemId, b.qty, b.size?.trim() || null, b.issuedOn, due, b.note ?? null, actor.id]);
  await audit(tx, 'system', actor, 'logistics.ppe_issued', 'user', b.userId, { item: item.name, qty: b.qty });
  return r;
}

export const PPE_SELECT = `
  SELECT i.*, p.name AS item_name, p.kind, p.unit, u.full_name AS user_name, ib.full_name AS issued_by_name,
         (i.returned_on IS NULL AND i.due_on IS NOT NULL AND i.due_on <= vn_today() + 30) AS due_soon
    FROM ppe_issues i JOIN ppe_items p ON p.id = i.item_id JOIN users u ON u.id = i.user_id JOIN users ib ON ib.id = i.issued_by`;

/* ================= Tổng hợp cảnh báo hậu cần ================= */

export async function logisticsAlerts(q: Queryable, stationId: string | null) {
  const [o2, temp, poOpen, ppeDue] = await Promise.all([
    o2Alerts(q, stationId), tempAlerts(q, stationId),
    one(q, `SELECT count(*) FILTER (WHERE status = 'cho_duyet')::int AS pending,
                   count(*) FILTER (WHERE status IN ('da_duyet', 'dang_nhan') AND expected_on < vn_today())::int AS late
              FROM purchase_orders WHERE ($1::text IS NULL OR station_id = $1)`, [stationId]),
    one(q, `SELECT count(*)::int AS n FROM ppe_issues i JOIN users u ON u.id = i.user_id
             WHERE u.active AND i.returned_on IS NULL AND i.due_on <= vn_today() + 30
               AND NOT EXISTS (SELECT 1 FROM ppe_issues j WHERE j.user_id = i.user_id AND j.item_id = i.item_id AND j.issued_on > i.issued_on)`),
  ]);
  return { o2, temp, purchase: poOpen, ppeDueSoon: ppeDue.n };
}
