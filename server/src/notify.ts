import { many, one, type Queryable, type Tx } from './db.js';
import { REGISTRIES } from './registry.js';
import { pendingRestock, stockAlerts, STOCK_APPROVERS, vehicleParStatus } from './stock.js';

/**
 * Nút chuông thông báo trên mọi tài khoản. Hai loại:
 * - Nhắc việc: tính trực tiếp từ dữ liệu theo vai trò (chưa làm bệnh án, chưa ký phiếu, chưa bù cơ số...),
 *   tự biến mất khi đã làm xong.
 * - Tin: sự kiện gửi tới người cần biết (hiện trường báo đông nạn nhân...), đọc rồi thì hết đỏ.
 */

export interface Reminder { key: string; level: 'red' | 'amber' | 'info'; title: string; body?: string; link: string }

export async function notifyRoles(tx: Tx, roles: string[], n: { kind: string; title: string; body?: string | null; link?: string | null; incidentId?: string | null }) {
  await tx.query(`INSERT INTO notifications(user_id, kind, title, body, link, incident_id)
                  SELECT id, $2, $3, $4, $5, $6 FROM users WHERE active AND role = ANY($1)`,
  [roles, n.kind, n.title, n.body ?? null, n.link ?? null, n.incidentId ?? null]);
}

/** Phiếu để quá 1 giờ sau khi kíp rời ca (hoặc tạo quá 3 giờ) mà chưa ký thì nhắc */
const LATE_SIGN = `(t.created_at < now() - interval '3 hours' OR NOT EXISTS (
  SELECT 1 FROM assignments a WHERE a.incident_id = t.incident_id AND a.vehicle_id = t.vehicle_id AND (a.ended_at IS NULL OR a.ended_at > now() - interval '1 hour')))`;

export async function remindersFor(q: Queryable, user: { id: string; role: string }): Promise<Reminder[]> {
  const out: Reminder[] = [];
  const me = await one(q, 'SELECT station_id, hospital_id FROM users WHERE id = $1', [user.id]);

  // Tài khoản bệnh viện: chỉ nhắc biểu mẫu nghiên cứu của ca chuyển tới bệnh viện mình còn thiếu phần trong viện
  if (user.role === 'hospital') {
    const open = await many(q, `SELECT c.registry, count(*)::int AS n FROM registry_cases c
                                 WHERE c.hospital_id = $1 AND c.status <> 'du' GROUP BY c.registry ORDER BY c.registry`, [me?.hospital_id ?? -1]);
    for (const r of open) out.push({ key: `reg:${r.registry}`, level: 'amber', title: `${r.n} ca ${REGISTRIES[r.registry]?.name ?? r.registry} chưa điền đủ phần trong viện`, link: '/benh-vien' });
    return out;
  }

  if (user.role === 'crew') {
    const shift = await one(q, `SELECT cs.vehicle_id, v.status FROM crew_shifts cs JOIN vehicles v ON v.id = cs.vehicle_id
                                 WHERE cs.user_id = $1 AND cs.ended_at IS NULL`, [user.id]);
    const mine = await many(q, `
      SELECT t.id, t.transfer_number, t.status, t.patient_id, t.created_at, i.code AS incident_code, ${LATE_SIGN} AS late
        FROM transfers t LEFT JOIN incidents i ON i.id = t.incident_id
       WHERE (t.author_id = $1 OR (t.vehicle_id = $2 AND t.created_at > now() - interval '24 hours'))
         AND t.created_at > now() - interval '14 days' AND (t.status = 'draft' OR t.patient_id IS NULL)
       ORDER BY t.created_at`, [user.id, shift?.vehicle_id ?? null]);
    for (const t of mine) {
      const name = t.transfer_number ?? t.incident_code ?? 'chưa cấp số';
      if (!t.patient_id) out.push({ key: `ba:${t.id}`, level: 'red', title: `Chưa làm bệnh án cho phiếu ${name}`, body: 'Lập bệnh án ở thẻ "Ký phiếu" (dò trùng CCCD, số điện thoại)', link: '/kip' });
      else if (t.status === 'draft' && t.late) out.push({ key: `sign:${t.id}`, level: 'red', title: `Chưa ký phiếu chuyển viện ${name}`, link: '/kip' });
    }
    // Ca đã ký có dùng cơ số trên xe mà chưa xác nhận danh sách bù sau ca
    const restock = shift ? await pendingRestock(q, shift.vehicle_id) : [];
    for (const r of restock) {
      out.push({ key: `restock:${r.id}`, level: 'red', title: `Chưa bù cơ số sau ca ${r.transfer_number ?? r.incident_code ?? ''}`.trim(), body: `${r.items} mặt hàng đã dùng trên xe`, link: '/kip' });
    }
    // Xe đang rảnh mà còn thiếu so với cơ số (ngoài các ca ở trên): nhắc bù
    if (shift && !restock.length && ['S1', 'S2', 'S8'].includes(shift.status)) {
      const par = await vehicleParStatus(q, shift.vehicle_id);
      if (par.short) {
        const names = par.items.filter((i) => i.missing > 0).slice(0, 4).map((i) => `${i.drug_name} (${i.missing})`).join(', ');
        out.push({ key: `par:${shift.vehicle_id}`, level: 'amber', title: `Xe ${shift.vehicle_id} thiếu ${par.short} mặt hàng so với cơ số: chưa bù`, body: names, link: '/kip' });
      }
    }
  }

  // Việc của mọi người: xác nhận nhận đồ bảo hộ, đọc phản hồi rà soát ca
  const ppe = await one(q, 'SELECT count(*)::int AS n FROM ppe_issues WHERE user_id = $1 AND received_at IS NULL AND returned_on IS NULL', [user.id]);
  if (ppe?.n) out.push({ key: 'ppe', level: 'amber', title: `Chưa xác nhận đã nhận ${ppe.n} lần cấp đồ bảo hộ`, link: '/ca-nhan' });
  const fb = await one(q, `SELECT count(*)::int AS n FROM ops_case_reviews cr
                            WHERE cr.status = 'da_xong' AND cr.reviewed_at > now() - interval '60 days'
                              AND NOT EXISTS (SELECT 1 FROM ops_review_acks a WHERE a.review_id = cr.id AND a.user_id = $1)
                              AND EXISTS (SELECT 1 FROM transfers t WHERE t.incident_id = cr.incident_id AND (t.author_id = $1 OR t.signed_by = $1))`, [user.id]);
  if (fb?.n) out.push({ key: 'feedback', level: 'info', title: `${fb.n} phản hồi rà soát ca chưa đọc`, link: '/ca-nhan' });

  if (['pharmacist', 'admin'].includes(user.role)) {
    const s = await stockAlerts(q, me?.station_id ?? null, 30);
    if (s.expired.length) out.push({ key: 'stock:expired', level: 'red', title: `${s.expired.length} lô thuốc, vật tư đã hết hạn còn trong kho`, link: '/kho' });
    if (s.belowMin.length) out.push({ key: 'stock:min', level: 'amber', title: `${s.belowMin.length} mặt hàng dưới định mức tối thiểu`, link: '/kho' });
    if (s.vehicleShort.length) out.push({ key: 'stock:vehicles', level: 'amber', title: `${s.vehicleShort.length} xe thiếu cơ số`, body: s.vehicleShort.map((v) => `${v.vehicleId} (${v.short})`).join(', '), link: '/kho' });
    if (s.pendingVouchers) out.push({ key: 'stock:vouchers', level: 'info', title: `${s.pendingVouchers} phiếu kho chờ duyệt`, link: '/kho' });
  }
  if (STOCK_APPROVERS.includes(user.role)) {
    const po = await one(q, `SELECT count(*)::int AS n FROM purchase_orders WHERE status = 'cho_duyet' AND created_by <> $1`, [user.id]);
    if (po?.n) out.push({ key: 'po', level: 'amber', title: `${po.n} đơn mua hàng chờ duyệt`, link: '/hau-can' });
  }
  if (['dispatcher', 'supervisor', 'admin', 'director'].includes(user.role)) {
    const mci = await many(q, `SELECT code FROM incidents WHERE mci_declared_at IS NOT NULL AND mci_ended_at IS NULL ORDER BY mci_declared_at`);
    if (mci.length) out.push({ key: 'mci', level: 'red', title: `Đang đông nạn nhân: ${mci.map((m) => m.code).join(', ')}`, link: '/van-hanh' });
  }
  if (['qa', 'supervisor', 'admin', 'director'].includes(user.role)) {
    const stale = await one(q, `SELECT count(*)::int AS n FROM registry_cases WHERE status <> 'du' AND created_at < now() - interval '30 days'`);
    if (stale?.n) out.push({ key: 'reg:stale', level: 'info', title: `${stale.n} ca biểu mẫu nghiên cứu quá 30 ngày chưa đủ phần trong viện`, link: '/nghien-cuu' });
  }
  return out;
}

export async function notificationsFor(q: Queryable, user: { id: string; role: string }) {
  const [reminders, messages] = await Promise.all([
    remindersFor(q, user),
    many(q, `SELECT id, kind, title, body, link, incident_id, created_at, read_at FROM notifications
              WHERE user_id = $1 AND (read_at IS NULL OR created_at > now() - interval '3 days') ORDER BY created_at DESC LIMIT 30`, [user.id]),
  ]);
  const unread = messages.filter((m) => !m.read_at).length;
  return { reminders, messages, count: reminders.length + unread, urgent: reminders.some((r) => r.level === 'red') || unread > 0 };
}
