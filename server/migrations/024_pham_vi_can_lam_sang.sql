-- Phạm vi thực hiện theo chức danh: thuốc, can thiệp nào chỉ nhóm chức danh nào được tự làm; người khác muốn làm
-- phải ghi bác sĩ đã trao đổi trên phiếu. Admin chỉnh danh sách, nhóm chức danh từng người, cấp riêng cho từng người.
ALTER TABLE users ADD COLUMN scope_category text
  CHECK (scope_category IN ('bac_si', 'y_si', 'dieu_duong', 'cap_cuu_vien', 'ktv', 'lai_xe', 'khac'));
-- Vai trò trong kíp người này được nhận (để trống = mọi vai trò)
ALTER TABLE users ADD COLUMN crew_roles text[];

CREATE TABLE crew_roles (
  name    text PRIMARY KEY,
  sort    int NOT NULL DEFAULT 0,
  active  boolean NOT NULL DEFAULT true
);
INSERT INTO crew_roles(name, sort) VALUES
  ('Trưởng kíp', 1), ('Bác sĩ', 2), ('Điều dưỡng', 3), ('Y sĩ', 4), ('Cấp cứu viên', 5), ('Kỹ thuật viên', 6), ('Lái xe', 7);

CREATE TABLE scope_rules (
  id          serial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('thuoc', 'can_thiep')),
  -- thuoc: mã thuốc trong danh mục (drugs.id); can_thiep: khóa ô can thiệp trên phiếu (ett, lma, defib...)
  ref         text NOT NULL,
  label       text NOT NULL,
  allowed     text[] NOT NULL DEFAULT '{bac_si}',
  note        text,
  active      boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref)
);

CREATE TABLE scope_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  rule_id     int NOT NULL REFERENCES scope_rules(id) ON DELETE CASCADE,
  note        text,
  expires_on  date,
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX scope_grants_one_active ON scope_grants(user_id, rule_id) WHERE revoked_at IS NULL;

-- Danh mục xét nghiệm tại chỗ, cận lâm sàng có giờ (admin chỉnh)
CREATE TABLE lab_types (
  code         text PRIMARY KEY,
  name         text NOT NULL,
  unit         text,
  normal_low   numeric,
  normal_high  numeric,
  sort         int NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true
);
INSERT INTO lab_types(code, name, unit, normal_low, normal_high, sort) VALUES
  ('glucose', 'Đường huyết mao mạch', 'mmol/L', 3.9, 7.8, 1),
  ('ecg12', 'Điện tim 12 chuyển đạo', NULL, NULL, NULL, 2),
  ('lactate', 'Lactate', 'mmol/L', 0.5, 2.0, 3),
  ('troponin', 'Troponin nhanh', 'ng/L', NULL, 14, 4),
  ('hb', 'Hemoglobin', 'g/L', 120, 170, 5),
  ('ketone', 'Ceton máu', 'mmol/L', NULL, 0.6, 6),
  ('ph', 'Khí máu: pH', NULL, 7.35, 7.45, 7),
  ('k', 'Kali máu', 'mmol/L', 3.5, 5.0, 8),
  ('na', 'Natri máu', 'mmol/L', 135, 145, 9),
  ('inr', 'INR', NULL, 0.8, 1.2, 10),
  ('hcg', 'Thử thai nhanh', NULL, NULL, NULL, 11),
  ('alcohol', 'Nồng độ cồn hơi thở', 'mg/L', NULL, NULL, 12);
