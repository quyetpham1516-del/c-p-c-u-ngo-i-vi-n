import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/triage/engine.js';
import { CORE_QUESTIONS, GROUPS } from '../src/triage/protocol.js';

const awake = { conscious: 'yes', breathing: 'normal', age_group: 'adult' };

describe('phân loại tự động', () => {
  it('không tỉnh + không thở => P1 ngừng tim ngay, không chờ chọn nhóm', () => {
    const r = evaluate({ conscious: 'no', breathing: 'none' });
    expect(r.priority).toBe('P1');
    expect(r.cardiacArrest).toBe(true);
    expect(r.earlyActivation).toBe(true);
    expect(r.vehicleType).toBe('ALS');
    expect(r.complete).toBe(false);
    expect(r.instructions[0]).toMatch(/nằm ngửa/);
  });

  it('không tỉnh + không rõ thở => coi như ngừng tim', () => {
    expect(evaluate({ conscious: 'no', breathing: 'unknown' }).cardiacArrest).toBe(true);
  });

  it('không tỉnh nhưng thở bình thường => P1, không phải ngừng tim', () => {
    const r = evaluate({ conscious: 'no', breathing: 'normal' });
    expect(r.priority).toBe('P1');
    expect(r.cardiacArrest).toBe(false);
  });

  it('chưa trả lời câu sống còn thì câu tiếp theo là câu đầu tiên', () => {
    expect(evaluate({}).nextQuestionId).toBe(CORE_QUESTIONS[0].id);
    expect(evaluate({}).priority).toBeNull();
  });

  it('đau ngực có dấu hiệu nghi NMCT => P2 + ALS + đèn còi + báo 115', () => {
    const r = evaluate({ ...awake, cp_severe: 'yes', cp_risk: 'no', cp_shock: 'no' }, 'dau_nguc');
    expect(r).toMatchObject({ priority: 'P2', vehicleType: 'ALS', lights: true, complete: true, notify115: true });
    expect(r.flags).toContain('NGHI_NMCT');
  });

  it('đau ngực nhẹ, không yếu tố nguy cơ => P3 + BLS, không đèn còi', () => {
    const r = evaluate({ ...awake, cp_severe: 'no', cp_risk: 'no', cp_shock: 'no' }, 'dau_nguc');
    expect(r).toMatchObject({ priority: 'P3', vehicleType: 'BLS', lights: false, notify115: false });
  });

  it('"Không rõ" được tính như "Có" để tránh phân loại thiếu', () => {
    const r = evaluate({ ...awake, cp_severe: 'unknown', cp_risk: 'no', cp_shock: 'no' }, 'dau_nguc');
    expect(r.priority).toBe('P2');
  });

  it('đột quỵ BE-FAST dương tính trong 4,5 giờ => đề xuất xe đột quỵ có CT', () => {
    const r = evaluate({ ...awake, st_face: 'yes', st_arm: 'no', st_speech: 'no', st_balance_eyes: 'no', st_lkw: 'lt4h5', st_anticoag: 'no' }, 'dot_quy');
    expect(r).toMatchObject({ priority: 'P2', vehicleType: 'MSU' });
  });

  it('đột quỵ quá 24 giờ => ALS, không MSU', () => {
    const r = evaluate({ ...awake, st_face: 'yes', st_arm: 'no', st_speech: 'no', st_balance_eyes: 'no', st_lkw: 'gt24h', st_anticoag: 'no' }, 'dot_quy');
    expect(r.vehicleType).toBe('ALS');
  });

  it('đột quỵ nhưng ngừng tim => ALS, hướng dẫn ép tim', () => {
    const r = evaluate({ conscious: 'no', breathing: 'none', age_group: 'adult', st_face: 'yes', st_lkw: 'lt4h5' }, 'dot_quy');
    expect(r.vehicleType).toBe('ALS');
    expect(r.cardiacArrest).toBe(true);
  });

  it('chấn thương có hiện trường nguy hiểm => cảnh báo điểm tập kết đứng đầu hướng dẫn', () => {
    const r = evaluate({ ...awake, tr_danger: 'yes', tr_bleeding: 'no', tr_penetrating: 'no', tr_mechanism: 'no', tr_head: 'no', tr_victims: 'no' }, 'chan_thuong');
    expect(r.flags).toContain('HIEN_TRUONG_NGUY_HIEM');
    expect(r.instructions[0]).toMatch(/điểm tập kết/);
  });

  it('tư vấn => P4, không cần xe; nhưng lơ mơ thì nâng P2 và cần ALS', () => {
    expect(evaluate(awake, 'tu_van')).toMatchObject({ priority: 'P4', vehicleType: 'NONE', complete: true });
    expect(evaluate({ ...awake, conscious: 'altered' }, 'tu_van')).toMatchObject({ priority: 'P2', vehicleType: 'ALS' });
  });

  it('chuyển viện theo hẹn => xe vận chuyển; cần bác sĩ đi kèm => ALS', () => {
    expect(evaluate({ ...awake, tf_als: 'no' }, 'chuyen_vien')).toMatchObject({ priority: 'HEN', vehicleType: 'VC' });
    expect(evaluate({ ...awake, tf_als: 'yes' }, 'chuyen_vien')).toMatchObject({ priority: 'HEN', vehicleType: 'ALS' });
  });

  it('ECMO luôn dùng xe ECMO', () => {
    expect(evaluate(awake, 'ecmo')).toMatchObject({ vehicleType: 'ECMO', priority: 'P2' });
  });

  it('mã không bao giờ thấp hơn mức nền của nhóm', () => {
    for (const g of GROUPS) {
      const allNo = Object.fromEntries(g.questions.map((q) => [q.id, q.options.find((o) => !o.priority)?.value ?? q.options[0].value]));
      const r = evaluate({ ...awake, ...allNo }, g.id);
      expect(r.priority, g.id).not.toBeNull();
    }
  });

  it('mọi câu hỏi trong bộ đều có id duy nhất', () => {
    const ids = [...CORE_QUESTIONS, ...GROUPS.flatMap((g) => g.questions)].map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cùng câu trả lời luôn cho cùng kết quả (dựng lại được khi rà soát)', () => {
    const a = { ...awake, br_sentence: 'no', br_cyanosis: 'no', br_sudden: 'no' };
    expect(evaluate(a, 'kho_tho')).toEqual(evaluate(a, 'kho_tho'));
    expect(evaluate(a, 'kho_tho').priority).toBe('P1');
  });
});
