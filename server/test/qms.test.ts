import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { gradeSupplier, indicatorStatus, periodRange, riskLevel } from '../src/qms.js';
import { freshApp, login } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let qa: Client, giamdoc: Client, sup: Client, bs: Client, dpv: Client, ketoan: Client;
const vnDate = (d = 0) => new Date(Date.now() + 7 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const thisPeriod = vnDate().slice(0, 7);
const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
const uid = async (username: string) => (await one('SELECT id FROM users WHERE username = $1', [username])).id as string;

/** Tạo nhanh ca đã đóng có giao xe; ca chẵn đủ mốc thời gian và phiếu đã ký giả lập không có (để kiểm tra cờ) */
async function closedIncident(n: number, withTimes: boolean) {
  const dispatcher = await uid('dpv06');
  const i = await one(`INSERT INTO incidents(code, source, status, callback_phone, final_priority, closed_at) VALUES ($1, '1800', 'closed', '0909000111', 'P2', now()) RETURNING id`, [`QM-${n}`]);
  await pool.query(`INSERT INTO assignments(incident_id, vehicle_id, assigned_by, ended_at) VALUES ($1, 'MD-BLS-01', $2, now())`, [i.id, dispatcher]);
  if (withTimes) {
    for (const [code, min] of [['T0', 0], ['T4', 1], ['T6', 2], ['T7', 12], ['T10', 30]] as const) {
      await pool.query(`INSERT INTO incident_times(incident_id, code, at, source) VALUES ($1, $2, now() - interval '2 hours' + make_interval(mins => $3), 'test')`, [i.id, code, min]);
    }
  }
  return i.id as string;
}

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [qa, giamdoc, sup, bs, dpv, ketoan] = await Promise.all(['qlcl', 'giamdoc', 'truongca', 'bs.als', 'dpv06', 'ketoan'].map((u) => login(app, u)));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('quy tắc', () => {
  it('mức rủi ro, trạng thái chỉ số, chấm nhà cung cấp, khoảng ngày của tháng', () => {
    expect([riskLevel(15), riskLevel(8), riskLevel(6)]).toEqual(['cao', 'trung_binh', 'thap']);
    expect(indicatorStatus({ direction: 'cao_tot', target: 90, warn: 93 }, 91)).toBe('canh_bao');
    expect(indicatorStatus({ direction: 'cao_tot', target: 90, warn: 93 }, 89)).toBe('khong_dat');
    expect(indicatorStatus({ direction: 'thap_tot', target: 1, warn: null }, 0.5)).toBe('dat');
    expect(indicatorStatus({ direction: 'thap_tot', target: 0, warn: null }, 1)).toBe('khong_dat');
    expect(gradeSupplier({ chat_luong: 4, dung_hen: 4, gia: 3, phuc_vu: 3, phap_ly: 4 })).toEqual({ pct: 72, result: 'dat' });
    expect(gradeSupplier({ chat_luong: 2, dung_hen: 3, gia: 3, phuc_vu: 2, phap_ly: 3 }).result).toBe('theo_doi');
    expect(() => gradeSupplier({ chat_luong: 6, dung_hen: 3, gia: 3, phuc_vu: 2, phap_ly: 3 })).toThrow();
    expect(periodRange('2026-02')).toEqual(['2026-02-01', '2026-02-28']);
  });

  it('dữ liệu mẫu: 12 chỉ số, 10 rủi ro, thời hạn lưu chưa xác nhận', async () => {
    const r = await one(`SELECT (SELECT count(*) FROM qm_indicators)::int AS ind, (SELECT count(*) FROM qm_indicators WHERE auto_key IS NOT NULL)::int AS auto,
                                (SELECT count(*) FROM qm_risks)::int AS risks, (SELECT count(*) FROM qm_retention WHERE NOT confirmed)::int AS ret`);
    expect(r).toEqual({ ind: 12, auto: 10, risks: 10, ret: 9 });
  });
});

describe('sổ rủi ro', () => {
  it('rủi ro cao chưa có khắc phục được nêu; đánh giá lại lưu lịch sử', async () => {
    const r = await qa('POST', '/api/qms/risks', { area: 'Điều phối', hazard: 'Gửi nhầm xe tới địa chỉ trùng tên đường', likelihood: 4, impact: 4, controls: 'Xác nhận lại quận, phường' });
    expect(r.code).toMatch(/^RR-\d{4}$/);
    let list = (await qa('GET', '/api/qms/risks')).data;
    expect(list.find((x: any) => x.id === r.id)).toMatchObject({ score: 16, level: 'cao', needs_action: true });
    expect((await bs('POST', '/api/qms/risks', { area: 'X', hazard: 'Không có quyền tạo', likelihood: 1, impact: 1 })).http).toBe(403);
    const c = await qa('POST', '/api/quality/capa', { riskId: r.id, description: 'Bản đồ gợi ý địa chỉ theo phường', ownerId: await uid('truongca'), dueDate: vnDate(30) });
    expect(c.source).toBe('rui_ro');
    list = (await qa('GET', '/api/qms/risks')).data;
    expect(list.find((x: any) => x.id === r.id).needs_action).toBe(false);
    await qa('POST', `/api/qms/risks/${r.id}/review`, { likelihood: 2, impact: 4, note: 'Sau khi dùng bản đồ gợi ý' });
    const h = (await qa('GET', `/api/qms/risks/${r.id}/history`)).data;
    expect(h.map((x: any) => x.score)).toEqual([8, 16]);
  });
});

describe('khắc phục dùng chung, kiểm tra hiệu quả', () => {
  it('phải có nguồn; người phụ trách không tự xác nhận; chưa hiệu quả thì mở lại', async () => {
    const owner = await uid('truongca');
    expect((await qa('POST', '/api/quality/capa', { description: 'Không có nguồn', ownerId: owner, dueDate: vnDate(10) })).http).toBe(400);
    const c = await qa('POST', '/api/quality/capa', { source: 'tieu_chi', sourceRef: 'TC-DV-CCNV TC9', description: 'Dán tem QR cho thiết bị trên xe', ownerId: owner, dueDate: vnDate(10) });
    expect(c.http).toBe(200);
    expect((await sup('POST', `/api/quality/capa/${c.id}/finish`, { status: 'xong', evidence: 'Đã dán 40 tem' })).http).toBe(200);
    let row = await one('SELECT status, verify_due FROM capa_actions WHERE id = $1', [c.id]);
    expect(row.status).toBe('xong');
    expect(row.verify_due).toBe(vnDate(30));
    expect((await sup('POST', `/api/quality/capa/${c.id}/verify`, { effective: true, note: 'Tự xác nhận' })).http).toBe(403);
    expect((await qa('POST', `/api/quality/capa/${c.id}/verify`, { effective: false, note: 'Còn 3 thiết bị chưa có tem' })).http).toBe(400);
    expect((await qa('POST', `/api/quality/capa/${c.id}/verify`, { effective: false, note: 'Còn 3 thiết bị chưa có tem', newDueDate: vnDate(7) })).http).toBe(200);
    row = await one('SELECT status, effective, due_date FROM capa_actions WHERE id = $1', [c.id]);
    expect(row).toMatchObject({ status: 'mo', effective: false, due_date: vnDate(7) });
    await sup('POST', `/api/quality/capa/${c.id}/finish`, { status: 'xong', evidence: 'Đủ tem' });
    expect((await qa('POST', `/api/quality/capa/${c.id}/verify`, { effective: true, note: 'Kiểm tra 3 xe, đủ tem' })).http).toBe(200);
    const list = (await qa('GET', '/api/quality/capa?source=tieu_chi')).data;
    expect(list[0]).toMatchObject({ status: 'da_xac_nhan', verified_by_name: 'Cán bộ QLCL' });
  });
});

describe('đánh giá nội bộ', () => {
  let auditId: string;
  it('đánh giá viên phải độc lập với bộ phận được đánh giá', async () => {
    const body = {
      year: 2026, title: 'Đánh giá quy trình tiếp nhận và điều phối', auditedUnit: 'Trung tâm điều phối', auditedRoles: ['calltaker', 'dispatcher', 'supervisor'],
      plannedMonth: 11, leadId: await uid('qlcl'), auditorIds: [await uid('truongca')], checklist: [{ q: 'Nhấc máy trong 10 giây?', ref: 'QT-DP-01' }, { q: 'Ghi lý do khi đổi mức ưu tiên?' }],
    };
    const bad = await qa('POST', '/api/qms/audits', body);
    expect(bad.http).toBe(409);
    expect(bad.error ?? bad.message).toMatch(/Trưởng ca EOC/);
    const a = await qa('POST', '/api/qms/audits', { ...body, auditorIds: [await uid('bs.als')] });
    expect(a.code).toBe('DGNB-2026-01');
    auditId = a.id;
  });

  it('báo cáo cần đủ kết quả; đóng cần mọi điểm không phù hợp có khắc phục đã xác nhận hiệu quả', async () => {
    expect((await dpv('POST', `/api/qms/audits/${auditId}/record`, { results: [], performedOn: vnDate() })).http).toBe(403);
    await bs('POST', `/api/qms/audits/${auditId}/record`, { results: [{ result: 'dat' }], performedOn: vnDate() });
    expect((await bs('POST', `/api/qms/audits/${auditId}/advance`, { to: 'da_bao_cao' })).http).toBe(409);
    await bs('POST', `/api/qms/audits/${auditId}/record`, { results: [{ result: 'dat' }, { result: 'khong_dat', note: '2/10 ca không ghi lý do' }], performedOn: vnDate(), summary: 'Cơ bản tuân thủ' });
    const f = await bs('POST', `/api/qms/audits/${auditId}/findings`, { kind: 'nc_nho', reference: 'QT-DP-02', description: 'Đổi mức ưu tiên không ghi lý do ở 2/10 ca' });
    expect(f.code).toBe('DGNB-2026-01/01');
    expect((await bs('POST', `/api/qms/audits/${auditId}/advance`, { to: 'da_bao_cao' })).http).toBe(200);
    expect((await qa('POST', `/api/qms/audits/${auditId}/advance`, { to: 'dong' })).http).toBe(409);
    const c = await qa('POST', '/api/quality/capa', { findingId: f.id, description: 'Bắt buộc ô lý do khi đổi mức', ownerId: await uid('truongca'), dueDate: vnDate(14) });
    await sup('POST', `/api/quality/capa/${c.id}/finish`, { status: 'xong', evidence: 'Đã cập nhật phần mềm' });
    await qa('POST', `/api/quality/capa/${c.id}/verify`, { effective: true, note: 'Rà 20 ca, đủ lý do' });
    expect((await qa('POST', `/api/qms/audits/${auditId}/advance`, { to: 'dong' })).http).toBe(200);
    const d = await qa('GET', `/api/qms/audits/${auditId}`);
    expect(d.status).toBe('dong');
    expect(d.findings[0].capa[0].status).toBe('da_xac_nhan');
  });
});

describe('bộ chỉ số', () => {
  it('tính tự động trong tháng, nhập tay chỉ số không tự động, đánh dấu không đạt', async () => {
    const ok = await uid('dpv01');
    await pool.query(`INSERT INTO hand_hygiene_obs(observer_id, moment, compliant) SELECT $1, 'truoc_tiep_xuc', g <= 7 FROM generate_series(1, 10) g`, [ok]);
    expect((await qa('POST', '/api/qms/indicators/compute', { period: thisPeriod })).http).toBe(200);
    const board = await qa('GET', `/api/qms/indicators?period=${thisPeriod}&months=3`);
    expect(board.periods).toHaveLength(3);
    const hh = board.rows.find((r: any) => r.auto_key === 'hand_hygiene');
    expect(hh.values[thisPeriod]).toMatchObject({ value: 70, numerator: 7, denominator: 10, status: 'khong_dat', auto: true });
    const manual = board.rows.find((r: any) => r.code === 'CS-11');
    expect((await qa('PUT', `/api/qms/indicators/${manual.id}/values/${thisPeriod}`, { numerator: 58, denominator: 60 })).value).toBe(96.7);
    expect((await qa('PUT', `/api/qms/indicators/${hh.id}/values/${thisPeriod}`, { value: 99 })).value).toBe(70);
    const c = await qa('POST', '/api/quality/capa', { indicatorId: hh.id, sourceRef: thisPeriod, description: 'Giám sát vệ sinh tay hằng tuần tại trạm', ownerId: await uid('qlcl'), dueDate: vnDate(20) });
    expect(c.source).toBe('chi_so');
    const again = await qa('GET', `/api/qms/indicators?period=${thisPeriod}&months=1`);
    expect(again.rows.find((r: any) => r.id === hh.id).values[thisPeriod].capa).toBe(true);
    expect((await bs('GET', '/api/qms/indicators')).http).toBe(403);
  });
});

describe('giám sát gọi lại', () => {
  it('rút tối thiểu 10% ca đã đóng, kiểm tra hồ sơ tự động, ghi kết quả gọi', async () => {
    for (let k = 0; k < 15; k++) await closedIncident(k, k % 2 === 0);
    expect((await qa('POST', '/api/qms/callback-rounds', { from: vnDate(-1), to: vnDate(), pct: 5 })).http).toBe(400);
    const r = await qa('POST', '/api/qms/callback-rounds', { from: vnDate(-1), to: vnDate(), pct: 20 });
    expect(r).toMatchObject({ population: 15, sample: 3 });
    const d = await qa('GET', `/api/qms/callback-rounds/${r.id}`);
    expect(d.rows).toHaveLength(3);
    for (const x of d.rows) expect(x.checks.flags).toContain('Chưa ký phiếu chăm sóc');
    await qa('PUT', `/api/qms/callbacks/${d.rows[0].id}`, { status: 'da_goi', confirmed: true, attitude: 2, issues: 'Người nhà phàn nàn kíp vội' });
    const rounds = (await qa('GET', '/api/qms/callback-rounds')).data;
    expect(rounds[0]).toMatchObject({ sample: 3, done: 1, issues: 3 });
    // Ca đã giám sát không rút lại
    const r2 = await qa('POST', '/api/qms/callback-rounds', { from: vnDate(-1), to: vnDate(), pct: 100 });
    expect(r2.population).toBe(12);
  });
});

describe('nhà cung cấp', () => {
  it('chấm điểm, không đạt thì chuyển theo dõi; ngừng hợp tác do Ban Giám đốc', async () => {
    const s = await qa('POST', '/api/qms/suppliers', { name: 'Công ty Thiết bị Y tế A', category: 'thiet_bi', contractUntil: vnDate(20) });
    const e = await qa('POST', `/api/qms/suppliers/${s.id}/evaluations`, { period: '2026-H2', scores: { chat_luong: 3, dung_hen: 3, gia: 3, phuc_vu: 2, phap_ly: 3 } });
    expect(e).toMatchObject({ result: 'theo_doi' });
    const list = (await qa('GET', '/api/qms/suppliers')).data;
    expect(list[0]).toMatchObject({ status: 'theo_doi', last_result: 'theo_doi', contract_expiring: true });
    expect((await qa('PUT', `/api/qms/suppliers/${s.id}`, { name: s.name, category: 'thiet_bi', status: 'ngung' })).http).toBe(403);
    expect((await giamdoc('PUT', `/api/qms/suppliers/${s.id}`, { name: s.name, category: 'thiet_bi', status: 'ngung' })).status).toBe('ngung');
    expect((await qa('POST', `/api/qms/suppliers/${s.id}/evaluations`, { period: 'năm nay', scores: {} })).http).toBe(400);
  });
});

describe('xem xét của lãnh đạo', () => {
  it('đầu vào tự lấy, giao việc cải tiến, chủ trì ký chốt rồi không sửa được', async () => {
    await qa('POST', '/api/qms/risks', { area: 'Nhân lực', hazard: 'Thiếu điều phối viên ca đêm cuối tuần', likelihood: 4, impact: 4 });
    const r = await qa('POST', '/api/qms/reviews', { from: vnDate(-30), to: vnDate(), meetingOn: vnDate(), chairId: await uid('giamdoc'), attendees: 'Ban Giám đốc, QLCL, Trưởng ca' });
    expect(r.code).toMatch(/^XXLD-\d{4}-Q[1-4]$/);
    expect(r.inputs.indicators.length).toBe(12);
    expect(r.inputs.capa.effective).toBeGreaterThanOrEqual(2);
    expect(r.inputs.highRisks.length).toBeGreaterThan(0);
    expect(r.inputs.audits[0].code).toBe('DGNB-2026-01');
    await qa('POST', '/api/quality/capa', { reviewId: r.id, kind: 'phong_ngua', description: 'Bổ sung một điều phối viên ca đêm cuối tuần', ownerId: await uid('truongca'), dueDate: vnDate(60) });
    expect((await giamdoc('POST', `/api/qms/reviews/${r.id}/sign`)).http).toBe(409);
    await qa('PATCH', `/api/qms/reviews/${r.id}`, { conclusions: 'Hệ thống chất lượng vận hành phù hợp; ưu tiên cải thiện vệ sinh tay', refresh: true });
    expect((await qa('POST', `/api/qms/reviews/${r.id}/sign`)).http).toBe(403);
    expect((await giamdoc('POST', `/api/qms/reviews/${r.id}/sign`)).http).toBe(200);
    expect((await qa('PATCH', `/api/qms/reviews/${r.id}`, { conclusions: 'Sửa sau khi chốt' })).http).toBe(409);
    const d = await giamdoc('GET', `/api/qms/reviews/${r.id}`);
    expect(d).toMatchObject({ status: 'da_chot', signed_by_name: 'Ban Giám đốc' });
    expect(d.actions).toHaveLength(1);
  });
});

describe('thời hạn lưu hồ sơ, tổng quan', () => {
  it('chưa xác nhận căn cứ thì không ghi biên bản hủy; không có hồ sơ quá hạn thì cũng không', async () => {
    expect((await giamdoc('POST', '/api/qms/disposals', { recordKey: 'khao_sat', decision: 'Hủy phiếu khảo sát quá hạn lưu theo quyết định Hội đồng' })).http).toBe(409);
    expect((await ketoan('PUT', '/api/qms/retention/khao_sat', { years: 3, confirmed: true })).http).toBe(403);
    await qa('PUT', '/api/qms/retention/khao_sat', { years: 3, basis: 'Quy định nội bộ QĐ-01/2026', confirmed: true });
    const res = await giamdoc('POST', '/api/qms/disposals', { recordKey: 'khao_sat', decision: 'Hủy phiếu khảo sát quá hạn lưu theo quyết định Hội đồng' });
    expect(res.http).toBe(409);
    expect(res.error ?? res.message).toMatch(/Không có hồ sơ/);
    const list = await qa('GET', '/api/qms/retention');
    expect(list.rows.find((r: any) => r.key === 'nhat_ky').expired).toBe(0);
  });

  it('tổng quan đếm việc cần làm', async () => {
    const s = await qa('GET', '/api/qms/summary');
    expect(s.risks.high).toBeGreaterThan(0);
    expect(s.callbacks.pending).toBeGreaterThan(0);
    expect(s.audits.done).toBe(1);
  });
});
