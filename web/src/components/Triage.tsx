export interface Option { value: string; label: string; priority?: string }
export interface Question { id: string; text: string; help?: string; options: Option[]; when?: { q: string; in: string[] } }
export interface Group { id: string; label: string; defaultPriority: string; questions: Question[] }
export interface Protocol { version: string; core: Question[]; groups: Group[]; cprInstructions: string[] }

export interface TriageResult {
  protocolVersion: string; priority: string | null; vehicleType: string | null; lights: boolean; earlyActivation: boolean;
  cardiacArrest: boolean; complete: boolean; nextQuestionId: string | null; flags: string[];
  reasons: { questionId: string; question: string; answer: string; priority?: string }[]; instructions: string[]; notify115: boolean;
}

export const FLAG_LABEL: Record<string, string> = {
  NGUNG_TIM: 'Nghi ngừng tim', TRE_DUOI_1_TUOI: 'Trẻ dưới 1 tuổi (bắt buộc y lệnh trực tuyến nếu nặng)', NGHI_NMCT: 'Nghi nhồi máu cơ tim',
  BEFAST_DUONG_TINH: 'BE-FAST dương tính', TRONG_CUA_SO_TSH: 'Trong cửa sổ tiêu sợi huyết', CUA_SO_LAY_HUYET_KHOI: 'Cửa sổ lấy huyết khối',
  CUA_SO_KHONG_RO: 'Không rõ giờ khởi phát', DUNG_CHONG_DONG: 'Đang dùng chống đông', HIEN_TRUONG_NGUY_HIEM: 'Hiện trường nguy hiểm',
  NHIEU_NAN_NHAN: 'Nhiều nạn nhân', SANH_ROT: 'Sanh rớt', NGO_DOC_NGUY_HIEM: 'Ngộ độc nguy hiểm', TU_HAI: 'Ý định tự hại',
  NGHI_PHAN_VE: 'Nghi phản vệ', CAN_BAC_SI_DI_KEM: 'Cần bác sĩ đi kèm',
};

function QuestionView({ q, value, next, onAnswer }: { q: Question; value?: string; next: boolean; onAnswer: (v: string) => void }) {
  return (
    <div className="q" style={next ? { borderLeft: '3px solid var(--brand)', paddingLeft: 8 } : undefined}>
      <div className="qt">{q.text}</div>
      {q.help && <div className="help">{q.help}</div>}
      <div className="row">
        {q.options.map((o) => (
          <button key={o.value} type="button"
            className={`choice ${value === o.value ? 'sel' : ''} ${value === o.value && o.priority === 'P1' ? 'p1' : ''}`}
            onClick={() => onAnswer(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Màn hình hỏi theo thứ tự cố định: call-taker đọc nguyên văn, bấm câu trả lời; phần mềm tính mã */
export function TriageQuestions({ protocol, answers, group, result, onChange, disabled }: {
  protocol: Protocol; answers: Record<string, string>; group: string | null; result: TriageResult | null;
  onChange: (answers: Record<string, string>, group: string | null) => void; disabled?: boolean;
}) {
  const g = protocol.groups.find((x) => x.id === group);
  const set = (id: string, v: string) => onChange({ ...answers, [id]: v }, group);
  const visible = (q: Question) => !q.when || q.when.in.includes(answers[q.when.q]);
  return (
    <fieldset disabled={disabled} style={{ border: 'none', padding: 0, margin: 0 }}>
      <h3>Câu hỏi sống còn</h3>
      {protocol.core.map((q) => (
        <QuestionView key={q.id} q={q} value={answers[q.id]} next={result?.nextQuestionId === q.id} onAnswer={(v) => set(q.id, v)} />
      ))}
      <h3 style={{ marginTop: 12 }}>Tình trạng chính</h3>
      <div className="row" style={{ marginBottom: 10, ...(result?.nextQuestionId === '__group' ? { outline: '2px solid var(--brand)', borderRadius: 6, padding: 4 } : {}) }}>
        {protocol.groups.map((x) => (
          <button key={x.id} type="button" className={`choice ${group === x.id ? 'sel' : ''}`} onClick={() => onChange(answers, x.id)}>{x.label}</button>
        ))}
      </div>
      {g && g.questions.filter(visible).map((q) => (
        <QuestionView key={q.id} q={q} value={answers[q.id]} next={result?.nextQuestionId === q.id} onAnswer={(v) => set(q.id, v)} />
      ))}
      <div className="small muted">Bộ câu hỏi {protocol.version}. Bản nháp: Hội đồng Chuyên môn phải duyệt trước khi dùng thật.</div>
    </fieldset>
  );
}
