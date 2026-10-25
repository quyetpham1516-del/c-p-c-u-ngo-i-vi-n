import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { computeLevel } from '../src/qc.js';
import { freshApp, login, token } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;
let app: FastifyInstance;
let pool: pg.Pool;
let qa: Client, giamdoc: Client, admin: Client, crew: Client, kythuat: Client, nhansu: Client;
const vnDate = (d = 0) => new Date(Date.now() + 7 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ({ app, pool } = await freshApp());
  [qa, giamdoc, admin, crew, kythuat, nhansu] = await Promise.all(['qlcl', 'giamdoc', 'admin', 'bs.als', 'kythuat', 'nhansu'].map((u) => login(app, u)));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('xếp mức tiêu chí theo tiểu mục', () => {
  const items = [{ id: 'a', level: 1 }, { id: 'b', level: 2 }, { id: 'c', level: 2 }, { id: 'd', level: 3 }, { id: 'e', level: 4 }, { id: 'f', level: 5 }];
  it('có tiểu mục mức 1 xảy ra thì mức 1, dù đạt các mức trên', () => {
    expect(computeLevel(items, { a: true, b: true, c: true, d: true, e: true, f: true })).toBe(1);
  });
  it('mức cao nhất mà mọi tiểu mục từ mức 2 tới mức đó đều đạt; không áp dụng thì bỏ qua', () => {
    expect(computeLevel(items, { a: false, b: true, c: true, d: true, e: false, f: true })).toBe(3);
    expect(computeLevel(items, { a: false, b: true, c: false, d: true })).toBe(1);
    expect(computeLevel(items, { a: false, b: true, c: null, d: true, e: true, f: true })).toBe(5);
  });
  it('chưa trả lời mức 1 thì chưa xếp được', () => {
    expect(computeLevel(items, { b: true, c: true })).toBeNull();
  });
});

describe('bộ tiêu chí chất lượng', () => {
  let setId = '';
  let draftId = '';
  it('nạp sẵn bộ 41 tiêu chí TTCC 115 và bộ 10 tiêu chí đơn vị CCNV, đang hiệu lực, không sửa trực tiếp', async () => {
    const sets = (await qa('GET', '/api/qc/sets')).data;
    expect(sets.map((s: any) => [s.code, s.criteria, s.status]).sort()).toEqual([['TC-CCNV', 41, 'hieu_luc'], ['TC-DV-CCNV', 10, 'hieu_luc'], ['TC-PK-SYT', 23, 'hieu_luc']]);
    setId = sets.find((s: any) => s.code === 'TC-CCNV').id;
    const d = await crew('GET', `/api/qc/sets/${setId}`);
    const a12 = d.criteria.find((c: any) => c.code === 'A1.2');
    expect(a12.items.filter((i: any) => i.level === 1)).toHaveLength(2);
    expect(a12.items.map((i: any) => i.ordinal)).toEqual(a12.items.map((_: any, k: number) => k + 1));
    const c = d.criteria[0];
    const body = { part: c.part, partName: c.part_name, chapter: c.chapter, chapterName: c.chapter_name, code: c.code, title: 'Sửa', levels: [[], ['x'], [], [], []] };
    expect((await qa('PUT', `/api/qc/sets/${setId}/criteria/${c.id}`, body)).http).toBe(409);
  });

  it('nhân bản thành bản Medone, sửa tiêu chí, thêm tiêu chí; người soạn không tự ban hành', async () => {
    const draft = await qa('POST', `/api/qc/sets/${setId}/clone`, { version: '2026-MD', name: 'Bộ tiêu chí chất lượng Medone' });
    expect(draft.http).toBe(200);
    draftId = draft.id;
    const d = await qa('GET', `/api/qc/sets/${draftId}`);
    expect(d.criteria).toHaveLength(41);
    const c = d.criteria.find((x: any) => x.code === 'A1.4');
    const levels = [1, 2, 3, 4, 5].map((l) => c.items.filter((i: any) => i.level === l).map((i: any) => i.text));
    levels[2].push('Xe có định vị GPS hiển thị trên bảng điều phối Medone');
    const upd = await qa('PUT', `/api/qc/sets/${draftId}/criteria/${c.id}`, {
      part: c.part, partName: c.part_name, chapter: c.chapter, chapterName: c.chapter_name, code: c.code, title: c.title, ownerUnit: 'Kỹ thuật', weight: 2, levels,
    });
    expect(upd.http).toBe(200);
    const added = await qa('POST', `/api/qc/sets/${draftId}/criteria`, {
      part: 'E', partName: 'Tiêu chí riêng Medone', chapter: 'E1', chapterName: 'Dịch vụ chuyển viện', code: 'E1.1', title: 'Chuyển viện an toàn',
      levels: [['Có người bệnh chuyển viện bị sự cố nghiêm trọng do thiếu thiết bị'], ['Có quy trình chuyển viện'], ['Kíp kiểm tra thiết bị đầu ca'], [], []],
    });
    expect(added.http).toBe(200);
    expect((await qa('POST', `/api/qc/sets/${draftId}/criteria`, { ...added, part: 'E', partName: 'x x', chapter: 'E1', chapterName: 'x x', code: 'E1.1', title: 'Trùng mã', levels: [[], ['a'], [], [], []] })).http).toBe(409);
    expect((await qa('POST', `/api/qc/sets/${draftId}/approve`)).http).toBe(403);
    expect((await giamdoc('POST', `/api/qc/sets/${draftId}/approve`)).status).toBe('hieu_luc');
    const sets = (await qa('GET', '/api/qc/sets')).data;
    expect(sets.find((s: any) => s.id === setId).status).toBe('het_hieu_luc');
    expect(sets.find((s: any) => s.code === 'TC-DV-CCNV').status).toBe('hieu_luc');
    const a14 = (await qa('GET', `/api/qc/sets/${draftId}`)).criteria.find((x: any) => x.code === 'A1.4');
    expect(a14.weight).toBe(2);
    expect(a14.items.some((i: any) => /GPS hiển thị/.test(i.text))).toBe(true);
  });

  it('đợt tự đánh giá: phân công người chấm, chỉ người được phân công hoặc QLCL chấm; mức khác tính toán phải giải trình', async () => {
    const a = await qa('POST', '/api/qc/assessments', { setId: draftId, name: 'Tự đánh giá quý 4/2026', kind: 'tu_danh_gia', periodFrom: vnDate(-90), periodTo: vnDate() });
    expect(a.http).toBe(200);
    const detail = await qa('GET', `/api/qc/assessments/${a.id}`);
    expect(detail.rows).toHaveLength(42);
    const b11 = detail.rows.find((r: any) => r.code === 'B1.1');
    const hr = (await qa('GET', '/api/staff')).data.find((u: any) => u.role === 'hr');
    expect((await qa('PUT', `/api/qc/assessments/${a.id}/assign`, { rows: [{ criterionId: b11.criterion_id, assessorId: hr.id }] })).http).toBe(200);
    expect((await nhansu('GET', '/api/qc/assessments')).data[0].mine_todo).toBe(1);

    const form = await nhansu('GET', `/api/qc/assessments/${a.id}/criteria/${b11.criterion_id}`);
    expect(form.canEdit).toBe(true);
    const results: Record<string, boolean> = {};
    for (const i of form.items) results[i.id] = i.level === 1 ? false : i.level <= 3;
    const s = await nhansu('PUT', `/api/qc/assessments/${a.id}/criteria/${b11.criterion_id}`, { applicable: true, results, methods: ['Kiểm tra văn bản, sổ sách'], currentState: 'Có kế hoạch nhân lực 2026' });
    expect(s.computed_level).toBe(3);
    expect(s.final_level).toBe(3);
    expect((await nhansu('PUT', `/api/qc/assessments/${a.id}/criteria/${b11.criterion_id}`, { applicable: true, results, finalLevel: 4 })).http).toBe(400);
    expect((await nhansu('PUT', `/api/qc/assessments/${a.id}/criteria/${b11.criterion_id}`, { applicable: true, results, finalLevel: 4, explanation: 'Đã đạt tiểu mục mức 4 theo minh chứng bổ sung' })).final_level).toBe(4);

    const other = detail.rows.find((r: any) => r.code === 'A1.1');
    expect((await nhansu('PUT', `/api/qc/assessments/${a.id}/criteria/${other.criterion_id}`, { applicable: true, results: {} })).http).toBe(403);
    expect((await qa('POST', `/api/qc/assessments/${a.id}/close`)).http).toBe(409);

    // QLCL chấm các tiêu chí còn lại: A1.1 không áp dụng, còn lại mức 3
    expect((await qa('PUT', `/api/qc/assessments/${a.id}/criteria/${other.criterion_id}`, { applicable: false, results: {} })).http).toBe(400);
    await qa('PUT', `/api/qc/assessments/${a.id}/criteria/${other.criterion_id}`, { applicable: false, results: {}, explanation: 'Chưa có trang thông tin điện tử' });
    for (const r of detail.rows) {
      if (r.code === 'B1.1' || r.code === 'A1.1') continue;
      await qa('PUT', `/api/qc/assessments/${a.id}/criteria/${r.criterion_id}`, { applicable: true, results: {}, finalLevel: 3, explanation: 'Chấm nhanh khi kiểm thử' });
    }
    expect((await qa('POST', `/api/qc/assessments/${a.id}/close`)).status).toBe('da_chot');
    expect((await qa('PUT', `/api/qc/assessments/${a.id}/criteria/${b11.criterion_id}`, { applicable: true, results })).http).toBe(409);

    const sum = await giamdoc('GET', `/api/qc/assessments/${a.id}/summary`);
    expect(sum.overall.total).toBe(42);
    expect(sum.overall.applicable).toBe(41);
    // 39 tiêu chí mức 3 hệ số 1, A1.4 mức 3 hệ số 2, B1.1 mức 4 → (39×3 + 3×2 + 4) / (39 + 2 + 1)
    expect(sum.overall.points).toBe(127);
    expect(sum.overall.average).toBe(Math.round((127 / 42) * 100) / 100);
    expect(sum.byLevel.find((l: any) => l.level === 3).n).toBe(40);
    expect(sum.parts.find((p: any) => p.code === 'E').applicable).toBe(1);
    const pb = sum.priorities.find((p: any) => p.code === 'B1.1');
    expect(pb.target).toBe(5);
    expect(pb.items.every((i: any) => i.level >= 4)).toBe(true);
    const csv = await app.inject({ method: 'GET', url: `/api/qc/assessments/${a.id}/summary?format=csv`, headers: { authorization: `Bearer ${await token(app, 'qlcl')}` } });
    expect(csv.body).toContain('Điểm trung bình');
    expect(csv.body).toContain('Không áp dụng');

    expect((await qa('POST', `/api/qc/assessments/${a.id}/reopen`, { reason: 'Bổ sung minh chứng' })).http).toBe(403);
    expect((await admin('POST', `/api/qc/assessments/${a.id}/reopen`, { reason: 'Bổ sung minh chứng' })).status).toBe('dang_cham');
  });

  it('tải bộ tiêu chí ra Excel, sửa, nạp lại thành phiên bản dự thảo mới', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const dv = (await qa('GET', '/api/qc/sets')).data.find((s: any) => s.code === 'TC-DV-CCNV');
    const res = await app.inject({ method: 'GET', url: `/api/qc/sets/${dv.id}/xlsx`, headers: { authorization: `Bearer ${await token(app, 'qlcl')}` } });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as any);
    const ws = wb.worksheets[0];
    expect(ws.rowCount).toBe(1 + 109);
    ws.addRow(['A', 'Tiêu chí chất lượng đơn vị cấp cứu ngoại viện', 'A1', 'Tiêu chí chung', 'TC11', 'Kiểm tra thiết bị bằng mã QR', '', 'Kỹ thuật', 1, 2, 'Thiết bị trên xe có tem QR']);
    ws.addRow(['', '', '', '', 'TC11', '', '', '', '', 3, 'Kíp quét QR kiểm tra thiết bị đầu ca']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const imp = await qa('POST', '/api/qc/sets/import', { code: 'TC-DV-CCNV', name: 'Bộ tiêu chí đơn vị CCNV – Medone', version: '1.1', facilityKind: 'ccnv', fileBase64: buf.toString('base64') });
    expect(imp.http).toBe(200);
    expect(imp.status).toBe('du_thao');
    const d = await qa('GET', `/api/qc/sets/${imp.id}`);
    expect(d.criteria).toHaveLength(11);
    expect(d.criteria[10].items.map((i: any) => [i.level, i.ordinal])).toEqual([[2, 1], [3, 2]]);
    ws.addRow(['', '', '', '', 'TC12', 'Thiếu mức', '', '', '', 9, 'Mức sai']);
    const bad = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const r = await qa('POST', '/api/qc/sets/import', { code: 'TC-DV-CCNV', name: 'x x x', version: '1.2', facilityKind: 'ccnv', fileBase64: bad });
    expect(r.http).toBe(400);
    expect(r.error).toMatch(/mức phải từ 1 đến 5/);
  });

  it('chỉ đánh giá theo bộ đang hiệu lực; bộ đã dùng không xóa được', async () => {
    expect((await qa('POST', '/api/qc/assessments', { setId, name: 'Theo bộ cũ', kind: 'tu_danh_gia', periodFrom: vnDate(), periodTo: vnDate() })).http).toBe(409);
    expect((await qa('DELETE', `/api/qc/sets/${draftId}`)).http).toBe(409);
    const pk = await qa('POST', '/api/qc/sets', { code: 'TC-PK', name: 'Bộ tiêu chí phòng khám Medone', version: '1', facilityKind: 'phong_kham' });
    expect(pk.http).toBe(200);
    expect((await giamdoc('POST', `/api/qc/sets/${pk.id}/approve`)).http).toBe(409);
    expect((await qa('DELETE', `/api/qc/sets/${pk.id}`)).ok).toBe(true);
  });
});

describe('mã QR thiết bị', () => {
  it('mỗi thiết bị có mã tài sản và mã QR riêng; quét ra đúng thiết bị; kíp kiểm tra nhanh thiết bị trên xe mình', async () => {
    const list = (await kythuat('GET', '/api/equipment?vehicleId=MD-ALS-01')).data;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].asset_code).toMatch(/^TB-\d{4}$/);
    expect(list[0].qr_code).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(list.map((e: any) => e.qr_code)).size).toBe(list.length);

    const r = await crew('GET', `/api/qr/${list[0].qr_code}`);
    expect(r).toMatchObject({ kind: 'equipment', id: list[0].id });
    expect((await crew('GET', `/api/qr/${list[0].asset_code.toLowerCase()}`)).id).toBe(list[0].id);
    expect((await crew('GET', '/api/qr/khongcoma')).http).toBe(404);

    // Chưa vào ca trên xe: không kiểm tra được; vào ca rồi thì được
    expect((await crew('GET', `/api/equipment/${list[0].id}`)).onMyVehicle).toBe(false);
    expect((await crew('POST', `/api/equipment/${list[0].id}/events`, { kind: 'kiem_tra' })).http).toBe(403);
    await crew('POST', '/api/crew/shift', { vehicleId: 'MD-ALS-01', crewRole: 'Trưởng kíp' });
    expect((await crew('GET', `/api/equipment/${list[0].id}`)).onMyVehicle).toBe(true);
    expect((await crew('POST', `/api/equipment/${list[0].id}/events`, { kind: 'kiem_tra' })).http).toBe(200);
    expect((await crew('GET', `/api/equipment/${list[0].id}`)).last_check).toBeTruthy();
    expect((await crew('POST', `/api/equipment/${list[0].id}/events`, { kind: 've_sinh', note: 'Lau cồn 70 độ' })).http).toBe(200);
    expect((await crew('POST', `/api/equipment/${list[0].id}/events`, { kind: 'bao_duong' })).http).toBe(403);
    expect((await kythuat('PATCH', `/api/equipment/${list[0].id}`, { manualText: 'Bật nguồn, kiểm tra pin trước ca' })).manual_text).toMatch(/kiểm tra pin/);
    expect((await crew('PATCH', `/api/equipment/${list[0].id}`, { manualText: 'x' })).http).toBe(403);

    // Nhãn mất: cấp mã mới, mã cũ hết tác dụng
    const old = list[0].qr_code;
    expect((await crew('POST', '/api/qr/reissue', { kind: 'equipment', id: list[0].id })).http).toBe(403);
    const re = await kythuat('POST', '/api/qr/reissue', { kind: 'equipment', id: list[0].id });
    expect(re.qr_code).not.toBe(old);
    expect((await crew('GET', `/api/qr/${old}`)).http).toBe(404);
  });

  it('bộ dụng cụ cũng có mã QR', async () => {
    const sets = (await kythuat('GET', '/api/instrument-sets')).data;
    if (!sets.length) return;
    expect((await crew('GET', `/api/qr/${sets[0].qr_code}`)).kind).toBe('instrument_set');
    expect((await crew('GET', `/api/instrument-sets/${sets[0].id}`)).code).toBe(sets[0].code);
  });
});
