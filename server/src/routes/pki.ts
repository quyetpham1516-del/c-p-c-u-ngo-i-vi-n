import type { FastifyInstance } from 'fastify';
import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, withTx } from '../db.js';
import { HttpError } from '../domain.js';
import { actorOf, guard, type Ctx } from '../http.js';
import { getCa, SIGNING_PROVIDERS } from '../pki.js';

const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
const certInfo = (pem: string) => {
  const c = new X509Certificate(pem);
  return { subject: c.subject.replace(/\n/g, ', '), issuer: c.issuer.replace(/\n/g, ', '), fingerprint256: c.fingerprint256 };
};

export function registerPki(app: FastifyInstance, { pool }: Ctx) {
  /** Chứng thư CA gốc: công khai để bệnh viện, cơ quan đối chiếu nhập vào phần mềm ký số của họ */
  app.get('/api/pki/ca.pem', async (_req, reply) => {
    const ca = await getCa(pool);
    return reply.header('content-type', 'application/x-pem-file')
      .header('content-disposition', 'attachment; filename="medone-ca-noi-bo.pem"').send(ca.cert_pem);
  });

  app.get('/api/pki', { preHandler: guard('admin', 'supervisor', 'qa', 'director') }, async () => {
    const ca = await getCa(pool);
    const certs = await many(pool, `
      SELECT c.id, c.provider, c.serial, c.not_before, c.not_after, c.revoked_at, c.revoke_reason, u.full_name, u.username, u.role,
             (SELECT count(*)::int FROM document_signatures d WHERE d.cert_id = c.id) AS signatures
        FROM user_certs c JOIN users u ON u.id = c.user_id ORDER BY c.revoked_at NULLS FIRST, u.full_name`);
    return {
      ca: { ...certInfo(ca.cert_pem), notAfter: ca.not_after, createdAt: ca.created_at },
      provider: process.env.MEDONE_SIGN_PROVIDER?.trim() || 'noi_bo',
      providers: Object.values(SIGNING_PROVIDERS).map((p) => ({ id: p.id, label: p.label })),
      certs,
    };
  });

  /** Thu hồi chứng thư (nghỉ việc, lộ mật khẩu, mất máy): chữ ký đã ký trước lúc thu hồi vẫn hợp lệ, lần ký sau cấp chứng thư mới */
  app.post('/api/pki/certs/:id/revoke', { preHandler: guard('admin') }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
    await withTx(pool, async (tx) => {
      const c = await one(tx, 'UPDATE user_certs SET revoked_at = now(), revoke_reason = $2, revoked_by = $3 WHERE id = $1 AND revoked_at IS NULL RETURNING serial, user_id',
        [id, b.reason, req.user.id]);
      if (!c) throw new HttpError(404, 'Không có chứng thư còn hiệu lực này');
      await audit(tx, 'system', actorOf(req), 'pki.cert_revoked', 'user_cert', id, { serial: c.serial, userId: c.user_id, reason: b.reason });
    });
    return { ok: true };
  });

  app.get('/api/pki/me', { preHandler: guard() }, async (req) => {
    const c = await one(pool, `SELECT id, serial, not_before, not_after, cert_pem FROM user_certs WHERE user_id = $1 AND provider = 'noi_bo' AND revoked_at IS NULL`, [req.user.id]);
    return c ? { ...c, ...certInfo(c.cert_pem) } : null;
  });
}
