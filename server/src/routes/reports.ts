import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, verifyChain } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { toCsv } from '../finance.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import { clinical, financial, INTERVALS, operations, quality, type Range } from '../reports.js';

const OPS_VIEW: Role[] = ['director', 'admin', 'supervisor', 'qa'];
const FIN_VIEW: Role[] = ['director', 'admin', 'accountant'];
const AUDIT_VIEW: Role[] = ['director', 'admin', 'qa'];
const DOC_EDIT: Role[] = ['qa', 'admin', 'director'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RangeQ = z.object({ from: date, to: date, stationId: z.string().max(20).optional(), format: z.enum(['json', 'csv']).default('json') })
  .refine((r) => r.to >= r.from, 'Khoảng ngày không hợp lệ')
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86400_000 <= 731, 'Tối đa 2 năm mỗi lần');
const KIND: Record<string, string> = { quy_trinh: 'Quy trình', huong_dan: 'Hướng dẫn', bieu_mau: 'Biểu mẫu', quy_dinh: 'Quy định', phac_do: 'Phác đồ', khac: 'Khác' };

type Row = (string | number | null)[];
/** Gộp nhiều bảng vào một tệp CSV, mỗi bảng có dòng tiêu đề riêng */
function blocks(parts: [title: string, header: string[], rows: Row[]][]): string {
  const out: Row[] = [];
  for (const [title, header, rows] of parts) out.push([title], header, ...rows, []);
  return toCsv(out);
}

export function registerReports(app: FastifyInstance, { pool }: Ctx) {
  const range = (q: any): Range => ({ from: q.from, to: q.to, stationId: q.stationId ?? null });
  const sendCsv = (reply: any, name: string, q: any, body: string) => {
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}-${q.from}-${q.to}.csv"`);
    return body;
  };

  app.get('/api/reports/operations', { preHandler: guard(...OPS_VIEW) }, async (req, reply) => {
    const q = RangeQ.parse(req.query);
    const r = await operations(pool, range(q));
    if (q.format === 'json') return r;
    return sendCsv(reply, 'van-hanh', q, blocks([
      ['Tổng hợp', ['Tổng ca', 'Có giao xe', 'Hủy', 'Chỉ tư vấn', 'Chuyển 115', 'Nhận từ 115', 'Đổi mã ưu tiên so với máy'],
        [[r.totals.total, r.totals.served, r.totals.cancelled, r.totals.advice_only, r.totals.transferred_115, r.totals.from_115, r.totals.priority_overridden]]],
      ['Thời gian đáp ứng (phút): trung vị / phân vị 90', ['Mức', 'Số ca', ...INTERVALS.map(([, l]) => l), 'Đạt chỉ tiêu tới hiện trường'],
        r.intervals.map((x: any) => [x.priority, x.n, ...INTERVALS.map(([k]) => x[`${k}_median`] == null ? '' : `${x[`${k}_median`]} / ${x[`${k}_p90`]}`),
          x.response_n ? `${Math.round((100 * x.response_on_target) / x.response_n)}% (≤ ${r.targets[x.priority]} phút)` : ''])],
      ['Theo ngày', ['Ngày', 'Số ca', 'P1', 'P2'], r.byDay.map((d: any) => [d.day, d.n, d.p1, d.p2])],
      ['Theo giờ trong ngày', ['Giờ', 'Số ca'], r.byHour.map((h: any) => [h.hour, h.n])],
      ['Sử dụng xe', ['Xe', 'Loại', 'Điểm', 'Lượt giao', 'Giờ sẵn sàng', 'Giờ làm nhiệm vụ', 'Giờ ngoài hoạt động', 'Tỉ lệ sử dụng %'],
        r.fleet.map((f: any) => [f.vehicle_id, f.type, f.station_id, f.missions, f.available_h, f.busy_h, f.out_h, f.utilization_pct])],
    ]));
  });

  app.get('/api/reports/clinical', { preHandler: guard(...OPS_VIEW) }, async (req, reply) => {
    const q = RangeQ.parse(req.query);
    const r = await clinical(pool, range(q));
    if (q.format === 'json') return r;
    return sendCsv(reply, 'chuyen-mon', q, blocks([
      ['Tổng hợp', ['Phiếu đã ký', 'Phiếu có bổ sung sau ký', 'Ca nghi truyền nhiễm'], [[r.totals.signed, r.totals.amended, r.totals.infectious]]],
      ['Kết cục', ['Kết cục', 'Số phiếu'], r.dispositions.map((d: any) => [d.type, d.n])],
      ['Chẩn đoán thường gặp', ['ICD-10', 'Tên bệnh', 'Số phiếu'], r.diagnoses.map((d: any) => [d.icd10, d.name, d.n])],
      ['Bệnh viện nhận', ['Bệnh viện', 'Số phiếu'], r.hospitals.map((d: any) => [d.hospital, d.n])],
      ['Thuốc dùng nhiều', ['Thuốc', 'Số lần'], r.medications.map((d: any) => [d.name, d.n])],
    ]));
  });

  app.get('/api/reports/quality', { preHandler: guard(...OPS_VIEW) }, async (req, reply) => {
    const q = RangeQ.parse(req.query);
    const r = await quality(pool, range(q));
    if (q.format === 'json') return r;
    const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '');
    return sendCsv(reply, 'chat-luong', q, blocks([
      ['Chỉ số', ['Chỉ số', 'Giá trị', 'Chỉ tiêu'], [
        ['Ca có giao xe', r.served, ''],
        ['Sự cố y khoa', r.eventTotal, ''],
        ['Sự cố trên 1000 ca', r.eventsPer1000, ''],
        ['Khiếu nại', r.complaints.n, ''],
        ['Khiếu nại phản hồi đúng hạn', pct(r.complaints.on_time, r.complaints.n), `${r.targets.complaintOnTimePct}%`],
        ['Khảo sát trả lời', `${r.surveys.answered}/${r.surveys.sent}`, ''],
        ['Hài lòng (4–5 điểm)', pct(r.surveys.satisfied, r.surveys.answered), `${r.targets.satisfactionPct}%`],
        ['Tuân thủ vệ sinh tay', pct(r.hygiene.compliant, r.hygiene.n), `${r.targets.handHygienePct}%`],
        ['Phiếu khử khuẩn đã ký', pct(r.disinfection.signed, r.disinfection.n), '100%'],
        ['Phơi nhiễm nghề nghiệp', r.exposures, ''],
        ['Giao xe thiếu thiết bị (có lý do)', r.equipmentOverrides, ''],
      ]],
      ['Sự cố theo mức độ', ['Mức', 'Số sự cố', 'Đã đóng', 'Ẩn danh'], r.events.map((e: any) => [e.severity, e.n, e.closed, e.anonymous])],
    ]));
  });

  app.get('/api/reports/financial', { preHandler: guard(...FIN_VIEW) }, async (req, reply) => {
    const q = RangeQ.parse(req.query);
    const r = await financial(pool, range(q));
    if (q.format === 'json') return r;
    return sendCsv(reply, 'tai-chinh', q, blocks([
      ['Theo tháng', ['Tháng', 'Doanh thu', 'Đã thu', 'Chi phí', 'Chênh lệch'], r.monthly.map((m: any) => [m.month, m.revenue, m.collected, m.expenses, m.revenue - m.expenses])],
      ['Theo xe', ['Xe', 'Loại', 'Điểm', 'Số chuyến', 'Doanh thu', 'Chi phí', 'Chênh lệch', 'Doanh thu/chuyến'],
        r.byVehicle.map((v: any) => [v.vehicle_id, v.type, v.station_id, v.trips, v.revenue, v.expenses, v.margin, v.per_trip])],
      ['Theo điểm', ['Điểm', 'Tên', 'Doanh thu', 'Chi phí', 'Chênh lệch'], r.byStation.map((s: any) => [s.station_id, s.name, s.revenue, s.expenses, s.margin])],
      ['Theo đối tượng', ['Đối tượng', 'Số khoản', 'Phải thu', 'Miễn giảm', 'Đã thu'], r.byPayer.map((p: any) => [p.payer_kind, p.n, p.total, p.waived, p.paid])],
      ['Chi phí theo khoản mục', ['Khoản mục', 'Số phiếu', 'Số tiền'], r.byCategory.map((c: any) => [c.category, c.n, c.amount])],
    ]));
  });

  /* ---------- Nhật ký thao tác ---------- */

  app.get('/api/reports/audit', { preHandler: guard(...AUDIT_VIEW) }, async (req) => {
    const q = z.object({
      from: date, to: date, action: z.string().max(60).optional(), actor: z.string().max(80).optional(), entity: z.string().max(40).optional(),
      entityId: z.string().max(80).optional(),
    }).parse(req.query);
    return many(pool, `
      SELECT id, scope, at, actor_name, action, entity, entity_id, data FROM audit_events
       WHERE at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AND at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
         AND ($3::text IS NULL OR action ILIKE $3 || '%') AND ($4::text IS NULL OR vn_plain(coalesce(actor_name, '')) LIKE '%' || vn_plain($4) || '%')
         AND ($5::text IS NULL OR entity = $5) AND ($6::text IS NULL OR entity_id = $6)
       ORDER BY id DESC LIMIT 500`, [q.from, q.to, q.action ?? null, q.actor ?? null, q.entity ?? null, q.entityId ?? null]);
  });

  app.get('/api/reports/audit/actions', { preHandler: guard(...AUDIT_VIEW) }, async () =>
    (await many(pool, `SELECT DISTINCT split_part(action, '.', 1) AS a FROM audit_events ORDER BY 1`)).map((r) => r.a));

  /** Kiểm tra chuỗi băm nhật ký hệ thống và các ca/bệnh án có hoạt động trong khoảng ngày */
  app.get('/api/reports/audit/verify', { preHandler: guard(...AUDIT_VIEW) }, async (req) => {
    const q = z.object({ from: date, to: date }).parse(req.query);
    const scopes = (await many(pool, `SELECT DISTINCT scope FROM audit_events
                                       WHERE at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AND at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
                                       LIMIT 2000`, [q.from, q.to])).map((r) => r.scope);
    if (!scopes.includes('system')) scopes.unshift('system');
    const broken: { scope: string; brokenAt?: number }[] = [];
    let events = 0;
    for (const s of scopes) {
      const c = await verifyChain(pool, s);
      events += c.count;
      if (!c.ok) broken.push({ scope: s, brokenAt: c.brokenAt });
    }
    return { scopes: scopes.length, events, ok: broken.length === 0, broken };
  });

  /* ---------- Kiểm soát tài liệu ---------- */

  app.get('/api/documents', { preHandler: guard() }, async (req) => {
    const q = z.object({ all: z.coerce.boolean().optional() }).parse(req.query);
    return many(pool, `
      SELECT d.*, u.full_name AS approved_by_name,
             (d.effective_on + make_interval(months => d.review_months))::date AS review_due,
             (d.status = 'hieu_luc' AND d.effective_on + make_interval(months => d.review_months) < vn_today() + 30) AS review_soon
        FROM documents d LEFT JOIN users u ON u.id = d.approved_by
       WHERE $1 OR d.status = 'hieu_luc' OR ($2 AND d.status = 'du_thao')
       ORDER BY d.code, d.created_at DESC`, [q.all === true, DOC_EDIT.includes(req.user.role)]);
  });

  app.post('/api/documents', { preHandler: guard(...DOC_EDIT) }, async (req) => {
    const b = z.object({
      code: z.string().trim().min(2).max(30), title: z.string().trim().min(3).max(300), kind: z.enum(Object.keys(KIND) as [string, ...string[]]),
      version: z.string().trim().min(1).max(10), ownerUnit: z.string().max(120).nullish(), reviewMonths: z.number().int().min(1).max(120).optional(),
      url: z.string().url().max(1000).nullish(), changeNote: z.string().max(1000).nullish(),
    }).parse(req.body);
    return withTx(pool, async (tx) => {
      if (await one(tx, 'SELECT 1 FROM documents WHERE code = $1 AND version = $2', [b.code, b.version])) throw new HttpError(409, 'Đã có phiên bản này');
      const d = await one(tx, `INSERT INTO documents(code, title, kind, version, owner_unit, review_months, url, change_note, created_by)
                               VALUES ($1,$2,$3,$4,$5,coalesce($6, 12),$7,$8,$9) RETURNING *`,
        [b.code, b.title, b.kind, b.version, b.ownerUnit ?? null, b.reviewMonths ?? null, b.url ?? null, b.changeNote ?? null, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'document.drafted', 'document', d.id, { code: b.code, version: b.version });
      return d;
    });
  });

  /** Ban hành: bản đang hiệu lực cùng mã chuyển sang hết hiệu lực; người ban hành khác người soạn */
  app.post('/api/documents/:id/approve', { preHandler: guard('director', 'admin') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ effectiveOn: date }).parse(req.body);
    return withTx(pool, async (tx) => {
      const d = await one(tx, 'SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id]);
      if (!d || d.status !== 'du_thao') throw new HttpError(409, 'Chỉ ban hành bản dự thảo');
      if (d.created_by === req.user.id) throw new HttpError(403, 'Người soạn không tự ban hành');
      await tx.query(`UPDATE documents SET status = 'het_hieu_luc' WHERE code = $1 AND status = 'hieu_luc'`, [d.code]);
      const r = await one(tx, `UPDATE documents SET status = 'hieu_luc', effective_on = $2, approved_by = $3, approved_at = now() WHERE id = $1 RETURNING *`, [id, b.effectiveOn, req.user.id]);
      await audit(tx, 'system', actorOf(req), 'document.approved', 'document', id, { code: d.code, version: d.version, effectiveOn: b.effectiveOn });
      return r;
    });
  });

  app.post('/api/documents/:id/retire', { preHandler: guard('director', 'admin') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withTx(pool, async (tx) => {
      const d = await one(tx, `UPDATE documents SET status = 'het_hieu_luc' WHERE id = $1 AND status = 'hieu_luc' RETURNING *`, [id]);
      if (!d) throw new HttpError(409, 'Tài liệu không ở trạng thái hiệu lực');
      await audit(tx, 'system', actorOf(req), 'document.retired', 'document', id, { code: d.code, version: d.version });
      return d;
    });
  });
}
