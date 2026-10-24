-- Danh mục bệnh viện và khoa nhận bệnh, danh mục ICD-10 (Bộ Y tế), kho thuốc theo số lô tại từng trạm.

CREATE TABLE hospitals (
  id           serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  kcb_code     text UNIQUE,                    -- mã cơ sở KCB (BHXH)
  kind         text,                           -- nhóm/tuyến: công lập tuyến tỉnh, tư nhân...
  address      text,
  phone        text,
  lat          double precision,
  lng          double precision,
  capabilities text[] NOT NULL DEFAULT '{}',   -- can thiệp tim 24/7, tiêu sợi huyết, lấy huyết khối, chấn thương, nhi, sản...
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hospital_departments (
  id          serial PRIMARY KEY,
  hospital_id int NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (hospital_id, name)
);

-- Danh mục mã bệnh ICD-10 theo Bộ Y tế; nạp toàn bộ bằng: npm run import:icd -w server -- <tệp .xlsx hoặc .csv>
CREATE TABLE icd10 (
  code    text PRIMARY KEY,
  name    text NOT NULL,
  chapter text,
  active  boolean NOT NULL DEFAULT true
);
CREATE INDEX icd10_name_lower_idx ON icd10 (lower(name) text_pattern_ops);

CREATE TABLE drugs (
  id            serial PRIMARY KEY,
  name          text NOT NULL UNIQUE,      -- tên, hàm lượng, dạng bào chế
  unit          text NOT NULL,             -- ống, lọ, chai, viên...
  default_route text,
  active        boolean NOT NULL DEFAULT true
);

-- Mỗi lô thuốc nhập về kho của một trạm; xe lấy thuốc từ kho trạm của mình
CREATE TABLE stock_lots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id  text NOT NULL REFERENCES stations(id),
  drug_id     int NOT NULL REFERENCES drugs(id),
  lot         text NOT NULL,
  expiry      date NOT NULL,
  qty         numeric NOT NULL CHECK (qty >= 0),
  supplier    text,
  received_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid REFERENCES users(id),
  UNIQUE (station_id, drug_id, lot)
);
CREATE INDEX stock_lots_station_idx ON stock_lots (station_id, drug_id, expiry);

-- Mọi thay đổi số lượng: nhập kho, dùng cho người bệnh (khi ký phiếu), điều chỉnh kiểm kê
CREATE TABLE stock_moves (
  id          bigserial PRIMARY KEY,
  lot_id      uuid NOT NULL REFERENCES stock_lots(id),
  delta       numeric NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('nhap_kho', 'dung_cho_nguoi_benh', 'dieu_chinh')),
  note        text,
  transfer_id uuid REFERENCES transfers(id),
  user_id     uuid REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_moves_lot_idx ON stock_moves (lot_id, at);

ALTER TABLE incidents ADD COLUMN destination_department text;

-- Điểm/trạm do quản trị quyết định: trụ sở, trạm xe, kho trung tâm, điểm trực sự kiện
ALTER TABLE stations
  ADD COLUMN kind    text NOT NULL DEFAULT 'tram' CHECK (kind IN ('tru_so', 'tram', 'kho_trung_tam', 'diem_su_kien')),
  ADD COLUMN address text,
  ADD COLUMN phone   text,
  ADD COLUMN active  boolean NOT NULL DEFAULT true;
UPDATE stations SET kind = 'tru_so' WHERE id = 'TS';

-- Điểm làm việc của nhân viên: kíp chỉ nhận xe thuộc điểm mình được phân (để trống = mọi điểm)
ALTER TABLE users ADD COLUMN station_id text REFERENCES stations(id);
