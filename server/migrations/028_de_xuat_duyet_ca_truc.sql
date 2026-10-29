-- Giai đoạn AB0a: mọi thay đổi danh mục, cấu hình do trưởng nhóm đề xuất, quản trị chỉ duyệt hoặc từ chối.
-- Lúc mới dựng hệ thống chưa khóa (quản trị nhập thẳng, có nhật ký); khi quản trị bật "khóa cấu hình" thì mọi thay đổi đi qua đề xuất.
CREATE TABLE governance_settings (
  id           int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enforced     boolean NOT NULL DEFAULT false,
  enforced_at  timestamptz,
  enforced_by  uuid REFERENCES users(id)
);
INSERT INTO governance_settings DEFAULT VALUES;

CREATE TABLE change_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,                 -- DX-2026-0001
  route          text NOT NULL,                        -- "PATCH /api/stations/:id": thao tác sẽ chạy khi được duyệt
  label          text NOT NULL,                        -- tên dễ đọc: "Sửa điểm", "Bảng giá dịch vụ"...
  method         text NOT NULL,
  url            text NOT NULL,                        -- đường dẫn thật (có tham số)
  body           jsonb,
  before         jsonb,                                -- giá trị hiện tại lúc đề xuất (nếu có) để so trước, sau
  domain         text NOT NULL,                        -- mảng phụ trách (kip, kho, ke_toan...)
  unit_id        int REFERENCES org_units(id),         -- bộ phận của trưởng nhóm đề xuất
  reason         text,
  status         text NOT NULL DEFAULT 'cho_duyet' CHECK (status IN ('cho_duyet', 'dang_ap_dung', 'da_duyet', 'tu_choi', 'rut_lai', 'loi')),
  proposed_by    uuid NOT NULL REFERENCES users(id),
  proposed_at    timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  decision_note  text,
  result         jsonb,
  error          text
);
CREATE INDEX change_requests_status ON change_requests(status, proposed_at DESC);

-- Ca trực do điều phối viên lập: xe nào, trực ở đâu (điểm có sẵn hoặc vị trí tạm), từ giờ nào tới giờ nào, ai ở vị trí nào trong kíp
CREATE TABLE duty_posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  text NOT NULL REFERENCES vehicles(id),
  station_id  text REFERENCES stations(id),
  place       text,                                   -- vị trí tạm: "Sân vận động Thống Nhất", "Ngã tư X"
  lat         double precision,
  lng         double precision,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  note        text,
  equipment   text[] NOT NULL DEFAULT '{}',           -- thiết bị mang thêm cho ca trực
  status      text NOT NULL DEFAULT 'ke_hoach' CHECK (status IN ('ke_hoach', 'huy')),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (station_id IS NOT NULL OR place IS NOT NULL)
);
CREATE INDEX duty_posts_time ON duty_posts(starts_at, ends_at);

CREATE TABLE duty_post_members (
  post_id   uuid NOT NULL REFERENCES duty_posts(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id),
  position  text NOT NULL,                            -- vị trí trong kíp: Trưởng kíp, Điều dưỡng 1...
  PRIMARY KEY (post_id, user_id)
);
