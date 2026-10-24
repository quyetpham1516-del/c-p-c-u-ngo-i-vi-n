/**
 * Bộ câu hỏi phân loại theo tiêu chí (CBD) — BẢN NHÁP để dựng phần mềm.
 *
 * Nội dung lâm sàng ở đây chỉ là khung khởi đầu theo mục 5.4 và 5.11 của kế hoạch. Trước khi dùng
 * thật, Hội đồng Chuyên môn phải duyệt từng câu, chạy thử trên tối thiểu 500 bản ghi âm thật và đo
 * tỷ lệ phân loại thiếu. Mọi thay đổi đi qua Hội đồng kiểm soát thay đổi (IEC 62304 / ISO 14971):
 * đổi nội dung thì phải tăng PROTOCOL_VERSION, vì mỗi ca lưu phiên bản bộ câu hỏi đã dùng.
 */

export type Priority = 'P1' | 'P2' | 'P3' | 'P4' | 'HEN';
export type VehicleType = 'ALS' | 'BLS' | 'MSU' | 'ECMO' | 'VC' | 'NONE';

export const PROTOCOL_VERSION = 'CBD-VN-0.1-nhap';

export interface Option {
  value: string;
  label: string;
  priority?: Priority;
  vehicle?: VehicleType;
  flags?: string[];
}

export interface Question {
  id: string;
  text: string;
  help?: string;
  options: Option[];
  /** Chỉ hỏi khi câu khác có một trong các giá trị này */
  when?: { q: string; in: string[] };
}

export interface ComplaintGroup {
  id: string;
  label: string;
  defaultPriority: Priority;
  /** Loại xe cố định cho nhóm (ghi đè ánh xạ theo mã ưu tiên) */
  vehicle?: VehicleType;
  questions: Question[];
  instructions: string[];
}

/** "Không rõ" được xử lý như "Có" (thiên về phân loại cao, tránh phân loại thiếu) */
const YES_NO = (yes: Omit<Option, 'value' | 'label'>, no: Omit<Option, 'value' | 'label'> = {}): Option[] => [
  { value: 'yes', label: 'Có', ...yes },
  { value: 'no', label: 'Không', ...no },
  { value: 'unknown', label: 'Không rõ', ...yes },
];

/** Câu hỏi sống còn: luôn hỏi trước, ngay sau địa chỉ và số gọi lại */
export const CORE_QUESTIONS: Question[] = [
  {
    id: 'conscious',
    text: 'Người bệnh có tỉnh không? (gọi hỏi có trả lời không)',
    options: [
      { value: 'yes', label: 'Tỉnh, nói chuyện được' },
      { value: 'altered', label: 'Lơ mơ, lú lẫn, khó đánh thức', priority: 'P2' },
      { value: 'no', label: 'Không tỉnh, gọi không đáp', priority: 'P1' },
      { value: 'unknown', label: 'Không rõ (người gọi không ở cạnh)', priority: 'P2' },
    ],
  },
  {
    id: 'breathing',
    text: 'Người bệnh có thở bình thường không?',
    help: 'Thở ngáp, thở rời rạc = KHÔNG thở bình thường.',
    options: [
      { value: 'normal', label: 'Thở bình thường' },
      { value: 'difficult', label: 'Khó thở, thở rít, nói không thành câu', priority: 'P2' },
      { value: 'none', label: 'Không thở hoặc thở ngáp', priority: 'P1', flags: ['NGUNG_TIM'] },
      { value: 'unknown', label: 'Không rõ', priority: 'P2' },
    ],
  },
  {
    id: 'age_group',
    text: 'Người bệnh bao nhiêu tuổi?',
    options: [
      { value: 'adult', label: 'Từ 16 tuổi trở lên' },
      { value: 'child', label: 'Từ 1 đến 15 tuổi' },
      { value: 'infant', label: 'Dưới 1 tuổi', flags: ['TRE_DUOI_1_TUOI'] },
    ],
  },
];

export const CPR_INSTRUCTIONS = [
  'Đặt người bệnh nằm ngửa trên mặt phẳng cứng.',
  'Đặt hai tay chồng lên nhau ở giữa ngực, ấn sâu 5–6 cm, nhịp 100–120 lần/phút, theo tiếng đếm của điều phối viên.',
  'Không dừng ép tim cho tới khi kíp cấp cứu tới hoặc người bệnh tỉnh lại.',
  'Nhờ người khác mở cửa, đón xe và tìm máy sốc điện tự động (AED) gần nhất nếu có.',
];

export const GROUPS: ComplaintGroup[] = [
  {
    id: 'dau_nguc',
    label: 'Đau ngực',
    defaultPriority: 'P3',
    questions: [
      { id: 'cp_severe', text: 'Đau dữ dội hoặc kéo dài trên 5 phút, kèm vã mồ hôi, khó thở, hoặc lan lên hàm/tay?', options: YES_NO({ priority: 'P2', flags: ['NGHI_NMCT'] }) },
      { id: 'cp_risk', text: 'Tuổi từ 35 trở lên, hoặc có bệnh tim, tăng huyết áp, đái tháo đường?', options: YES_NO({ priority: 'P2' }) },
      { id: 'cp_shock', text: 'Có ngất, da tái lạnh, hoặc vã mồ hôi lạnh?', options: YES_NO({ priority: 'P1' }) },
    ],
    instructions: [
      'Cho người bệnh ngồi hoặc nằm nghỉ, không đi lại, không tự lái xe đến viện.',
      'Mở cửa, bật đèn, chuẩn bị đơn thuốc và giấy tờ khám trước đây.',
      'Chỉ cho nhai aspirin khi bác sĩ EOC đồng ý và người bệnh không dị ứng.',
      'Nếu người bệnh ngất, không thở bình thường: báo ngay cho điều phối viên để hướng dẫn ép tim.',
    ],
  },
  {
    id: 'dot_quy',
    label: 'Dấu hiệu đột quỵ',
    defaultPriority: 'P3',
    questions: [
      { id: 'st_face', text: 'Méo miệng, mặt lệch một bên?', options: YES_NO({ priority: 'P2', flags: ['BEFAST_DUONG_TINH'] }) },
      { id: 'st_arm', text: 'Yếu hoặc tê tay/chân một bên?', options: YES_NO({ priority: 'P2', flags: ['BEFAST_DUONG_TINH'] }) },
      { id: 'st_speech', text: 'Nói khó, nói ngọng, không hiểu lời nói?', options: YES_NO({ priority: 'P2', flags: ['BEFAST_DUONG_TINH'] }) },
      { id: 'st_balance_eyes', text: 'Đột ngột chóng mặt, mất thăng bằng, hoặc nhìn mờ/mất thị lực?', options: YES_NO({ priority: 'P2', flags: ['BEFAST_DUONG_TINH'] }) },
      {
        id: 'st_lkw',
        text: 'Lần cuối cùng người nhà thấy người bệnh bình thường là cách đây bao lâu?',
        help: 'Nếu khởi phát khi ngủ, tính từ lúc đi ngủ.',
        options: [
          { value: 'lt4h5', label: 'Dưới 4 giờ 30 phút', flags: ['TRONG_CUA_SO_TSH'] },
          { value: '4h5_24h', label: 'Từ 4 giờ 30 phút đến 24 giờ', flags: ['CUA_SO_LAY_HUYET_KHOI'] },
          { value: 'gt24h', label: 'Trên 24 giờ' },
          { value: 'unknown', label: 'Không rõ', flags: ['CUA_SO_KHONG_RO'] },
        ],
      },
      { id: 'st_anticoag', text: 'Người bệnh có đang dùng thuốc chống đông (warfarin, rivaroxaban, apixaban, dabigatran...)?', options: [
        { value: 'yes', label: 'Có', flags: ['DUNG_CHONG_DONG'] },
        { value: 'no', label: 'Không' },
        { value: 'unknown', label: 'Không rõ' },
      ] },
    ],
    instructions: [
      'Ghi lại chính xác giờ cuối cùng thấy người bệnh bình thường.',
      'Không cho ăn, uống, kể cả thuốc.',
      'Nếu người bệnh nôn, đặt nằm nghiêng an toàn.',
      'Chuẩn bị danh sách thuốc đang dùng, đặc biệt thuốc chống đông.',
    ],
  },
  {
    id: 'kho_tho',
    label: 'Khó thở',
    defaultPriority: 'P3',
    questions: [
      { id: 'br_sentence', text: 'Người bệnh có nói được trọn một câu không?', options: [
        { value: 'yes', label: 'Nói được trọn câu' },
        { value: 'no', label: 'Không nói được trọn câu', priority: 'P1' },
        { value: 'unknown', label: 'Không rõ', priority: 'P2' },
      ] },
      { id: 'br_cyanosis', text: 'Môi hoặc da tím tái?', options: YES_NO({ priority: 'P1' }) },
      { id: 'br_sudden', text: 'Khởi phát đột ngột, kèm đau ngực, sưng mặt/môi, hoặc có hen/COPD nặng?', options: YES_NO({ priority: 'P2' }) },
    ],
    instructions: [
      'Để người bệnh ngồi tư thế dễ thở nhất, nới lỏng quần áo.',
      'Nếu có bình xịt hen được kê cho người bệnh, cho dùng theo đơn.',
      'Mở cửa thoáng, tránh khói.',
    ],
  },
  {
    id: 'chan_thuong',
    label: 'Chấn thương, tai nạn giao thông',
    defaultPriority: 'P3',
    questions: [
      { id: 'tr_danger', text: 'Hiện trường còn nguy hiểm (cháy, điện, sập, ẩu đả, có vũ khí)?', options: YES_NO({ flags: ['HIEN_TRUONG_NGUY_HIEM'] }) },
      { id: 'tr_bleeding', text: 'Chảy máu ồ ạt không cầm được?', options: YES_NO({ priority: 'P1' }) },
      { id: 'tr_penetrating', text: 'Vết thương đâm xuyên ở đầu, cổ, ngực hoặc bụng?', options: YES_NO({ priority: 'P1' }) },
      { id: 'tr_mechanism', text: 'Cơ chế nặng: va chạm tốc độ cao, văng khỏi xe, bị kẹt, ngã cao trên 3 mét?', options: YES_NO({ priority: 'P2' }) },
      { id: 'tr_head', text: 'Chấn thương đầu kèm nôn, co giật, hoặc lơ mơ dần?', options: YES_NO({ priority: 'P2' }) },
      { id: 'tr_victims', text: 'Có từ 5 người bị thương nặng trở lên?', options: YES_NO({ priority: 'P1', flags: ['NHIEU_NAN_NHAN'] }) },
    ],
    instructions: [
      'Không tự di chuyển nạn nhân nếu nghi chấn thương cột sống, trừ khi có nguy hiểm tại chỗ.',
      'Dùng khăn sạch ép chặt vào vết thương đang chảy máu.',
      'Không rút dị vật đang cắm vào cơ thể.',
      'Không tự vào khu vực nguy hiểm; chờ công an, PCCC.',
    ],
  },
  {
    id: 'chay_mau',
    label: 'Chảy máu (không do chấn thương)',
    defaultPriority: 'P3',
    questions: [
      { id: 'bl_massive', text: 'Chảy máu ồ ạt, không cầm được?', options: YES_NO({ priority: 'P1' }) },
      { id: 'bl_gi', text: 'Nôn ra máu, ho ra máu lượng nhiều, hoặc đi ngoài phân đen?', options: YES_NO({ priority: 'P2' }) },
      { id: 'bl_shock', text: 'Có ngất, choáng, da tái lạnh?', options: YES_NO({ priority: 'P1' }) },
    ],
    instructions: ['Ép chặt vào chỗ chảy máu bằng khăn sạch.', 'Cho người bệnh nằm, kê chân cao nếu không khó thở.', 'Không cho ăn uống.'],
  },
  {
    id: 'san_khoa',
    label: 'Sản khoa',
    defaultPriority: 'P3',
    questions: [
      { id: 'ob_bleeding', text: 'Chảy máu âm đạo nhiều (thấm ướt hơn 1 băng vệ sinh trong 1 giờ)?', options: YES_NO({ priority: 'P1' }) },
      { id: 'ob_seizure', text: 'Co giật, đau đầu dữ dội hoặc nhìn mờ khi đang có thai/mới sinh?', options: YES_NO({ priority: 'P1' }) },
      { id: 'ob_crowning', text: 'Đang rặn, thấy đầu em bé hoặc em bé đã ra ngoài?', options: YES_NO({ priority: 'P2', flags: ['SANH_ROT'] }) },
      { id: 'ob_preterm', text: 'Thai dưới 37 tuần mà vỡ ối hoặc đau bụng từng cơn?', options: YES_NO({ priority: 'P2' }) },
    ],
    instructions: [
      'Chuẩn bị khăn sạch, khô và ấm.',
      'Nếu em bé đã ra: lau khô, đặt áp da lên ngực mẹ, giữ ấm; không kéo dây rốn.',
      'Không để sản phụ đi lại nếu đang chảy máu nhiều.',
    ],
  },
  {
    id: 'tre_em',
    label: 'Trẻ em: sốt, co giật, khó thở',
    defaultPriority: 'P3',
    questions: [
      { id: 'pd_seizure', text: 'Trẻ đang co giật kéo dài trên 5 phút?', options: YES_NO({ priority: 'P1' }) },
      { id: 'pd_resp', text: 'Trẻ tím tái, rút lõm lồng ngực, hoặc thở rất nhanh?', options: YES_NO({ priority: 'P1' }) },
      { id: 'pd_young_fever', text: 'Trẻ dưới 3 tháng tuổi sốt từ 38°C trở lên?', options: YES_NO({ priority: 'P2' }) },
      { id: 'pd_dehydration', text: 'Không đi tiểu trên 8 giờ, mắt trũng, li bì?', options: YES_NO({ priority: 'P2' }) },
    ],
    instructions: [
      'Đang co giật: đặt trẻ nằm nghiêng, không cho gì vào miệng, không giữ chặt tay chân.',
      'Nới bớt quần áo, lau mát bằng nước ấm nếu sốt cao.',
    ],
  },
  {
    id: 'ngo_doc',
    label: 'Ngộ độc, quá liều',
    defaultPriority: 'P3',
    questions: [
      { id: 'tx_agent', text: 'Nghi ngộ độc thuốc trừ sâu, rượu pha methanol, khí CO, hoặc nọc rắn?', options: YES_NO({ priority: 'P2', flags: ['NGO_DOC_NGUY_HIEM'] }) },
      { id: 'tx_selfharm', text: 'Người bệnh có ý định tự hại?', options: YES_NO({ priority: 'P2', flags: ['TU_HAI'] }) },
      { id: 'tx_gas', text: 'Có khí độc hoặc mùi lạ trong phòng kín?', options: YES_NO({ flags: ['HIEN_TRUONG_NGUY_HIEM'] }) },
    ],
    instructions: [
      'Không gây nôn.',
      'Giữ lại vỏ thuốc, chai, bao bì để kíp mang theo.',
      'Nghi khí độc: không vào phòng kín, mở cửa từ bên ngoài nếu an toàn.',
    ],
  },
  {
    id: 'co_giat',
    label: 'Co giật (người lớn)',
    defaultPriority: 'P3',
    questions: [
      { id: 'sz_ongoing', text: 'Đang co giật trên 5 phút, hoặc co giật liên tiếp không tỉnh giữa các cơn?', options: YES_NO({ priority: 'P1' }) },
      { id: 'sz_risk', text: 'Co giật lần đầu, đang có thai, sau chấn thương đầu, hoặc bị đái tháo đường?', options: YES_NO({ priority: 'P2' }) },
    ],
    instructions: ['Dọn vật cứng xung quanh, không cho gì vào miệng.', 'Hết cơn: đặt nằm nghiêng an toàn, theo dõi nhịp thở.'],
  },
  {
    id: 'phan_ve',
    label: 'Dị ứng, phản vệ',
    defaultPriority: 'P3',
    questions: [
      { id: 'an_airway', text: 'Sưng môi, lưỡi, họng, khò khè hoặc khó thở?', options: YES_NO({ priority: 'P1', flags: ['NGHI_PHAN_VE'] }) },
      { id: 'an_shock', text: 'Choáng, ngất, da lạnh?', options: YES_NO({ priority: 'P1', flags: ['NGHI_PHAN_VE'] }) },
      { id: 'an_rash', text: 'Nổi mẩn toàn thân ngay sau tiêm, ăn hoặc côn trùng đốt?', options: YES_NO({ priority: 'P2' }) },
    ],
    instructions: [
      'Nếu người bệnh có bút tiêm adrenalin được kê, tiêm ngay vào mặt ngoài đùi.',
      'Không khó thở: nằm, kê chân cao. Khó thở: để ngồi.',
      'Tránh xa tác nhân nghi gây dị ứng.',
    ],
  },
  {
    id: 'dau_bung',
    label: 'Đau bụng',
    defaultPriority: 'P3',
    questions: [
      { id: 'ab_shock', text: 'Đau dữ dội kèm ngất, da tái lạnh?', options: YES_NO({ priority: 'P2' }) },
      { id: 'ab_bleed', text: 'Nôn ra máu hoặc đi ngoài phân đen?', options: YES_NO({ priority: 'P2' }) },
      { id: 'ab_ectopic', text: 'Phụ nữ trễ kinh, đau bụng dưới dữ dội?', options: YES_NO({ priority: 'P2' }) },
    ],
    instructions: ['Không cho ăn uống.', 'Không tự dùng thuốc giảm đau.'],
  },
  {
    id: 'bong',
    label: 'Bỏng',
    defaultPriority: 'P3',
    questions: [
      { id: 'bu_large', text: 'Bỏng rộng (hơn một cánh tay), bỏng mặt, hoặc hít phải khói?', options: YES_NO({ priority: 'P2' }) },
      { id: 'bu_electric', text: 'Bỏng điện hoặc bỏng hóa chất?', options: YES_NO({ priority: 'P2', flags: ['HIEN_TRUONG_NGUY_HIEM'] }) },
    ],
    instructions: ['Xả nước mát (không phải nước đá) lên vùng bỏng 20 phút.', 'Không bôi kem đánh răng, mỡ, nước mắm.', 'Bỏng điện: ngắt nguồn điện trước khi chạm vào người bệnh.'],
  },
  {
    id: 'khac',
    label: 'Khác / chưa rõ',
    defaultPriority: 'P3',
    questions: [
      { id: 'ot_worse', text: 'Tình trạng có xấu đi nhanh trong vài giờ gần đây?', options: YES_NO({ priority: 'P2' }) },
    ],
    instructions: ['Giữ máy, điều phối viên sẽ hỏi thêm.', 'Gọi lại ngay nếu người bệnh xấu đi.'],
  },
  {
    id: 'tu_van',
    label: 'Chỉ cần tư vấn qua điện thoại',
    defaultPriority: 'P4',
    vehicle: 'NONE',
    questions: [],
    instructions: ['Điều dưỡng tư vấn gọi lại trong vòng 60 phút.'],
  },
  {
    id: 'chuyen_vien',
    label: 'Chuyển viện theo hẹn, đưa về nhà',
    defaultPriority: 'HEN',
    vehicle: 'VC',
    questions: [
      { id: 'tf_als', text: 'Người bệnh đang thở máy, dùng thuốc vận mạch, hoặc cần bác sĩ đi kèm?', options: YES_NO({ vehicle: 'ALS', flags: ['CAN_BAC_SI_DI_KEM'] }) },
    ],
    instructions: ['Hẹn giờ đón với khoa đang điều trị; chuẩn bị giấy chuyển viện và tóm tắt bệnh án.'],
  },
  {
    id: 'ecmo',
    label: 'Chuyển người bệnh đang chạy ECMO',
    defaultPriority: 'P2',
    vehicle: 'ECMO',
    questions: [],
    instructions: ['Liên hệ bác sĩ điều trị để thống nhất giờ đón và thông số máy.'],
  },
];

export function findGroup(id: string | undefined): ComplaintGroup | undefined {
  return GROUPS.find((g) => g.id === id);
}

/** Mô tả bộ câu hỏi gửi xuống giao diện (không chứa hàm) */
export function protocolDescriptor() {
  return { version: PROTOCOL_VERSION, core: CORE_QUESTIONS, groups: GROUPS, cprInstructions: CPR_INSTRUCTIONS };
}
