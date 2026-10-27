import type { FastifyReply, FastifyRequest } from 'fastify';
import { audit } from './audit.js';
import { many, nextCounter, one, withTx, type Queryable } from './db.js';
import type { Ctx } from './http.js';
import { notifyRoles } from './notify.js';
import { sheetByKey } from './sheets.js';

/**
 * Trưởng nhóm đề xuất, quản trị duyệt. Khi đã "khóa cấu hình", các thao tác sửa danh mục, cấu hình dưới đây không chạy ngay:
 * trưởng nhóm đúng mảng gửi thì thành phiếu đề xuất; quản trị chỉ duyệt hoặc từ chối, duyệt xong hệ thống mới chạy thao tác đó.
 * Việc hằng ngày (ca cấp cứu, phiếu kho, lập ca trực) không nằm trong danh sách nên không phải chờ duyệt.
 */

export type Domain = 'ban_giam_doc' | 'tiep_nhan' | 'dieu_phoi' | 'kip' | 'kho' | 'thiet_bi' | 'ksnk' | 'chat_luong' | 'nhan_su' | 'ke_toan' | 'khac';

export const DOMAIN_LABEL: Record<Domain, string> = {
  ban_giam_doc: 'Ban Giám đốc', tiep_nhan: 'Tiếp nhận cuộc gọi', dieu_phoi: 'Điều phối', kip: 'Chuyên môn – kíp', kho: 'Dược – kho',
  thiet_bi: 'Thiết bị – xe', ksnk: 'Kiểm soát nhiễm khuẩn', chat_luong: 'Quản lý chất lượng', nhan_su: 'Nhân sự', ke_toan: 'Tài chính – kế toán', khac: 'Khác',
};

interface Governed {
  route: string;
  label: string;
  domain: Domain;
  /** Bản ghi hiện tại để so trước, sau: bảng, cột khóa, tên tham số trên đường dẫn */
  before?: { table: string; key: string; param: string };
  /** Thao tác quản trị được làm ngay dù đã khóa (khóa tài khoản khẩn) */
  exempt?: (body: any) => boolean;
  /** Tên và mảng phụ thuộc tham số (file mẫu: mỗi danh mục một mảng) */
  resolve?: (params: Record<string, string>) => { label: string; domain: Domain } | null;
}

export const GOVERNED: Governed[] = [
  { route: 'POST /api/stations', label: 'Thêm điểm', domain: 'dieu_phoi' },
  { route: 'PATCH /api/stations/:id', label: 'Sửa điểm', domain: 'dieu_phoi', before: { table: 'stations', key: 'id', param: 'id' } },
  { route: 'PATCH /api/vehicles/:id/station', label: 'Chuyển xe sang điểm khác', domain: 'dieu_phoi', before: { table: 'vehicles', key: 'id', param: 'id' } },
  { route: 'PATCH /api/users/:id/station', label: 'Phân điểm làm việc cho nhân viên', domain: 'nhan_su' },
  {
    route: 'PATCH /api/users/:id', label: 'Sửa tài khoản', domain: 'nhan_su',
    exempt: (b) => b && typeof b === 'object' && Object.keys(b).length === 1 && b.active === false,
  },
  { route: 'POST /api/hospitals', label: 'Thêm bệnh viện', domain: 'dieu_phoi' },
  { route: 'PATCH /api/hospitals/:id', label: 'Sửa bệnh viện', domain: 'dieu_phoi', before: { table: 'hospitals', key: 'id', param: 'id' } },
  { route: 'POST /api/hospitals/:id/departments', label: 'Thêm khoa của bệnh viện', domain: 'dieu_phoi' },
  { route: 'DELETE /api/hospitals/:id/departments/:deptId', label: 'Xóa khoa của bệnh viện', domain: 'dieu_phoi' },
  { route: 'POST /api/equipment-types', label: 'Thêm loại thiết bị', domain: 'thiet_bi' },
  { route: 'PATCH /api/equipment-types/:id', label: 'Sửa loại thiết bị', domain: 'thiet_bi', before: { table: 'equipment_types', key: 'id', param: 'id' } },
  { route: 'PUT /api/vehicle-required-equipment', label: 'Thiết bị bắt buộc theo loại xe', domain: 'thiet_bi' },
  { route: 'PUT /api/finance/settings', label: 'Cài đặt tài chính', domain: 'ke_toan' },
  { route: 'POST /api/finance/price-lists', label: 'Bảng giá vận chuyển', domain: 'ke_toan' },
  { route: 'POST /api/finance/service-prices', label: 'Thêm giá dịch vụ', domain: 'ke_toan' },
  { route: 'PATCH /api/finance/service-prices/:id', label: 'Sửa giá dịch vụ', domain: 'ke_toan', before: { table: 'service_prices', key: 'id', param: 'id' } },
  { route: 'PUT /api/finance/bhyt/settings', label: 'Cài đặt BHYT', domain: 'ke_toan' },
  { route: 'PUT /api/payroll/settings', label: 'Cài đặt bảng lương', domain: 'ke_toan' },
  { route: 'PATCH /api/logistics/drugs/:id/control-class', label: 'Nhóm thuốc kiểm soát đặc biệt', domain: 'kho', before: { table: 'drugs', key: 'id', param: 'id' } },
  { route: 'PUT /api/stock/minimums', label: 'Định mức tồn kho', domain: 'kho' },
  { route: 'PUT /api/par-levels', label: 'Cơ số xe', domain: 'kho' },
  { route: 'POST /api/par-levels/import', label: 'Nạp cơ số xe từ Excel', domain: 'kho' },
  { route: 'PATCH /api/drugs/:id', label: 'Sửa thuốc', domain: 'kho', before: { table: 'drugs', key: 'id', param: 'id' } },
  { route: 'POST /api/item-groups', label: 'Thêm nhóm hàng', domain: 'kho' },
  { route: 'POST /api/items', label: 'Thêm mặt hàng', domain: 'kho' },
  { route: 'PATCH /api/items/:id', label: 'Sửa mặt hàng', domain: 'kho', before: { table: 'drugs', key: 'id', param: 'id' } },
  { route: 'POST /api/scope/rules', label: 'Thêm quy định phạm vi chuyên môn', domain: 'kip' },
  { route: 'PATCH /api/scope/rules/:id', label: 'Sửa quy định phạm vi chuyên môn', domain: 'kip', before: { table: 'scope_rules', key: 'id', param: 'id' } },
  { route: 'PATCH /api/users/:id/scope', label: 'Nhóm chức danh, vị trí được làm trong kíp', domain: 'kip' },
  { route: 'POST /api/scope/grants', label: 'Cấp riêng phạm vi cho một người', domain: 'kip' },
  { route: 'POST /api/scope/grants/:id/revoke', label: 'Thu hồi phạm vi cấp riêng', domain: 'kip' },
  { route: 'POST /api/crew-roles', label: 'Thêm vị trí trong kíp', domain: 'kip' },
  { route: 'PATCH /api/crew-roles/:name', label: 'Sửa vị trí trong kíp', domain: 'kip', before: { table: 'crew_roles', key: 'name', param: 'name' } },
  { route: 'POST /api/lab-types', label: 'Thêm loại cận lâm sàng', domain: 'kip' },
  { route: 'PATCH /api/lab-types/:code', label: 'Sửa loại cận lâm sàng', domain: 'kip', before: { table: 'lab_types', key: 'code', param: 'code' } },
  { route: 'PUT /api/registry/settings/:code', label: 'Bật, tắt biểu mẫu nghiên cứu', domain: 'chat_luong', before: { table: 'registry_settings', key: 'code', param: 'code' } },
  { route: 'POST /api/org/units', label: 'Thêm bộ phận', domain: 'nhan_su' },
  { route: 'PATCH /api/org/units/:id', label: 'Sửa bộ phận', domain: 'nhan_su', before: { table: 'org_units', key: 'id', param: 'id' } },
  { route: 'PUT /api/org/units/:id/members/:staffId', label: 'Xếp người vào bộ phận, chỉ định trưởng nhóm', domain: 'nhan_su' },
  { route: 'DELETE /api/org/units/:id/members/:staffId', label: 'Bỏ người khỏi bộ phận', domain: 'nhan_su' },
  { route: 'PUT /api/telephony/extensions/:ext', label: 'Máy nhánh tổng đài', domain: 'dieu_phoi' },
  { route: 'DELETE /api/telephony/extensions/:ext', label: 'Xóa máy nhánh tổng đài', domain: 'dieu_phoi' },
  { route: 'PATCH /api/attendance/stations/:id', label: 'Cài đặt chấm công tại điểm', domain: 'nhan_su' },
  { route: 'PUT /api/security/settings', label: 'Cài đặt bảo mật', domain: 'ban_giam_doc' },
  { route: 'PUT /api/approvals/limits', label: 'Hạn mức phê duyệt', domain: 'ban_giam_doc' },
  { route: 'PUT /api/ops/settings/population', label: 'Dân số vùng phục vụ', domain: 'ban_giam_doc' },
  {
    route: 'POST /api/sheets/:key/apply', label: 'Nạp danh mục từ Excel', domain: 'ban_giam_doc',
    resolve: (p) => { const s = sheetByKey(p.key); return s ? { label: `Nạp Excel: ${s.label}`, domain: s.domain } : null; },
  },
  { route: 'PUT /api/inventory/settings', label: 'Cài đặt kho tổng, tự phát theo định mức', domain: 'kho' },
  { route: 'PUT /api/stocktake-schedules/:scope', label: 'Lịch kiểm kê', domain: 'kho' },
  { route: 'PUT /api/handover-settings', label: 'Cài đặt bàn giao ca trên xe', domain: 'kip' },
  { route: 'PUT /api/duty-tasks/:position', label: 'Nhiệm vụ của vị trí trong kíp', domain: 'kip' },
  { route: 'PUT /api/governance', label: 'Khóa, mở khóa cấu hình', domain: 'ban_giam_doc' },
];

const BY_ROUTE = new Map(GOVERNED.map((g) => [g.route, g]));
export const governedRoute = (method: string, url: string | undefined) => (url ? BY_ROUTE.get(`${method} ${url}`) : undefined);

export async function governanceEnforced(q: Queryable): Promise<boolean> {
  return (await one(q, 'SELECT enforced FROM governance_settings WHERE id = 1'))?.enforced === true;
}

/** Mảng mà người này là trưởng nhóm (gồm cả các nhóm con); trưởng Ban Giám đốc đề xuất được mọi mảng */
export async function leadDomains(q: Queryable, userId: string): Promise<{ domain: Domain; unitId: number; unitName: string }[]> {
  return many(q, `
    WITH RECURSIVE led AS (
      SELECT o.id, o.id AS root, o.name AS root_name FROM org_members m JOIN staff s ON s.id = m.staff_id JOIN org_units o ON o.id = m.unit_id
       WHERE s.user_id = $1 AND m.is_lead AND o.active
      UNION SELECT c.id, led.root, led.root_name FROM org_units c JOIN led ON c.parent_id = led.id WHERE c.active
    )
    SELECT DISTINCT ON (o.domain) o.domain, led.root AS "unitId", led.root_name AS "unitName"
      FROM led JOIN org_units o ON o.id = led.id ORDER BY o.domain, led.root`, [userId]);
}

async function canPropose(q: Queryable, userId: string, domain: Domain) {
  const doms = await leadDomains(q, userId);
  return doms.find((d) => d.domain === domain) ?? doms.find((d) => d.domain === 'ban_giam_doc') ?? null;
}

declare module 'fastify' {
  interface FastifyRequest { changeRequestApproved?: boolean }
}

/**
 * Chạy trước phần kiểm tra quyền của từng thao tác. Thao tác thuộc danh sách trên, khi đã khóa cấu hình:
 * - đang được áp dụng sau khi duyệt (vé có mã đề xuất): cho chạy;
 * - quản trị gửi: từ chối (quản trị chỉ duyệt), trừ khóa tài khoản khẩn;
 * - trưởng nhóm đúng mảng gửi: lưu thành đề xuất (202);
 * - người khác: từ chối.
 */
export function governanceHook({ pool }: Ctx) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const found = governedRoute(req.method, req.routeOptions?.url);
    if (!found) return;
    const resolved = found.resolve?.((req.params ?? {}) as Record<string, string>);
    const g = resolved ? { ...found, ...resolved } : found;
    try { await req.jwtVerify(); } catch { return; } // chưa đăng nhập: để phần kiểm tra của thao tác trả lỗi
    const user = req.user as any;
    if (user.cr) {
      const cr = await one(pool, `SELECT id FROM change_requests WHERE id = $1 AND status = 'dang_ap_dung' AND method = $2 AND url = $3`, [user.cr, req.method, req.url]);
      if (cr) { req.changeRequestApproved = true; return; }
      return reply.code(403).send({ error: 'Vé áp dụng đề xuất không hợp lệ' });
    }
    if (!(await governanceEnforced(pool))) return;
    if (g.exempt?.(req.body) && user.role === 'admin') return;
    if (user.role === 'admin') {
      return reply.code(403).send({ error: 'Đã khóa cấu hình: quản trị chỉ duyệt hoặc từ chối đề xuất của trưởng nhóm, không sửa trực tiếp', details: { code: 'GOVERNED_ADMIN' } });
    }
    const lead = await canPropose(pool, user.id, g.domain);
    if (!lead) {
      return reply.code(403).send({ error: `Thay đổi "${g.label}" do trưởng nhóm ${DOMAIN_LABEL[g.domain]} đề xuất, quản trị duyệt`, details: { code: 'GOVERNED_NOT_LEAD' } });
    }
    // Đề xuất lưu nguyên nội dung thay đổi nên không nhận mật khẩu, khóa bí mật
    if (JSON.stringify(req.body ?? {}).match(/"(password|secret|token|apiKey|privateKey|cccd)[^"]*"\s*:/i)) {
      return reply.code(400).send({ error: 'Đề xuất không được chứa mật khẩu hay khóa bí mật' });
    }
    const params = (req.params ?? {}) as Record<string, string>;
    const before = g.before && params[g.before.param] != null
      ? await one(pool, `SELECT to_jsonb(t) AS row FROM ${g.before.table} t WHERE ${g.before.key}::text = $1`, [params[g.before.param]]).then((r) => r?.row ?? null)
      : null;
    const reasonHeader = req.headers['x-ly-do'];
    const reason = typeof reasonHeader === 'string' && reasonHeader ? decodeURIComponent(reasonHeader).slice(0, 1000) : null;
    const row = await withTx(pool, async (tx) => {
      const n = await nextCounter(tx, 'change_request', String(new Date().getFullYear()));
      const code = `DX-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
      const cr = await one(tx, `INSERT INTO change_requests(code, route, label, method, url, body, before, domain, unit_id, reason, proposed_by)
                                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, code`,
      [code, g.route, g.label, req.method, req.url, req.body === undefined ? null : JSON.stringify(req.body), before, g.domain, lead.unitId, reason, user.id]);
      await audit(tx, 'system', { id: user.id, name: user.name }, 'change_request.created', 'change_request', cr.id, { code, route: g.route });
      await notifyRoles(tx, ['admin'], { kind: 'change_request', title: `Đề xuất ${code} chờ duyệt: ${g.label}`, body: `${user.name} (${lead.unitName})`, link: '/quan-tri#de-xuat' });
      return cr;
    });
    return reply.code(202).send({ proposal: true, id: row.id, code: row.code, message: `Đã gửi đề xuất ${row.code} "${g.label}", chờ quản trị duyệt` });
  };
}
