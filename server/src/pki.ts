import 'reflect-metadata';
import { createPrivateKey, randomBytes, sign as nodeSign, verify as nodeVerify, webcrypto, X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { decryptId, encryptId } from './crypto.js';
import { one, type Queryable } from './db.js';
import { HttpError } from './domain.js';

/**
 * Chữ ký số nội bộ (giai đoạn 1): Medone tự làm CA gốc, cấp chứng thư ECDSA P-256 cho từng người ký.
 * Phiếu ký xong mang chữ ký số kiểm tra được bằng chứng thư CA Medone; sửa nội dung một chữ là chữ ký hỏng.
 * Giá trị pháp lý: dùng trong nội bộ và với bên đã thỏa thuận chấp nhận. Giai đoạn 2 cắm CA công cộng
 * (MobiFone CA SIM PKI, VNPT SmartCA, Viettel MySign) vào SIGNING_PROVIDERS, phần còn lại không đổi.
 */
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const CA_YEARS = 10;
const USER_YEARS = 1;
export const ORG = () => process.env.MEDONE_ORG_NAME?.trim() || 'Medone';

/** Tên phân biệt dạng cấu trúc (theo OID) để tên có dấu phẩy, dấu tiếng Việt không làm sai chứng thư */
const OID = { CN: '2.5.4.3', UID: '0.9.2342.19200300.100.1.1', T: '2.5.4.12', O: '2.5.4.10', C: '2.5.4.6' } as const;
const dn = (parts: [keyof typeof OID, string | null | undefined][]): x509.JsonName =>
  parts.filter(([, v]) => v && v.trim()).map(([k, v]) => ({ [OID[k]]: [v!.trim()] }));
const serial = () => {
  const b = randomBytes(16);
  b[0] &= 0x7f; // số dương
  return b.toString('hex');
};
const addYears = (d: Date, y: number) => { const x = new Date(d); x.setFullYear(x.getFullYear() + y); return x; };

async function exportKey(k: CryptoKey) {
  return encryptId(Buffer.from(await webcrypto.subtle.exportKey('pkcs8', k)).toString('base64'));
}
const importForCa = async (enc: string) => webcrypto.subtle.importKey('pkcs8', Buffer.from(decryptId(enc), 'base64'), ALG, false, ['sign']);
const nodeKey = (enc: string) => createPrivateKey({ key: Buffer.from(decryptId(enc), 'base64'), format: 'der', type: 'pkcs8' });

/** CA gốc của Medone: tạo lần đầu khi cần, khóa bí mật mã hóa bằng MEDONE_DATA_KEY */
export async function getCa(q: Queryable) {
  const ca = await one(q, 'SELECT * FROM pki_ca WHERE id = 1');
  if (ca) return ca;
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']) as CryptoKeyPair;
  const now = new Date();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(), name: dn([['CN', `${ORG()} CA nội bộ`], ['O', ORG()], ['C', 'VN']]), notBefore: now, notAfter: addYears(now, CA_YEARS), signingAlgorithm: ALG, keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  // Hai tiến trình cùng tạo: giữ bản đến trước
  await q.query(`INSERT INTO pki_ca(id, subject, cert_pem, key_enc, not_after) VALUES (1,$1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
    [cert.subject, cert.toString('pem'), await exportKey(keys.privateKey), cert.notAfter]);
  return one(q, 'SELECT * FROM pki_ca WHERE id = 1');
}

/** Chứng thư còn hiệu lực của người ký; chưa có hoặc sắp hết hạn (dưới 7 ngày) thì CA nội bộ cấp mới */
export async function userCert(q: Queryable, userId: string) {
  const c = await one(q, `SELECT * FROM user_certs WHERE user_id = $1 AND provider = 'noi_bo' AND revoked_at IS NULL`, [userId]);
  if (c && new Date(c.not_after).getTime() - Date.now() > 7 * 86400_000) return c;
  const u = await one(q, 'SELECT id, username, full_name, title FROM users WHERE id = $1', [userId]);
  if (!u) throw new HttpError(404, 'Không tìm thấy người ký');
  const ca = await getCa(q);
  const caCert = new x509.X509Certificate(ca.cert_pem);
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']) as CryptoKeyPair;
  const now = new Date();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(), subject: dn([['CN', u.full_name], ['UID', u.username], ['T', u.title], ['O', ORG()], ['C', 'VN']]), issuer: caCert.subject, notBefore: now, notAfter: addYears(now, USER_YEARS),
    signingAlgorithm: ALG, publicKey: keys.publicKey, signingKey: (await importForCa(ca.key_enc)) as unknown as CryptoKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.nonRepudiation, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
    ],
  });
  if (c) await q.query(`UPDATE user_certs SET revoked_at = now(), revoke_reason = 'Thay chứng thư sắp hết hạn' WHERE id = $1`, [c.id]);
  return one(q, `INSERT INTO user_certs(user_id, provider, serial, subject, cert_pem, key_enc, not_before, not_after)
                 VALUES ($1,'noi_bo',$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, cert.serialNumber, cert.subject, cert.toString('pem'), await exportKey(keys.privateKey), cert.notBefore, cert.notAfter]);
}

/** Nhà cung cấp chữ ký số. Giai đoạn 2 thêm MobiFone CA / VNPT SmartCA / Viettel MySign với cùng giao diện sign() */
export interface SigningProvider {
  id: string; label: string;
  sign(q: Queryable, userId: string, payload: string): Promise<{ certId: string; alg: string; signature: string }>;
}
const internalProvider: SigningProvider = {
  id: 'noi_bo', label: 'CA nội bộ Medone',
  async sign(q, userId, payload) {
    const c = await userCert(q, userId);
    const sig = nodeSign('sha256', Buffer.from(payload), { key: nodeKey(c.key_enc), dsaEncoding: 'der' });
    return { certId: c.id, alg: 'ES256', signature: sig.toString('base64') };
  },
};
export const SIGNING_PROVIDERS: Record<string, SigningProvider> = { noi_bo: internalProvider };

/** Chuỗi được ký: loại phiếu, mã, phiên bản, mã băm nội dung (đổi nội dung là đổi mã băm, chữ ký cũ không còn khớp) */
export const signingPayload = (docType: string, docId: string, version: number, contentHash: string) =>
  `medone:${docType}:${docId}:v${version}:sha256:${contentHash}`;

export async function signDocument(q: Queryable, userId: string, doc: { type: string; id: string; version: number; contentHash: string; purpose: 'ky_phieu' | 'bo_sung' | 'lap_phieu' | 'duyet' | 'xuat_kho' | 'nhan_hang' }) {
  const p = SIGNING_PROVIDERS[process.env.MEDONE_SIGN_PROVIDER?.trim() || 'noi_bo'] ?? internalProvider;
  const payload = signingPayload(doc.type, doc.id, doc.version, doc.contentHash);
  const s = await p.sign(q, userId, payload);
  return one(q, `INSERT INTO document_signatures(doc_type, doc_id, doc_version, purpose, user_id, cert_id, provider, alg, payload, signature)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, signed_at`,
    [doc.type, doc.id, doc.version, doc.purpose, userId, s.certId, p.id, s.alg, payload, s.signature]);
}

/**
 * Kiểm tra chữ ký số mới nhất của phiếu: chữ ký đúng với chứng thư, chứng thư do CA Medone cấp, còn hạn lúc ký,
 * chưa bị thu hồi trước lúc ký, và chuỗi đã ký khớp mã băm nội dung hiện tại của phiếu.
 */
export async function verifyDocument(q: Queryable, docType: string, docId: string, currentHash: string | null, currentVersion: number) {
  const s = await one(q, `
    SELECT ds.*, c.cert_pem, c.serial, c.revoked_at, c.revoke_reason, c.not_before, c.not_after, c.provider AS cert_provider, u.full_name
      FROM document_signatures ds JOIN user_certs c ON c.id = ds.cert_id JOIN users u ON u.id = ds.user_id
     WHERE ds.doc_type = $1 AND ds.doc_id = $2 ORDER BY ds.signed_at DESC, ds.id DESC LIMIT 1`, [docType, docId]);
  if (!s) return null;
  const problems: string[] = [];
  const cert = new X509Certificate(s.cert_pem);
  const ca = await one(q, 'SELECT cert_pem FROM pki_ca WHERE id = 1');
  if (!ca || !cert.verify(new X509Certificate(ca.cert_pem).publicKey)) problems.push('Chứng thư không do CA Medone cấp');
  const ok = nodeVerify('sha256', Buffer.from(s.payload), { key: cert.publicKey, dsaEncoding: 'der' }, Buffer.from(s.signature, 'base64'));
  if (!ok) problems.push('Chữ ký không khớp chứng thư');
  const at = new Date(s.signed_at).getTime();
  if (at < new Date(s.not_before).getTime() || at > new Date(s.not_after).getTime()) problems.push('Chứng thư hết hạn tại thời điểm ký');
  if (s.revoked_at && new Date(s.revoked_at).getTime() <= at) problems.push(`Chứng thư đã bị thu hồi trước khi ký (${s.revoke_reason ?? ''})`);
  if (currentHash && s.payload !== signingPayload(docType, docId, currentVersion, currentHash)) problems.push('Nội dung phiếu đã thay đổi sau khi ký');
  return {
    valid: problems.length === 0, problems, signedAt: s.signed_at, signerName: s.full_name, purpose: s.purpose, version: s.doc_version,
    certSerial: s.serial, provider: s.provider, issuer: cert.issuer.replace(/\n/g, ', '), alg: s.alg,
    revokedLater: !!s.revoked_at && new Date(s.revoked_at).getTime() > at,
  };
}
