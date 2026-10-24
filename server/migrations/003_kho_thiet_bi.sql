-- Đợt B: kho đầy đủ (kho điểm → cơ số xe, phiếu kho, duyệt hai cấp, định mức, thuốc kiểm soát đặc biệt),
-- trang thiết bị theo số seri (bảo dưỡng, kiểm định, hiệu chuẩn, báo hỏng) và dụng cụ dùng lại (tiệt khuẩn theo lô hấp).
-- QL-13, QLCL-15, QLCL-16 trong bộ quy trình Medone.

-- Vai trò mới cho các phân hệ quản trị (dùng cả cho đợt C, D, E)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'calltaker','dispatcher','supervisor','crew','qa','admin',
  'pharmacist',   -- kho, dược
  'technician',   -- kỹ thuật trang thiết bị
  'ipc',          -- kiểm soát nhiễm khuẩn
  'hr',           -- hành chính, nhân sự
  'accountant',   -- kế toán, thu ngân
  'director'      -- ban giám đốc
));

/* ---------------- Kho ---------------- */

-- Thuốc gây nghiện, hướng thần: dùng phải có người chứng kiến
ALTER TABLE drugs ADD COLUMN controlled boolean NOT NULL DEFAULT false;
UPDATE drugs SET controlled = true WHERE name ~* '^(morphin|fentanyl|midazolam|diazepam|ketamin|pethidin)';

-- Một lô nằm ở kho điểm (vehicle_id rỗng) hoặc trên một xe của điểm đó (cơ số xe)
ALTER TABLE stock_lots ADD COLUMN vehicle_id text REFERENCES vehicles(id);
ALTER TABLE stock_lots DROP CONSTRAINT IF EXISTS stock_lots_station_id_drug_id_lot_key;
CREATE UNIQUE INDEX stock_lots_place_uq ON stock_lots (station_id, coalesce(vehicle_id, ''), drug_id, lot);
CREATE INDEX stock_lots_vehicle_idx ON stock_lots (vehicle_id, drug_id, expiry) WHERE vehicle_id IS NOT NULL;

-- Cơ số chuẩn theo loại xe: số lượng mỗi thuốc phải có trên xe đầu ca
CREATE TABLE par_levels (
  vehicle_type text NOT NULL,
  drug_id      int NOT NULL REFERENCES drugs(id),
  qty          numeric NOT NULL CHECK (qty > 0),
  PRIMARY KEY (vehicle_type, drug_id)
);

-- Định mức tối thiểu tại kho điểm: dưới mức thì cảnh báo và đưa vào đơn đặt hàng
CREATE TABLE stock_minimums (
  station_id text NOT NULL REFERENCES stations(id),
  drug_id    int NOT NULL REFERENCES drugs(id),
  min_qty    numeric NOT NULL CHECK (min_qty >= 0),
  PRIMARY KEY (station_id, drug_id)
);

-- Phiếu kho: cấp cơ số xe, xe trả kho, điều chuyển giữa điểm, kiểm kê, hủy thuốc.
-- Kiểm kê có chênh lệch và hủy thuốc phải được người thứ hai duyệt (duyệt hai cấp).
CREATE TABLE stock_vouchers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('cap_xe', 'tra_kho', 'dieu_chuyen', 'kiem_ke', 'huy')),
  status        text NOT NULL CHECK (status IN ('cho_duyet', 'da_duyet', 'tu_choi')),
  station_id    text NOT NULL REFERENCES stations(id),  -- nơi xuất (hoặc nơi kiểm kê)
  vehicle_id    text REFERENCES vehicles(id),           -- xe nhận (cap_xe), xe trả (tra_kho), xe được kiểm kê
  to_station_id text REFERENCES stations(id),           -- điểm nhận (dieu_chuyen)
  note          text,
  witness       text,                                   -- người chứng kiến khi có thuốc kiểm soát đặc biệt
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text
);
CREATE INDEX stock_vouchers_status_idx ON stock_vouchers (status, created_at DESC);

CREATE TABLE stock_voucher_lines (
  id          bigserial PRIMARY KEY,
  voucher_id  uuid NOT NULL REFERENCES stock_vouchers(id) ON DELETE CASCADE,
  lot_id      uuid NOT NULL REFERENCES stock_lots(id),
  qty         numeric NOT NULL,          -- số lượng chuyển/hủy; với kiểm kê là chênh lệch (đếm thực tế − sổ sách)
  counted_qty numeric,                   -- kiểm kê: số đếm thực tế
  book_qty    numeric                    -- kiểm kê: số trên sổ lúc đếm
);

ALTER TABLE stock_moves DROP CONSTRAINT IF EXISTS stock_moves_reason_check;
ALTER TABLE stock_moves ADD CONSTRAINT stock_moves_reason_check CHECK (reason IN (
  'nhap_kho', 'dung_cho_nguoi_benh', 'dieu_chinh', 'cap_xe', 'tra_kho', 'dieu_chuyen', 'kiem_ke', 'huy'));
ALTER TABLE stock_moves ADD COLUMN voucher_id uuid REFERENCES stock_vouchers(id);

/* ---------------- Trang thiết bị và dụng cụ ---------------- */

CREATE TABLE equipment_types (
  id                    serial PRIMARY KEY,
  name                  text NOT NULL UNIQUE,
  maintenance_days      int,     -- chu kỳ bảo dưỡng
  inspection_days       int,     -- chu kỳ kiểm định (thiết bị đo, bình áp lực)
  calibration_days      int,     -- chu kỳ hiệu chuẩn
  active                boolean NOT NULL DEFAULT true
);

-- Thiết bị bắt buộc theo loại xe: thiếu, hỏng hoặc quá hạn kiểm định thì xe không được giao
CREATE TABLE vehicle_required_equipment (
  vehicle_type      text NOT NULL,
  equipment_type_id int NOT NULL REFERENCES equipment_types(id),
  qty               int NOT NULL DEFAULT 1 CHECK (qty > 0),
  PRIMARY KEY (vehicle_type, equipment_type_id)
);

CREATE TABLE equipment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id          int NOT NULL REFERENCES equipment_types(id),
  serial           text NOT NULL UNIQUE,
  model            text,
  station_id       text NOT NULL REFERENCES stations(id),
  vehicle_id       text REFERENCES vehicles(id),         -- đang lắp trên xe nào (rỗng = để ở kho điểm)
  status           text NOT NULL DEFAULT 'hoat_dong' CHECK (status IN ('hoat_dong', 'hong', 'bao_tri', 'thanh_ly')),
  next_maintenance date,
  next_inspection  date,
  next_calibration date,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_vehicle_idx ON equipment (vehicle_id) WHERE vehicle_id IS NOT NULL;

CREATE TABLE equipment_events (
  id           bigserial PRIMARY KEY,
  equipment_id uuid NOT NULL REFERENCES equipment(id),
  kind         text NOT NULL CHECK (kind IN ('nhap', 'bao_duong', 'kiem_dinh', 'hieu_chuan', 'bao_hong', 'sua_xong', 'dieu_chuyen', 'thanh_ly')),
  at           timestamptz NOT NULL DEFAULT now(),
  user_id      uuid REFERENCES users(id),
  note         text,
  cert_no      text,          -- số giấy chứng nhận kiểm định/hiệu chuẩn
  next_due     date
);
CREATE INDEX equipment_events_idx ON equipment_events (equipment_id, at DESC);

-- Bộ dụng cụ dùng lại (bộ đặt nội khí quản, bộ đỡ sanh, bộ tiểu phẫu...): dùng → thu hồi → tiệt khuẩn → sẵn sàng
CREATE TABLE instrument_sets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  station_id    text NOT NULL REFERENCES stations(id),
  vehicle_id    text REFERENCES vehicles(id),
  status        text NOT NULL DEFAULT 'san_sang' CHECK (status IN ('san_sang', 'da_dung', 'dang_tiet_khuan', 'hong')),
  sterile_until date,          -- hạn vô khuẩn của lần tiệt khuẩn gần nhất
  cycles        int NOT NULL DEFAULT 0,
  last_used_at  timestamptz,
  last_incident_id uuid REFERENCES incidents(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sterilization_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  method       text NOT NULL CHECK (method IN ('hap_uot', 'eo', 'plasma')),
  station_id   text NOT NULL REFERENCES stations(id),
  status       text NOT NULL DEFAULT 'dang_chay' CHECK (status IN ('dang_chay', 'dat', 'khong_dat')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  started_by   uuid REFERENCES users(id),
  finished_at  timestamptz,
  finished_by  uuid REFERENCES users(id),
  indicator_ok boolean,        -- chỉ thị hóa học
  bi_ok        boolean,        -- chỉ thị sinh học (nếu có)
  shelf_days   int NOT NULL DEFAULT 30,
  note         text
);

CREATE TABLE sterilization_items (
  batch_id uuid NOT NULL REFERENCES sterilization_batches(id) ON DELETE CASCADE,
  set_id   uuid NOT NULL REFERENCES instrument_sets(id),
  PRIMARY KEY (batch_id, set_id)
);

/* ---------------- Tìm không dấu ---------------- */

-- Bỏ dấu tiếng Việt để tìm "nhoi mau" ra "Nhồi máu cơ tim"
CREATE FUNCTION vn_plain(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT lower(translate(t, 'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ', 'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyydAAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYD')) $$;
ALTER TABLE icd10 ADD COLUMN name_plain text GENERATED ALWAYS AS (vn_plain(name)) STORED;
