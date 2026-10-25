/* Giai đoạn L: xác thực hai lớp bằng ứng dụng điện thoại (TOTP) và hạn mức phê duyệt */

/* ---------------- Xác thực hai lớp ---------------- */

ALTER TABLE users ADD COLUMN totp_secret_enc  text;          -- khóa TOTP đã mã hóa AES-GCM (khóa MEDONE_DATA_KEY)
ALTER TABLE users ADD COLUMN totp_pending_enc text;          -- khóa đang cài, chưa xác nhận bằng mã đầu tiên
ALTER TABLE users ADD COLUMN totp_enabled_at  timestamptz;
ALTER TABLE users ADD COLUMN totp_last_step   bigint;        -- bước thời gian của mã đã dùng gần nhất, chặn dùng lại mã
ALTER TABLE users ADD COLUMN totp_recovery    text[] NOT NULL DEFAULT '{}';  -- SHA-256 của mã dự phòng còn dùng được
ALTER TABLE users ADD COLUMN mfa_failed       int NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_locked_until timestamptz;

-- Một dòng: vai trò bắt buộc bật xác thực hai lớp, và có đang bắt buộc hay chưa (admin bật khi mọi người đã cài xong)
CREATE TABLE security_settings (
  id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mfa_roles   text[] NOT NULL DEFAULT '{dispatcher,supervisor,accountant,director,admin}',
  mfa_enforce boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO security_settings(id) VALUES (1);

/* ---------------- Hạn mức phê duyệt ---------------- */

-- mien_giam: số tiền miễn/giảm tối đa mỗi khoản thu người có vai trò này được duyệt (đồng)
-- rut_xe, huy_ca: số lần mỗi ngày được làm mà không cần trưởng ca hậu kiểm. NULL = không giới hạn
CREATE TABLE approval_limits (
  action     text NOT NULL CHECK (action IN ('mien_giam', 'rut_xe', 'huy_ca')),
  role       text NOT NULL,
  max_value  numeric(14,0) CHECK (max_value IS NULL OR max_value >= 0),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action, role)
);
-- Mặc định (bản nháp, Ban Giám đốc chỉnh ở trang Bảo mật và hạn mức)
INSERT INTO approval_limits(action, role, max_value) VALUES
  ('mien_giam', 'accountant', 500000),
  ('mien_giam', 'director', NULL),
  ('rut_xe', 'dispatcher', 0),
  ('rut_xe', 'supervisor', NULL),
  ('rut_xe', 'admin', NULL),
  ('huy_ca', 'calltaker', 0),
  ('huy_ca', 'dispatcher', 0),
  ('huy_ca', 'supervisor', NULL),
  ('huy_ca', 'admin', NULL);

-- Hậu kiểm: việc khẩn (rút xe, hủy ca đã có xe) làm ngay, vượt hạn mức thì trưởng ca xem lại sau
CREATE TABLE approval_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action      text NOT NULL CHECK (action IN ('rut_xe', 'huy_ca')),
  incident_id uuid REFERENCES incidents(id),
  vehicle_id  text REFERENCES vehicles(id),
  reason      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'cho_xem' CHECK (status IN ('cho_xem', 'dong_y', 'khong_dong_y')),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  note        text
);
CREATE INDEX approval_reviews_open ON approval_reviews(created_at) WHERE status = 'cho_xem';
CREATE INDEX approval_reviews_user_day ON approval_reviews(created_by, action, created_at);

-- Đếm số lần làm trong ngày (kể cả lần trong hạn mức, không cần hậu kiểm) để so với hạn mức
CREATE TABLE approval_usage (
  id         bigserial PRIMARY KEY,
  action     text NOT NULL,
  user_id    uuid NOT NULL REFERENCES users(id),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_usage_user_day ON approval_usage(user_id, action, at);
