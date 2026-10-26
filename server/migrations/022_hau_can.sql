-- Giai đoạn Y: hậu cần (QL-13 mua sắm, QLCL-16 thuốc/vật tư, QLCL-15 thiết bị)

/* ---------------- Mua hàng: đơn đặt hàng → duyệt → nhận hàng vào kho theo lô ---------------- */

-- Đơn đặt hàng gửi nhà cung cấp (đã có trong danh sách nhà cung cấp được duyệt của hệ thống chất lượng)
CREATE TABLE purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,                     -- DH-YYYY-NNNNN
  station_id    text NOT NULL REFERENCES stations(id),    -- điểm nhận hàng
  supplier_id   uuid NOT NULL REFERENCES qm_suppliers(id),
  status        text NOT NULL DEFAULT 'cho_duyet' CHECK (status IN ('cho_duyet', 'da_duyet', 'dang_nhan', 'da_nhan', 'tu_choi', 'huy')),
  expected_on   date,
  note          text,
  total         numeric(14,0) NOT NULL DEFAULT 0,         -- tổng tiền dự kiến (đơn giá × số lượng)
  proposal_id   uuid REFERENCES proposals(id),            -- đề xuất chi đã duyệt khi tổng tiền từ ngưỡng duyệt chi trở lên
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text
);
CREATE INDEX purchase_orders_station ON purchase_orders(station_id, created_at DESC);

CREATE TABLE purchase_order_lines (
  id           bigserial PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  drug_id      int NOT NULL REFERENCES drugs(id),
  qty          numeric(12,2) NOT NULL CHECK (qty > 0),
  unit_price   numeric(14,0) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  received_qty numeric(12,2) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  UNIQUE (order_id, drug_id)
);

-- Phiếu nhập kho theo đơn: mỗi dòng là một lô (số lô, hạn dùng) đã cộng vào kho điểm
CREATE TABLE goods_receipts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,                       -- NK-YYYY-NNNNN
  order_id    uuid NOT NULL REFERENCES purchase_orders(id),
  invoice_no  text,                                       -- số hóa đơn của nhà cung cấp
  note        text,
  received_by uuid NOT NULL REFERENCES users(id),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE goods_receipt_lines (
  id          bigserial PRIMARY KEY,
  receipt_id  uuid NOT NULL REFERENCES goods_receipts(id),
  line_id     bigint NOT NULL REFERENCES purchase_order_lines(id),
  lot_id      uuid NOT NULL REFERENCES stock_lots(id),
  qty         numeric(12,2) NOT NULL CHECK (qty > 0)
);
ALTER TABLE stock_moves ADD COLUMN receipt_id uuid REFERENCES goods_receipts(id);

/* ---------------- Thuốc kiểm soát đặc biệt: phân loại để lập sổ theo dõi ---------------- */

ALTER TABLE drugs ADD COLUMN control_class text CHECK (control_class IN ('gay_nghien', 'huong_than', 'tien_chat'));
UPDATE drugs SET control_class = 'gay_nghien' WHERE controlled AND name ~* '^(morphin|fentanyl|pethidin)';
UPDATE drugs SET control_class = 'huong_than' WHERE controlled AND control_class IS NULL AND name ~* '^(midazolam|diazepam|ketamin)';
-- Người chứng kiến ghi trên phiếu ePCR được giữ lại ở dòng xuất kho để in sổ
ALTER TABLE stock_moves ADD COLUMN witness text;

/* ---------------- Bình oxy ---------------- */

CREATE TABLE o2_cylinders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,                    -- số bình dập trên vỏ
  size_l         numeric(6,1) NOT NULL CHECK (size_l > 0),-- dung tích nước (lít): 2, 5, 10, 40...
  station_id     text NOT NULL REFERENCES stations(id),
  vehicle_id     text REFERENCES vehicles(id),            -- đang gắn trên xe nào; rỗng = ở kho điểm hoặc gửi nạp
  status         text NOT NULL DEFAULT 'day' CHECK (status IN ('day', 'dang_dung', 'rong', 'gui_nap', 'hong', 'thanh_ly')),
  pressure_bar   numeric(5,0) CHECK (pressure_bar BETWEEN 0 AND 300),
  full_bar       numeric(5,0) NOT NULL DEFAULT 150,       -- áp suất khi đầy
  last_filled_on date,
  next_test_on   date,                                    -- hạn kiểm định bình chịu áp lực
  supplier_id    uuid REFERENCES qm_suppliers(id),        -- đơn vị nạp
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX o2_cylinders_vehicle ON o2_cylinders(vehicle_id) WHERE vehicle_id IS NOT NULL;

CREATE TABLE o2_events (
  id           bigserial PRIMARY KEY,
  cylinder_id  uuid NOT NULL REFERENCES o2_cylinders(id),
  kind         text NOT NULL CHECK (kind IN ('nhap', 'do_ap', 'gan_xe', 've_kho', 'gui_nap', 'nhan_nap', 'kiem_dinh', 'hong', 'thanh_ly')),
  pressure_bar numeric(5,0),
  vehicle_id   text REFERENCES vehicles(id),
  note         text,
  user_id      uuid REFERENCES users(id),
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX o2_events_cylinder ON o2_events(cylinder_id, at DESC);

/* ---------------- Nhiệt độ, độ ẩm nơi bảo quản thuốc ---------------- */

CREATE TABLE storage_points (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('kho', 'tu_thuoc', 'tu_lanh', 'xe')),
  station_id  text NOT NULL REFERENCES stations(id),
  vehicle_id  text REFERENCES vehicles(id),
  min_c       numeric(4,1) NOT NULL,
  max_c       numeric(4,1) NOT NULL,
  max_humidity numeric(4,1),                              -- % độ ẩm tối đa (kho thường 75%)
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (min_c < max_c),
  UNIQUE (station_id, name)
);

CREATE TABLE temp_readings (
  id           bigserial PRIMARY KEY,
  point_id     uuid NOT NULL REFERENCES storage_points(id),
  at           timestamptz NOT NULL DEFAULT now(),
  temp_c       numeric(4,1) NOT NULL,
  humidity     numeric(4,1),
  out_of_range boolean NOT NULL,
  action       text,                                      -- xử trí khi ngoài ngưỡng
  user_id      uuid REFERENCES users(id),
  ack_by       uuid REFERENCES users(id),                 -- dược sĩ/trưởng ca đã xem xét lần ngoài ngưỡng
  ack_at       timestamptz,
  ack_note     text
);
CREATE INDEX temp_readings_point ON temp_readings(point_id, at DESC);
CREATE INDEX temp_readings_open ON temp_readings(at) WHERE out_of_range AND ack_at IS NULL;

/* ---------------- Tài sản cố định, khấu hao đường thẳng ---------------- */

CREATE TABLE fixed_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,                     -- TS-YYYY-NNNNN
  name          text NOT NULL,
  category      text NOT NULL CHECK (category IN ('xe', 'thiet_bi_y_te', 'cntt', 'nha_cua', 'noi_that', 'khac')),
  station_id    text REFERENCES stations(id),
  vehicle_id    text REFERENCES vehicles(id),
  equipment_id  uuid REFERENCES equipment(id),
  acquired_on   date NOT NULL,
  cost          numeric(14,0) NOT NULL CHECK (cost > 0),  -- nguyên giá
  life_months   int NOT NULL CHECK (life_months BETWEEN 1 AND 600),
  salvage       numeric(14,0) NOT NULL DEFAULT 0 CHECK (salvage >= 0),
  status        text NOT NULL DEFAULT 'dang_dung' CHECK (status IN ('dang_dung', 'thanh_ly')),
  disposed_on   date,
  disposal_note text,
  note          text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (salvage < cost)
);

/* ---------------- Đồng phục, bảo hộ lao động cấp cho nhân viên ---------------- */

CREATE TABLE ppe_items (
  id             serial PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  kind           text NOT NULL CHECK (kind IN ('dong_phuc', 'bao_ho')),
  unit           text NOT NULL DEFAULT 'bộ',
  replace_months int CHECK (replace_months BETWEEN 1 AND 120), -- cấp lại sau bao nhiêu tháng; rỗng = khi hỏng
  active         boolean NOT NULL DEFAULT true
);
INSERT INTO ppe_items(name, kind, unit, replace_months) VALUES
  ('Đồng phục cấp cứu (áo + quần phản quang)', 'dong_phuc', 'bộ', 12),
  ('Áo khoác phản quang', 'dong_phuc', 'cái', 24),
  ('Giày bảo hộ', 'bao_ho', 'đôi', 12),
  ('Mũ bảo hiểm hiện trường', 'bao_ho', 'cái', 36),
  ('Kính bảo hộ', 'bao_ho', 'cái', 12),
  ('Áo choàng phòng hộ cấp 4', 'bao_ho', 'bộ', NULL);

CREATE TABLE ppe_issues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  item_id     int NOT NULL REFERENCES ppe_items(id),
  qty         int NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 50),
  size        text,
  issued_on   date NOT NULL,
  due_on      date,                                       -- hạn cấp lại
  returned_on date,
  note        text,
  issued_by   uuid NOT NULL REFERENCES users(id),
  received_at timestamptz,                                -- nhân viên bấm xác nhận đã nhận
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ppe_issues_user ON ppe_issues(user_id, issued_on DESC);
