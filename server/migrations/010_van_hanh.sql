-- Giai đoạn I: vận hành cấp cứu ngoại viện
-- Rà soát ca sau cấp cứu (bình ca, just culture), sổ ngừng tuần hoàn ngoài viện theo Utstein, chế độ đông nạn nhân (ICS,
-- phân loại START), hồ sơ và bảo dưỡng xe (QL-19), sao lưu có thử khôi phục và rà soát tài khoản (QL-16), bảo vệ dữ liệu
-- cá nhân (QL-17, NĐ 13/2023), an toàn lao động và PCCC (QL-18).

/* ---------------- Rà soát ca ---------------- */

-- Mỗi ca rà soát một lần; tiêu chí chấm dat | can_cai_thien | khong_dat | khong_ap_dung
CREATE TABLE ops_case_reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,                       -- RSC-YYYY-NNNN
  incident_id    uuid NOT NULL UNIQUE REFERENCES incidents(id),
  reasons        text[] NOT NULL DEFAULT '{}',               -- lý do đưa vào rà soát (tự động hoặc người chọn)
  scores         jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary        text,
  good_practice  text,
  learning       text,
  status         text NOT NULL DEFAULT 'dang_ra_soat' CHECK (status IN ('dang_ra_soat', 'da_xong')),
  reviewer_id    uuid NOT NULL REFERENCES users(id),
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Kíp xem phản hồi và xác nhận đã đọc
CREATE TABLE ops_review_acks (
  review_id  uuid NOT NULL REFERENCES ops_case_reviews(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  comment    text,
  acked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, user_id)
);

ALTER TABLE capa_actions DROP CONSTRAINT IF EXISTS capa_actions_source_check;
ALTER TABLE capa_actions ADD CONSTRAINT capa_actions_source_check CHECK (source IN
  ('su_co', 'khieu_nai', 'danh_gia_noi_bo', 'tieu_chi', 'rui_ro', 'chi_so', 'giam_sat', 'xem_xet_lanh_dao', 'ra_soat_ca', 'dien_tap', 'khac'));
ALTER TABLE capa_actions
  ADD COLUMN case_review_id uuid REFERENCES ops_case_reviews(id),
  ADD COLUMN drill_id       uuid;

/* ---------------- Utstein ---------------- */

-- Dữ liệu tại hiện trường nằm trong ePCR (epcr.arrest); bảng này giữ kết cục tại bệnh viện do QLCL theo dõi
CREATE TABLE ops_arrest_outcomes (
  transfer_id      uuid PRIMARY KEY REFERENCES transfers(id),
  admitted         boolean,                                  -- nhập viện còn sống
  survived_30d     boolean,                                  -- sống 30 ngày hoặc ra viện
  discharged_on    date,
  cpc              int CHECK (cpc BETWEEN 1 AND 5),          -- phân độ chức năng não khi ra viện
  note             text,
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

/* ---------------- Đông nạn nhân ---------------- */

ALTER TABLE incidents
  ADD COLUMN mci_declared_at timestamptz,
  ADD COLUMN mci_declared_by uuid REFERENCES users(id),
  ADD COLUMN mci_level       int CHECK (mci_level BETWEEN 1 AND 3),
  ADD COLUMN mci_note        text,
  ADD COLUMN mci_ended_at    timestamptz,
  ADD COLUMN mci_roles       jsonb NOT NULL DEFAULT '{}'::jsonb;   -- vai trò ICS: chỉ huy, tác nghiệp, kế hoạch, hậu cần, hành chính

-- Nạn nhân theo thẻ phân loại; phiếu chăm sóc (transfer) gắn khi kíp mở phiếu
CREATE TABLE ops_mci_victims (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid NOT NULL REFERENCES incidents(id),
  tag          text NOT NULL,                                -- số thẻ phân loại
  triage       text NOT NULL CHECK (triage IN ('do', 'vang', 'xanh', 'den')),
  sex          text CHECK (sex IN ('M', 'F', 'U')),
  age_group    text,
  note         text,
  status       text NOT NULL DEFAULT 'hien_truong' CHECK (status IN ('hien_truong', 'dang_chuyen', 'da_den_vien', 'tai_cho', 'tu_vong')),
  vehicle_id   text REFERENCES vehicles(id),
  hospital     text,
  transfer_id  uuid REFERENCES transfers(id),
  recorded_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, tag)
);

/* ---------------- Xe: hồ sơ, km, bảo dưỡng ---------------- */

ALTER TABLE vehicles ADD COLUMN odometer_km int, ADD COLUMN odometer_at timestamptz;

-- Giấy tờ có hạn: đăng kiểm, bảo hiểm bắt buộc TNDS, giấy phép thiết bị ưu tiên (đèn, còi)...
CREATE TABLE ops_vehicle_docs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  text NOT NULL REFERENCES vehicles(id),
  kind        text NOT NULL CHECK (kind IN ('dang_kiem', 'bao_hiem_tnds', 'bao_hiem_vat_chat', 'uu_tien', 'phu_hieu', 'khac')),
  number      text,
  issued_on   date,
  expires_on  date NOT NULL,
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_vehicle_docs_idx ON ops_vehicle_docs (vehicle_id, kind, expires_on DESC);

-- Định mức bảo dưỡng theo loại xe: mỗi X km hoặc Y tháng, cái nào đến trước
CREATE TABLE ops_maintenance_plans (
  vehicle_id      text PRIMARY KEY REFERENCES vehicles(id),
  interval_km     int NOT NULL DEFAULT 5000 CHECK (interval_km > 0),
  interval_months int NOT NULL DEFAULT 3 CHECK (interval_months > 0)
);

CREATE TABLE ops_maintenance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id   text NOT NULL REFERENCES vehicles(id),
  kind         text NOT NULL CHECK (kind IN ('dinh_ky', 'sua_chua', 'tai_nan')),
  done_on      date NOT NULL,
  odometer_km  int,
  supplier_id  uuid REFERENCES qm_suppliers(id),
  work         text NOT NULL,
  cost         bigint,
  out_of_service_hours double precision,
  recorded_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_maintenance_idx ON ops_maintenance (vehicle_id, done_on DESC);

-- Km và nhiên liệu ghi đầu/cuối ca
CREATE TABLE ops_odometer (
  id          bigserial PRIMARY KEY,
  vehicle_id  text NOT NULL REFERENCES vehicles(id),
  km          int NOT NULL CHECK (km >= 0),
  fuel_liters double precision,
  fuel_cost   bigint,
  note        text,
  user_id     uuid REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_odometer_idx ON ops_odometer (vehicle_id, at DESC);

/* ---------------- Sao lưu, tài khoản ---------------- */

CREATE TABLE ops_backups (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('sao_luu', 'thu_khoi_phuc')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  file        text,                                          -- tên tệp, không lưu đường dẫn tuyệt đối
  size_bytes  bigint,
  sha256      text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,            -- số dòng các bảng chính khi thử khôi phục
  error       text,
  actor       text
);

ALTER TABLE users ADD COLUMN last_login_at timestamptz;

-- Rà soát quyền truy cập định kỳ (mỗi quý): từng tài khoản giữ, đổi vai trò hay khóa
CREATE TABLE ops_access_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,                         -- RSTK-YYYY-Qn
  reviewer_id  uuid NOT NULL REFERENCES users(id),
  items        jsonb NOT NULL DEFAULT '[]'::jsonb,           -- [{userId, username, role, active, lastLogin, decision, note}]
  status       text NOT NULL DEFAULT 'dang_lam' CHECK (status IN ('dang_lam', 'da_xong')),
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

/* ---------------- Bảo vệ dữ liệu cá nhân ---------------- */

CREATE TABLE pd_activities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,                       -- XL-01...
  name           text NOT NULL,
  purpose        text NOT NULL,
  subjects       text NOT NULL,                              -- người bệnh, người gọi, nhân viên...
  data_basic     text,
  data_sensitive text,                                       -- sức khỏe, vị trí, sinh trắc... (dữ liệu nhạy cảm)
  legal_basis    text NOT NULL,
  recipients     text,
  retention_key  text REFERENCES qm_retention(key),
  cross_border   boolean NOT NULL DEFAULT false,
  safeguards     text,
  owner_id       uuid REFERENCES users(id),
  confirmed      boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pd_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,                        -- YCDL-YYYY-NNN
  kind          text NOT NULL CHECK (kind IN ('xem', 'sua', 'xoa', 'rut_dong_y', 'han_che', 'phan_doi', 'cung_cap')),
  requester     text NOT NULL,
  relation      text,                                        -- chính chủ, người đại diện, cơ quan
  contact       text,
  patient_id    uuid REFERENCES patients(id),
  content       text NOT NULL,
  identity_checked boolean NOT NULL DEFAULT false,
  received_at   timestamptz NOT NULL DEFAULT now(),
  due_at        timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'moi' CHECK (status IN ('moi', 'dang_xu_ly', 'da_tra_loi', 'tu_choi')),
  response      text,
  handled_by    uuid REFERENCES users(id),
  closed_at     timestamptz,
  created_by    uuid REFERENCES users(id)
);

-- Vi phạm dữ liệu: thông báo cơ quan chuyên trách trong 72 giờ (NĐ 13/2023 Điều 23)
CREATE TABLE pd_breaches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,                       -- VPDL-YYYY-NN
  detected_at    timestamptz NOT NULL,
  description    text NOT NULL,
  data_affected  text,
  subjects_count int,
  severity       text NOT NULL CHECK (severity IN ('thap', 'trung_binh', 'cao')),
  containment    text,
  authority_notified_at timestamptz,
  subjects_notified_at  timestamptz,
  status         text NOT NULL DEFAULT 'mo' CHECK (status IN ('mo', 'dong')),
  reported_by    uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Đánh giá tác động xử lý dữ liệu (lập khi có hoạt động xử lý mới hoặc thay đổi)
CREATE TABLE pd_assessments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  activity_id  uuid REFERENCES pd_activities(id),
  assessed_on  date NOT NULL,
  risks        text NOT NULL,
  measures     text NOT NULL,
  conclusion   text,
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

/* ---------------- An toàn lao động, PCCC, diễn tập ---------------- */

CREATE TABLE sf_drills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,                        -- DT-YYYY-NN
  kind          text NOT NULL CHECK (kind IN ('pccc', 'so_tan', 'atld', 'mci_ban', 'mci_thuc_dia', 'khoi_phuc_he_thong', 'mat_lien_lac', 'khac')),
  title         text NOT NULL,
  station_id    text REFERENCES stations(id),
  planned_on    date NOT NULL,
  done_on       date,
  participants  uuid[] NOT NULL DEFAULT '{}',
  duration_min  int,
  scenario      text,
  findings      text,
  result        text CHECK (result IN ('dat', 'can_cai_thien', 'khong_dat')),
  status        text NOT NULL DEFAULT 'ke_hoach' CHECK (status IN ('ke_hoach', 'da_lam', 'huy')),
  lead_id       uuid REFERENCES users(id),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE capa_actions ADD CONSTRAINT capa_actions_drill_fk FOREIGN KEY (drill_id) REFERENCES sf_drills(id);

-- Tai nạn lao động (phơi nhiễm vật sắc nhọn đã có ở KSNK)
CREATE TABLE sf_injuries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,                         -- TNLD-YYYY-NN
  occurred_at  timestamptz NOT NULL,
  staff_user   uuid REFERENCES users(id),
  person       text NOT NULL,
  place        text,
  kind         text NOT NULL CHECK (kind IN ('giao_thong', 'nang_vac', 'te_nga', 'bao_luc', 'hoa_chat', 'dien', 'khac')),
  severity     text NOT NULL CHECK (severity IN ('nhe', 'nang', 'chet_nguoi')),
  description  text NOT NULL,
  days_off     int,
  action       text,
  reported_authority_at timestamptz,
  recorded_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

/* ---------------- Lưu vết GPS ---------------- */

-- Mỗi lần máy tính bảng gửi vị trí (5 giây khi làm nhiệm vụ, 30 giây khi trực) và mỗi lần đổi trạng thái có tọa độ
CREATE TABLE ops_gps_track (
  id           bigserial PRIMARY KEY,
  vehicle_id   text NOT NULL REFERENCES vehicles(id),
  incident_id  uuid REFERENCES incidents(id),
  status       text,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  accuracy_m   double precision,
  speed_kmh    double precision,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_gps_track_vehicle_idx ON ops_gps_track (vehicle_id, at);
CREATE INDEX ops_gps_track_incident_idx ON ops_gps_track (incident_id, at) WHERE incident_id IS NOT NULL;

CREATE TABLE ops_settings (
  key         text PRIMARY KEY,
  value       jsonb,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
