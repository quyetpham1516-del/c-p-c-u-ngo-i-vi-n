/* Giai đoạn Q: sơ đồ tổ chức (bộ phận, nhóm, trưởng nhóm) và báo cáo theo cấp: trưởng nhóm lập, cấp trên duyệt hoặc trả lại, tổng hợp lên Ban Giám đốc */

CREATE TABLE org_units (
  id         serial PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  parent_id  int REFERENCES org_units(id),
  -- loại số liệu tự điền vào báo cáo
  domain     text NOT NULL DEFAULT 'khac' CHECK (domain IN ('ban_giam_doc', 'tiep_nhan', 'dieu_phoi', 'kip', 'kho', 'thiet_bi', 'ksnk', 'chat_luong', 'nhan_su', 'ke_toan', 'khac')),
  station_id text REFERENCES stations(id),
  sort       int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

-- Thành viên; trưởng nhóm (có thể thêm phó nhóm cũng là is_lead) lập và nộp báo cáo của bộ phận
CREATE TABLE org_members (
  unit_id   int NOT NULL REFERENCES org_units(id),
  staff_id  uuid NOT NULL REFERENCES staff(id),
  is_lead   boolean NOT NULL DEFAULT false,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, staff_id)
);
CREATE INDEX org_members_staff ON org_members(staff_id);

CREATE TABLE unit_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id       int NOT NULL REFERENCES org_units(id),
  period        text NOT NULL CHECK (period IN ('ngay', 'tuan', 'thang')),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  status        text NOT NULL DEFAULT 'nhap' CHECK (status IN ('nhap', 'da_nop', 'da_duyet', 'tra_lai')),
  metrics       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- số liệu tự lấy từ phần mềm lúc lập/nộp
  children      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- tóm tắt báo cáo các bộ phận cấp dưới (tổng hợp)
  summary       text,
  issues        text,
  proposals     text,
  next_plan     text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  submitted_by  uuid REFERENCES users(id),
  submitted_at  timestamptz,
  reviewed_by   uuid REFERENCES users(id),
  reviewed_at   timestamptz,
  review_note   text,
  UNIQUE (unit_id, period, period_start),
  CHECK (period_end >= period_start)
);

CREATE TABLE unit_report_events (
  id         bigserial PRIMARY KEY,
  report_id  uuid NOT NULL REFERENCES unit_reports(id),
  action     text NOT NULL,
  actor_id   uuid REFERENCES users(id),
  actor_name text NOT NULL,
  note       text,
  at         timestamptz NOT NULL DEFAULT now()
);

-- Sơ đồ mặc định (quản trị sửa, đổi tên, thêm bớt; trưởng nhóm do quản trị/Ban Giám đốc/nhân sự chỉ định)
INSERT INTO org_units(code, name, domain, sort) VALUES ('BGD', 'Ban Giám đốc', 'ban_giam_doc', 0);
INSERT INTO org_units(code, name, parent_id, domain, sort) VALUES
  ('EOC', 'Trung tâm điều hành (EOC)', 1, 'dieu_phoi', 1),
  ('CM', 'Chuyên môn – Kíp cấp cứu', 1, 'kip', 2),
  ('HC', 'Hậu cần – Kỹ thuật', 1, 'khac', 3),
  ('QLCL', 'Quản lý chất lượng – KSNK', 1, 'chat_luong', 4),
  ('HCNS', 'Hành chính – Nhân sự', 1, 'nhan_su', 5),
  ('TCKT', 'Tài chính – Kế toán', 1, 'ke_toan', 6);
INSERT INTO org_units(code, name, parent_id, domain, sort)
  SELECT v.code, v.name, (SELECT id FROM org_units WHERE code = v.parent), v.domain, v.sort FROM (VALUES
    ('EOC-TN', 'Nhóm tiếp nhận cuộc gọi', 'EOC', 'tiep_nhan', 1),
    ('EOC-DP', 'Nhóm điều phối', 'EOC', 'dieu_phoi', 2),
    ('HC-KHO', 'Nhóm dược – kho', 'HC', 'kho', 1),
    ('HC-TB', 'Nhóm kỹ thuật thiết bị – xe', 'HC', 'thiet_bi', 2),
    ('QLCL-KSNK', 'Nhóm kiểm soát nhiễm khuẩn', 'QLCL', 'ksnk', 1)
  ) AS v(code, name, parent, domain, sort);

-- Xếp nhân viên đã có tài khoản vào bộ phận theo vai trò (Ban Giám đốc là trưởng nhóm của mình; trưởng các nhóm khác do quản trị chỉ định)
INSERT INTO org_members(unit_id, staff_id, is_lead)
  SELECT o.id, s.id, u.role = 'director' FROM staff s JOIN users u ON u.id = s.user_id
    JOIN org_units o ON o.code = CASE u.role
      WHEN 'calltaker' THEN 'EOC-TN' WHEN 'dispatcher' THEN 'EOC-DP' WHEN 'supervisor' THEN 'EOC' WHEN 'crew' THEN 'CM'
      WHEN 'pharmacist' THEN 'HC-KHO' WHEN 'technician' THEN 'HC-TB' WHEN 'ipc' THEN 'QLCL-KSNK' WHEN 'qa' THEN 'QLCL'
      WHEN 'hr' THEN 'HCNS' WHEN 'accountant' THEN 'TCKT' WHEN 'director' THEN 'BGD' END
   WHERE s.status <> 'nghi_viec';
