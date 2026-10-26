import { many, one, type Queryable } from './db.js';
import type { Epcr } from './epcr.js';

/**
 * Phạm vi thực hiện theo chức danh. Mỗi thuốc, can thiệp trong danh sách giới hạn chỉ một số nhóm chức danh được tự
 * làm (mặc định bác sĩ). Ca có dùng mà trong kíp không ai thuộc nhóm đó, cũng không ai được admin cấp riêng, thì
 * phiếu phải ghi bác sĩ đã trao đổi (y lệnh qua điện thoại, video) cho từng mục, nếu không thì chưa ký được.
 */

export const SCOPE_CATEGORY: Record<string, string> = {
  bac_si: 'Bác sĩ', y_si: 'Y sĩ', dieu_duong: 'Điều dưỡng', cap_cuu_vien: 'Cấp cứu viên', ktv: 'Kỹ thuật viên', lai_xe: 'Lái xe', khac: 'Khác',
};

/** Ô can thiệp trên phiếu có thể đưa vào danh sách giới hạn */
export const CARE_LABELS: Record<string, string> = {
  heimlich: 'Heimlich', bvm: 'Bóp bóng', lma: 'Đặt mask thanh quản', ett: 'Đặt nội khí quản', suction: 'Hút đàm',
  o2Cannula: 'Thở oxy canula', nrbMask: 'Mask có túi khí', bagMask: 'Bóp mask', bagEtt: 'Bóp bóng NKQ', nebulizer: 'Phun khí dung',
  cpr: 'Ép tim', defib: 'Sốc điện bằng tay', monitor: 'Monitor', iv: 'Truyền tĩnh mạch', collar: 'Nẹp cổ', spine: 'Cố định cột sống',
  pelvis: 'Đai khung chậu', splintShoulder: 'Nẹp vai', splintArm: 'Nẹp tay', splintLeg: 'Nẹp chân', pressureBandage: 'Băng ép cầm máu',
};

/** Nhóm chức danh: admin đặt cho từng người; chưa đặt thì đoán theo chức danh ghi trên tài khoản */
export function categoryOf(scopeCategory: string | null | undefined, title: string | null | undefined): string {
  if (scopeCategory) return scopeCategory;
  const t = (title ?? '').toLowerCase();
  if (/bác sĩ|bác sỹ|^bs\b/.test(t)) return 'bac_si';
  if (/y sĩ|y sỹ|^ys\b/.test(t)) return 'y_si';
  if (/điều dưỡng|^đd\b/.test(t)) return 'dieu_duong';
  if (/cấp cứu viên|paramedic|ccv/.test(t)) return 'cap_cuu_vien';
  if (/kỹ thuật viên|ktv/.test(t)) return 'ktv';
  if (/lái xe/.test(t)) return 'lai_xe';
  return 'khac';
}

export const ruleKey = (kind: string, ref: string) => `${kind}:${ref}`;

export interface CrewMember { id: string; full_name: string; title: string | null; category: string; crew_role: string | null; grants: number[] }

/** Người trong kíp: đang trực trên xe của phiếu, cộng người đang mở phiếu (nếu khác xe, ví dụ ký bổ sung) */
export async function crewForScope(q: Queryable, vehicleId: string | null, extraUserId?: string): Promise<CrewMember[]> {
  const rows = await many(q, `
    SELECT u.id, u.full_name, u.title, u.scope_category, cs.crew_role,
           coalesce((SELECT array_agg(g.rule_id) FROM scope_grants g
                      WHERE g.user_id = u.id AND g.revoked_at IS NULL AND (g.expires_on IS NULL OR g.expires_on >= vn_today())), '{}') AS grants
      FROM users u LEFT JOIN crew_shifts cs ON cs.user_id = u.id AND cs.ended_at IS NULL AND cs.vehicle_id = $1
     WHERE (cs.id IS NOT NULL) OR u.id = $2
     ORDER BY cs.started_at NULLS LAST`, [vehicleId, extraUserId ?? null]);
  return rows.map((r) => ({ id: r.id, full_name: r.full_name, title: r.title, category: categoryOf(r.scope_category, r.title), crew_role: r.crew_role, grants: r.grants }));
}

export async function activeRules(q: Queryable) {
  return many(q, `SELECT id, kind, ref, label, allowed FROM scope_rules WHERE active ORDER BY kind, label`);
}

type Rule = { id: number; kind: string; ref: string; label: string; allowed: string[] };

/** Mục giới hạn có trên phiếu: ô can thiệp đã đánh dấu và thuốc đã dùng (theo mã thuốc, hoặc tên trùng khớp) */
export function restrictedUsed(e: Pick<Epcr, 'care' | 'medications'>, rules: Rule[]): Rule[] {
  const care = (e.care ?? {}) as Record<string, unknown>;
  const meds = e.medications ?? [];
  return rules.filter((r) => r.kind === 'can_thiep'
    ? care[r.ref] === true
    : meds.some((m) => (m.drugId != null && String(m.drugId) === r.ref) || (m.name && m.name.trim().toLowerCase() === r.label.toLowerCase())));
}

/**
 * Mục giới hạn chưa có người đủ phạm vi trong kíp và chưa ghi bác sĩ trao đổi.
 * Trả về tên mục để báo lỗi khi ký.
 */
export function uncoveredScope(e: Pick<Epcr, 'care' | 'medications' | 'consults'>, rules: Rule[], crew: CrewMember[]) {
  const consulted = new Set((e.consults ?? []).filter((c) => c.doctor?.trim()).flatMap((c) => c.items));
  return restrictedUsed(e, rules).filter((r) =>
    !crew.some((m) => r.allowed.includes(m.category) || m.grants.includes(r.id)) && !consulted.has(ruleKey(r.kind, r.ref)));
}

/** Dữ liệu cho phiếu tự kiểm tra cả khi mất mạng: danh sách giới hạn, kíp, nhóm chức danh, quyền cấp riêng */
export async function scopeContext(q: Queryable, transferId: string | null, userId: string) {
  let vehicleId: string | null = null;
  if (transferId) vehicleId = (await one(q, 'SELECT vehicle_id FROM transfers WHERE id = $1', [transferId]))?.vehicle_id ?? null;
  if (!vehicleId) vehicleId = (await one(q, 'SELECT vehicle_id FROM crew_shifts WHERE user_id = $1 AND ended_at IS NULL', [userId]))?.vehicle_id ?? null;
  const [rules, crew, doctors] = await Promise.all([
    activeRules(q),
    crewForScope(q, vehicleId, userId),
    // Bác sĩ trực điều hành, bác sĩ đang trực trên xe khác: gợi ý cho ô "bác sĩ đã trao đổi" (vẫn gõ tay được)
    many(q, `SELECT u.full_name, u.license_no FROM users u WHERE u.active AND (u.scope_category = 'bac_si' OR (u.scope_category IS NULL AND u.title ~* 'bác s'))
              ORDER BY u.full_name`),
  ]);
  return { vehicleId, rules, crew, doctors };
}
