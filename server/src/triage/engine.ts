import {
  CORE_QUESTIONS, CPR_INSTRUCTIONS, findGroup, PROTOCOL_VERSION,
  type Priority, type Question, type VehicleType,
} from './protocol.js';

export type Answers = Record<string, string>;

export interface TriageResult {
  protocolVersion: string;
  priority: Priority | null;
  vehicleType: VehicleType | null;
  lights: boolean;
  /** Đủ dữ kiện để báo động trước xe (P1) dù chưa hỏi xong */
  earlyActivation: boolean;
  cardiacArrest: boolean;
  complete: boolean;
  nextQuestionId: string | null;
  flags: string[];
  reasons: { questionId: string; question: string; answer: string; priority?: Priority }[];
  instructions: string[];
  /** Thông báo tự động sang 115 tỉnh (mục 12.7: ca P1–P2) */
  notify115: boolean;
}

const RANK: Record<Priority, number> = { P1: 5, P2: 4, P3: 3, P4: 2, HEN: 1 };

export function higher(a: Priority | null, b: Priority | null | undefined): Priority | null {
  if (!b) return a;
  if (!a) return b;
  return RANK[b] > RANK[a] ? b : a;
}

export function priorityRank(p: Priority): number {
  return RANK[p];
}

export function vehicleForPriority(p: Priority): VehicleType {
  switch (p) {
    case 'P1':
    case 'P2':
      return 'ALS';
    case 'P3':
      return 'BLS';
    case 'P4':
      return 'NONE';
    case 'HEN':
      return 'VC';
  }
}

function visible(q: Question, a: Answers): boolean {
  return !q.when || q.when.in.includes(a[q.when.q]);
}

/**
 * Tính mã ưu tiên đề xuất từ câu trả lời. Hàm thuần, không có trạng thái: cùng câu trả lời và cùng
 * phiên bản bộ câu hỏi luôn cho cùng kết quả, để QLCL dựng lại được khi rà soát ca.
 */
export function evaluate(answers: Answers, groupId?: string | null): TriageResult {
  const reasons: TriageResult['reasons'] = [];
  const flags = new Set<string>();
  let priority: Priority | null = null;
  let vehicleOverride: VehicleType | null = null;
  let next: string | null = null;

  const consider = (q: Question) => {
    if (!visible(q, answers)) return;
    const v = answers[q.id];
    const opt = q.options.find((o) => o.value === v);
    if (!opt) {
      next ??= q.id;
      return;
    }
    opt.flags?.forEach((f) => flags.add(f));
    if (opt.vehicle) vehicleOverride = opt.vehicle;
    if (opt.priority || opt.flags?.length || opt.vehicle) {
      reasons.push({ questionId: q.id, question: q.text, answer: opt.label, priority: opt.priority });
    }
    priority = higher(priority, opt.priority);
  };

  CORE_QUESTIONS.forEach(consider);

  // Không tỉnh và không thở bình thường (hoặc không rõ) => coi như ngừng tim
  const unconscious = answers.conscious === 'no';
  const notBreathingNormally = answers.breathing === 'none' || answers.breathing === 'unknown';
  if ((unconscious && notBreathingNormally) || answers.breathing === 'none') flags.add('NGUNG_TIM');
  const cardiacArrest = flags.has('NGUNG_TIM');
  if (cardiacArrest) priority = 'P1';

  const group = findGroup(groupId ?? undefined);
  if (group) {
    group.questions.forEach(consider);
    // Mức nền của nhóm chỉ áp dụng khi chưa có gì cao hơn
    priority = higher(priority, group.defaultPriority);
  } else {
    next ??= '__group';
  }

  const p = priority as Priority | null;
  let vehicleType: VehicleType | null = p ? vehicleForPriority(p) : null;
  // Loại xe riêng của nhóm (tư vấn, chuyển viện hẹn) chỉ giữ khi câu sống còn không nâng mã lên
  if (group?.vehicle && p === group.defaultPriority) vehicleType = vehicleOverride ?? group.vehicle;
  if (group?.vehicle === 'ECMO') vehicleType = 'ECMO';

  // Đột quỵ trong cửa sổ tiêu sợi huyết: đề xuất xe đột quỵ có CT (MSU), trừ khi đã ngừng tim
  if (group?.id === 'dot_quy' && flags.has('BEFAST_DUONG_TINH') && !cardiacArrest
      && (flags.has('TRONG_CUA_SO_TSH') || flags.has('CUA_SO_KHONG_RO'))) {
    vehicleType = 'MSU';
  }

  const instructions = cardiacArrest ? [...CPR_INSTRUCTIONS] : [...(group?.instructions ?? [])];
  if (flags.has('HIEN_TRUONG_NGUY_HIEM')) {
    instructions.unshift('Hiện trường nguy hiểm: báo công an/PCCC; xe chờ ở điểm tập kết cho tới khi an toàn.');
  }

  const complete = next === null;
  return {
    protocolVersion: PROTOCOL_VERSION,
    priority: p,
    vehicleType,
    lights: p === 'P1' || p === 'P2',
    earlyActivation: p === 'P1',
    cardiacArrest,
    complete,
    nextQuestionId: next,
    flags: [...flags].sort(),
    reasons,
    instructions,
    notify115: p === 'P1' || p === 'P2',
  };
}
