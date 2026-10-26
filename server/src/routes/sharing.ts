import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError, incidentScope, incidentSummary } from '../domain.js';
import { actorOf, DISPATCH_ROLES, EOC_ROLES, guard, type Ctx } from '../http.js';
import { findShare, newShareToken, SHARE_HOURS, SHARE_KIND, SHARE_PATH, shareHash, shareView, smsBody, type ShareKind } from '../sharing.js';

const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
const tokenParam = (p: unknown) => z.object({ token: z.string().regex(/^[\w-]{20,40}$/) }).parse(p).token;
const phone = z.string().trim().transform((s) => s.replace(/[\s.-]/g, '')).pipe(z.string().regex(/^(0|\+84)\d{9,10}$/, 'Số điện thoại không hợp lệ'));

/** Trang công khai: mỗi địa chỉ IP tối đa 60 lượt mỗi phút (trang tự làm mới 20 giây một lần) */
const PUBLIC_LIMIT = 60;
const hits = new Map<string, { n: number; until: number }>();
function limited(ip: string) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.until < now) { hits.set(ip, { n: 1, until: now + 60_000 }); return false; }
  h.n++;
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  return h.n > PUBLIC_LIMIT;
}

export function registerSharing(app: FastifyInstance, { pool, hub }: Ctx) {
  const pushIncident = async (id: string) => hub.publish({ type: 'incident', id, incident: await incidentSummary(pool, id) });

  /** Tạo đường dẫn; đường dẫn đầy đủ chỉ trả về một lần. Gửi kèm tin nhắn nếu có số điện thoại. */
  app.post('/api/incidents/:id/share', { preHandler: guard(...EOC_ROLES) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({
      kind: z.enum(Object.keys(SHARE_KIND) as [ShareKind, ...ShareKind[]]),
      baseUrl: z.string().url().max(200).refine((u) => /^https?:\/\//.test(u), 'Địa chỉ phải bắt đầu bằng http:// hoặc https://'),
      phone: phone.nullish(),
      hospital: z.string().trim().min(2).max(200).nullish(),
      department: z.string().trim().max(200).nullish(),
    }).parse(req.body);
    if (b.kind === 'benh_vien' && !DISPATCH_ROLES.includes(req.user.role)) throw new HttpError(403, 'Chỉ điều phối viên gửi báo trước cho bệnh viện');
    const token = newShareToken();
    const out = await withTx(pool, async (tx) => {
      const inc = await one(tx, `SELECT id, code, status, caller_phone, callback_phone, destination, destination_department FROM incidents WHERE id = $1`, [id]);
      if (!inc) throw new HttpError(404, 'Không tìm thấy ca');
      if (['closed', 'cancelled', 'transferred_115', 'advice_only'].includes(inc.status)) throw new HttpError(409, 'Ca đã kết thúc');
      const hospital = b.kind === 'benh_vien' ? (b.hospital ?? inc.destination) : null;
      if (b.kind === 'benh_vien' && !hospital) throw new HttpError(422, 'Chọn bệnh viện nhận (báo trước bệnh viện) trước khi gửi đường dẫn');
      // Gửi thông tin cho bệnh viện khi xe đã rời hiện trường (S6, S7); ca P1 được báo sớm để bệnh viện chuẩn bị
      if (b.kind === 'benh_vien') {
        const ok = await one(tx, `SELECT 1 FROM incidents i WHERE i.id = $1 AND (i.final_priority = 'P1' OR EXISTS (
                                    SELECT 1 FROM assignments a JOIN vehicles v ON v.id = a.vehicle_id
                                     WHERE a.incident_id = i.id AND a.ended_at IS NULL AND v.status IN ('S6', 'S7')))`, [id]);
        if (!ok) throw new HttpError(409, 'Gửi báo trước cho bệnh viện khi xe đã rời hiện trường (ca P1 được gửi sớm)');
      }
      const department = b.kind === 'benh_vien' ? (b.department ?? inc.destination_department ?? null) : null;
      const link = await one(tx, `INSERT INTO share_links(kind, incident_id, token_hash, hospital, department, phone, expires_at, created_by)
                                  VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7), $8) RETURNING id, expires_at`,
        [b.kind, id, shareHash(token), hospital, department, b.phone ?? null, SHARE_HOURS[b.kind], req.user.id]);
      const url = `${b.baseUrl.replace(/\/$/, '')}${SHARE_PATH[b.kind]}?m=${token}`;
      if (b.phone) {
        await tx.query(`INSERT INTO message_outbox(to_phone, body, purpose, ref_id) VALUES ($1, $2, $3, $4)`,
          [b.phone, smsBody(b.kind, inc.code, url, hospital), b.kind === 'benh_vien' ? 'bao_truoc_bv' : 'theo_doi_xe', link.id]);
      }
      await audit(tx, incidentScope(id), actorOf(req), 'share.created', 'incident', id, { kind: b.kind, hospital, phone: b.phone ?? null, linkId: link.id });
      return { id: link.id, kind: b.kind, url, expiresAt: link.expires_at, queuedSms: !!b.phone };
    });
    await pushIncident(id);
    return out;
  });

  app.get('/api/incidents/:id/shares', { preHandler: guard(...EOC_ROLES) }, async (req) => many(pool, `
    SELECT s.id, s.kind, s.hospital, s.department, s.phone, s.expires_at, s.revoked_at, s.created_at, s.views, s.last_viewed_at,
           s.response, s.response_by, s.response_note, s.responded_at, u.full_name AS created_by_name,
           (s.revoked_at IS NULL AND s.expires_at > now()) AS active,
           (SELECT m.status FROM message_outbox m WHERE m.ref_id = s.id::text ORDER BY m.id DESC LIMIT 1) AS sms_status
      FROM share_links s JOIN users u ON u.id = s.created_by WHERE s.incident_id = $1 ORDER BY s.created_at DESC`, [idParam(req.params)]));

  app.post('/api/shares/:id/revoke', { preHandler: guard(...EOC_ROLES) }, async (req) => {
    const id = idParam(req.params);
    const r = await withTx(pool, async (tx) => {
      const s = await one(tx, 'UPDATE share_links SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING incident_id, kind', [id]);
      if (!s) throw new HttpError(404, 'Không tìm thấy đường dẫn hoặc đã thu hồi');
      await audit(tx, incidentScope(s.incident_id), actorOf(req), 'share.revoked', 'incident', s.incident_id, { linkId: id, kind: s.kind });
      return s;
    });
    await pushIncident(r.incident_id);
    return { ok: true };
  });

  /* ---------- Công khai ---------- */

  app.get('/api/public/share/:token', async (req, reply) => {
    const token = tokenParam(req.params);
    if (limited(req.ip)) return reply.code(429).send({ error: 'Mở trang quá nhiều lần, thử lại sau một phút' });
    const link = await findShare(pool, token);
    if (!link) return reply.code(404).send({ error: 'Đường dẫn không đúng, đã hết hạn hoặc đã bị thu hồi' });
    await pool.query('UPDATE share_links SET views = views + 1, last_viewed_at = now() WHERE id = $1', [link.id]);
    return shareView(pool, link);
  });

  /** Bệnh viện nhận xác nhận sẵn sàng tiếp nhận hoặc báo không nhận được (điều phối thấy ngay) */
  app.post('/api/public/share/:token/respond', async (req, reply) => {
    const token = tokenParam(req.params);
    if (limited(req.ip)) return reply.code(429).send({ error: 'Thao tác quá nhiều lần, thử lại sau một phút' });
    const b = z.object({
      response: z.enum(['san_sang', 'khong_nhan']),
      name: z.string().trim().min(2).max(120),
      note: z.string().trim().max(500).nullish(),
    }).refine((x) => x.response === 'san_sang' || (x.note ?? '').length >= 3, { message: 'Ghi lý do không nhận được', path: ['note'] }).parse(req.body);
    const link = await findShare(pool, token);
    if (!link || link.kind !== 'benh_vien') return reply.code(404).send({ error: 'Đường dẫn không đúng, đã hết hạn hoặc đã bị thu hồi' });
    await withTx(pool, async (tx) => {
      await tx.query(`UPDATE share_links SET response = $2, response_by = $3, response_note = $4, responded_at = now() WHERE id = $1`,
        [link.id, b.response, b.name, b.note ?? null]);
      await audit(tx, incidentScope(link.incident_id), { id: null, name: `${b.name} (${link.hospital})` },
        b.response === 'san_sang' ? 'hospital.prealert_ready' : 'hospital.prealert_declined', 'incident', link.incident_id,
        { hospital: link.hospital, note: b.note ?? null, linkId: link.id });
    });
    await Promise.all([pushIncident(link.incident_id), hub.publish({ type: 'hospital_response', id: link.incident_id, response: b.response, hospital: link.hospital })]);
    return shareView(pool, { ...link, response: b.response, response_by: b.name, response_note: b.note ?? null, responded_at: new Date() });
  });
}
