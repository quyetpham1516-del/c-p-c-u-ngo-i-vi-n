import { randomBytes } from 'node:crypto';
import { audit, type Actor } from './audit.js';
import { config } from './config.js';
import { many, nextCounter, one, type Queryable, type Tx } from './db.js';
import { HttpError } from './domain.js';
import { CAPA_LINKS, CAPA_SOURCE, CAPA_VERIFY_DAYS } from './qms.js';

/**
 * Chất lượng và an toàn: kiểm soát nhiễm khuẩn (QLCL-05), sự cố y khoa (QLCL-03, TT 43/2018/TT-BYT),
 * hành động khắc phục (QLCL-10), khiếu nại (QLCL-07), khảo sát hài lòng (QLCL-08).
 */

const vnYear = () => String(new Date(Date.now() + 7 * 3600_000).getUTCFullYear());
async function code(tx: Tx, prefix: string, counter: string) {
  const y = vnYear();
  const n = await nextCounter(tx, counter, y);
  return `${prefix}-${y}-${String(n).padStart(5, '0')}`;
}

/* ================= Kiểm soát nhiễm khuẩn ================= */

export const DISINFECTION_LEVEL: Record<string, string> = {
  thuong_quy: 'Thường quy', tang_cuong: 'Tăng cường (tiếp xúc, giọt bắn)', toan_dien: 'Toàn diện (lây qua không khí)',
};
const RANK: Record<string, number> = { thuong_quy: 0, tang_cuong: 1, toan_dien: 2 };

/** Việc phải làm theo mức khử khuẩn; mức cao gồm cả việc của mức thấp */
export const DISINFECTION_STEPS: Record<string, [string, string][]> = {
  thuong_quy: [['be_mat', 'Lau bề mặt khoang bệnh nhân'], ['cang', 'Khử khuẩn cáng, dây đai'], ['thiet_bi', 'Lau thiết bị đã dùng'], ['rac_thai', 'Thu gom chất thải, vật sắc nhọn']],
  tang_cuong: [['san', 'Lau sàn bằng dung dịch khử khuẩn'], ['tay_nam', 'Khử khuẩn tay nắm, vô lăng, bộ đàm'], ['do_vai', 'Thay vải trải, chăn']],
  toan_dien: [['thong_khi', 'Thông khí khoang xe đủ thời gian'], ['phun_khu_khuan', 'Phun/khử khuẩn toàn khoang']],
};
export function stepsFor(level: string): [string, string][] {
  const order = ['thuong_quy', 'tang_cuong', 'toan_dien'];
  return order.slice(0, RANK[level] + 1).flatMap((l) => DISINFECTION_STEPS[l]);
}

/** Mức khử khuẩn phải đạt sau ca: theo nguy cơ lây nhiễm điều phối/kíp đánh dấu và cờ "bệnh truyền nhiễm" trên phiếu */
export async function requiredLevel(q: Queryable, incidentId: string): Promise<string> {
  const r = await one(q, `SELECT i.infection_risk,
                                 EXISTS (SELECT 1 FROM transfers t WHERE t.incident_id = i.id AND (t.epcr->>'infectious')::boolean) AS epcr_flag
                            FROM incidents i WHERE i.id = $1`, [incidentId]);
  if (!r) return 'thuong_quy';
  if (r.infection_risk === 'khong_khi') return 'toan_dien';
  if (r.infection_risk || r.epcr_flag) return 'tang_cuong';
  return 'thuong_quy';
}

/** Tạo phiếu khử khuẩn chờ làm khi xe xong ca (một phiếu cho mỗi xe, mỗi ca) */
export async function ensureDisinfection(tx: Tx, vehicleId: string, incidentId: string) {
  const level = await requiredLevel(tx, incidentId);
  await tx.query(`INSERT INTO disinfections(vehicle_id, incident_id, level, required_level) VALUES ($1,$2,$3,$3)
                  ON CONFLICT (vehicle_id, incident_id) WHERE incident_id IS NOT NULL
                  DO UPDATE SET required_level = EXCLUDED.required_level, level = CASE WHEN disinfections.status = 'cho_lam' THEN EXCLUDED.level ELSE disinfections.level END`,
  [vehicleId, incidentId, level]);
}

/** Ca nghi lây nhiễm: xe chưa ký phiếu khử khuẩn đủ mức thì chưa được báo sẵn sàng */
export async function assertDisinfected(tx: Tx, vehicleId: string, incidentId: string) {
  const need = await requiredLevel(tx, incidentId);
  if (need === 'thuong_quy') return;
  const done = await one(tx, `SELECT level FROM disinfections WHERE vehicle_id = $1 AND incident_id = $2 AND status = 'da_ky'`, [vehicleId, incidentId]);
  if (!done || RANK[done.level] < RANK[need]) {
    throw new HttpError(409, `Ca nghi lây nhiễm: ký phiếu khử khuẩn mức "${DISINFECTION_LEVEL[need]}" trước khi báo xe sẵn sàng`,
      { code: 'DISINFECTION', vehicleId, incidentId, required: need });
  }
}

export async function signDisinfection(tx: Tx, actor: Actor, b: {
  vehicleId: string; incidentId?: string | null; level: string; checklist: Record<string, boolean>;
  chemical: string; concentration?: string | null; contactMinutes?: number | null; note?: string | null;
}) {
  const need = b.incidentId ? await requiredLevel(tx, b.incidentId) : 'thuong_quy';
  if (RANK[b.level] < RANK[need]) throw new HttpError(409, `Ca này cần khử khuẩn mức "${DISINFECTION_LEVEL[need]}"`);
  const missing = stepsFor(b.level).filter(([k]) => !b.checklist[k]).map(([, label]) => label);
  if (missing.length) throw new HttpError(422, 'Chưa làm đủ các bước khử khuẩn', missing);
  const args = [b.vehicleId, b.incidentId ?? null, b.level, need, b.checklist, b.chemical, b.concentration ?? null, b.contactMinutes ?? null, b.note ?? null, actor.id];
  const row = b.incidentId
    ? await one(tx, `INSERT INTO disinfections(vehicle_id, incident_id, level, required_level, checklist, chemical, concentration, contact_minutes, note, done_by, done_at, status)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), 'da_ky')
                     ON CONFLICT (vehicle_id, incident_id) WHERE incident_id IS NOT NULL DO UPDATE SET
                       level = EXCLUDED.level, required_level = EXCLUDED.required_level, checklist = EXCLUDED.checklist, chemical = EXCLUDED.chemical,
                       concentration = EXCLUDED.concentration, contact_minutes = EXCLUDED.contact_minutes, note = EXCLUDED.note,
                       done_by = EXCLUDED.done_by, done_at = now(), status = 'da_ky'
                     RETURNING *`, args)
    : await one(tx, `INSERT INTO disinfections(vehicle_id, incident_id, level, required_level, checklist, chemical, concentration, contact_minutes, note, done_by, done_at, status)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), 'da_ky') RETURNING *`, args);
  await audit(tx, 'system', actor, 'ipc.disinfection_signed', 'vehicle', b.vehicleId, { incidentId: b.incidentId ?? null, level: b.level, chemical: b.chemical });
  return row;
}

/* ================= Sự cố y khoa ================= */

export const EVENT_CATEGORY: Record<string, string> = {
  thu_thuat: 'Thực hiện quy trình kỹ thuật, thủ thuật', nhiem_khuan: 'Nhiễm khuẩn liên quan chăm sóc', thuoc: 'Thuốc và dịch truyền',
  mau: 'Máu và chế phẩm máu', thiet_bi: 'Thiết bị y tế', hanh_vi: 'Hành vi', tai_nan: 'Tai nạn đối với người bệnh (té ngã...)',
  ha_tang: 'Hạ tầng, xe cộ', nguon_luc: 'Quản lý nguồn lực, tổ chức', ho_so: 'Hồ sơ, tài liệu, thủ tục hành chính',
  dieu_phoi: 'Tiếp nhận, điều phối, thời gian phản hồi', khac: 'Khác',
};
export const SEVERITY: Record<string, string> = {
  NC0: 'Chưa xảy ra (suýt xảy ra)', NC1: 'Đã xảy ra, chưa gây tổn hại', NC2: 'Tổn hại nhẹ đến trung bình', NC3: 'Tổn hại nặng hoặc tử vong',
};
export const FACTORS = ['Con người', 'Quy trình', 'Thiết bị', 'Môi trường', 'Tổ chức, quản lý', 'Người bệnh', 'Giao tiếp, bàn giao'];

const ANONYMOUS: Actor = { id: null, name: 'Ẩn danh' };

export async function reportEvent(tx: Tx, actor: Actor, b: {
  occurredAt: string; anonymous: boolean; incidentId?: string | null; vehicleId?: string | null; stationId?: string | null;
  category: string; description: string; immediateAction?: string | null; patientAffected: boolean; severity: string; sourceRef?: string | null;
}) {
  if (!EVENT_CATEGORY[b.category]) throw new HttpError(400, 'Nhóm sự cố không hợp lệ');
  if (b.sourceRef && await one(tx, 'SELECT 1 FROM adverse_events WHERE source_ref = $1', [b.sourceRef])) throw new HttpError(409, 'Gợi ý này đã được báo cáo');
  const ev = await one(tx, `INSERT INTO adverse_events(code, occurred_at, reporter_id, anonymous, incident_id, vehicle_id, station_id, category, description,
                                                        immediate_action, patient_affected, severity_reported, source_ref)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
  [await code(tx, 'SC', 'adverse_event'), b.occurredAt, b.anonymous ? null : actor.id, b.anonymous, b.incidentId ?? null, b.vehicleId ?? null,
    b.stationId ?? null, b.category, b.description, b.immediateAction ?? null, b.patientAffected, b.severity, b.sourceRef ?? null]);
  // Báo ẩn danh thì nhật ký cũng không ghi người báo
  await audit(tx, 'system', b.anonymous ? ANONYMOUS : actor, 'quality.event_reported', 'adverse_event', ev.id, { code: ev.code, severity: b.severity, category: b.category });
  return ev;
}

export async function updateEvent(tx: Tx, actor: Actor, id: string, b: {
  severity?: string; handlerId?: string | null; status?: 'dang_xu_ly' | 'da_phan_tich'; rootCause?: string | null; factors?: string[]; lessons?: string | null;
  authorityReported?: boolean;
}) {
  const ev = await one(tx, 'SELECT * FROM adverse_events WHERE id = $1 FOR UPDATE', [id]);
  if (!ev) throw new HttpError(404, 'Không tìm thấy báo cáo sự cố');
  if (ev.status === 'dong') throw new HttpError(409, 'Sự cố đã đóng');
  if (b.status === 'da_phan_tich' && !(b.rootCause ?? ev.root_cause)?.trim()) throw new HttpError(400, 'Ghi nguyên nhân gốc trước khi chuyển "đã phân tích"');
  const r = await one(tx, `UPDATE adverse_events SET
                             severity = coalesce($2, severity), handler_id = CASE WHEN $8 THEN $3 ELSE handler_id END,
                             status = coalesce($4, CASE WHEN status = 'moi' THEN 'dang_xu_ly' ELSE status END),
                             root_cause = CASE WHEN $9 THEN $5 ELSE root_cause END, factors = coalesce($6, factors),
                             lessons = CASE WHEN $10 THEN $7 ELSE lessons END,
                             authority_reported_at = CASE WHEN $11 AND authority_reported_at IS NULL THEN now() ELSE authority_reported_at END
                           WHERE id = $1 RETURNING *`,
  [id, b.severity ?? null, b.handlerId ?? null, b.status ?? null, b.rootCause ?? null, b.factors ?? null, b.lessons ?? null,
    'handlerId' in b, 'rootCause' in b, 'lessons' in b, !!b.authorityReported]);
  await audit(tx, 'system', actor, 'quality.event_updated', 'adverse_event', id, { code: ev.code, ...b });
  return r;
}

/**
 * Đóng sự cố: mọi hành động khắc phục phải xong hoặc hủy. NC2–NC3 phải có nguyên nhân gốc.
 * NC3 (nghiêm trọng): phải đã báo cơ quan quản lý, và người đóng là ban giám đốc/quản trị, khác người xử lý (duyệt hai cấp).
 */
export async function closeEvent(tx: Tx, actor: Actor & { role: string }, id: string, note: string) {
  const ev = await one(tx, 'SELECT * FROM adverse_events WHERE id = $1 FOR UPDATE', [id]);
  if (!ev) throw new HttpError(404, 'Không tìm thấy báo cáo sự cố');
  if (ev.status === 'dong') throw new HttpError(409, 'Sự cố đã đóng');
  const sev = ev.severity ?? ev.severity_reported;
  const open = await one(tx, `SELECT count(*)::int AS n FROM capa_actions WHERE event_id = $1 AND status = 'mo'`, [id]);
  if (open.n) throw new HttpError(409, `Còn ${open.n} hành động khắc phục chưa xong`);
  if ((sev === 'NC2' || sev === 'NC3') && !ev.root_cause?.trim()) throw new HttpError(409, 'Sự cố NC2–NC3 phải phân tích nguyên nhân gốc trước khi đóng');
  if (sev === 'NC3') {
    if (!ev.authority_reported_at) throw new HttpError(409, 'Sự cố nghiêm trọng: ghi nhận đã báo cơ quan quản lý trước khi đóng');
    if (!['director', 'admin'].includes(actor.role)) throw new HttpError(403, 'Sự cố nghiêm trọng do Ban Giám đốc đóng');
    if (ev.handler_id === actor.id) throw new HttpError(403, 'Người xử lý không tự đóng sự cố nghiêm trọng (duyệt hai cấp)');
  }
  await tx.query(`UPDATE adverse_events SET status = 'dong', closed_by = $2, closed_at = now(), close_note = $3 WHERE id = $1`, [id, actor.id, note]);
  await audit(tx, 'system', actor, 'quality.event_closed', 'adverse_event', id, { code: ev.code, severity: sev, note });
}

/**
 * Gợi ý sự cố từ dữ liệu ca (không phải chờ ai báo): ca P1 xe lăn bánh chậm hoặc tới hiện trường quá 15 phút,
 * phiếu sửa sau khi ký, xe thiếu thiết bị vẫn được cho đi, lô tiệt khuẩn không đạt, khiếu nại về chuyên môn.
 */
export async function eventSuggestions(q: Queryable, days = 30) {
  const rows = await many(q, `
    WITH t AS (
      SELECT i.id, i.code, i.final_priority, i.created_at,
             max(at) FILTER (WHERE it.code = 'T0') AS t0, max(at) FILTER (WHERE it.code = 'T4') AS t4,
             max(at) FILTER (WHERE it.code = 'T6') AS t6, max(at) FILTER (WHERE it.code = 'T7') AS t7
        FROM incidents i JOIN incident_times it ON it.incident_id = i.id
       WHERE i.created_at > now() - make_interval(days => $1) AND i.final_priority = 'P1'
       GROUP BY i.id)
    SELECT 'cham-xuat-phat:' || id AS ref, 'dieu_phoi' AS category, id AS incident_id, NULL::text AS vehicle_id, created_at AS at,
           'Ca P1 ' || code || ': xe lăn bánh sau ' || round(extract(epoch FROM t6 - t4) / 60.0, 1) || ' phút kể từ khi giao (chuẩn ≤ 2 phút)' AS text
      FROM t WHERE t6 - t4 > interval '2 minutes'
    UNION ALL
    SELECT 'cham-toi-noi:' || id, 'dieu_phoi', id, NULL, created_at,
           'Ca P1 ' || code || ': tới hiện trường sau ' || round(extract(epoch FROM t7 - t0) / 60.0, 1) || ' phút từ cuộc gọi (mục tiêu ≤ 15 phút)'
      FROM t WHERE t7 - t0 > interval '15 minutes'
    UNION ALL
    SELECT 'sua-phieu:' || m.transfer_id || ':' || m.version, 'ho_so', t.incident_id, t.vehicle_id, m.created_at,
           'Phiếu ' || coalesce(t.transfer_number, '') || ' được bổ sung sau khi ký: ' || m.reason
      FROM transfer_amendments m JOIN transfers t ON t.id = m.transfer_id
     WHERE m.created_at > now() - make_interval(days => $1)
    UNION ALL
    SELECT 'xe-thieu-thiet-bi:' || a.id, 'thiet_bi', NULLIF(split_part(a.scope, ':', 2), '')::uuid, a.entity_id, a.at,
           'Xe ' || a.entity_id || ' được cho đi khi thiếu thiết bị: ' || (a.data->'equipmentOverride'->>'gaps') || '. Lý do: ' || (a.data->'equipmentOverride'->>'reason')
      FROM audit_events a
     WHERE a.action IN ('assignment.created', 'assignment.auto') AND a.data ? 'equipmentOverride' AND a.at > now() - make_interval(days => $1)
    UNION ALL
    SELECT 'tiet-khuan:' || b.id, 'nhiem_khuan', NULL, NULL, b.finished_at,
           'Lô tiệt khuẩn ' || b.code || ' không đạt chỉ thị'
      FROM sterilization_batches b WHERE b.status = 'khong_dat' AND b.finished_at > now() - make_interval(days => $1)
    UNION ALL
    SELECT 'khieu-nai:' || c.id, 'khac', c.incident_id, NULL, c.received_at,
           'Khiếu nại ' || c.code || ' về chuyên môn: ' || left(c.content, 160)
      FROM complaints c WHERE c.category = 'chuyen_mon' AND c.received_at > now() - make_interval(days => $1)
    ORDER BY at DESC`, [days]);
  const used = new Set((await many(q, 'SELECT source_ref FROM adverse_events WHERE source_ref IS NOT NULL')).map((r) => r.source_ref));
  return rows.filter((r) => !used.has(r.ref));
}

/* ================= CAPA ================= */

/** Hành động khắc phục, phòng ngừa dùng chung: gắn với sự cố, khiếu nại, phát hiện đánh giá nội bộ, rủi ro, chỉ số, giám sát hoặc xem xét của lãnh đạo */
export async function addCapa(tx: Tx, actor: Actor, b: {
  eventId?: string | null; complaintId?: string | null; findingId?: string | null; riskId?: string | null; reviewId?: string | null;
  callbackId?: string | null; indicatorId?: string | null; source?: string | null; sourceRef?: string | null; rootCause?: string | null;
  kind: string; description: string; ownerId: string; dueDate: string;
}) {
  const links = CAPA_LINKS.filter(([f]) => (b as Record<string, unknown>)[f]);
  if (links.length > 1) throw new HttpError(400, 'Mỗi hành động gắn với một nguồn');
  const source = links[0]?.[2] ?? b.source ?? null;
  if (!source || (!links.length && !b.sourceRef?.trim())) throw new HttpError(400, 'Ghi rõ nguồn của hành động (sự cố, khiếu nại, đánh giá, tiêu chí...)');
  if (!CAPA_SOURCE[source]) throw new HttpError(400, 'Nguồn không hợp lệ');
  const cols = links.map(([, c]) => c);
  const vals = links.map(([f]) => (b as Record<string, unknown>)[f]);
  const c = await one(tx, `INSERT INTO capa_actions(${['source', 'source_ref', 'root_cause', 'kind', 'description', 'owner_id', 'due_date', 'created_by', ...cols].join(', ')})
                           VALUES (${[...Array(8 + cols.length)].map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
  [source, b.sourceRef ?? null, b.rootCause ?? null, b.kind, b.description, b.ownerId, b.dueDate, actor.id, ...vals]);
  await audit(tx, 'system', actor, 'quality.capa_added', 'capa_action', c.id, b);
  return c;
}

/** Xong thì chờ người khác kiểm tra hiệu quả sau CAPA_VERIFY_DAYS ngày (QLCL-10) */
export async function finishCapa(tx: Tx, actor: Actor & { role: string }, id: string, b: { status: 'xong' | 'huy'; evidence: string }) {
  const c = await one(tx, 'SELECT * FROM capa_actions WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw new HttpError(404, 'Không tìm thấy hành động');
  if (c.status !== 'mo') throw new HttpError(409, 'Hành động đã kết thúc');
  if (c.owner_id !== actor.id && !['qa', 'supervisor', 'admin', 'director'].includes(actor.role)) throw new HttpError(403, 'Chỉ người phụ trách hoặc QLCL cập nhật');
  await tx.query(`UPDATE capa_actions SET status = $2, done_at = now(), evidence = $3,
                    verify_due = CASE WHEN $2 = 'xong' THEN vn_today() + $4::int ELSE NULL END WHERE id = $1`, [id, b.status, b.evidence, CAPA_VERIFY_DAYS]);
  await audit(tx, 'system', actor, 'quality.capa_finished', 'capa_action', id, b);
}

/* ================= Khiếu nại và khảo sát ================= */

export async function createComplaint(tx: Tx, actor: Actor | null, b: {
  channel: string; complainant?: string | null; phone?: string | null; incidentId?: string | null; category: string; content: string; urgent: boolean;
}) {
  const c = await one(tx, `INSERT INTO complaints(code, channel, complainant, phone, incident_id, category, content, urgent, due_at, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(hours => $9), $10) RETURNING *`,
  [await code(tx, 'KN', 'complaint'), b.channel, b.complainant ?? null, b.phone ?? null, b.incidentId ?? null, b.category, b.content, b.urgent,
    b.urgent ? 24 : 48, actor?.id ?? null]);
  await audit(tx, 'system', actor ?? { id: null, name: 'Khảo sát' }, 'quality.complaint_received', 'complaint', c.id, { code: c.code, category: b.category, urgent: b.urgent });
  return c;
}

export async function updateComplaint(tx: Tx, actor: Actor, id: string, b: { assignedTo?: string | null; response?: string; close?: boolean; satisfied?: boolean | null }) {
  const c = await one(tx, 'SELECT * FROM complaints WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw new HttpError(404, 'Không tìm thấy khiếu nại');
  if (c.status === 'dong') throw new HttpError(409, 'Khiếu nại đã đóng');
  if (b.close && !(b.response ?? c.response)) throw new HttpError(409, 'Phản hồi người khiếu nại trước khi đóng');
  const r = await one(tx, `UPDATE complaints SET
                             assigned_to = CASE WHEN $6 THEN $2 ELSE assigned_to END,
                             response = coalesce($3, response),
                             responded_at = CASE WHEN $3::text IS NOT NULL AND responded_at IS NULL THEN now() ELSE responded_at END,
                             responded_by = CASE WHEN $3::text IS NOT NULL THEN $7 ELSE responded_by END,
                             status = CASE WHEN $4 THEN 'dong' WHEN $3::text IS NOT NULL THEN 'da_phan_hoi' WHEN status = 'moi' THEN 'dang_xu_ly' ELSE status END,
                             satisfied = coalesce($5, satisfied)
                           WHERE id = $1 RETURNING *`,
  [id, b.assignedTo ?? null, b.response ?? null, !!b.close, b.satisfied ?? null, 'assignedTo' in b, actor.id]);
  await audit(tx, 'system', actor, 'quality.complaint_updated', 'complaint', id, { code: c.code, ...b, response: b.response ? '(đã ghi)' : undefined });
  return r;
}

/**
 * Khi đóng ca: tạo khảo sát hài lòng và xếp tin nhắn gửi tới số gọi lại. Không gửi cho ca tử vong tại chỗ,
 * ca hủy, hoặc khi không có số gọi lại.
 */
export async function queueSurvey(tx: Tx, incidentId: string) {
  const inc = await one(tx, `SELECT i.code, coalesce(i.callback_phone, i.caller_phone) AS phone,
                                    EXISTS (SELECT 1 FROM transfers t WHERE t.incident_id = i.id AND t.epcr->'disposition'->>'type' = 'dead_on_scene') AS died
                               FROM incidents i WHERE i.id = $1`, [incidentId]);
  if (!inc?.phone || inc.died) return null;
  const token = randomBytes(12).toString('base64url');
  const s = await one(tx, `INSERT INTO surveys(incident_id, token, phone) VALUES ($1,$2,$3) ON CONFLICT (incident_id) DO NOTHING RETURNING id`, [incidentId, token, inc.phone]);
  if (!s) return null;
  const base = config.webOrigins[0]?.replace(/\/$/, '') ?? '';
  await tx.query(`INSERT INTO message_outbox(to_phone, body, purpose, ref_id) VALUES ($1, $2, 'khao_sat', $3)`,
    [inc.phone, `Medone cam on quy khach. Xin danh gia chat luong phuc vu ca ${inc.code}: ${base}/khao-sat/${token}`, s.id]);
  return token;
}

/** Người bệnh/người nhà trả lời khảo sát (không cần đăng nhập, mã riêng, chỉ trả lời một lần). Điểm thấp tự thành khiếu nại */
export async function answerSurvey(tx: Tx, token: string, b: { overall: number; timeliness?: number | null; attitude?: number | null; care?: number | null; comment?: string | null }) {
  const s = await one(tx, 'SELECT * FROM surveys WHERE token = $1 FOR UPDATE', [token]);
  if (!s) throw new HttpError(404, 'Đường dẫn khảo sát không đúng');
  if (s.answered_at) throw new HttpError(409, 'Khảo sát này đã được trả lời. Cảm ơn quý khách.');
  if (Date.now() - new Date(s.created_at).getTime() > 30 * 86400_000) throw new HttpError(410, 'Khảo sát đã hết hạn');
  await tx.query(`UPDATE surveys SET answered_at = now(), overall = $2, timeliness = $3, attitude = $4, care = $5, comment = $6 WHERE id = $1`,
    [s.id, b.overall, b.timeliness ?? null, b.attitude ?? null, b.care ?? null, b.comment ?? null]);
  const low = Math.min(b.overall, b.timeliness ?? 5, b.attitude ?? 5, b.care ?? 5) <= 2;
  if (low) {
    await createComplaint(tx, null, {
      channel: 'khao_sat', phone: s.phone, incidentId: s.incident_id, category: (b.attitude ?? 5) <= 2 ? 'thai_do' : (b.timeliness ?? 5) <= 2 ? 'thoi_gian' : 'khac',
      content: `Khảo sát điểm thấp (chung ${b.overall}/5). ${b.comment ?? ''}`.trim(), urgent: false,
    });
  }
  return { low };
}
