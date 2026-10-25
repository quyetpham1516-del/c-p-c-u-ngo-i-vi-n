import { randomUUID, X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { freshApp, login } from './helpers.js';

let app: FastifyInstance; let pool: pg.Pool;
let crew: Awaited<ReturnType<typeof login>>;
let tid = ''; let incId = ''; let patientId = '';
const at = () => new Date().toISOString();
const epcr = (complaint = 'Đau ngực') => ({
  chiefComplaint: complaint, vitals: [{ at: at(), hr: 98, sbp: 140, spo2: 95 }], interventions: [{ at: at(), name: 'Thở oxy' }],
  diagnosis: { text: 'Hội chứng vành cấp', icd10: 'I24.9' }, payer: 'THU_PHI',
  disposition: { type: 'transported', hospital: 'Bệnh viện Chợ Rẫy', receiverName: 'BS Nhận', handoverAt: at(), distanceKm: 6 },
});
async function signedTransfer() {
  const id = randomUUID();
  expect((await crew('PUT', `/api/transfers/${id}`, { incidentId: incId, vehicleId: 'MD-ALS-01', patientId, baseVersion: 0, epcr: epcr() })).http).toBe(200);
  const sr = await crew('POST', `/api/transfers/${id}/sign`); if (sr.http !== 200) console.log('SIGN', JSON.stringify(sr));
  expect(sr.http).toBe(200);
  return id;
}

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  // Tên có dấu phẩy, dấu tiếng Việt: chứng thư vẫn đúng
  await pool.query(`UPDATE users SET full_name = 'Trần Thị Bích, BS' WHERE username = 'bs.als'`);
  crew = await login(app, 'bs.als');
  expect((await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Bác sĩ' })).http).toBe(200);
  incId = (await (await login(app, 'dpv06'))('POST', '/api/incidents', { source: '1800', callerPhone: '0900000009' })).id;
  patientId = (await crew('POST', '/api/patients', { idType: 'CCCD', idNumber: '079300009876', fullName: 'Lê Văn Cường', birthYear: 1960, sex: 'M' })).id;
  tid = await signedTransfer();
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('chữ ký số nội bộ', () => {
  it('ký phiếu: cấp chứng thư cho người ký từ CA Medone, phiếu mang chữ ký số hợp lệ', async () => {
    const t = await crew('GET', `/api/transfers/${tid}`);
    expect(t.digitalSignature).toMatchObject({ valid: true, problems: [], signerName: 'Trần Thị Bích, BS', provider: 'noi_bo', alg: 'ES256', purpose: 'ky_phieu' });
    const ca = await app.inject({ method: 'GET', url: '/api/pki/ca.pem' });
    expect(ca.statusCode).toBe(200);
    const caCert = new X509Certificate(ca.body);
    expect(caCert.ca).toBe(true);
    const uc = (await pool.query(`SELECT cert_pem FROM user_certs c JOIN users u ON u.id = c.user_id WHERE u.username = 'bs.als'`)).rows[0];
    const userCert = new X509Certificate(uc.cert_pem);
    expect(userCert.checkIssued(caCert)).toBe(true);
    expect(userCert.verify(caCert.publicKey)).toBe(true);
    expect(userCert.ca).toBe(false);
    expect(userCert.subject).toContain('Trần Thị Bích');
    expect(userCert.subject).toContain('UID=bs.als');
  });

  it('trang tra cứu công khai: chữ ký hợp lệ, khối chữ ký số chỉ hiện tên viết tắt người ký', async () => {
    const code = (await pool.query('SELECT verify_code FROM transfers WHERE id = $1', [tid])).rows[0].verify_code;
    const r = (await app.inject({ method: 'GET', url: `/api/public/verify/${code}` })).json();
    expect(r.digitalSignature).toMatchObject({ valid: true, signer: 'T.T.B.B.' });
    expect(JSON.stringify(r.digitalSignature)).not.toContain('Trần Thị Bích');
  });

  it('sửa thẳng nội dung trong cơ sở dữ liệu: chữ ký báo không còn khớp', async () => {
    await pool.query(`UPDATE transfers SET content_hash = 'a' || substr(content_hash, 2) WHERE id = $1`, [tid]);
    const t = await crew('GET', `/api/transfers/${tid}`);
    expect(t.digitalSignature.valid).toBe(false);
    expect(t.digitalSignature.problems).toContain('Nội dung phiếu đã thay đổi sau khi ký');
  });

  it('sửa chữ ký hoặc chuỗi đã ký: báo chữ ký không khớp chứng thư', async () => {
    const id = await signedTransfer();
    await pool.query(`UPDATE document_signatures SET payload = payload || 'x' WHERE doc_id = $1`, [id]);
    const t = await crew('GET', `/api/transfers/${id}`);
    expect(t.digitalSignature.problems).toContain('Chữ ký không khớp chứng thư');
  });

  it('bổ sung sau khi ký: người bổ sung ký số bản mới, bản mới hợp lệ', async () => {
    const id = await signedTransfer();
    expect((await crew('POST', `/api/transfers/${id}/amend`, { reason: 'Bổ sung giờ bàn giao', epcr: epcr('Đau ngực trái') })).http).toBe(200);
    const t = await crew('GET', `/api/transfers/${id}`);
    expect(t.digitalSignature).toMatchObject({ valid: true, purpose: 'bo_sung', version: t.version });
    const n = await pool.query('SELECT count(*)::int AS n FROM document_signatures WHERE doc_id = $1', [id]);
    expect(n.rows[0].n).toBe(2);
  });

  it('thu hồi chứng thư: phiếu đã ký trước vẫn hợp lệ, lần ký sau cấp chứng thư mới; chỉ quản trị thu hồi', async () => {
    const id = await signedTransfer();
    const cert = (await pool.query(`SELECT c.id FROM user_certs c JOIN users u ON u.id = c.user_id WHERE u.username = 'bs.als' AND revoked_at IS NULL`)).rows[0];
    expect((await (await login(app, 'truongca'))('POST', `/api/pki/certs/${cert.id}/revoke`, { reason: 'Thử' })).http).toBe(403);
    const admin = await login(app, 'admin');
    expect((await admin('POST', `/api/pki/certs/${cert.id}/revoke`, { reason: 'Mất máy tính bảng' })).http).toBe(200);
    const t = await crew('GET', `/api/transfers/${id}`);
    expect(t.digitalSignature).toMatchObject({ valid: true, revokedLater: true });
    const id2 = await signedTransfer();
    const t2 = await crew('GET', `/api/transfers/${id2}`);
    expect(t2.digitalSignature.valid).toBe(true);
    expect(t2.digitalSignature.certSerial).not.toBe(t.digitalSignature.certSerial);
    const list = await admin('GET', '/api/pki');
    expect(list.ca.subject).toContain('CA nội bộ');
    expect(list.certs.filter((c: any) => c.username === 'bs.als')).toHaveLength(2);
    const acts = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'pki.cert_revoked'`);
    expect(acts.rows[0].n).toBe(1);
  });
});
