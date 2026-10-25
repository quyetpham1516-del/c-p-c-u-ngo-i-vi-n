import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import {
  cancelCharge, CHARGE_STATUS, createExpense, createInvoice, createProposal, decideProposal, decideWaiver, EXPENSE_CATEGORY, getSettings, journal,
  L1_APPROVERS, L2_APPROVERS, PAY_METHOD, PAYER, PROPOSAL_KIND, receivables, recordPayment, requestWaiver, toCsv, updateCharge, voidPayment, WAIVER_APPROVERS,
} from '../finance.js';
import { actorOf, EOC_ROLES, guard, type Ctx, type Role } from '../http.js';

const FIN: Role[] = ['accountant', 'director'];
const FIN_VIEW: Role[] = ['accountant', 'director', 'admin'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const opt = (n = 500) => z.string().trim().max(n).nullish();
const money = z.number().int().min(0).max(100_000_000_000);
const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;

export function registerFinance(app: FastifyInstance, { pool }: Ctx) {
  app.get('/api/finance/meta', { preHandler: guard() }, async () => ({
    payer: PAYER, chargeStatus: CHARGE_STATUS, payMethod: PAY_METHOD, proposalKind: PROPOSAL_KIND, expenseCategory: EXPENSE_CATEGORY,
    settings: await getSettings(pool), l1: L1_APPROVERS, l2: L2_APPROVERS, waiverApprovers: WAIVER_APPROVERS,
  }));

  app.put('/api/finance/settings', { preHandler: guard(...FIN) }, async (req) => {
    const b = z.object({
      approvalThreshold: money.optional(),
      accounts: z.record(z.string(), z.string().regex(/^\d{3,8}$/, 'Số hiệu tài khoản chỉ gồm chữ số')).optional(),
      company: z.object({ name: z.string().max(200), taxCode: z.string().max(20), address: z.string().max(300) }).partial().optional(),
    }).parse(req.body);
    await withTx(pool, async (tx) => {
      const cur = await getSettings(tx);
      const next: Record<string, unknown> = {};
      if (b.approvalThreshold !== undefined) next.approvalThreshold = b.approvalThreshold;
      if (b.accounts) next.accounts = { ...cur.accounts, ...b.accounts };
      if (b.company) next.company = { ...cur.company, ...b.company };
      for (const [k, v] of Object.entries(next)) {
        await tx.query('INSERT INTO finance_settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, JSON.stringify(v)]);
      }
      await audit(tx, 'system', actorOf(req), 'finance.settings', 'settings', 'finance', b);
    });
    return getSettings(pool);
  });

  /* ---------- Bảng giá, khách hàng ---------- */

  app.get('/api/finance/price-lists', { preHandler: guard(...FIN_VIEW) }, async () =>
    many(pool, 'SELECT * FROM price_lists ORDER BY active DESC, vehicle_type, effective_from DESC'));

  /** Bảng giá mới cho một loại xe thay thế bảng đang dùng (bảng cũ giữ lại để tra cứu khoản thu cũ) */
  app.post('/api/finance/price-lists', { preHandler: guard(...FIN) }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(120), vehicleType: z.string().min(1).max(10), baseFee: money, baseKm: z.number().min(0).max(1000),
      perKm: money, waitPerHour: money, nightSurchargePct: z.number().min(0).max(200), vatRate: z.number().min(0).max(20), effectiveFrom: date.optional(),
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      await tx.query('UPDATE price_lists SET active = false WHERE vehicle_type = $1 AND active', [b.vehicleType]);
      const p = await one(tx, `INSERT INTO price_lists(name, vehicle_type, base_fee, base_km, per_km, wait_per_hour, night_surcharge_pct, vat_rate, effective_from)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::date, vn_today())) RETURNING *`,
        [b.name, b.vehicleType, b.baseFee, b.baseKm, b.perKm, b.waitPerHour, b.nightSurchargePct, b.vatRate, b.effectiveFrom ?? null]);
      await audit(tx, 'system', actorOf(req), 'finance.price_list', 'price_list', String(p.id), b);
      return p;
    });
  });

  app.get('/api/finance/customers', { preHandler: guard(...FIN_VIEW) }, async () =>
    many(pool, `SELECT cu.*, (SELECT coalesce(sum(total - paid - waived), 0) FROM charges c WHERE c.customer_id = cu.id AND c.status IN ('cho_thu', 'thu_mot_phan'))::float AS outstanding
                  FROM customers cu ORDER BY cu.active DESC, cu.name`));

  /** Danh sách khách hàng hợp đồng cho điều phối gắn vào ca */
  app.get('/api/customers/active', { preHandler: guard(...EOC_ROLES, ...FIN_VIEW) }, async () =>
    many(pool, `SELECT id, code, name, kind FROM customers WHERE active AND (contract_to IS NULL OR contract_to >= vn_today()) ORDER BY name`));

  const CustomerBody = z.object({
    code: z.string().trim().min(2).max(20), name: z.string().trim().min(2).max(200),
    kind: z.enum(['benh_vien', 'bao_hiem', 'doanh_nghiep', 'su_kien', 'ca_nhan', 'khac']), taxCode: opt(20), address: opt(300), contact: opt(120),
    phone: opt(20), email: opt(120), contractNo: opt(60), contractFrom: date.nullish(), contractTo: date.nullish(),
    discountPct: z.number().min(0).max(100).optional(), paymentDays: z.number().int().min(0).max(365).optional(), active: z.boolean().optional(),
  });
  const CU: Record<string, string> = {
    code: 'code', name: 'name', kind: 'kind', taxCode: 'tax_code', address: 'address', contact: 'contact', phone: 'phone', email: 'email',
    contractNo: 'contract_no', contractFrom: 'contract_from', contractTo: 'contract_to', discountPct: 'discount_pct', paymentDays: 'payment_days', active: 'active',
  };
  app.post('/api/finance/customers', { preHandler: guard(...FIN) }, async (req) => {
    const b = CustomerBody.parse(req.body);
    const keys = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
    return withTx(pool, async (tx) => {
      if (await one(tx, 'SELECT 1 FROM customers WHERE code = $1', [b.code])) throw new HttpError(409, 'Mã khách hàng đã có');
      const c = await one(tx, `INSERT INTO customers(${keys.map((k) => CU[k]).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        keys.map((k) => (b as any)[k]));
      await audit(tx, 'system', actorOf(req), 'finance.customer_created', 'customer', c.id, { code: b.code });
      return c;
    });
  });
  app.patch('/api/finance/customers/:id', { preHandler: guard(...FIN) }, async (req) => {
    const id = idParam(req.params);
    const b = CustomerBody.partial().parse(req.body);
    const keys = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) return one(pool, 'SELECT * FROM customers WHERE id = $1', [id]);
    return withTx(pool, async (tx) => {
      const c = await one(tx, `UPDATE customers SET ${keys.map((k, i) => `${CU[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => (b as any)[k])]);
      if (!c) throw new HttpError(404, 'Không tìm thấy khách hàng');
      await audit(tx, 'system', actorOf(req), 'finance.customer_updated', 'customer', id, b);
      return c;
    });
  });

  /* ---------- Khoản thu, phiếu thu ---------- */

  app.get('/api/finance/charges', { preHandler: guard(...FIN_VIEW) }, async (req) => {
    const q = z.object({
      status: z.string().max(40).optional(), from: date.optional(), to: date.optional(), customerId: z.string().uuid().optional(), q: z.string().max(60).optional(),
      waiver: z.literal('cho_duyet').optional(),
    }).parse(req.query);
    return many(pool, `
      SELECT c.*, (c.total - c.paid - c.waived)::float AS outstanding, cu.name AS customer_name, i.code AS incident_code, t.transfer_number,
             (SELECT inv.code FROM invoice_charges ic JOIN invoices inv ON inv.id = ic.invoice_id WHERE ic.charge_id = c.id AND inv.status <> 'huy' LIMIT 1) AS invoice_code
        FROM charges c LEFT JOIN customers cu ON cu.id = c.customer_id LEFT JOIN incidents i ON i.id = c.incident_id LEFT JOIN transfers t ON t.id = c.transfer_id
       WHERE ($1::text IS NULL OR c.status = ANY(string_to_array($1, ','))) AND ($2::date IS NULL OR c.service_date >= $2) AND ($3::date IS NULL OR c.service_date <= $3)
         AND ($4::uuid IS NULL OR c.customer_id = $4) AND ($5::text IS NULL OR c.code ILIKE '%' || $5 || '%' OR i.code ILIKE '%' || $5 || '%'
              OR t.transfer_number ILIKE '%' || $5 || '%' OR vn_plain(coalesce(c.payer_name, '')) LIKE '%' || vn_plain($5) || '%')
         AND ($6::text IS NULL OR c.waiver_status = $6)
       ORDER BY c.service_date DESC, c.code DESC LIMIT 500`,
    [q.status ?? null, q.from ?? null, q.to ?? null, q.customerId ?? null, q.q ?? null, q.waiver ?? null]);
  });

  app.get('/api/finance/charges/:id', { preHandler: guard(...FIN_VIEW) }, async (req) => {
    const id = idParam(req.params);
    const c = await one(pool, `SELECT c.*, (c.total - c.paid - c.waived)::float AS outstanding, cu.name AS customer_name, i.code AS incident_code,
                                      t.transfer_number, p.name AS price_list_name, wb.full_name AS waiver_by_name, wd.full_name AS waiver_decided_by_name
                                 FROM charges c LEFT JOIN customers cu ON cu.id = c.customer_id LEFT JOIN incidents i ON i.id = c.incident_id
                                 LEFT JOIN transfers t ON t.id = c.transfer_id LEFT JOIN price_lists p ON p.id = c.price_list_id
                                 LEFT JOIN users wb ON wb.id = c.waiver_by LEFT JOIN users wd ON wd.id = c.waiver_decided_by WHERE c.id = $1`, [id]);
    if (!c) throw new HttpError(404, 'Không tìm thấy khoản thu');
    const payments = await many(pool, `SELECT p.*, u.full_name AS received_by_name FROM payments p JOIN users u ON u.id = p.received_by WHERE charge_id = $1 ORDER BY received_at`, [id]);
    return { ...c, payments };
  });

  app.patch('/api/finance/charges/:id', { preHandler: guard('accountant') }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({
      km: z.number().min(0).max(5000).nullish(), waitHours: z.number().min(0).max(240).optional(), night: z.boolean().optional(),
      customerId: z.string().uuid().nullish(), payerName: opt(200), note: opt(), priceListId: z.number().int().optional(),
    }).parse(req.body);
    return withTx(pool, (tx) => updateCharge(tx, actorOf(req), id, b));
  });

  app.post('/api/finance/charges/:id/payments', { preHandler: guard('accountant') }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ amount: money.min(1), method: z.enum(['tien_mat', 'chuyen_khoan', 'the', 'bhyt']), reference: opt(80), payerName: opt(200) }).parse(req.body);
    return withTx(pool, (tx) => recordPayment(tx, actorOf(req), id, b));
  });

  app.post('/api/finance/payments/:id/void', { preHandler: guard(...FIN) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body);
    await withTx(pool, (tx) => voidPayment(tx, actorOf(req), id, b.reason));
    return { ok: true };
  });

  app.post('/api/finance/charges/:id/waiver', { preHandler: guard('accountant', 'supervisor') }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ kind: z.enum(['mien', 'giam', 'that_thu']), amount: money.min(1), reason: z.string().trim().min(5).max(500) }).parse(req.body);
    await withTx(pool, (tx) => requestWaiver(tx, actorOf(req), id, b));
    return { ok: true };
  });

  app.post('/api/finance/charges/:id/waiver/decide', { preHandler: guard(...WAIVER_APPROVERS) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ approve: z.boolean(), note: opt() }).parse(req.body);
    return withTx(pool, (tx) => decideWaiver(tx, actorOf(req), req.user.role, id, b.approve, b.note));
  });

  app.post('/api/finance/charges/:id/cancel', { preHandler: guard(...FIN) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body);
    await withTx(pool, (tx) => cancelCharge(tx, actorOf(req), id, b.reason));
    return { ok: true };
  });

  /* ---------- Hóa đơn ---------- */

  app.get('/api/finance/invoices', { preHandler: guard(...FIN_VIEW) }, async () =>
    many(pool, `SELECT inv.*, (SELECT array_agg(c.code ORDER BY c.code) FROM invoice_charges ic JOIN charges c ON c.id = ic.charge_id WHERE ic.invoice_id = inv.id) AS charge_codes
                  FROM invoices inv ORDER BY inv.created_at DESC LIMIT 300`));

  app.post('/api/finance/invoices', { preHandler: guard('accountant') }, async (req) => {
    const b = z.object({
      chargeIds: z.array(z.string().uuid()).min(1).max(500), customerId: z.string().uuid().nullish(),
      buyerName: opt(200), buyerTaxCode: opt(20), buyerAddress: opt(300),
    }).parse(req.body);
    return withTx(pool, (tx) => createInvoice(tx, actorOf(req), b));
  });

  /** Ghi số hóa đơn điện tử sau khi phát hành ở hệ thống của nhà cung cấp hóa đơn */
  app.post('/api/finance/invoices/:id/issue', { preHandler: guard('accountant') }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ einvoiceNo: z.string().trim().min(1).max(30), einvoiceSymbol: z.string().trim().min(1).max(20), issuedOn: date.optional() }).parse(req.body);
    return withTx(pool, async (tx) => {
      const inv = await one(tx, `UPDATE invoices SET status = 'da_phat_hanh', einvoice_no = $2, einvoice_symbol = $3, issued_on = coalesce($4::date, issued_on)
                                 WHERE id = $1 AND status = 'nhap' RETURNING *`, [id, b.einvoiceNo, b.einvoiceSymbol, b.issuedOn ?? null]);
      if (!inv) throw new HttpError(409, 'Chỉ ghi số cho hóa đơn nháp');
      await audit(tx, 'system', actorOf(req), 'finance.invoice_issued', 'invoice', id, b);
      return inv;
    });
  });

  app.post('/api/finance/invoices/:id/cancel', { preHandler: guard(...FIN) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body);
    return withTx(pool, async (tx) => {
      const inv = await one(tx, `UPDATE invoices SET status = 'huy' WHERE id = $1 AND status <> 'huy' RETURNING *`, [id]);
      if (!inv) throw new HttpError(409, 'Hóa đơn không tồn tại hoặc đã hủy');
      await audit(tx, 'system', actorOf(req), 'finance.invoice_cancelled', 'invoice', id, b);
      return inv;
    });
  });

  /* ---------- Đề xuất chi, phiếu chi ---------- */

  app.get('/api/finance/proposals', { preHandler: guard() }, async (req) => {
    const q = z.object({ status: z.string().max(40).optional(), mine: z.coerce.boolean().optional() }).parse(req.query);
    const all = [...FIN_VIEW].includes(req.user.role) && !q.mine;
    return many(pool, `
      SELECT p.*, cu.full_name AS created_by_name, l1.full_name AS l1_name, l2.full_name AS l2_name,
             (SELECT coalesce(sum(amount), 0) FROM expenses e WHERE e.proposal_id = p.id)::float AS spent
        FROM proposals p JOIN users cu ON cu.id = p.created_by LEFT JOIN users l1 ON l1.id = p.l1_by LEFT JOIN users l2 ON l2.id = p.l2_by
       WHERE ($1::text IS NULL OR p.status = ANY(string_to_array($1, ','))) AND ($2 OR p.created_by = $3)
       ORDER BY p.created_at DESC LIMIT 300`, [q.status ?? null, all, req.user.id]);
  });

  app.post('/api/finance/proposals', { preHandler: guard() }, async (req) => {
    const b = z.object({
      kind: z.enum(['mua_sam', 'sua_chua', 'chi_phi', 'tam_ung', 'khac']), title: z.string().trim().min(5).max(200), description: opt(2000),
      amount: money.min(1), stationId: z.string().nullish(), vehicleId: z.string().nullish(),
    }).parse(req.body);
    return withTx(pool, (tx) => createProposal(tx, actorOf(req), b));
  });

  app.post('/api/finance/proposals/:id/decide', { preHandler: guard(...L1_APPROVERS, ...L2_APPROVERS) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ approve: z.boolean(), note: opt() }).parse(req.body);
    return withTx(pool, (tx) => decideProposal(tx, actorOf(req), req.user.role, id, b.approve, b.note));
  });

  app.get('/api/finance/expenses', { preHandler: guard(...FIN_VIEW) }, async (req) => {
    const q = z.object({ from: date.optional(), to: date.optional(), category: z.string().max(30).optional(), vehicleId: z.string().optional() }).parse(req.query);
    return many(pool, `SELECT e.*, p.code AS proposal_code, u.full_name AS created_by_name FROM expenses e LEFT JOIN proposals p ON p.id = e.proposal_id JOIN users u ON u.id = e.created_by
                        WHERE ($1::date IS NULL OR e.spent_on >= $1) AND ($2::date IS NULL OR e.spent_on <= $2) AND ($3::text IS NULL OR e.category = $3)
                          AND ($4::text IS NULL OR e.vehicle_id = $4)
                        ORDER BY e.spent_on DESC, e.code DESC LIMIT 500`, [q.from ?? null, q.to ?? null, q.category ?? null, q.vehicleId ?? null]);
  });

  app.post('/api/finance/expenses', { preHandler: guard('accountant') }, async (req) => {
    const b = z.object({
      category: z.enum(Object.keys(EXPENSE_CATEGORY) as [string, ...string[]]), amount: money.min(1), spentOn: date,
      method: z.enum(['tien_mat', 'chuyen_khoan', 'cong_no']), payee: opt(200), docNo: opt(40), stationId: z.string().nullish(),
      vehicleId: z.string().nullish(), proposalId: z.string().uuid().nullish(), note: opt(),
    }).parse(req.body);
    return withTx(pool, (tx) => createExpense(tx, actorOf(req), b));
  });

  /* ---------- Công nợ, kế toán ---------- */

  app.get('/api/finance/receivables', { preHandler: guard(...FIN_VIEW) }, async () => receivables(pool));

  app.get('/api/finance/journal', { preHandler: guard(...FIN_VIEW) }, async (req, reply) => {
    const q = z.object({ from: date, to: date, format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    if (q.to < q.from) throw new HttpError(422, 'Khoảng ngày không hợp lệ');
    const rows = await journal(pool, q.from, q.to);
    if (q.format === 'json') return rows;
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="but-toan-${q.from}-${q.to}.csv"`);
    return toCsv([
      ['Ngày hạch toán', 'Số chứng từ', 'Diễn giải', 'TK Nợ', 'TK Có', 'Số tiền', 'Đối tượng', 'Mã xe (thống kê)'],
      ...rows.map((r) => [r.date, r.docNo, r.description, r.debit, r.credit, r.amount, r.object, r.vehicle]),
    ]);
  });

  app.get('/api/finance/summary', { preHandler: guard(...FIN_VIEW) }, async (req) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
    const month = q.month ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
    return one(pool, `
      WITH m AS (SELECT ($1 || '-01')::date AS s, (($1 || '-01')::date + interval '1 month')::date AS e)
      SELECT $1 AS month,
             (SELECT coalesce(sum(total - waived), 0) FROM charges, m WHERE status NOT IN ('huy', 'thieu_thong_tin') AND service_date >= m.s AND service_date < m.e)::float AS revenue,
             (SELECT coalesce(sum(amount), 0) FROM payments p, m WHERE NOT voided AND (p.received_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= m.s
                                                                    AND (p.received_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date < m.e)::float AS collected,
             (SELECT coalesce(sum(amount), 0) FROM expenses, m WHERE spent_on >= m.s AND spent_on < m.e)::float AS expenses,
             (SELECT coalesce(sum(total - paid - waived), 0) FROM charges WHERE status IN ('cho_thu', 'thu_mot_phan'))::float AS outstanding,
             (SELECT count(*) FROM charges WHERE status = 'thieu_thong_tin')::int AS missing_info,
             (SELECT count(*) FROM charges WHERE waiver_status = 'cho_duyet')::int AS waivers_pending,
             (SELECT count(*) FROM proposals WHERE status IN ('cho_duyet_1', 'cho_duyet_2'))::int AS proposals_pending,
             (SELECT count(*) FROM invoices WHERE status = 'nhap')::int AS invoices_draft`, [month]);
  });
}
