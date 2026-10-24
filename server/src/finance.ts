import { audit, type Actor } from './audit.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';
import type { Role } from './http.js';

/**
 * Tài chính: bảng giá, khoản phải thu sinh từ phiếu chuyển viện đã ký, thu tiền, miễn giảm có duyệt,
 * hóa đơn, đề xuất chi 2 cấp duyệt, phiếu chi, công nợ và bút toán xuất sang phần mềm kế toán.
 */

const vnYear = () => String(new Date(Date.now() + 7 * 3600_000).getUTCFullYear());
async function code(tx: Tx, prefix: string) {
  const y = vnYear();
  const n = await nextCounter(tx, `fin_${prefix}`, y);
  return `${prefix}-${y}-${String(n).padStart(5, '0')}`;
}

export const PAYER: Record<string, string> = {
  THU_PHI: 'Thu phí', BHYT: 'BHYT', HOP_DONG: 'Hợp đồng', MIEN: 'Miễn', GIAM: 'Giảm', THAT_THU: 'Thất thu',
};
export const CHARGE_STATUS: Record<string, string> = {
  thieu_thong_tin: 'Thiếu thông tin tính giá', cho_thu: 'Chờ thu', thu_mot_phan: 'Thu một phần', da_thu: 'Đã thu',
  mien_giam: 'Miễn/giảm', that_thu: 'Thất thu', huy: 'Hủy',
};
export const PAY_METHOD: Record<string, string> = { tien_mat: 'Tiền mặt', chuyen_khoan: 'Chuyển khoản', the: 'Thẻ', bhyt: 'BHXH thanh toán' };
export const PROPOSAL_KIND: Record<string, string> = { mua_sam: 'Mua sắm', sua_chua: 'Sửa chữa', chi_phi: 'Chi phí hoạt động', tam_ung: 'Tạm ứng', khac: 'Khác' };
export const EXPENSE_CATEGORY: Record<string, string> = {
  nhien_lieu: 'Nhiên liệu', sua_chua_xe: 'Sửa chữa, bảo dưỡng xe', bao_duong_tb: 'Bảo dưỡng, kiểm định thiết bị', thuoc_vat_tu: 'Thuốc, vật tư',
  luong: 'Lương, phụ cấp', thue_mat_bang: 'Thuê mặt bằng', dien_nuoc: 'Điện, nước, viễn thông', cau_duong: 'Phí cầu đường, bến bãi',
  bao_hiem: 'Bảo hiểm xe, trách nhiệm', khac: 'Khác',
};

export interface FinanceSettings {
  approvalThreshold: number;
  accounts: Record<string, string>;
  company: { name: string; taxCode: string; address: string };
}
/** Mặc định: kế toán rà soát số hiệu tài khoản theo chế độ kế toán đơn vị đang áp dụng và sửa ở thẻ Cài đặt */
export const DEFAULT_SETTINGS: FinanceSettings = {
  approvalThreshold: 5_000_000,
  accounts: {
    receivable: '131', revenue: '5113', vatOut: '33311', cash: '1111', bank: '1121', payable: '331',
    waiver: '5213', badDebt: '6428',
    nhien_lieu: '6278', sua_chua_xe: '6277', bao_duong_tb: '6277', thuoc_vat_tu: '6272', luong: '6271',
    thue_mat_bang: '6427', dien_nuoc: '6427', cau_duong: '6278', bao_hiem: '6427', khac: '6428',
  },
  company: { name: '', taxCode: '', address: '' },
};
export async function getSettings(q: Queryable): Promise<FinanceSettings> {
  const rows = await many(q, 'SELECT key, value FROM finance_settings');
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    approvalThreshold: Number(m.approvalThreshold ?? DEFAULT_SETTINGS.approvalThreshold),
    accounts: { ...DEFAULT_SETTINGS.accounts, ...(m.accounts ?? {}) },
    company: { ...DEFAULT_SETTINGS.company, ...(m.company ?? {}) },
  };
}

/* ================= Tính giá ================= */

interface PriceInput { km: number | null; waitHours: number; night: boolean; discountPct: number }
export function priceLines(p: any, i: PriceInput) {
  const lines: { label: string; qty: number; unit_price: number; amount: number }[] = [];
  const baseKm = Number(p.base_km);
  lines.push({ label: `Giá mở cửa${baseKm ? ` (gồm ${baseKm} km đầu)` : ''}`, qty: 1, unit_price: Number(p.base_fee), amount: Number(p.base_fee) });
  const extra = Math.max(0, (i.km ?? 0) - baseKm);
  if (extra > 0 && Number(p.per_km)) lines.push({ label: 'Km tiếp theo', qty: extra, unit_price: Number(p.per_km), amount: Math.round(extra * Number(p.per_km)) });
  if (i.waitHours > 0 && Number(p.wait_per_hour)) lines.push({ label: 'Thời gian chờ (giờ)', qty: i.waitHours, unit_price: Number(p.wait_per_hour), amount: Math.round(i.waitHours * Number(p.wait_per_hour)) });
  const before = lines.reduce((s, l) => s + l.amount, 0);
  if (i.night && Number(p.night_surcharge_pct)) {
    lines.push({ label: `Phụ thu ban đêm ${Number(p.night_surcharge_pct)}%`, qty: 1, unit_price: Math.round(before * Number(p.night_surcharge_pct) / 100), amount: Math.round(before * Number(p.night_surcharge_pct) / 100) });
  }
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const discount = Math.round(subtotal * i.discountPct / 100);
  const vat = Math.round((subtotal - discount) * Number(p.vat_rate) / 100);
  return { lines, subtotal, discount, vat, total: subtotal - discount + vat };
}

async function reprice(tx: Tx, id: string) {
  const c = await one(tx, `SELECT c.*, cu.discount_pct, cu.payment_days FROM charges c LEFT JOIN customers cu ON cu.id = c.customer_id WHERE c.id = $1`, [id]);
  const p = c.price_list_id ? await one(tx, 'SELECT * FROM price_lists WHERE id = $1', [c.price_list_id]) : null;
  if (!p) return;
  const r = priceLines(p, { km: c.km == null ? null : Number(c.km), waitHours: Number(c.wait_hours), night: c.night, discountPct: Number(c.discount_pct ?? 0) });
  if (r.total < Number(c.paid)) throw new HttpError(409, 'Số tiền mới nhỏ hơn số đã thu; hủy phiếu thu trước');
  await tx.query(`UPDATE charges SET lines = $2, subtotal = $3, discount = $4, vat = $5, total = $6,
                         due_date = service_date + $7::int, updated_at = now() WHERE id = $1`,
    [id, JSON.stringify(r.lines), r.subtotal, r.discount, r.vat, r.total, Number(c.payment_days ?? 0)]);
}

/** Cập nhật đã thu, đã miễn và trạng thái */
export async function refreshCharge(tx: Tx, id: string) {
  const c = await one(tx, `SELECT c.*, p.per_km FROM charges c LEFT JOIN price_lists p ON p.id = c.price_list_id WHERE c.id = $1`, [id]);
  if (!c || c.status === 'huy') return c;
  const paid = Number((await one(tx, 'SELECT coalesce(sum(amount), 0) AS s FROM payments WHERE charge_id = $1 AND NOT voided', [id])).s);
  const waived = c.waiver_status === 'da_duyet' ? Number(c.waiver_amount) : 0;
  const total = Number(c.total);
  const missing = !c.price_list_id || (c.km == null && Number(c.per_km) > 0);
  let status: string;
  if (missing && paid === 0 && waived === 0) status = 'thieu_thong_tin';
  else if (paid + waived >= total) status = waived > 0 && paid === 0 ? (c.waiver_kind === 'that_thu' ? 'that_thu' : 'mien_giam') : 'da_thu';
  else status = paid > 0 ? 'thu_mot_phan' : 'cho_thu';
  return one(tx, `UPDATE charges SET paid = $2, waived = $3, status = $4, updated_at = now() WHERE id = $1 RETURNING *`, [id, paid, waived, status]);
}

/** Gọi trong giao dịch ký phiếu chuyển viện: sinh khoản phải thu theo bảng giá loại xe */
export async function createChargeForTransfer(tx: Tx, actor: Actor, transferId: string) {
  const t = await one(tx, `SELECT t.id, t.incident_id, t.vehicle_id, t.payer, t.epcr, t.signed_at, v.type AS vehicle_type, v.station_id,
                                  i.customer_id, i.created_at AS incident_at, p.full_name AS patient_name
                             FROM transfers t LEFT JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN incidents i ON i.id = t.incident_id
                             LEFT JOIN patients p ON p.id = t.patient_id WHERE t.id = $1`, [transferId]);
  if (!t) return null;
  if (await one(tx, 'SELECT 1 FROM charges WHERE transfer_id = $1', [transferId])) return null;
  const price = t.vehicle_type ? await one(tx, 'SELECT * FROM price_lists WHERE vehicle_type = $1 AND active', [t.vehicle_type]) : null;
  const kmRaw = t.epcr?.disposition?.distanceKm;
  const km = kmRaw == null || kmRaw === '' || Number.isNaN(Number(kmRaw)) ? null : Number(kmRaw);
  const at = new Date(t.incident_at ?? t.signed_at ?? Date.now());
  const vnHour = (at.getUTCHours() + 7) % 24;
  const night = vnHour >= 22 || vnHour < 6;
  const payerKind = ['MIEN', 'GIAM', 'THAT_THU', 'BHYT'].includes(t.payer) ? t.payer : t.customer_id ? 'HOP_DONG' : 'THU_PHI';
  const customer = t.customer_id ? await one(tx, 'SELECT name FROM customers WHERE id = $1', [t.customer_id]) : null;
  const c = await one(tx, `INSERT INTO charges(code, transfer_id, incident_id, vehicle_id, station_id, customer_id, payer_kind, payer_name, price_list_id,
                                               service_date, km, night)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ($10::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, $11, $12) RETURNING id, code`,
    [await code(tx, 'KT'), transferId, t.incident_id, t.vehicle_id, t.station_id, t.customer_id, payerKind, customer?.name ?? t.patient_name ?? null,
      price?.id ?? null, at.toISOString(), km, night]);
  await reprice(tx, c.id);
  if (['MIEN', 'THAT_THU', 'GIAM'].includes(payerKind)) {
    const total = Number((await one(tx, 'SELECT total FROM charges WHERE id = $1', [c.id])).total);
    const kind = payerKind === 'MIEN' ? 'mien' : payerKind === 'GIAM' ? 'giam' : 'that_thu';
    await tx.query(`UPDATE charges SET waiver_kind = $2, waiver_amount = $3, waiver_reason = $4, waiver_status = 'cho_duyet', waiver_by = $5 WHERE id = $1`,
      [c.id, kind, kind === 'giam' ? null : total, `Đối tượng "${PAYER[payerKind]}" ghi trên phiếu chuyển viện`, actor.id]);
  }
  await refreshCharge(tx, c.id);
  await audit(tx, t.incident_id ? `incident:${t.incident_id}` : 'system', actor, 'finance.charge_created', 'charge', c.id, { code: c.code, transferId });
  return c;
}

export async function updateCharge(tx: Tx, actor: Actor, id: string, b: {
  km?: number | null; waitHours?: number; night?: boolean; customerId?: string | null; payerName?: string | null; note?: string | null; priceListId?: number;
}) {
  const c = await one(tx, 'SELECT * FROM charges WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw new HttpError(404, 'Không tìm thấy khoản thu');
  if (c.status === 'huy') throw new HttpError(409, 'Khoản thu đã hủy');
  if (await one(tx, `SELECT 1 FROM invoice_charges ic JOIN invoices i ON i.id = ic.invoice_id WHERE ic.charge_id = $1 AND i.status = 'da_phat_hanh'`, [id])) {
    throw new HttpError(409, 'Đã phát hành hóa đơn: hủy hoặc điều chỉnh hóa đơn trước');
  }
  const map: Record<string, string> = { km: 'km', waitHours: 'wait_hours', night: 'night', customerId: 'customer_id', payerName: 'payer_name', note: 'note', priceListId: 'price_list_id' };
  const keys = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
  if (keys.length) {
    await tx.query(`UPDATE charges SET ${keys.map((k, i) => `${map[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => (b as any)[k])]);
  }
  if (b.customerId !== undefined) {
    await tx.query(`UPDATE charges SET payer_kind = CASE WHEN $2::uuid IS NOT NULL AND payer_kind = 'THU_PHI' THEN 'HOP_DONG'
                                                     WHEN $2::uuid IS NULL AND payer_kind = 'HOP_DONG' THEN 'THU_PHI' ELSE payer_kind END WHERE id = $1`, [id, b.customerId]);
  }
  await reprice(tx, id);
  const r = await refreshCharge(tx, id);
  await audit(tx, 'system', actor, 'finance.charge_updated', 'charge', id, b);
  return r;
}

export async function recordPayment(tx: Tx, actor: Actor, chargeId: string, b: { amount: number; method: string; reference?: string | null; payerName?: string | null }) {
  const c = await one(tx, 'SELECT * FROM charges WHERE id = $1 FOR UPDATE', [chargeId]);
  if (!c) throw new HttpError(404, 'Không tìm thấy khoản thu');
  if (['huy', 'thieu_thong_tin'].includes(c.status)) throw new HttpError(409, c.status === 'huy' ? 'Khoản thu đã hủy' : 'Bổ sung số km/bảng giá trước khi thu');
  const outstanding = Number(c.total) - Number(c.paid) - Number(c.waived);
  if (b.amount > outstanding) throw new HttpError(409, `Số tiền vượt số còn phải thu (${outstanding.toLocaleString('vi-VN')} đ)`);
  if (b.method === 'chuyen_khoan' && !b.reference) throw new HttpError(422, 'Chuyển khoản phải ghi mã giao dịch');
  const p = await one(tx, `INSERT INTO payments(code, charge_id, amount, method, reference, payer_name, received_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [await code(tx, 'PT'), chargeId, b.amount, b.method, b.reference ?? null, b.payerName ?? c.payer_name, actor.id]);
  await refreshCharge(tx, chargeId);
  await audit(tx, 'system', actor, 'finance.payment', 'charge', chargeId, { code: p.code, amount: b.amount, method: b.method });
  return p;
}

export async function voidPayment(tx: Tx, actor: Actor, paymentId: string, reason: string) {
  const p = await one(tx, 'SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
  if (!p) throw new HttpError(404, 'Không tìm thấy phiếu thu');
  if (p.voided) throw new HttpError(409, 'Phiếu thu đã hủy');
  await tx.query('UPDATE payments SET voided = true, void_reason = $2 WHERE id = $1', [paymentId, reason]);
  await refreshCharge(tx, p.charge_id);
  await audit(tx, 'system', actor, 'finance.payment_voided', 'charge', p.charge_id, { code: p.code, reason });
}

export async function requestWaiver(tx: Tx, actor: Actor, id: string, b: { kind: string; amount: number; reason: string }) {
  const c = await one(tx, 'SELECT * FROM charges WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw new HttpError(404, 'Không tìm thấy khoản thu');
  const outstanding = Number(c.total) - Number(c.paid);
  if (b.amount <= 0 || b.amount > outstanding) throw new HttpError(422, `Số miễn/giảm phải từ 1 đến ${outstanding.toLocaleString('vi-VN')} đ`);
  await tx.query(`UPDATE charges SET waiver_kind = $2, waiver_amount = $3, waiver_reason = $4, waiver_status = 'cho_duyet', waiver_by = $5,
                         waiver_decided_by = NULL, waiver_decided_at = NULL WHERE id = $1`, [id, b.kind, b.amount, b.reason, actor.id]);
  await refreshCharge(tx, id);
  await audit(tx, 'system', actor, 'finance.waiver_requested', 'charge', id, b);
}

export const WAIVER_APPROVERS: Role[] = ['director'];
export async function decideWaiver(tx: Tx, actor: Actor, id: string, approve: boolean, note?: string | null) {
  const c = await one(tx, 'SELECT * FROM charges WHERE id = $1 FOR UPDATE', [id]);
  if (!c || c.waiver_status !== 'cho_duyet') throw new HttpError(409, 'Không có đề nghị miễn/giảm chờ duyệt');
  if (c.waiver_amount == null) throw new HttpError(409, 'Kế toán chưa nhập số tiền giảm');
  if (c.waiver_by === actor.id) throw new HttpError(403, 'Người đề nghị miễn/giảm không tự duyệt');
  if (approve && Number(c.waiver_amount) > Number(c.total) - Number(c.paid)) throw new HttpError(409, 'Số miễn/giảm vượt số còn phải thu');
  await tx.query(`UPDATE charges SET waiver_status = $2, waiver_decided_by = $3, waiver_decided_at = now(),
                         note = coalesce($4, note) WHERE id = $1`, [id, approve ? 'da_duyet' : 'tu_choi', actor.id, note ?? null]);
  const r = await refreshCharge(tx, id);
  await audit(tx, 'system', actor, approve ? 'finance.waiver_approved' : 'finance.waiver_rejected', 'charge', id, { amount: c.waiver_amount, kind: c.waiver_kind });
  return r;
}

export async function cancelCharge(tx: Tx, actor: Actor, id: string, reason: string) {
  const c = await one(tx, 'SELECT * FROM charges WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw new HttpError(404, 'Không tìm thấy khoản thu');
  if (Number(c.paid) > 0) throw new HttpError(409, 'Đã có phiếu thu: hủy phiếu thu trước');
  await tx.query(`UPDATE charges SET status = 'huy', note = $2, updated_at = now() WHERE id = $1`, [id, reason]);
  await audit(tx, 'system', actor, 'finance.charge_cancelled', 'charge', id, { reason });
}

/* ================= Hóa đơn ================= */

export async function createInvoice(tx: Tx, actor: Actor, b: { chargeIds: string[]; customerId?: string | null; buyerName?: string | null; buyerTaxCode?: string | null; buyerAddress?: string | null }) {
  const charges = await many(tx, `SELECT c.*, p.vat_rate FROM charges c LEFT JOIN price_lists p ON p.id = c.price_list_id WHERE c.id = ANY($1::uuid[]) FOR UPDATE OF c`, [b.chargeIds]);
  if (charges.length !== b.chargeIds.length) throw new HttpError(404, 'Có khoản thu không tồn tại');
  const bad = charges.filter((c) => ['huy', 'thieu_thong_tin', 'that_thu'].includes(c.status));
  if (bad.length) throw new HttpError(409, `Không xuất hóa đơn cho khoản ${bad.map((c) => c.code).join(', ')}`);
  const dup = await many(tx, `SELECT c.code FROM invoice_charges ic JOIN invoices i ON i.id = ic.invoice_id JOIN charges c ON c.id = ic.charge_id
                               WHERE ic.charge_id = ANY($1::uuid[]) AND i.status <> 'huy'`, [b.chargeIds]);
  if (dup.length) throw new HttpError(409, `Đã có hóa đơn cho ${dup.map((d) => d.code).join(', ')}`);
  const customers = new Set(charges.map((c) => c.customer_id ?? ''));
  if (customers.size > 1) throw new HttpError(422, 'Các khoản thu phải cùng một khách hàng');
  const customerId = b.customerId ?? charges[0].customer_id ?? null;
  const cu = customerId ? await one(tx, 'SELECT * FROM customers WHERE id = $1', [customerId]) : null;
  const buyerName = b.buyerName ?? cu?.name ?? charges[0].payer_name;
  if (!buyerName) throw new HttpError(422, 'Ghi tên người mua');
  // Hóa đơn ghi giá trị sau miễn/giảm
  const net = charges.map((c) => {
    const factor = Number(c.total) ? (Number(c.total) - Number(c.waived)) / Number(c.total) : 0;
    return { sub: Math.round((Number(c.subtotal) - Number(c.discount)) * factor), vat: Math.round(Number(c.vat) * factor) };
  });
  const subtotal = net.reduce((s, x) => s + x.sub, 0);
  const vat = net.reduce((s, x) => s + x.vat, 0);
  if (subtotal + vat <= 0) throw new HttpError(409, 'Giá trị hóa đơn bằng 0');
  const inv = await one(tx, `INSERT INTO invoices(code, customer_id, buyer_name, buyer_tax_code, buyer_address, subtotal, vat, total, created_by)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [await code(tx, 'HD'), customerId, buyerName, b.buyerTaxCode ?? cu?.tax_code ?? null, b.buyerAddress ?? cu?.address ?? null, subtotal, vat, subtotal + vat, actor.id]);
  for (const c of charges) await tx.query('INSERT INTO invoice_charges(invoice_id, charge_id) VALUES ($1,$2)', [inv.id, c.id]);
  await audit(tx, 'system', actor, 'finance.invoice_created', 'invoice', inv.id, { code: inv.code, charges: charges.map((c) => c.code) });
  return inv;
}

/* ================= Đề xuất chi, phiếu chi ================= */

export const L1_APPROVERS: Role[] = ['accountant', 'director'];
export const L2_APPROVERS: Role[] = ['director'];

export async function createProposal(tx: Tx, actor: Actor, b: {
  kind: string; title: string; description?: string | null; amount: number; stationId?: string | null; vehicleId?: string | null;
}) {
  const p = await one(tx, `INSERT INTO proposals(code, kind, title, description, amount, station_id, vehicle_id, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [await code(tx, 'DX'), b.kind, b.title, b.description ?? null, b.amount, b.stationId ?? null, b.vehicleId ?? null, actor.id]);
  await audit(tx, 'system', actor, 'finance.proposal_created', 'proposal', p.id, { code: p.code, amount: b.amount });
  return p;
}

export async function decideProposal(tx: Tx, actor: Actor, role: Role, id: string, approve: boolean, note?: string | null) {
  const p = await one(tx, 'SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw new HttpError(404, 'Không tìm thấy đề xuất');
  if (p.created_by === actor.id) throw new HttpError(403, 'Người đề xuất không tự duyệt');
  if (!approve && !note?.trim()) throw new HttpError(422, 'Từ chối phải ghi lý do');
  const s = await getSettings(tx);
  let next: string;
  if (p.status === 'cho_duyet_1') {
    if (!L1_APPROVERS.includes(role)) throw new HttpError(403, 'Duyệt cấp 1 là Kế toán');
    next = !approve ? 'tu_choi' : Number(p.amount) >= s.approvalThreshold ? 'cho_duyet_2' : 'da_duyet';
    await tx.query('UPDATE proposals SET status = $2, l1_by = $3, l1_at = now(), l1_note = $4 WHERE id = $1', [id, next, actor.id, note ?? null]);
  } else if (p.status === 'cho_duyet_2') {
    if (!L2_APPROVERS.includes(role)) throw new HttpError(403, 'Duyệt cấp 2 là Ban Giám đốc');
    if (p.l1_by === actor.id) throw new HttpError(403, 'Người đã duyệt cấp 1 không duyệt cấp 2');
    next = approve ? 'da_duyet' : 'tu_choi';
    await tx.query('UPDATE proposals SET status = $2, l2_by = $3, l2_at = now(), l2_note = $4 WHERE id = $1', [id, next, actor.id, note ?? null]);
  } else throw new HttpError(409, 'Đề xuất không ở bước chờ duyệt');
  await audit(tx, 'system', actor, `finance.proposal_${next}`, 'proposal', id, { note: note ?? null });
  return one(tx, 'SELECT * FROM proposals WHERE id = $1', [id]);
}

export async function createExpense(tx: Tx, actor: Actor, b: {
  category: string; amount: number; spentOn: string; method: string; payee?: string | null; docNo?: string | null;
  stationId?: string | null; vehicleId?: string | null; proposalId?: string | null; note?: string | null;
}) {
  const s = await getSettings(tx);
  if (b.amount >= s.approvalThreshold && !b.proposalId) {
    throw new HttpError(422, `Khoản chi từ ${s.approvalThreshold.toLocaleString('vi-VN')} đ phải gắn đề xuất đã duyệt`);
  }
  if (b.proposalId) {
    const p = await one(tx, 'SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [b.proposalId]);
    if (!p || !['da_duyet', 'da_chi'].includes(p.status)) throw new HttpError(409, 'Đề xuất chưa được duyệt');
    const spent = Number((await one(tx, 'SELECT coalesce(sum(amount), 0) AS s FROM expenses WHERE proposal_id = $1', [b.proposalId])).s);
    if (spent + b.amount > Number(p.amount)) throw new HttpError(409, `Vượt số tiền đề xuất đã duyệt (còn ${(Number(p.amount) - spent).toLocaleString('vi-VN')} đ)`);
    if (spent + b.amount === Number(p.amount)) await tx.query(`UPDATE proposals SET status = 'da_chi' WHERE id = $1`, [b.proposalId]);
  }
  const e = await one(tx, `INSERT INTO expenses(code, category, amount, spent_on, method, payee, doc_no, station_id, vehicle_id, proposal_id, note, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [await code(tx, 'PC'), b.category, b.amount, b.spentOn, b.method, b.payee ?? null, b.docNo ?? null, b.stationId ?? null,
      b.vehicleId ?? null, b.proposalId ?? null, b.note ?? null, actor.id]);
  await audit(tx, 'system', actor, 'finance.expense', 'expense', e.id, { code: e.code, amount: b.amount, category: b.category });
  return e;
}

/* ================= Công nợ, bút toán ================= */

export async function receivables(q: Queryable) {
  return many(q, `
    SELECT coalesce(cu.name, CASE c.payer_kind WHEN 'BHYT' THEN 'BHXH (BHYT)' ELSE 'Khách lẻ' END) AS payer,
           c.customer_id, count(*)::int AS count,
           sum(c.total - c.paid - c.waived)::float AS outstanding,
           sum(CASE WHEN c.due_date >= vn_today() THEN c.total - c.paid - c.waived ELSE 0 END)::float AS not_due,
           sum(CASE WHEN vn_today() - c.due_date BETWEEN 1 AND 30 THEN c.total - c.paid - c.waived ELSE 0 END)::float AS d30,
           sum(CASE WHEN vn_today() - c.due_date BETWEEN 31 AND 60 THEN c.total - c.paid - c.waived ELSE 0 END)::float AS d60,
           sum(CASE WHEN vn_today() - c.due_date BETWEEN 61 AND 90 THEN c.total - c.paid - c.waived ELSE 0 END)::float AS d90,
           sum(CASE WHEN vn_today() - c.due_date > 90 THEN c.total - c.paid - c.waived ELSE 0 END)::float AS over90
      FROM charges c LEFT JOIN customers cu ON cu.id = c.customer_id
     WHERE c.status IN ('cho_thu', 'thu_mot_phan')
     GROUP BY 1, 2 ORDER BY outstanding DESC`);
}

export interface JournalRow { date: string; docNo: string; description: string; debit: string; credit: string; amount: number; object: string; vehicle: string }

/** Bút toán trong kỳ để nhập vào phần mềm kế toán (MISA, Fast, Bravo... đều nhập được từ Excel/CSV) */
export async function journal(q: Queryable, from: string, to: string): Promise<JournalRow[]> {
  const a = (await getSettings(q)).accounts;
  const rows: JournalRow[] = [];
  const charges = await many(q, `SELECT c.*, cu.code AS cu_code FROM charges c LEFT JOIN customers cu ON cu.id = c.customer_id
                                  WHERE c.status <> 'huy' AND c.status <> 'thieu_thong_tin' AND c.service_date BETWEEN $1 AND $2 ORDER BY c.service_date, c.code`, [from, to]);
  for (const c of charges) {
    const obj = c.cu_code ?? (c.payer_kind === 'BHYT' ? 'BHXH' : 'KHACHLE');
    const net = Number(c.subtotal) - Number(c.discount);
    if (net > 0) rows.push({ date: c.service_date, docNo: c.code, description: `Doanh thu vận chuyển cấp cứu ${c.code}`, debit: a.receivable, credit: a.revenue, amount: net, object: obj, vehicle: c.vehicle_id ?? '' });
    if (Number(c.vat) > 0) rows.push({ date: c.service_date, docNo: c.code, description: `Thuế GTGT ${c.code}`, debit: a.receivable, credit: a.vatOut, amount: Number(c.vat), object: obj, vehicle: c.vehicle_id ?? '' });
  }
  const pays = await many(q, `SELECT p.*, c.code AS charge_code, c.payer_kind, c.vehicle_id, cu.code AS cu_code,
                                     (p.received_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS d
                                FROM payments p JOIN charges c ON c.id = p.charge_id LEFT JOIN customers cu ON cu.id = c.customer_id
                               WHERE NOT p.voided AND (p.received_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1 AND $2 ORDER BY p.received_at`, [from, to]);
  for (const p of pays) {
    rows.push({ date: p.d, docNo: p.code, description: `Thu tiền ${p.charge_code}${p.reference ? ` (${p.reference})` : ''}`, debit: p.method === 'tien_mat' ? a.cash : a.bank,
      credit: a.receivable, amount: Number(p.amount), object: p.cu_code ?? (p.payer_kind === 'BHYT' ? 'BHXH' : 'KHACHLE'), vehicle: p.vehicle_id ?? '' });
  }
  const waivers = await many(q, `SELECT c.*, cu.code AS cu_code, (c.waiver_decided_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS d
                                   FROM charges c LEFT JOIN customers cu ON cu.id = c.customer_id
                                  WHERE c.waiver_status = 'da_duyet' AND (c.waiver_decided_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1 AND $2`, [from, to]);
  for (const c of waivers) {
    rows.push({ date: c.d, docNo: c.code, description: `${c.waiver_kind === 'that_thu' ? 'Xóa nợ thất thu' : 'Miễn/giảm phí'} ${c.code}: ${c.waiver_reason ?? ''}`,
      debit: c.waiver_kind === 'that_thu' ? a.badDebt : a.waiver, credit: a.receivable, amount: Number(c.waiver_amount), object: c.cu_code ?? 'KHACHLE', vehicle: c.vehicle_id ?? '' });
  }
  const exps = await many(q, `SELECT e.*, e.spent_on::text AS d FROM expenses e WHERE e.spent_on BETWEEN $1 AND $2 ORDER BY e.spent_on, e.code`, [from, to]);
  for (const e of exps) {
    rows.push({ date: e.d, docNo: e.code, description: `${EXPENSE_CATEGORY[e.category]}${e.payee ? ` – ${e.payee}` : ''}${e.doc_no ? ` (HĐ ${e.doc_no})` : ''}`,
      debit: a[e.category] ?? a.khac, credit: e.method === 'tien_mat' ? a.cash : e.method === 'chuyen_khoan' ? a.bank : a.payable,
      amount: Number(e.amount), object: e.payee ?? '', vehicle: e.vehicle_id ?? '' });
  }
  return rows.sort((x, y) => x.date.localeCompare(y.date) || x.docNo.localeCompare(y.docNo));
}

export function toCsv(rows: (string | number | null)[][]): string {
  const esc = (v: string | number | null) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
