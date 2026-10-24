import { describe, expect, it } from 'vitest';
import { eventHash } from '../src/audit.js';
import { decryptId, encryptId, hashPassword, lookupHash, verifyPassword } from '../src/crypto.js';
import { estimateFree, haversineKm, isOfficeHours, suggestVehicles, type VehicleRow } from '../src/fleet.js';
import { EpcrSchema, missingForSign } from '../src/epcr.js';

const v = (id: string, type: string, status = 'S1', lat = 10.77, lng = 106.70, duty = '24/7'): VehicleRow => ({
  id, type, plate: null, station_id: 'TS', duty, status, status_since: new Date().toISOString(), lat, lng,
  current_incident_id: null, free_hint_at: null, supplies_ok: true, supplies_note: null,
});

describe('mã hóa số định danh', () => {
  it('mã hóa rồi giải mã trả lại đúng số, mỗi lần mã hóa khác nhau', () => {
    const a = encryptId('079123456789');
    expect(a).not.toBe(encryptId('079123456789'));
    expect(decryptId(a)).toBe('079123456789');
  });
  it('mã băm tìm kiếm ổn định và tách theo loại giấy tờ', () => {
    expect(lookupHash('CCCD', '079123456789')).toBe(lookupHash('CCCD', '079123456789'));
    expect(lookupHash('CCCD', '079123456789')).not.toBe(lookupHash('PASSPORT', '079123456789'));
  });
  it('mật khẩu băm scrypt', () => {
    const h = hashPassword('abc');
    expect(verifyPassword('abc', h)).toBe(true);
    expect(verifyPassword('abd', h)).toBe(false);
  });
});

describe('chuỗi băm', () => {
  it('đổi một ký tự trong dữ liệu làm đổi mã băm', () => {
    const e = { prev_hash: '0'.repeat(64), scope: 's', at: '2026-10-24T05:00:00.000Z', actor_id: null, action: 'x', entity: null, entity_id: null, data: { a: 1, b: 'c' } };
    expect(eventHash(e)).toBe(eventHash({ ...e, data: { b: 'c', a: 1 } }));
    expect(eventHash(e)).not.toBe(eventHash({ ...e, data: { a: 2, b: 'c' } }));
  });
});

describe('gợi ý xe', () => {
  const scene = { lat: 10.78, lng: 106.70 };
  it('ca P1 ưu tiên ALS gần nhất, bỏ xe đang bận', () => {
    const r = suggestVehicles([v('A1', 'ALS', 'S4'), v('A2', 'ALS'), v('B1', 'BLS')], scene, 'ALS', 'P1');
    expect(r.suggestions[0].vehicleId).toBe('A2');
    expect(r.suggestions.find((s) => s.vehicleId === 'A1')).toBeUndefined();
  });
  it('ALS xa quá 12 phút cho P1 => khuyên gửi đồng thời BLS', () => {
    const r = suggestVehicles([v('A1', 'ALS', 'S1', 10.95, 106.9), v('B1', 'BLS')], scene, 'ALS', 'P1');
    expect(r.advice.join(' ')).toMatch(/gửi đồng thời B1/);
  });
  it('xe đột quỵ chỉ là phương án sau ALS cho ca P1', () => {
    const r = suggestVehicles([v('M1', 'MSU'), v('A1', 'ALS', 'S1', 10.80, 106.72)], scene, 'ALS', 'P1');
    expect(r.suggestions[0].vehicleId).toBe('A1');
  });
  it('ECMO ngoài giờ hành chính => khuyên chuyển đội ECMO bệnh viện', () => {
    const sunday = new Date('2026-10-25T03:00:00Z');
    expect(isOfficeHours(sunday)).toBe(false);
    const r = suggestVehicles([v('E1', 'ECMO', 'S1', 10.77, 106.70, 'office')], scene, 'ECMO', 'P2', sunday);
    expect(r.suggestions).toHaveLength(0);
    expect(r.advice[0]).toMatch(/ECMO của bệnh viện/);
  });
  it('khoảng cách haversine hợp lý', () => {
    expect(haversineKm({ lat: 10.7769, lng: 106.7009 }, { lat: 10.8016, lng: 106.6526 })).toBeCloseTo(5.8, 0);
  });
});

describe('ước tính giờ rảnh', () => {
  const now = new Date('2026-10-24T05:00:00Z');
  it('xe rảnh => rảnh ngay; S9 => không ước tính', () => {
    expect(estimateFree({ status: 'S1', status_since: now.toISOString(), free_hint_at: null }, {}, now).freeAt).toBe(now.toISOString());
    expect(estimateFree({ status: 'S9', status_since: now.toISOString(), free_hint_at: null }, {}, now).freeAt).toBeNull();
  });
  it('đang bàn giao 5 phút => còn bàn giao + bổ sung', () => {
    const since = new Date(now.getTime() - 5 * 60_000).toISOString();
    const r = estimateFree({ status: 'S7', status_since: since, free_hint_at: null }, { S7: 15, S8: 15 }, now);
    expect((new Date(r.freeAt!).getTime() - now.getTime()) / 60_000).toBeCloseTo(25, 0);
  });
  it('kíp báo rảnh trong 5 phút thì dùng con số của kíp', () => {
    const hint = new Date(now.getTime() + 5 * 60_000).toISOString();
    expect(estimateFree({ status: 'S8', status_since: now.toISOString(), free_hint_at: hint }, {}, now).freeAt).toBe(hint);
  });
});

describe('ePCR', () => {
  it('phiếu trống thiếu các trường bắt buộc khi ký', () => {
    const miss = missingForSign(EpcrSchema.parse({}));
    expect(miss).toContain('Chẩn đoán');
    expect(miss).toContain('Đối tượng thu phí');
  });
  it('thuốc không có số lô thì không ký được', () => {
    const e = EpcrSchema.parse({
      chiefComplaint: 'Đau ngực', vitals: [{ at: 'x', hr: 90 }], diagnosis: { text: 'NMCT' }, payer: 'BHYT',
      disposition: { type: 'transported', hospital: 'BV X', receiverName: 'BS Y' },
      medications: [{ at: 'x', name: 'Aspirin' }],
    });
    expect(missingForSign(e)).toEqual(['Số lô thuốc Aspirin']);
  });
});
