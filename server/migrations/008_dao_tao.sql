-- Đợt G: đào tạo và sát hạch (QLCL-13), phân quyền kỹ thuật (QLCL-14), đọc và xác nhận tài liệu (QLCL-01)
-- Theo MedOne: thi trắc nghiệm 100 câu / 30 phút / đạt 70%, chưa đạt thì không nhận ca (bật bằng cấu hình).
-- Bổ sung: nhiều loại câu hỏi, bộ đề theo ma trận chủ đề × độ khó có phiên bản, thi thực hành theo bảng kiểm,
-- chứng nhận có hạn và phân quyền kỹ thuật.

CREATE TABLE tr_settings (
  id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  require_cert   boolean NOT NULL DEFAULT false,      -- bật: chưa có chứng nhận Medone còn hạn thì không nhận ca trên xe
  cert_months    int NOT NULL DEFAULT 24 CHECK (cert_months BETWEEN 1 AND 120),
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tr_settings(id) VALUES (1);

CREATE SEQUENCE tr_question_seq;

-- Ngân hàng câu hỏi; bài thi lưu bản chụp câu hỏi nên sửa câu không làm đổi kết quả cũ
CREATE TABLE tr_questions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE DEFAULT 'CH-' || lpad(nextval('tr_question_seq')::text, 4, '0'),
  topic        text NOT NULL,
  difficulty   int NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 3),   -- 1 dễ, 2 trung bình, 3 khó
  roles        text[] NOT NULL DEFAULT '{}',                                -- vị trí áp dụng; rỗng = mọi người
  kind         text NOT NULL CHECK (kind IN ('mot_dap_an', 'nhieu_dap_an', 'dung_sai')),
  stem         text NOT NULL,
  options      jsonb NOT NULL,                       -- [{"key":"A","text":"..."}]
  answer       text[] NOT NULL,                      -- khóa đáp án đúng
  explanation  text,
  reference    text,                                 -- tài liệu, quy trình làm căn cứ
  status       text NOT NULL DEFAULT 'du_thao' CHECK (status IN ('du_thao', 'hieu_luc', 'ngung')),
  source       text,
  created_by   uuid REFERENCES users(id),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tr_questions_topic ON tr_questions(topic, difficulty) WHERE status = 'hieu_luc';

-- Bộ đề: cố định (danh sách câu) hoặc ngẫu nhiên theo ma trận; có phiên bản như bộ tiêu chí
CREATE TABLE tr_blueprints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL,
  name           text NOT NULL,
  version        text NOT NULL,
  purpose        text NOT NULL DEFAULT 'sat_hach' CHECK (purpose IN ('sat_hach', 'dinh_ky', 'luyen_tap')),
  mode           text NOT NULL DEFAULT 'ngau_nhien' CHECK (mode IN ('ngau_nhien', 'co_dinh')),
  rules          jsonb NOT NULL DEFAULT '[]',        -- [{"topic":"...","difficulty":2|null,"count":10}]
  question_ids   uuid[] NOT NULL DEFAULT '{}',       -- dùng khi mode = co_dinh
  duration_min   int NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 1 AND 300),
  pass_pct       int NOT NULL DEFAULT 70 CHECK (pass_pct BETWEEN 1 AND 100),
  max_attempts   int CHECK (max_attempts BETWEEN 1 AND 20),   -- trong một kỳ thi; null = không giới hạn
  shuffle        boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'du_thao' CHECK (status IN ('du_thao', 'hieu_luc', 'het_hieu_luc')),
  note           text,
  created_by     uuid REFERENCES users(id),
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tr_blueprints_code_version_uq ON tr_blueprints(code, version);
CREATE UNIQUE INDEX tr_blueprints_one_effective_uq ON tr_blueprints(code) WHERE status = 'hieu_luc';

-- Kỳ thi: một bộ đề giao cho danh sách người, có thời gian mở
CREATE TABLE tr_exams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id  uuid NOT NULL REFERENCES tr_blueprints(id),
  name          text NOT NULL,
  opens_on      date NOT NULL,
  closes_on     date NOT NULL CHECK (closes_on >= opens_on),
  status        text NOT NULL DEFAULT 'mo' CHECK (status IN ('mo', 'dong')),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tr_exam_candidates (
  exam_id   uuid NOT NULL REFERENCES tr_exams(id) ON DELETE CASCADE,
  staff_id  uuid NOT NULL REFERENCES staff(id),
  PRIMARY KEY (exam_id, staff_id)
);

-- Lượt làm bài (thi trong kỳ thi hoặc luyện tập tự do)
CREATE TABLE tr_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id       uuid REFERENCES tr_exams(id),
  blueprint_id  uuid REFERENCES tr_blueprints(id),      -- null: luyện tập nhanh theo chủ đề
  staff_id      uuid NOT NULL REFERENCES staff(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL,                         -- bản chụp tên đề, mục đích, điểm đạt
  purpose       text NOT NULL CHECK (purpose IN ('sat_hach', 'dinh_ky', 'luyen_tap')),
  pass_pct      int NOT NULL,
  questions     jsonb NOT NULL,                      -- bản chụp: [{id, code, topic, difficulty, kind, stem, options(đã trộn), answer, explanation}]
  answers       jsonb NOT NULL DEFAULT '{}',         -- {questionId: ["A"]}
  started_at    timestamptz NOT NULL DEFAULT now(),
  deadline      timestamptz NOT NULL,
  submitted_at  timestamptz,
  auto_submit   boolean NOT NULL DEFAULT false,
  score         int,
  total         int NOT NULL,
  pct           numeric(5,1),
  passed        boolean,
  by_topic      jsonb
);
CREATE INDEX tr_attempts_staff ON tr_attempts(staff_id, started_at DESC);
CREATE UNIQUE INDEX tr_attempts_one_open ON tr_attempts(staff_id) WHERE submitted_at IS NULL;

-- Quy trình kỹ thuật chia bước, dùng làm bảng kiểm thi thực hành và giám sát tuân thủ
CREATE TABLE tr_procedures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL,
  title         text NOT NULL,
  version       text NOT NULL,
  category      text,
  roles         text[] NOT NULL DEFAULT '{}',
  document_id   uuid REFERENCES documents(id),       -- văn bản quy trình trong kiểm soát tài liệu
  epcr_flags    text[] NOT NULL DEFAULT '{}',        -- can thiệp ePCR tương ứng (ett, defib, iv...) để nhắc phân quyền
  pass_pct      int NOT NULL DEFAULT 80 CHECK (pass_pct BETWEEN 1 AND 100),
  privilege_months int NOT NULL DEFAULT 12 CHECK (privilege_months BETWEEN 1 AND 120),
  source        text,
  status        text NOT NULL DEFAULT 'du_thao' CHECK (status IN ('du_thao', 'hieu_luc', 'het_hieu_luc')),
  created_by    uuid REFERENCES users(id),
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tr_procedures_code_version_uq ON tr_procedures(code, version);
CREATE UNIQUE INDEX tr_procedures_one_effective_uq ON tr_procedures(code) WHERE status = 'hieu_luc';

CREATE TABLE tr_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procedure_id  uuid NOT NULL REFERENCES tr_procedures(id) ON DELETE CASCADE,
  ordinal       int NOT NULL,
  text          text NOT NULL,
  critical      boolean NOT NULL DEFAULT false,      -- bước bắt buộc: sai là không đạt dù đủ điểm
  UNIQUE (procedure_id, ordinal)
);

-- Lượt chấm theo bảng kiểm (sát hạch thực hành hoặc giám sát tuân thủ tại chỗ)
CREATE TABLE tr_skill_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procedure_id  uuid NOT NULL REFERENCES tr_procedures(id),
  staff_id      uuid NOT NULL REFERENCES staff(id),
  examiner_id   uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL DEFAULT 'sat_hach' CHECK (kind IN ('sat_hach', 'giam_sat')),
  steps         jsonb NOT NULL,                      -- bản chụp các bước
  results       jsonb NOT NULL,                      -- {stepId: true|false|null}
  score_pct     numeric(5,1) NOT NULL,
  critical_failed int NOT NULL DEFAULT 0,
  passed        boolean NOT NULL,
  note          text,
  incident_id   uuid REFERENCES incidents(id),       -- giám sát trên ca thật
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tr_skill_checks_staff ON tr_skill_checks(staff_id, at DESC);

-- Chứng nhận Medone: đạt lý thuyết và thực hành, có hạn
CREATE TABLE tr_certs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id       uuid NOT NULL REFERENCES staff(id),
  number         text NOT NULL UNIQUE,
  issued_on      date NOT NULL,
  expires_on     date NOT NULL,
  attempt_id     uuid REFERENCES tr_attempts(id),
  skill_check_ids uuid[] NOT NULL DEFAULT '{}',
  revoked_at     timestamptz,
  revoke_reason  text,
  issued_by      uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tr_certs_staff ON tr_certs(staff_id, expires_on DESC);

-- Phân quyền kỹ thuật: ai được làm kỹ thuật gì, đến khi nào
CREATE TABLE tr_privileges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id       uuid NOT NULL REFERENCES staff(id),
  procedure_code text NOT NULL,
  granted_on     date NOT NULL,
  expires_on     date NOT NULL,
  skill_check_id uuid REFERENCES tr_skill_checks(id),
  note           text,
  granted_by     uuid REFERENCES users(id),
  revoked_at     timestamptz,
  revoke_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tr_privileges_staff ON tr_privileges(staff_id, procedure_code);

-- Kế hoạch đào tạo năm: lớp dự kiến, điểm danh; lớp kết thúc thì ghi giờ đào tạo vào hồ sơ người có mặt
CREATE TABLE tr_plan_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year          int NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  title         text NOT NULL,
  kind          text NOT NULL,                       -- theo loại đào tạo (cme, bls, acls, ksnk...)
  hours         numeric(6,1) NOT NULL DEFAULT 0 CHECK (hours >= 0),
  planned_month int NOT NULL CHECK (planned_month BETWEEN 1 AND 12),
  target_titles text[] NOT NULL DEFAULT '{}',        -- chức danh cần học; rỗng = mọi người
  procedure_code text,                               -- quy trình kỹ thuật liên quan (nếu có)
  trainer       text,
  provider      text,
  status        text NOT NULL DEFAULT 'ke_hoach' CHECK (status IN ('ke_hoach', 'da_to_chuc', 'huy')),
  held_on       date,
  note          text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tr_plan_items_year ON tr_plan_items(year, planned_month);
CREATE TABLE tr_attendance (
  plan_item_id  uuid NOT NULL REFERENCES tr_plan_items(id) ON DELETE CASCADE,
  staff_id      uuid NOT NULL REFERENCES staff(id),
  PRIMARY KEY (plan_item_id, staff_id)
);
ALTER TABLE trainings ADD COLUMN plan_item_id uuid REFERENCES tr_plan_items(id);

-- Đọc và xác nhận tài liệu (theo MedOne library_reads)
ALTER TABLE documents ADD COLUMN must_read boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN read_roles text[] NOT NULL DEFAULT '{}';   -- rỗng = mọi người
CREATE TABLE document_reads (
  document_id  uuid NOT NULL REFERENCES documents(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);

-- Đào tạo ghi nhận từ sát hạch, cho phép loại "sat_hach"
ALTER TABLE trainings DROP CONSTRAINT trainings_kind_check;
ALTER TABLE trainings ADD CONSTRAINT trainings_kind_check CHECK (kind IN ('cme', 'bls', 'acls', 'phtls', 'ksnk', 'pccc', 'dieu_phoi', 'lai_xe', 'sat_hach', 'khac'));
