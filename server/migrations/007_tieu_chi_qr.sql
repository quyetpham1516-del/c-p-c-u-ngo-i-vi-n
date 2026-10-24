-- Đợt F: bộ tiêu chí chất lượng (sửa được, có phiên bản), đợt đánh giá và phiếu chấm; mã QR cho thiết bị và bộ dụng cụ

/* ---------------- Bộ tiêu chí chất lượng ----------------
   Khung theo Quyết định 6858/QĐ-BYT: tiêu chí có 5 mức, mỗi mức gồm các tiểu mục.
   Mức 1 là các tiểu mục "có vấn đề": chỉ cần một tiểu mục xảy ra là tiêu chí ở mức 1.
   Bộ đang dùng cho đợt đánh giá thì không sửa trực tiếp; muốn đổi thì nhân bản thành phiên bản mới. */

CREATE TABLE qc_sets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL,                      -- TC-CCNV, TC-PK (phòng khám)...
  name           text NOT NULL,
  facility_kind  text NOT NULL DEFAULT 'ccnv' CHECK (facility_kind IN ('ccnv', 'phong_kham', 'khac')),
  version        text NOT NULL,
  source         text,                               -- căn cứ ban hành
  status         text NOT NULL DEFAULT 'du_thao' CHECK (status IN ('du_thao', 'hieu_luc', 'het_hieu_luc')),
  created_by     uuid REFERENCES users(id),
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX qc_sets_code_version_uq ON qc_sets(code, version);
CREATE UNIQUE INDEX qc_sets_one_effective_uq ON qc_sets(code) WHERE status = 'hieu_luc';

CREATE TABLE qc_criteria (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id        uuid NOT NULL REFERENCES qc_sets(id) ON DELETE CASCADE,
  part          text NOT NULL,                       -- A
  part_name     text NOT NULL,
  chapter       text NOT NULL,                       -- A1
  chapter_name  text NOT NULL,
  code          text NOT NULL,                       -- A1.1
  title         text NOT NULL,
  legal_basis   text,
  owner_unit    text,                                -- khoa/phòng phụ trách
  weight        numeric(3,1) NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 5),   -- hệ số
  sort          int NOT NULL DEFAULT 0,
  UNIQUE (set_id, code)
);

CREATE TABLE qc_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criterion_id  uuid NOT NULL REFERENCES qc_criteria(id) ON DELETE CASCADE,
  level         int NOT NULL CHECK (level BETWEEN 1 AND 5),
  ordinal       int NOT NULL,                        -- số tiểu mục, đánh liên tục từ mức 1 đến mức 5
  text          text NOT NULL,
  UNIQUE (criterion_id, ordinal)
);

/* ---------------- Đợt đánh giá và phiếu chấm ---------------- */

CREATE TABLE qc_assessments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id        uuid NOT NULL REFERENCES qc_sets(id),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('tu_danh_gia', 'kiem_tra_cap_tren', 'danh_gia_ngoai')),
  period_from   date NOT NULL,
  period_to     date NOT NULL CHECK (period_to >= period_from),
  status        text NOT NULL DEFAULT 'dang_cham' CHECK (status IN ('dang_cham', 'da_chot')),
  note          text,
  created_by    uuid REFERENCES users(id),
  closed_by     uuid REFERENCES users(id),
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE qc_scores (
  assessment_id  uuid NOT NULL REFERENCES qc_assessments(id) ON DELETE CASCADE,
  criterion_id   uuid NOT NULL REFERENCES qc_criteria(id),
  assessor_id    uuid REFERENCES users(id),          -- người được phân công chấm
  applicable     boolean NOT NULL DEFAULT true,
  results        jsonb NOT NULL DEFAULT '{}',        -- {itemId: true | false | null(không áp dụng)}
  computed_level int CHECK (computed_level BETWEEN 1 AND 5),
  final_level    int CHECK (final_level BETWEEN 1 AND 5),
  current_state  text,                               -- mô tả thực trạng, điểm mạnh, điểm yếu
  methods        text[] NOT NULL DEFAULT '{}',       -- quan sát, kiểm tra số liệu, văn bản, phỏng vấn, đóng vai
  explanation    text,                               -- giải trình xếp mức
  doubts         text,                               -- điểm còn phân vân
  evidence       text,                               -- minh chứng (đường dẫn, số văn bản)
  improvement    text,                               -- kế hoạch cải tiến
  reviewer_note  text,                               -- góp ý của đoàn kiểm tra
  scored_by      uuid REFERENCES users(id),
  scored_at      timestamptz,
  PRIMARY KEY (assessment_id, criterion_id)
);
CREATE INDEX qc_scores_assessor_idx ON qc_scores(assessor_id) WHERE assessor_id IS NOT NULL;

/* ---------------- Mã QR cho thiết bị và bộ dụng cụ ----------------
   QR chứa đường dẫn /tb/<qr_code>; mã ngẫu nhiên để không đoán được thiết bị khác. Mã tài sản TB-0001 in kèm trên nhãn. */

CREATE SEQUENCE equipment_asset_seq;
ALTER TABLE equipment ADD COLUMN asset_code text;
UPDATE equipment SET asset_code = 'TB-' || lpad(nextval('equipment_asset_seq')::text, 4, '0')
  FROM (SELECT id FROM equipment ORDER BY created_at, serial) o WHERE o.id = equipment.id;
ALTER TABLE equipment ALTER COLUMN asset_code SET DEFAULT 'TB-' || lpad(nextval('equipment_asset_seq')::text, 4, '0');
ALTER TABLE equipment ALTER COLUMN asset_code SET NOT NULL;
ALTER TABLE equipment ADD CONSTRAINT equipment_asset_code_uq UNIQUE (asset_code);

ALTER TABLE equipment ADD COLUMN qr_code text NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
ALTER TABLE equipment ADD CONSTRAINT equipment_qr_uq UNIQUE (qr_code);
ALTER TABLE instrument_sets ADD COLUMN qr_code text NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
ALTER TABLE instrument_sets ADD CONSTRAINT instrument_sets_qr_uq UNIQUE (qr_code);

-- Hướng dẫn sử dụng hiện ra khi quét tem (như MedOne v107)
ALTER TABLE equipment ADD COLUMN manual_url text, ADD COLUMN manual_text text;

-- Quét QR: kíp kiểm tra nhanh đầu ca (thiết bị hoạt động tốt), ghi vệ sinh thiết bị sau ca
ALTER TABLE equipment_events DROP CONSTRAINT equipment_events_kind_check;
ALTER TABLE equipment_events ADD CONSTRAINT equipment_events_kind_check CHECK (kind IN (
  'nhap', 'kiem_tra', 've_sinh', 'bao_duong', 'kiem_dinh', 'hieu_chuan', 'bao_hong', 'sua_xong', 'dieu_chuyen', 'thanh_ly'));
