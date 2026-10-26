-- Kíp (hoặc tổng đài viên) báo nhanh từ hiện trường đông nạn nhân: số nạn nhân theo màu phân loại, chỉ huy hiện trường,
-- nguy hiểm, đường vào, lực lượng cần thêm. Báo lần đầu thì kích hoạt quy trình đông nạn nhân cho ca.
CREATE TABLE mci_scene_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id        uuid NOT NULL REFERENCES incidents(id),
  red                int NOT NULL DEFAULT 0 CHECK (red >= 0),
  yellow             int NOT NULL DEFAULT 0 CHECK (yellow >= 0),
  green              int NOT NULL DEFAULT 0 CHECK (green >= 0),
  black              int NOT NULL DEFAULT 0 CHECK (black >= 0),
  commander_present  boolean NOT NULL DEFAULT false,
  commander_name     text,
  commander_unit     text,
  commander_phone    text,
  hazards            text,
  access             text,
  resources_needed   text,
  note               text,
  vehicle_id         text REFERENCES vehicles(id),
  reported_by        uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mci_scene_reports_incident ON mci_scene_reports(incident_id, created_at DESC);

-- Thông báo gửi tới từng tài khoản (nút chuông): sự kiện cần biết; việc còn quên làm được tính trực tiếp, không lưu ở đây
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  kind         text NOT NULL,
  title        text NOT NULL,
  body         text,
  link         text,
  incident_id  uuid REFERENCES incidents(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
