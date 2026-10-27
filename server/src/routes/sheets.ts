import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { DOMAIN_LABEL } from '../governance.js';
import { actorOf, guard, type Ctx, type Role } from '../http.js';
import { applySheet, parseSheet, sheetByKey, sheetWorkbook, SHEETS } from '../sheets.js';

/** Người dùng nội bộ tải được file mẫu và nạp thử (chỉ so, không ghi); áp dụng thì quản trị (chưa khóa) hoặc qua đề xuất */
const STAFF: Role[] = ['calltaker', 'dispatcher', 'supervisor', 'crew', 'qa', 'admin', 'pharmacist', 'technician', 'ipc', 'hr', 'accountant', 'director'];

export function registerSheets(app: FastifyInstance, { pool }: Ctx) {
  const sheetOf = (params: unknown) => {
    const s = sheetByKey(z.object({ key: z.string() }).parse(params).key);
    if (!s) throw new HttpError(404, 'Không có file mẫu này');
    return s;
  };

  app.get('/api/sheets', { preHandler: guard(...STAFF) }, async () =>
    SHEETS.map((s) => ({ key: s.key, label: s.label, domain: s.domain, domainLabel: DOMAIN_LABEL[s.domain], columns: s.cols.map((c) => c.header) })));

  app.get('/api/sheets/:key/template', { preHandler: guard(...STAFF) }, async (req, reply) => {
    const s = sheetOf(req.params);
    return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="mau-${s.key}.xlsx"`)
      .send(await sheetWorkbook(pool, s));
  });

  app.post('/api/sheets/:key/parse', { preHandler: guard(...STAFF), bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const s = sheetOf(req.params);
    const b = z.object({ fileBase64: z.string().min(10) }).parse(req.body);
    return parseSheet(pool, s, Buffer.from(b.fileBase64.replace(/^data:[^,]*,/, ''), 'base64'));
  });

  app.post('/api/sheets/:key/apply', { preHandler: guard('admin'), bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const s = sheetOf(req.params);
    const b = z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(2000) }).parse(req.body);
    const rows = b.rows.map(({ _action, ...r }) => r);
    return withTx(pool, (tx) => applySheet(tx, actorOf(req), s, rows));
  });
}
