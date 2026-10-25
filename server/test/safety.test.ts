import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { EpcrSchema, missingForSign } from '../src/epcr.js';
import { contentHash, initials, newVerifyCode, normalizeCode, signatureHash } from '../src/safety.js';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let crew: Client, crew2: Client, dpv: Client, sup: Client, ketoan: Client;
const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [crew, crew2, dpv, sup, ketoan] = await Promise.all(['bs.als', 'ys.bls', 'dpv06', 'truongca', 'ketoan'].map((u) => login(app, u)));
  expect((await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Bác sĩ' })).http).toBe(200);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('báo khẩn của kíp', () => {
  let id = '';

  it('kíp bấm báo khẩn: ghi vị trí, xe, vết GPS và hàng gửi; bấm lại chỉ cập nhật vị trí', async () => {
    const r = await crew('POST', '/api/crew/sos', { lat: 10.776, lng: 106.700, accuracy: 12, note: 'Bị đe dọa tại hiện trường' });
    expect(r.http).toBe(200);
    expect(r.code).toMatch(/^BK-\d{4}-0001$/);
    expect(r.vehicle_id).toBe('MD-ALS-01');
    id = r.id;
    const again = await crew('POST', '/api/crew/sos', { lat: 10.777, lng: 106.701, accuracy: 8 });
    expect(again.id).toBe(id);
    expect(again.lat).toBeCloseTo(10.777);
    expect((await one('SELECT count(*)::int AS n FROM crew_sos')).n).toBe(1);
    expect((await one(`SELECT count(*)::int AS n FROM outbox WHERE topic = 'crew_sos'`)).n).toBe(1);
    expect((await one(`SELECT count(*)::int AS n FROM ops_gps_track WHERE vehicle_id = 'MD-ALS-01'`)).n).toBe(2);
    // Không có vị trí (máy tắt GPS) vẫn báo được
    expect((await crew('POST', '/api/crew/sos', {})).http).toBe(200);
  });

  it('EOC thấy báo khẩn đang mở; kế toán không thấy; phải xác nhận trước khi kết thúc', async () => {
    const list = await dpv('GET', '/api/sos');
    expect(list.data.map((s: any) => s.id)).toContain(id);
    expect(list.data[0].user_name).toBeTruthy();
    expect((await ketoan('GET', '/api/sos')).http).toBe(403);
    expect((await sup('POST', `/api/sos/${id}/resolve`, { resolution: 'Đã an toàn' })).error).toMatch(/Xác nhận/);
    const ack = await dpv('POST', `/api/sos/${id}/ack`, { note: 'Đã gọi 113, điều MD-BLS-01 hỗ trợ' });
    expect(ack.acked_at).toBeTruthy();
    expect((await crew('GET', '/api/crew/sos')).ack_note).toMatch(/113/);
  });

  it('kíp khác không hủy được; trưởng ca kết thúc; sau đó kíp bấm lại là báo khẩn mới', async () => {
    expect((await crew2('POST', `/api/crew/sos/${id}/cancel`, { reason: 'Không phải tôi' })).http).toBe(403);
    const r = await sup('POST', `/api/sos/${id}/resolve`, { resolution: 'Công an đã tới, kíp an toàn, tiếp tục vận chuyển' });
    expect(r.resolved_at).toBeTruthy();
    expect((await dpv('GET', '/api/sos')).data).toHaveLength(0);
    const fresh = await crew('POST', '/api/crew/sos', { lat: 10.7, lng: 106.6 });
    expect(fresh.id).not.toBe(id);
    expect(fresh.code).toMatch(/0002$/);
    // Người bấm hủy khi bấm nhầm: ghi là báo nhầm
    const c = await crew('POST', `/api/crew/sos/${fresh.id}/cancel`, { reason: 'Bấm nhầm' });
    expect(c.false_alarm).toBe(true);
    expect(c.resolution).toMatch(/Bấm nhầm/);
    const audit = await one(`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'safety.sos_%'`);
    expect(audit.n).toBeGreaterThanOrEqual(5);
  });

  it('không phải kíp thì không bấm báo khẩn', async () => {
    expect((await dpv('POST', '/api/crew/sos', {})).http).toBe(403);
  });
});

describe('chữ ký điện tử trên phiếu', () => {
  const base = { chiefComplaint: 'Đau ngực', vitals: [{ at: new Date().toISOString(), hr: 90 }], diagnosis: { text: 'Đau ngực', icd10: 'R07.4' }, payer: 'THU_PHI' };
  const sig = (kind: string, extra: Record<string, unknown> = {}) => ({
    id: randomUUID(), kind, signerName: 'Lê Văn Nhà', relation: 'Con', statement: 'Tôi đã được giải thích...', image: PNG, signedAt: new Date().toISOString(), ...extra,
  });

  it('từ chối vận chuyển: cần chữ ký trên máy hoặc đánh dấu đã ký giấy', () => {
    const refused = { ...base, disposition: { type: 'refused' } };
    expect(missingForSign(EpcrSchema.parse(refused)).join()).toMatch(/Cam kết từ chối/);
    expect(missingForSign(EpcrSchema.parse({ ...refused, signatures: [sig('tu_choi_van_chuyen')] })).join()).not.toMatch(/Cam kết từ chối/);
    expect(missingForSign(EpcrSchema.parse({ ...refused, disposition: { type: 'refused', refusalSigned: true } })).join()).not.toMatch(/Cam kết từ chối/);
  });

  it('chỉ nhận ảnh PNG, tối đa 8 chữ ký', () => {
    expect(EpcrSchema.safeParse({ ...base, signatures: [sig('dong_y_thu_thuat', { image: 'javascript:alert(1)' })] }).success).toBe(false);
    expect(EpcrSchema.safeParse({ ...base, signatures: [sig('loai_khac')] }).success).toBe(false);
    expect(EpcrSchema.safeParse({ ...base, signatures: Array.from({ length: 9 }, () => sig('dong_y_thu_thuat')) }).success).toBe(false);
  });

  it('ký phiếu: băm từng chữ ký, cấp mã xác thực; bổ sung sau ký không thêm bớt được chữ ký', async () => {
    const p = await crew('POST', '/api/patients', { idType: 'CCCD', idNumber: '079200000777', fullName: 'Nguyễn Văn An', birthYear: 1960, sex: 'M' });
    const inc = (await one(`INSERT INTO incidents(code, source, status) VALUES ('KY-1', '1800', 'on_scene') RETURNING id`)).id;
    const tid = randomUUID();
    const epcr = { ...base, disposition: { type: 'refused' }, signatures: [sig('tu_choi_van_chuyen'), sig('dong_y_thu_thuat')] };
    expect((await crew('PUT', `/api/transfers/${tid}`, { incidentId: inc, vehicleId: 'MD-ALS-01', patientId: p.id, baseVersion: 0, epcr })).http).toBe(200);
    expect((await crew('POST', `/api/transfers/${tid}/sign`)).http).toBe(200);
    const t = await one('SELECT * FROM transfers WHERE id = $1', [tid]);
    expect(t.verify_code).toMatch(/^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
    expect(t.content_hash).toBe(contentHash(t.epcr));
    for (const s of t.epcr.signatures) expect(s.hash).toBe(signatureHash(s));

    const amended = { ...t.epcr, notes: 'Bổ sung giờ', signatures: [] };
    expect((await crew('POST', `/api/transfers/${tid}/amend`, { reason: 'Bổ sung giờ bàn giao', epcr: amended })).http).toBe(200);
    const t2 = await one('SELECT * FROM transfers WHERE id = $1', [tid]);
    expect(t2.epcr.signatures).toHaveLength(2);
    expect(t2.epcr.notes).toBe('Bổ sung giờ');
    expect(t2.content_hash).not.toBe(t.content_hash);

    // Tra cứu công khai: không cần đăng nhập, chỉ tên viết tắt, không chẩn đoán
    const r = await app.inject({ method: 'GET', url: `/api/public/verify/${t.verify_code.toLowerCase().replace('-', ' ')}` });
    const v = r.json();
    expect(v.found).toBe(true);
    expect(v.patient.initials).toBe('N.V.A.');
    expect(v.patient.birthYear).toBe(1960);
    expect(v.amendments).toBe(1);
    expect(v.hashPrefix).toBe(t2.content_hash.slice(0, 12));
    expect(JSON.stringify(v)).not.toMatch(/Nguyễn|Đau ngực|R07|079200000777/);
    const miss = (await app.inject({ method: 'GET', url: '/api/public/verify/AAAAA-BBBBB' })).json();
    expect(miss.found).toBe(false);
    expect((await one('SELECT count(*)::int AS n FROM transfer_verifications')).n).toBe(2);
  });

  it('giới hạn số lần tra cứu mỗi phút', async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await app.inject({ method: 'GET', url: '/api/public/verify/ZZZZZ-ZZZZZ', remoteAddress: '10.9.9.9' })).statusCode;
    expect(last).toBe(429);
  });
});

describe('mã xác thực', () => {
  it('sinh mã không có ký tự dễ nhầm, chuẩn hóa khi nhập tay', () => {
    const codes = new Set(Array.from({ length: 200 }, newVerifyCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).not.toMatch(/[01ILO]/);
    expect(normalizeCode('abcde fghjk')).toBe('ABCDE-FGHJK');
    expect(initials('Trần thị  Bé')).toBe('T.T.B.');
    expect(initials(null)).toBeNull();
  });
});
