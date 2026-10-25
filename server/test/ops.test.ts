import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { EpcrSchema, missingForSign } from '../src/epcr.js';
import { trackDistanceKm, trackFlags, utsteinReport, type ArrestRow } from '../src/ops.js';
import { freshApp, login, token } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let qa: Client, sup: Client, dpv: Client, crew: Client, admin: Client, giamdoc: Client, kt: Client;
const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
const uid = async (username: string) => (await one('SELECT id FROM users WHERE username = $1', [username])).id as string;
const vnDate = (d = 0) => new Date(Date.now() + 7 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();

async function incident(code: string, extra: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { code, source: '1800', status: 'closed', final_priority: 'P2', suggested_priority: 'P2', ...extra };
  const cols = Object.keys(row);
  const vals = Object.values(row);
  const i = await one(`INSERT INTO incidents(${cols.join(',')}, closed_at) VALUES (${cols.map((_, k) => `$${k + 1}`).join(',')}, now()) RETURNING id`, vals);
  return i.id as string;
}

async function arrestTransfer(code: string, arrest: Record<string, unknown>, opts: { t0?: string; t7?: string } = {}) {
  const inc = await incident(code, { final_priority: 'P1', suggested_priority: 'P1' });
  if (opts.t0) await pool.query(`INSERT INTO incident_times(incident_id, code, at, source) VALUES ($1, 'T0', $2, 'test')`, [inc, opts.t0]);
  if (opts.t7) await pool.query(`INSERT INTO incident_times(incident_id, code, at, source) VALUES ($1, 'T7', $2, 'test')`, [inc, opts.t7]);
  const id = randomUUID();
  await pool.query(`INSERT INTO transfers(id, transfer_number, incident_id, vehicle_id, status, epcr, signed_at) VALUES ($1, $2, $3, 'MD-ALS-01', 'signed', $4, now())`,
    [id, `T-${code}`, inc, JSON.stringify({ patient: { age: 60, sex: 'M' }, arrest: { present: true, ...arrest }, disposition: { type: 'transported', hospital: 'BV Chợ Rẫy' } })]);
  return { transferId: id, incidentId: inc };
}

const backupDir = mkdtempSync(join(tmpdir(), 'medone-backup-'));
process.env.MEDONE_BACKUP_DIR = backupDir;

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [qa, sup, dpv, crew, admin, giamdoc, kt] = await Promise.all(['qlcl', 'truongca', 'dpv06', 'bs.als', 'admin', 'giamdoc', 'ketoan'].map((u) => login(app, u)));
});

afterAll(async () => {
  await app.close();
  await pool.end();
  for (const f of readdirSync(backupDir)) chmodSync(join(backupDir, f), 0o600);
  rmSync(backupDir, { recursive: true, force: true });
});

describe('mẫu Utstein trong ePCR', () => {
  const base = { chiefComplaint: 'Ngừng tim', vitals: [{ at: iso(0), hr: 0 }], diagnosis: { text: 'Ngừng tuần hoàn' }, disposition: { type: 'dead_on_scene' }, payer: 'MIEN' };

  it('đã ép tim hoặc sốc điện thì phải trả lời có ngừng tuần hoàn không', () => {
    const e = EpcrSchema.parse({ ...base, care: { cpr: true } });
    expect(missingForSign(e)).toContain('Có ngừng tuần hoàn không (đã ép tim hoặc sốc điện)');
  });

  it('có ngừng tuần hoàn và hồi sức: bắt buộc biến Utstein cốt lõi', () => {
    const e = EpcrSchema.parse({ ...base, care: { cpr: true }, arrest: { present: true, attempted: true } });
    const miss = missingForSign(e);
    expect(miss).toEqual(expect.arrayContaining(['Utstein: người chứng kiến', 'Utstein: nguyên nhân', 'Utstein: nhịp đầu tiên', 'Utstein: giờ kíp bắt đầu ép tim', 'Utstein: có tuần hoàn trở lại (ROSC)']));
    const full = EpcrSchema.parse({
      ...base, care: { cpr: true },
      arrest: { present: true, attempted: true, witnessed: 'kip', cause: 'tim', location: 'nha', firstRhythm: 'vf', cprStartAt: iso(30), roscAny: false, terminatedAt: iso(1) },
    });
    // Kíp chứng kiến thì không hỏi người dân ép tim
    expect(missingForSign(full).filter((m) => m.startsWith('Utstein') || m.startsWith('Có ngừng'))).toEqual([]);
  });

  it('không hồi sức thì phải có lý do', () => {
    const e = EpcrSchema.parse({ ...base, arrest: { present: true, attempted: false, witnessed: 'khong', cause: 'khong_ro', location: 'nha', bystanderCpr: 'khong' } });
    expect(missingForSign(e)).toContain('Utstein: lý do không hồi sức');
  });
});

describe('sổ và báo cáo Utstein', () => {
  let survivor = '';
  beforeAll(async () => {
    survivor = (await arrestTransfer('UT-1', {
      attempted: true, witnessed: 'nguoi_dan', cause: 'tim', location: 'noi_cong_cong', bystanderCpr: 'chi_ep_tim', publicAed: 'co_soc', firstRhythm: 'vf',
      collapseAt: iso(40), cprStartAt: iso(30), firstShockAt: iso(29), roscAny: true, roscAt: iso(20), roscOnArrival: true,
    }, { t0: iso(38), t7: iso(31) })).transferId;
    await arrestTransfer('UT-2', { attempted: true, witnessed: 'khong', cause: 'tim', location: 'nha', bystanderCpr: 'khong', firstRhythm: 'vo_tam_thu', cprStartAt: iso(25), roscAny: false, terminatedAt: iso(5) });
    await arrestTransfer('UT-3', { attempted: true, witnessed: 'kip', cause: 'ngat', location: 'nha', firstRhythm: 'pea', cprStartAt: iso(15), roscAny: true, roscOnArrival: false });
    await arrestTransfer('UT-4', { attempted: false, notAttemptedReason: 'dau_hieu_tu_vong', witnessed: 'khong', cause: 'khong_ro', location: 'nha', bystanderCpr: 'khong' });
  });

  it('sơ đồ luồng, nhóm so sánh, tỷ lệ người dân ép tim, khoảng thời gian', async () => {
    const r = await qa('GET', '/api/ops/arrests');
    expect(r.rows).toHaveLength(4);
    expect(r.report.flow).toMatchObject({ total: 4, attempted: 3, notAttempted: 1, emsWitnessed: 1, beforeEms: 2, cardiac: 2, comparator: 1 });
    expect(r.report.flow.notAttemptedReasons).toEqual({ dau_hieu_tu_vong: 1 });
    expect(r.report.bystander.cprPct).toBe(50);
    expect(r.report.bystander.publicShockPct).toBe(50);
    expect(r.report.outcomes.all).toMatchObject({ n: 3, roscAny: 2, roscOnArrival: 1, followedUp: 0 });
    expect(r.report.intervals.callToArrival).toBe(7);
    expect(r.report.intervals.collapseToCpr).toBe(10);
    expect(r.rows.find((x: any) => x.incident_code === 'UT-1').comparator).toBe(true);
    expect((await dpv('GET', '/api/ops/arrests')).http).toBe(403);
  });

  it('QLCL ghi kết cục ra viện; CPC chỉ khi sống; sống 30 ngày tính vào nhóm so sánh', async () => {
    expect((await qa('PUT', `/api/ops/arrests/${survivor}/outcome`, { admitted: true, survived30d: false, cpc: 1 })).http).toBe(400);
    expect((await qa('PUT', `/api/ops/arrests/${survivor}/outcome`, { admitted: true, survived30d: true, cpc: 1, dischargedOn: vnDate() })).http).toBe(200);
    expect((await sup('PUT', `/api/ops/arrests/${survivor}/outcome`, { admitted: true })).http).toBe(403);
    await admin('PUT', '/api/ops/settings/population', { value: 1_000_000 });
    const r = await qa('GET', '/api/ops/arrests');
    expect(r.report.outcomes.comparator).toMatchObject({ n: 1, survived: 1, goodCpc: 1 });
    expect(r.report.incidencePer100k).toBe(0.3);
  });

  it('báo cáo đếm đúng khi không có ca', () => {
    const r = utsteinReport([] as ArrestRow[], null);
    expect(r.flow.total).toBe(0);
    expect(r.bystander.cprPct).toBeNull();
  });
});

describe('rà soát ca (bình ca)', () => {
  let incidentId = '';
  let reviewId = '';
  beforeAll(async () => {
    await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' });
    incidentId = await incident('RS-1', { final_priority: 'P1', suggested_priority: 'P2', override_reason: 'Người gọi mô tả tím tái' });
    await pool.query(`INSERT INTO assignments(incident_id, vehicle_id, assigned_by, assigned_at, ended_at) VALUES ($1, 'MD-ALS-01', $2, now() - interval '1 hour', now())`,
      [incidentId, await uid('dpv06')]);
  });

  it('hàng chờ có ca P1 đổi mức ưu tiên, kèm lý do', async () => {
    const q = await qa('GET', '/api/ops/case-reviews');
    const row = q.rows.find((r: any) => r.code === 'RS-1');
    expect(row.reasons).toEqual(expect.arrayContaining(['p1', 'phan_loai']));
    expect(row.review_id).toBeNull();
  });

  it('người trong kíp không tự rà soát ca mình', async () => {
    await pool.query(`UPDATE users SET role = 'qa' WHERE username = 'bs.als'`);
    const asQa = await login(app, 'bs.als');
    expect((await asQa('POST', '/api/ops/case-reviews', { incidentId })).http).toBe(409);
    await pool.query(`UPDATE users SET role = 'crew' WHERE username = 'bs.als'`);
  });

  it('chấm đủ tiêu chí mới chốt; có tiêu chí chưa đạt phải ghi bài học', async () => {
    const r = await qa('POST', '/api/ops/case-reviews', { incidentId });
    expect(r.code).toMatch(/^RSC-\d{4}-0001$/);
    reviewId = r.id;
    const scores = { dieu_phoi: 'dat', tiep_can: 'dat', dieu_tri: 'can_cai_thien', an_toan: 'dat', ghi_chep: 'dat', ban_giao: 'dat' };
    expect((await qa('PUT', `/api/ops/case-reviews/${reviewId}`, { scores, summary: 'Ổn', finish: true })).error).toMatch(/Chưa chấm/);
    const all = { ...scores, giao_tiep: 'dat' };
    expect((await qa('PUT', `/api/ops/case-reviews/${reviewId}`, { scores: all, summary: 'Ổn', finish: true })).error).toMatch(/bài học/);
    expect((await sup('PUT', `/api/ops/case-reviews/${reviewId}`, { scores: all, summary: 'Ổn' })).http).toBe(403);
    const done = await qa('PUT', `/api/ops/case-reviews/${reviewId}`, { scores: all, summary: 'Xử trí tốt', learning: 'Cho adrenaline sớm hơn', finish: true });
    expect(done.status).toBe('da_xong');
    const detail = await qa('GET', `/api/ops/case-reviews/${reviewId}`);
    expect(detail.crew.map((c: any) => c.full_name)).toHaveLength(1);
  });

  it('kíp thấy phản hồi và xác nhận đã đọc; khắc phục gắn phiếu rà soát', async () => {
    const fb = await crew('GET', '/api/ops/my-feedback');
    expect(fb.data.map((x: any) => x.incident_code)).toContain('RS-1');
    expect((await crew('POST', `/api/ops/my-feedback/${reviewId}/ack`, { comment: 'Đã rút kinh nghiệm' })).ok).toBe(true);
    expect((await dpv('POST', `/api/ops/my-feedback/${reviewId}/ack`, {})).http).toBe(404);
    const capa = await qa('POST', '/api/quality/capa', { caseReviewId: reviewId, description: 'Tập huấn lại phác đồ ngừng tim', ownerId: await uid('bs.als'), dueDate: vnDate(14) });
    expect(capa.source).toBe('ra_soat_ca');
    const list = await qa('GET', '/api/quality/capa?source=ra_soat_ca');
    expect(list.data[0].case_review_code).toMatch(/^RSC-/);
  });
});

describe('lưu vết GPS', () => {
  it('cộng quãng đường bỏ điểm sai số lớn và bước nhảy phi lý', () => {
    const t = (s: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, s)).toISOString();
    const pts = [
      { lat: 10.0, lng: 106.0, at: t(0) }, { lat: 10.009, lng: 106.0, at: t(60) },
      { lat: 10.5, lng: 106.0, at: t(70) }, { lat: 10.018, lng: 106.0, at: t(120), accuracy_m: 500 }, { lat: 10.018, lng: 106.0, at: t(180) },
    ];
    expect(trackDistanceKm(pts)).toBe(2);
    expect(trackFlags(0, 0, 5, null)[0]).toMatch(/Không có lộ trình/);
    expect(trackFlags(10, 10, 5, 0.1)[0]).toMatch(/khác quãng đường khai/);
  });

  it('máy tính bảng gửi vị trí thì lưu vết theo ca đang làm; gọi lại giám sát cờ lộ trình', async () => {
    const inc = await one(`INSERT INTO incidents(code, source, status, final_priority, confirmed_at, lat, lng) VALUES ('GPS-1', '1800', 'dispatched', 'P2', now(), 10.80, 106.70) RETURNING id`);
    await pool.query(`INSERT INTO assignments(incident_id, vehicle_id, assigned_by, assigned_at) VALUES ($1, 'MD-ALS-01', $2, now() - interval '15 minutes')`, [inc.id, await uid('dpv06')]);
    await pool.query(`UPDATE vehicles SET current_incident_id = $1, status = 'S4' WHERE id = 'MD-ALS-01'`, [inc.id]);
    for (const [lat, lng] of [[10.77, 106.70], [10.785, 106.70], [10.80, 106.70]]) {
      expect((await crew('POST', '/api/vehicles/MD-ALS-01/location', { lat, lng, accuracy: 10 })).ok).toBe(true);
    }
    // Giãn thời gian các điểm như thật (gửi trong cùng một giây thì bị coi là bước nhảy phi lý)
    await pool.query(`UPDATE ops_gps_track g SET at = now() - make_interval(mins => (10 - x.rn * 3)::int)
                        FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ops_gps_track WHERE incident_id = $1) x WHERE g.id = x.id`, [inc.id]);
    const tr = await dpv('GET', `/api/ops/incidents/${inc.id}/track`);
    expect(tr.vehicles[0].points).toHaveLength(3);
    expect(tr.vehicles[0].km).toBeCloseTo(3.3, 0);
    expect(tr.vehicles[0].nearestToSceneKm).toBe(0);
    expect((await kt('GET', `/api/ops/incidents/${inc.id}/track`)).http).toBe(403);
    await pool.query(`UPDATE assignments SET ended_at = now() WHERE incident_id = $1`, [inc.id]);
    await pool.query(`UPDATE vehicles SET current_incident_id = NULL, status = 'S1' WHERE id = 'MD-ALS-01'`);
  });
});

describe('đông nạn nhân', () => {
  let incidentId = '';
  beforeAll(async () => {
    incidentId = (await one(`INSERT INTO incidents(code, source, status, final_priority, confirmed_at, address) VALUES ('MCI-1', '1800', 'on_scene', 'P1', now(), 'Cầu Sài Gòn') RETURNING id`)).id;
  });

  it('chỉ trưởng ca kích hoạt; báo 115 qua hàng gửi', async () => {
    expect((await dpv('POST', `/api/ops/mci/${incidentId}/declare`, { level: 1 })).http).toBe(403);
    const b = await sup('POST', `/api/ops/mci/${incidentId}/declare`, { level: 1, note: 'Tai nạn liên hoàn', roles: { chi_huy: 'Trưởng ca Lan' } });
    expect(b.incident.mci_level).toBe(1);
    expect((await one(`SELECT count(*)::int AS n FROM outbox WHERE topic = 'mci_declared'`)).n).toBe(1);
  });

  it('ghi nạn nhân theo thẻ; từ 5 ca nặng gợi ý nâng mức; chuyển viện phải có xe và bệnh viện', async () => {
    for (const [tag, triage] of [['01', 'do'], ['02', 'do'], ['03', 'vang'], ['04', 'vang'], ['05', 'vang'], ['06', 'xanh']] as const) {
      expect((await dpv('POST', `/api/ops/mci/${incidentId}/victims`, { tag, triage })).http).toBe(200);
    }
    expect((await dpv('POST', `/api/ops/mci/${incidentId}/victims`, { tag: '01', triage: 'xanh' })).http).toBe(409);
    const board = await dpv('GET', `/api/ops/mci/${incidentId}`);
    expect(board.byTriage).toEqual({ do: 2, vang: 3, xanh: 1, den: 0 });
    expect(board.advice.join(' ')).toMatch(/nâng lên mức 2/);
    const v = board.victims.find((x: any) => x.tag === '01');
    expect((await dpv('PUT', `/api/ops/mci/${incidentId}/victims/${v.id}`, { tag: '01', triage: 'do', status: 'dang_chuyen' })).http).toBe(400);
    expect((await crew('PUT', `/api/ops/mci/${incidentId}/victims/${v.id}`, { tag: '01', triage: 'do', status: 'dang_chuyen', vehicleId: 'MD-ALS-01', hospital: 'BV Chợ Rẫy' })).http).toBe(403);
    expect((await dpv('PUT', `/api/ops/mci/${incidentId}/victims/${v.id}`, { tag: '01', triage: 'do', status: 'dang_chuyen', vehicleId: 'MD-ALS-01', hospital: 'BV Chợ Rẫy' })).status).toBe('dang_chuyen');
  });

  it('còn nạn nhân ở hiện trường thì chưa kết thúc được', async () => {
    expect((await sup('POST', `/api/ops/mci/${incidentId}/end`, { note: 'Xong' })).http).toBe(409);
    await pool.query(`UPDATE ops_mci_victims SET status = 'tai_cho' WHERE incident_id = $1`, [incidentId]);
    expect((await sup('POST', `/api/ops/mci/${incidentId}/end`, { note: 'Đã chuyển hết' })).incident.mci_ended_at).toBeTruthy();
  });
});

describe('hồ sơ xe, bảo dưỡng, khóa xe', () => {
  it('đăng kiểm hết hạn: xe bị khóa, không được gợi ý, không ai giao được', async () => {
    const tech = await login(app, 'kythuat');
    await pool.query(`UPDATE vehicles SET status = 'S1' WHERE id = 'MD-BLS-01'`);
    expect((await tech('POST', '/api/ops/fleet/MD-BLS-01/docs', { kind: 'dang_kiem', number: 'DK-1', expiresOn: vnDate(-1) })).http).toBe(200);
    const fleet = await dpv('GET', '/api/ops/fleet');
    expect(fleet.data.find((v: any) => v.vehicleId === 'MD-BLS-01').blocks[0]).toMatch(/Đăng kiểm hết hạn/);
    const inc = await one(`INSERT INTO incidents(code, source, status, final_priority, final_vehicle_type, confirmed_at, lat, lng) VALUES ('LOCK-1', '1800', 'confirmed', 'P3', 'BLS', now(), 10.78, 106.70) RETURNING id`);
    const r = await sup('POST', `/api/incidents/${inc.id}/assign`, { vehicleId: 'MD-BLS-01', equipmentOverride: 'Gấp', confirmFar: true });
    expect(r.http).toBe(409);
    expect(r.error).toMatch(/bị khóa/);
    const s = await dpv('GET', `/api/incidents/${inc.id}/suggest`);
    expect(s.suggestions.map((x: any) => x.vehicleId)).not.toContain('MD-BLS-01');
    expect(s.advice.join(' ')).toMatch(/MD-BLS-01 rảnh nhưng bị khóa/);
    await tech('POST', '/api/ops/fleet/MD-BLS-01/docs', { kind: 'dang_kiem', number: 'DK-2', issuedOn: vnDate(), expiresOn: vnDate(365) });
    expect((await dpv('GET', '/api/ops/fleet')).data.find((v: any) => v.vehicleId === 'MD-BLS-01').blocks).toEqual([]);
  });

  it('km chỉ tăng; bảo dưỡng tính hạn theo km hoặc tháng', async () => {
    const tech = await login(app, 'kythuat');
    expect((await crew('POST', '/api/ops/fleet/MD-ALS-01/odometer', { km: 10000 })).ok).toBe(true);
    expect((await crew('POST', '/api/ops/fleet/MD-ALS-01/odometer', { km: 9000 })).http).toBe(400);
    expect((await crew('POST', '/api/ops/fleet/MD-BLS-01/odometer', { km: 1 })).http).toBe(403);
    await tech('POST', '/api/ops/fleet/MD-ALS-01/maintenance', { kind: 'dinh_ky', doneOn: vnDate(-10), odometerKm: 6000, work: 'Thay dầu, lọc' });
    const d = await tech('GET', '/api/ops/fleet/MD-ALS-01');
    expect(d.maintenance).toMatchObject({ dueKm: 11000, kmLeft: 1000 });
    await crew('POST', '/api/ops/fleet/MD-ALS-01/odometer', { km: 11200 });
    expect((await tech('GET', '/api/ops/fleet/MD-ALS-01')).warnings.join(' ')).toMatch(/Quá hạn bảo dưỡng 200 km/);
  });
});

describe('tuân thủ: tài khoản, dữ liệu cá nhân, diễn tập, sao lưu', () => {
  it('rà soát tài khoản: quyết định đủ mới chốt; khóa xong không đăng nhập được', async () => {
    const r = await admin('POST', '/api/compliance/access-reviews');
    expect(r.code).toMatch(/^RSTK-\d{4}-Q[1-4]$/);
    expect((await admin('POST', '/api/compliance/access-reviews')).http).toBe(409);
    const target = await uid('ketoan');
    expect((await admin('PUT', `/api/compliance/access-reviews/${r.id}`, { userId: target, decision: 'khoa' })).error).toMatch(/lý do/);
    await admin('PUT', `/api/compliance/access-reviews/${r.id}`, { userId: target, decision: 'khoa', note: 'Nghỉ việc' });
    expect((await admin('POST', `/api/compliance/access-reviews/${r.id}/complete`)).error).toMatch(/chưa quyết định/);
    for (const it of r.items.filter((x: any) => x.active && x.userId !== target)) {
      await admin('PUT', `/api/compliance/access-reviews/${r.id}`, { userId: it.userId, decision: 'giu' });
    }
    expect(await admin('POST', `/api/compliance/access-reviews/${r.id}/complete`)).toMatchObject({ locked: 1, changed: 0 });
    await expect(token(app, 'ketoan')).rejects.toThrow();
    await pool.query(`UPDATE users SET active = true WHERE username = 'ketoan'`);
  });

  it('yêu cầu của chủ thể dữ liệu: hạn 72 giờ, chưa xác minh danh tính thì không cung cấp', async () => {
    const p = await one(`INSERT INTO patients(ba_number, id_type, full_name) VALUES ('BA-9000001', 'UNKNOWN', 'Trần Thị Yêu Cầu') RETURNING id`);
    const r = await qa('POST', '/api/compliance/pd/requests', { kind: 'cung_cap', requester: 'Trần Thị Yêu Cầu', relation: 'Chính chủ', patientBa: 'BA-9000001', content: 'Xin bản sao bệnh án' });
    expect(Math.round((Date.parse(r.due_at) - Date.parse(r.received_at)) / 3600000)).toBe(72);
    expect((await qa('GET', `/api/compliance/pd/requests/${r.id}/data`)).http).toBe(409);
    expect((await qa('PATCH', `/api/compliance/pd/requests/${r.id}`, { status: 'da_tra_loi', response: 'Đã gửi' })).http).toBe(409);
    await qa('PATCH', `/api/compliance/pd/requests/${r.id}`, { status: 'dang_xu_ly', identityChecked: true });
    const data = await qa('GET', `/api/compliance/pd/requests/${r.id}/data`);
    expect(data.patient.id).toBe(p.id);
    expect(data.patient.id_enc).toBeUndefined();
    expect((await qa('PATCH', `/api/compliance/pd/requests/${r.id}`, { status: 'da_tra_loi', response: 'Đã gửi bản sao qua email' })).status).toBe('da_tra_loi');
    expect((await kt('GET', '/api/compliance/pd/requests')).http).toBe(403);
  });

  it('vi phạm dữ liệu: quá 72 giờ chưa báo thì cảnh báo; chưa báo cơ quan thì chưa đóng', async () => {
    const b = await qa('POST', '/api/compliance/pd/breaches', { detectedAt: iso(80 * 60), description: 'Máy tính bảng bị mất trên xe', severity: 'trung_binh' });
    expect(b.code).toMatch(/^VPDL-/);
    expect((await qa('GET', '/api/compliance/pd/breaches')).data[0].overdue).toBe(true);
    expect((await qa('PATCH', `/api/compliance/pd/breaches/${b.id}`, { close: true })).http).toBe(400);
    expect((await qa('PATCH', `/api/compliance/pd/breaches/${b.id}`, { authorityNotifiedAt: iso(0), close: true })).status).toBe('dong');
  });

  it('sổ hoạt động xử lý mẫu đã nạp, chưa xác nhận', async () => {
    const a = await qa('GET', '/api/compliance/pd/activities');
    expect(a.data.length).toBe(6);
    expect(a.data.every((x: any) => !x.confirmed)).toBe(true);
  });

  it('diễn tập: kế hoạch, ghi kết quả có người tham gia, đếm theo yêu cầu năm', async () => {
    const d = await sup('POST', '/api/compliance/drills', { kind: 'mci_ban', title: 'Diễn tập đông nạn nhân trên bàn', plannedOn: vnDate() });
    expect((await sup('POST', `/api/compliance/drills/${d.id}/record`, { doneOn: vnDate(), participants: [], findings: 'Ổn', result: 'dat' })).http).toBe(400);
    await sup('POST', `/api/compliance/drills/${d.id}/record`, { doneOn: vnDate(), participants: [await uid('dpv06'), await uid('bs.als')], findings: 'Phân bổ bệnh viện chậm', result: 'can_cai_thien' });
    const list = await sup('GET', '/api/compliance/drills');
    expect(list.compliance.find((c: any) => c.kind === 'mci_ban').done).toBe(1);
    const capa = await sup('POST', '/api/quality/capa', { drillId: d.id, description: 'Lập bảng năng lực tiếp nhận bệnh viện', ownerId: await uid('truongca'), dueDate: vnDate(30) });
    expect(capa.source).toBe('dien_tap');
  });

  it('sao lưu bằng pg_dump, thử khôi phục vào cơ sở tạm khớp số dòng', async () => {
    const before = await admin('GET', '/api/compliance/backups');
    expect(before.warnings.join(' ')).toMatch(/Chưa có bản sao lưu/);
    const r = await admin('POST', '/api/compliance/backups/run', { kind: 'sao_luu' });
    expect(r.http).toBe(200);
    expect(r.lastOk.file).toMatch(/^medone-\d{8}-\d{6}\.dump$/);
    const v = await admin('POST', '/api/compliance/backups/run', { kind: 'thu_khoi_phuc' });
    expect(v.lastRestore.ok).toBe(true);
    expect(v.warnings).toEqual([]);
    expect((await giamdoc('GET', '/api/compliance/backups')).http).toBe(200);
    expect((await qa('GET', '/api/compliance/backups')).http).toBe(403);
  }, 60_000);
});

