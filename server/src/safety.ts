import { createHash, randomInt } from 'node:crypto';
import { audit, type Actor } from './audit.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError, incidentScope } from './domain.js';
import { recordGps } from './ops.js';
import { verifyDocument } from './pki.js';

/**
 * Giai đoạn K: báo khẩn của kíp (bị hành hung, đe dọa, tai nạn trên đường), chữ ký điện tử của người bệnh/người nhà
 * trên phiếu (đồng ý thủ thuật, từ chối vận chuyển, nhận bàn giao) và mã xác thực phiếu chuyển viện cho bệnh viện nhận.
 */

/* ================= Báo khẩn ================= */

export const SOS_SELECT = `
  SELECT s.*, u.full_name AS user_name, (SELECT st.phone FROM staff st WHERE st.user_id = s.user_id) AS user_phone, i.code AS incident_code, i.address AS incident_address,
         a.full_name AS acked_by_name, r.full_name AS resolved_by_name
    FROM crew_sos s JOIN users u ON u.id = s.user_id
    LEFT JOIN incidents i ON i.id = s.incident_id
    LEFT JOIN users a ON a.id = s.acked_by
    LEFT JOIN users r ON r.id = s.resolved_by`;

/** Kíp bấm báo khẩn. Đang có báo khẩn mở thì cập nhật vị trí vào báo khẩn đó (bấm lại không tạo thêm) */
export async function raiseSos(tx: Tx, actor: Actor, b: { lat?: number | null; lng?: number | null; accuracy?: number | null; note?: string | null }) {
  const shift = await one(tx, `SELECT cs.vehicle_id, v.current_incident_id FROM crew_shifts cs JOIN vehicles v ON v.id = cs.vehicle_id
                                WHERE cs.user_id = $1 AND cs.ended_at IS NULL`, [actor.id]);
  const hasPos = b.lat != null && b.lng != null;
  const open = await one(tx, 'SELECT * FROM crew_sos WHERE user_id = $1 AND resolved_at IS NULL FOR UPDATE', [actor.id]);
  let row;
  if (open) {
    row = await one(tx, `UPDATE crew_sos SET lat = coalesce($2, lat), lng = coalesce($3, lng), accuracy_m = coalesce($4, accuracy_m),
                                located_at = CASE WHEN $2::float8 IS NULL THEN located_at ELSE now() END, note = coalesce($5, note)
                          WHERE id = $1 RETURNING *`, [open.id, hasPos ? b.lat : null, hasPos ? b.lng : null, hasPos ? b.accuracy ?? null : null, b.note ?? null]);
  } else {
    const year = new Date(Date.now() + 7 * 3600_000).getUTCFullYear();
    const n = await nextCounter(tx, 'crew_sos', String(year));
    row = await one(tx, `INSERT INTO crew_sos(code, user_id, vehicle_id, incident_id, lat, lng, accuracy_m, located_at, note)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [`BK-${year}-${String(n).padStart(4, '0')}`, actor.id, shift?.vehicle_id ?? null, shift?.current_incident_id ?? null,
      hasPos ? b.lat : null, hasPos ? b.lng : null, hasPos ? b.accuracy ?? null : null, hasPos ? new Date() : null, b.note ?? null]);
    // Báo trưởng ca và lãnh đạo qua hàng đợi gửi (tin nhắn khi có nhà cung cấp); EOC nhận báo động ngay qua kết nối trực tiếp
    await tx.query(`INSERT INTO outbox(topic, payload) VALUES ('crew_sos', $1)`,
      [{ sosId: row.id, code: row.code, user: actor.name, vehicleId: row.vehicle_id, lat: row.lat, lng: row.lng }]);
    await audit(tx, row.incident_id ? incidentScope(row.incident_id) : 'system', actor, 'safety.sos_raised', 'crew_sos', row.id,
      { code: row.code, vehicleId: row.vehicle_id, hasPosition: hasPos });
  }
  if (hasPos && row.vehicle_id) await recordGps(tx, row.vehicle_id, { lat: b.lat!, lng: b.lng!, accuracy: b.accuracy ?? null });
  return row;
}

export async function ackSos(tx: Tx, actor: Actor, id: string, note: string) {
  const row = await one(tx, `UPDATE crew_sos SET acked_at = coalesce(acked_at, now()), acked_by = coalesce(acked_by, $2),
                                    ack_note = CASE WHEN ack_note IS NULL THEN $3 ELSE ack_note || E'\\n' || $3 END
                              WHERE id = $1 AND resolved_at IS NULL RETURNING *`, [id, actor.id, note]);
  if (!row) throw new HttpError(409, 'Báo khẩn đã kết thúc hoặc không tồn tại');
  await audit(tx, row.incident_id ? incidentScope(row.incident_id) : 'system', actor, 'safety.sos_acked', 'crew_sos', id, { note });
  return row;
}

/** Kết thúc báo khẩn: EOC sau khi xác minh kíp an toàn, hoặc chính người bấm khi bấm nhầm (ghi là báo nhầm) */
export async function resolveSos(tx: Tx, actor: Actor, id: string, b: { resolution: string; falseAlarm: boolean }, ownOnly: boolean) {
  const s = await one(tx, 'SELECT * FROM crew_sos WHERE id = $1 FOR UPDATE', [id]);
  if (!s) throw new HttpError(404, 'Không tìm thấy báo khẩn');
  if (s.resolved_at) throw new HttpError(409, 'Báo khẩn đã kết thúc');
  if (ownOnly && s.user_id !== actor.id) throw new HttpError(403, 'Chỉ hủy được báo khẩn của chính mình');
  if (!ownOnly && !s.acked_at) throw new HttpError(409, 'Xác nhận đã nhận báo khẩn trước khi kết thúc');
  const row = await one(tx, `UPDATE crew_sos SET resolved_at = now(), resolved_by = $2, resolution = $3, false_alarm = $4 WHERE id = $1 RETURNING *`,
    [id, actor.id, b.resolution, b.falseAlarm]);
  await audit(tx, s.incident_id ? incidentScope(s.incident_id) : 'system', actor, 'safety.sos_resolved', 'crew_sos', id,
    { resolution: b.resolution, falseAlarm: b.falseAlarm, byCrew: ownOnly });
  return row;
}

export const openSos = (q: Queryable) => many(q, `${SOS_SELECT} WHERE s.resolved_at IS NULL ORDER BY s.created_at`);

/* ================= Chữ ký điện tử trên phiếu ================= */

export const SIGNATURE_KIND: Record<string, { label: string; statement: string }> = {
  dong_y_thu_thuat: {
    label: 'Đồng ý thủ thuật, can thiệp',
    statement: 'Tôi đã được nhân viên y tế giải thích về tình trạng bệnh, thủ thuật/can thiệp dự kiến, lợi ích và nguy cơ có thể xảy ra. Tôi đồng ý thực hiện.',
  },
  tu_choi_van_chuyen: {
    label: 'Từ chối vận chuyển, từ chối điều trị',
    statement: 'Tôi đã được nhân viên y tế giải thích rõ tình trạng bệnh và nguy cơ (kể cả nguy cơ tử vong) nếu không được vận chuyển, điều trị. Tôi vẫn từ chối và tự chịu trách nhiệm.',
  },
  nhan_ban_giao: {
    label: 'Bệnh viện nhận bàn giao người bệnh',
    statement: 'Tôi xác nhận đã nhận bàn giao người bệnh cùng tình trạng, hồ sơ và thuốc đã dùng như ghi trên phiếu.',
  },
};
/** Ảnh chữ ký PNG dạng data URL, tối đa khoảng 300 KB */
export const SIGNATURE_MAX_CHARS = 400_000;

export const signatureHash = (s: { kind: string; signerName?: string; statement?: string; image?: string; signedAt?: string }) =>
  createHash('sha256').update(JSON.stringify([s.kind, s.signerName ?? '', s.statement ?? '', s.image ?? '', s.signedAt ?? ''])).digest('hex');

/* ================= Mã xác thực phiếu ================= */

/** Bảng chữ không dễ nhầm (bỏ 0 O 1 I L), 10 ký tự ~ 50 bit */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function newVerifyCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
export const normalizeCode = (c: string) => {
  const s = c.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return s.length === 10 ? `${s.slice(0, 5)}-${s.slice(5)}` : s;
};

/** Băm nội dung phiếu theo thứ tự khóa cố định, để bệnh viện đối chiếu bản in với bản trên hệ thống */
export function contentHash(epcr: unknown): string {
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  return createHash('sha256').update(JSON.stringify(canon(epcr))).digest('hex');
}

/** Viết tắt tên (Nguyễn Văn An → N.V.A.) để trang xác thực công khai không lộ họ tên */
export const initials = (name?: string | null) => (name ? name.trim().split(/\s+/).map((w) => `${w[0]?.toUpperCase()}.`).join('') : null);

/** Kết quả kiểm tra chữ ký số cho trang công khai: không lộ họ tên người ký, chỉ viết tắt */
async function publicSignature(q: Queryable, id: string, hash: string | null, version: number) {
  const v = await verifyDocument(q, 'transfer', id, hash, version);
  if (!v) return null;
  return { valid: v.valid, problems: v.problems, signedAt: v.signedAt, signer: initials(v.signerName), issuer: v.issuer, certSerial: v.certSerial, provider: v.provider };
}

/** Tra cứu công khai: chỉ trả thông tin đủ để đối chiếu bản in, không có chẩn đoán hay số định danh */
export async function verifyTransfer(q: Queryable, code: string, ip: string | null) {
  const c = normalizeCode(code);
  const t = await one(q, `
    SELECT t.id, t.transfer_number, t.signed_at, t.vehicle_id, t.version, t.content_hash, t.epcr->'disposition'->>'hospital' AS hospital,
           t.epcr->'disposition'->>'handoverAt' AS handover_at, p.full_name, coalesce(extract(year FROM p.dob)::int, p.birth_year) AS birth_year, p.sex,
           s.full_name AS signed_by_name, (SELECT count(*)::int FROM transfer_amendments m WHERE m.transfer_id = t.id) AS amendments
      FROM transfers t LEFT JOIN patients p ON p.id = t.patient_id LEFT JOIN users s ON s.id = t.signed_by
     WHERE t.verify_code = $1 AND t.status = 'signed'`, [c]);
  await q.query('INSERT INTO transfer_verifications(transfer_id, code, found, ip) VALUES ($1,$2,$3,$4)', [t?.id ?? null, c.slice(0, 20), !!t, ip]);
  if (!t) return { found: false as const };
  return {
    found: true as const,
    transferNumber: t.transfer_number, signedAt: t.signed_at, signedBy: t.signed_by_name, vehicleId: t.vehicle_id,
    patient: { initials: initials(t.full_name), birthYear: t.birth_year, sex: t.sex },
    hospital: t.hospital, handoverAt: t.handover_at, version: t.version, amendments: t.amendments,
    hashPrefix: t.content_hash ? String(t.content_hash).slice(0, 12) : null,
    digitalSignature: await publicSignature(q, t.id, t.content_hash, t.version),
  };
}
