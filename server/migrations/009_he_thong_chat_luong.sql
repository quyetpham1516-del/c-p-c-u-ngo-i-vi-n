-- Giai đoạn H: hệ thống quản lý chất lượng theo ISO 9001 / tiêu chí chất lượng.
-- Rủi ro (QLCL-04), đánh giá nội bộ (QLCL-09), khắc phục phòng ngừa dùng chung (QLCL-10), bộ chỉ số (QLCL-11),
-- giám sát tuân thủ bằng gọi lại ngẫu nhiên (QLCL-12), đánh giá nhà cung cấp (QLCL-17), xem xét của lãnh đạo (QLCL-18),
-- thời hạn lưu hồ sơ (QLCL-02).

/* ---------------- Sổ đăng ký rủi ro ---------------- */

-- Mức rủi ro = khả năng (1–5) × hậu quả (1–5): từ 15 là cao, 8–14 trung bình, dưới 8 thấp. Rà soát lại 6 tháng một lần
CREATE TABLE qm_risks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,                     -- RR-0001
  area            text NOT NULL,                            -- dịch vụ, khâu: tiếp nhận cuộc gọi, vận chuyển, thuốc...
  hazard          text NOT NULL,                            -- mối nguy
  cause           text,
  consequence     text,
  likelihood      int NOT NULL CHECK (likelihood BETWEEN 1 AND 5),
  impact          int NOT NULL CHECK (impact BETWEEN 1 AND 5),
  score           int GENERATED ALWAYS AS (likelihood * impact) STORED,
  controls        text,                                     -- biện pháp kiểm soát đang có
  owner_id        uuid REFERENCES users(id),
  review_months   int NOT NULL DEFAULT 6 CHECK (review_months BETWEEN 1 AND 24),
  reviewed_on     date NOT NULL DEFAULT vn_today(),
  status          text NOT NULL DEFAULT 'mo' CHECK (status IN ('mo', 'dong')),
  source          text,                                     -- ghi chú nguồn mẫu cần chuyên môn xác nhận
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Lịch sử đánh giá lại: giữ mức cũ để thấy rủi ro giảm sau khắc phục
CREATE TABLE qm_risk_reviews (
  id          bigserial PRIMARY KEY,
  risk_id     uuid NOT NULL REFERENCES qm_risks(id),
  reviewed_on date NOT NULL,
  likelihood  int NOT NULL,
  impact      int NOT NULL,
  note        text,
  reviewed_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

/* ---------------- Đánh giá nội bộ ---------------- */

CREATE TABLE qm_audits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,                    -- DGNB-2026-01
  year             int NOT NULL,
  title            text NOT NULL,
  scope            text,                                    -- quy trình, tiêu chí được đánh giá
  audited_unit     text NOT NULL,                           -- bộ phận được đánh giá
  audited_roles    text[] NOT NULL DEFAULT '{}',            -- vai trò thuộc bộ phận đó: đánh giá viên không được có vai trò này
  audited_station  text REFERENCES stations(id),
  planned_month    int NOT NULL CHECK (planned_month BETWEEN 1 AND 12),
  lead_id          uuid REFERENCES users(id),
  auditor_ids      uuid[] NOT NULL DEFAULT '{}',
  checklist        jsonb NOT NULL DEFAULT '[]',             -- [{q, ref, result: dat|khong_dat|khong_ap_dung, note}]
  performed_on     date,
  summary          text,
  status           text NOT NULL DEFAULT 'ke_hoach' CHECK (status IN ('ke_hoach', 'dang_danh_gia', 'da_bao_cao', 'dong', 'huy')),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);

-- Phát hiện: không phù hợp phải có hành động khắc phục trước khi đóng cuộc đánh giá
CREATE TABLE qm_findings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id    uuid NOT NULL REFERENCES qm_audits(id),
  code        text NOT NULL UNIQUE,                         -- DGNB-2026-01/03
  kind        text NOT NULL CHECK (kind IN ('nc_lon', 'nc_nho', 'luu_y', 'diem_manh')),
  reference   text,                                         -- điều khoản, quy trình, tiêu chí
  description text NOT NULL,
  evidence    text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

/* ---------------- Bộ chỉ số chất lượng ---------------- */

CREATE TABLE qm_indicators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,                         -- CS-01
  name        text NOT NULL,
  definition  text,
  formula     text,                                         -- tử số / mẫu số
  unit        text NOT NULL DEFAULT '%',
  direction   text NOT NULL DEFAULT 'cao_tot' CHECK (direction IN ('cao_tot', 'thap_tot')),
  target      double precision NOT NULL,
  warn        double precision,                                      -- ngưỡng cảnh báo trước khi chạm chỉ tiêu
  auto_key    text,                                         -- tính tự động từ dữ liệu; rỗng là nhập tay
  owner_id    uuid REFERENCES users(id),
  active      boolean NOT NULL DEFAULT true,
  ordinal     int NOT NULL DEFAULT 0,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE qm_indicator_values (
  indicator_id uuid NOT NULL REFERENCES qm_indicators(id),
  period       text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  value        double precision,
  numerator    double precision,
  denominator  double precision,
  note         text,
  auto         boolean NOT NULL DEFAULT false,
  entered_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (indicator_id, period)
);

/* ---------------- Giám sát tuân thủ: gọi lại ngẫu nhiên ---------------- */

CREATE TABLE qm_callback_rounds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,                         -- GS-2026-10
  date_from   date NOT NULL,
  date_to     date NOT NULL,
  sample_pct  double precision NOT NULL DEFAULT 10,
  population  int NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE qm_callbacks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id      uuid NOT NULL REFERENCES qm_callback_rounds(id),
  incident_id   uuid NOT NULL REFERENCES incidents(id),
  checks        jsonb NOT NULL DEFAULT '{}',                -- kiểm tra tự động hồ sơ: phiếu đã ký, đủ mốc thời gian, thời gian hiện trường...
  status        text NOT NULL DEFAULT 'cho_goi' CHECK (status IN ('cho_goi', 'da_goi', 'khong_lien_lac')),
  confirmed     boolean,                                    -- người nhà xác nhận có được phục vụ
  attitude      int CHECK (attitude BETWEEN 1 AND 5),
  issues        text,
  called_by     uuid REFERENCES users(id),
  called_at     timestamptz,
  UNIQUE (round_id, incident_id)
);

/* ---------------- Nhà cung cấp, đối tác ---------------- */

CREATE TABLE qm_suppliers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  category       text NOT NULL CHECK (category IN ('xe', 'thuoc_vat_tu', 'thiet_bi', 'xet_nghiem', 'benh_vien', 'phan_mem', 'dich_vu', 'khac')),
  contact        text,
  contract_until date,
  status         text NOT NULL DEFAULT 'duoc_duyet' CHECK (status IN ('duoc_duyet', 'theo_doi', 'ngung')),
  note           text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Chấm 5 tiêu chí 1–5 điểm; từ 70% đạt, 50–69% theo dõi, dưới 50% không đạt
CREATE TABLE qm_supplier_evals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id  uuid NOT NULL REFERENCES qm_suppliers(id),
  period       text NOT NULL,                               -- 2026 hoặc 2026-H2
  scores       jsonb NOT NULL,                              -- {chat_luong, dung_hen, gia, phuc_vu, phap_ly}
  pct          double precision NOT NULL,
  result       text NOT NULL CHECK (result IN ('dat', 'theo_doi', 'khong_dat')),
  note         text,
  evaluated_by uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, period)
);

/* ---------------- Xem xét của lãnh đạo ---------------- */

CREATE TABLE qm_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,                        -- XXLD-2026-Q4
  date_from    date NOT NULL,
  date_to      date NOT NULL,
  meeting_on   date NOT NULL,
  chair_id     uuid REFERENCES users(id),
  attendees    text,
  inputs       jsonb NOT NULL DEFAULT '{}',                 -- số liệu đầu vào tự lấy, chốt cố định khi ký biên bản
  conclusions  text,
  status       text NOT NULL DEFAULT 'du_thao' CHECK (status IN ('du_thao', 'da_chot')),
  signed_by    uuid REFERENCES users(id),
  signed_at    timestamptz,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

/* ---------------- Khắc phục, phòng ngừa dùng chung ---------------- */

ALTER TABLE capa_actions DROP CONSTRAINT IF EXISTS capa_actions_check;
ALTER TABLE capa_actions
  ADD COLUMN source       text NOT NULL DEFAULT 'khac' CHECK (source IN ('su_co', 'khieu_nai', 'danh_gia_noi_bo', 'tieu_chi', 'rui_ro', 'chi_so', 'giam_sat', 'xem_xet_lanh_dao', 'khac')),
  ADD COLUMN finding_id   uuid REFERENCES qm_findings(id),
  ADD COLUMN risk_id      uuid REFERENCES qm_risks(id),
  ADD COLUMN review_id    uuid REFERENCES qm_reviews(id),
  ADD COLUMN callback_id  uuid REFERENCES qm_callbacks(id),
  ADD COLUMN indicator_id uuid REFERENCES qm_indicators(id),
  ADD COLUMN source_ref   text,                             -- mã tiêu chí, kỳ chỉ số... khi không có bảng riêng
  ADD COLUMN root_cause   text,
  -- Kiểm tra hiệu quả: người khác người phụ trách xác nhận sau khi xong; không hiệu quả thì mở lại
  ADD COLUMN verify_due   date,
  ADD COLUMN verified_at  timestamptz,
  ADD COLUMN verified_by  uuid REFERENCES users(id),
  ADD COLUMN effective    boolean,
  ADD COLUMN verify_note  text;
UPDATE capa_actions SET source = CASE WHEN event_id IS NOT NULL THEN 'su_co' ELSE 'khieu_nai' END;
ALTER TABLE capa_actions DROP CONSTRAINT IF EXISTS capa_actions_status_check;
ALTER TABLE capa_actions ADD CONSTRAINT capa_actions_status_check CHECK (status IN ('mo', 'xong', 'da_xac_nhan', 'huy'));
CREATE INDEX capa_actions_source_idx ON capa_actions (source, status);

/* ---------------- Thời hạn lưu hồ sơ ---------------- */

CREATE TABLE qm_retention (
  key         text PRIMARY KEY,
  label       text NOT NULL,
  years       int NOT NULL CHECK (years BETWEEN 1 AND 100),
  basis       text,
  confirmed   boolean NOT NULL DEFAULT false,               -- QLCL đã đối chiếu căn cứ pháp lý
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Biên bản hủy hồ sơ hết hạn lưu: phần mềm không tự xóa dữ liệu, chỉ ghi nhận quyết định của Hội đồng
CREATE TABLE qm_disposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_key   text NOT NULL REFERENCES qm_retention(key),
  before_date  date NOT NULL,
  records      int NOT NULL,
  decision     text NOT NULL,
  approved_by  uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
