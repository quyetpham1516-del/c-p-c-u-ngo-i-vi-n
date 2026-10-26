-- Cổng bệnh viện: tài khoản của bệnh viện nhận (vai trò hospital, gắn một bệnh viện) tra cứu phiếu chuyển viện ca mình nhận,
-- nhận thông báo ca chuyển tới, điền phần trong viện của các biểu mẫu nghiên cứu (Utstein, PATOS chấn thương, đột quỵ).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'calltaker','dispatcher','supervisor','crew','qa','admin','pharmacist','technician','ipc','hr','accountant','director',
  'hospital'      -- nhân viên bệnh viện nhận bệnh (chỉ thấy ca chuyển tới bệnh viện của mình)
));
ALTER TABLE users ADD COLUMN hospital_id int REFERENCES hospitals(id);
ALTER TABLE users ADD CONSTRAINT users_hospital_role CHECK (role <> 'hospital' OR hospital_id IS NOT NULL);

-- Bật, tắt từng biểu mẫu nghiên cứu và khoảng thời gian lấy số liệu (admin chỉnh)
CREATE TABLE registry_settings (
  code        text PRIMARY KEY CHECK (code IN ('utstein', 'patos', 'stroke')),
  enabled     boolean NOT NULL DEFAULT false,
  start_on    date,
  end_on      date,
  note        text,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO registry_settings(code, enabled) VALUES ('utstein', true), ('patos', false), ('stroke', false);

-- Ca đưa vào biểu mẫu: tự đưa vào khi ký phiếu nếu biểu mẫu đang bật và ca đúng tiêu chí; phần trước viện lấy từ phiếu,
-- phần trong viện do bệnh viện (hoặc bác sĩ, điều phối của trung tâm) điền sau
CREATE TABLE registry_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registry      text NOT NULL REFERENCES registry_settings(code),
  transfer_id   uuid NOT NULL REFERENCES transfers(id),
  incident_id   uuid REFERENCES incidents(id),
  hospital_id   int REFERENCES hospitals(id),
  prehospital   jsonb NOT NULL DEFAULT '{}'::jsonb,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'cho_bo_sung' CHECK (status IN ('cho_bo_sung', 'dang_bo_sung', 'du')),
  completed_at  timestamptz,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (registry, transfer_id)
);
CREATE INDEX registry_cases_hospital ON registry_cases(hospital_id, created_at DESC);

ALTER TABLE transfers ADD COLUMN hospital_id int REFERENCES hospitals(id);
