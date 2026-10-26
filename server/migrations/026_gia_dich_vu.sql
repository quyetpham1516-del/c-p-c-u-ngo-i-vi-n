-- Bảng giá dịch vụ kỹ thuật (admin, kế toán chỉnh): tự cộng vào khoản thu khi phiếu có can thiệp, cận lâm sàng tương ứng.
-- Giá mẫu là bản nháp để trung tâm sửa theo bảng giá được duyệt.
CREATE TABLE service_prices (
  id          serial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  unit        text NOT NULL DEFAULT 'lần',
  price       numeric(14,0) NOT NULL CHECK (price >= 0),
  care_key    text,          -- tự tính khi ô can thiệp này được đánh dấu trên phiếu
  lab_type    text,          -- tự tính theo số kết quả cận lâm sàng loại này
  active      boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 50,
  note        text,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO service_prices(code, name, unit, price, care_key, lab_type, sort, note) VALUES
  ('OXY', 'Thở oxy', 'ca', 50000, 'o2Cannula', NULL, 1, 'Bản nháp'),
  ('OXY_MASK', 'Thở oxy mask có túi', 'ca', 80000, 'nrbMask', NULL, 2, 'Bản nháp'),
  ('MONITOR', 'Theo dõi monitor', 'ca', 100000, 'monitor', NULL, 3, 'Bản nháp'),
  ('IV', 'Lập đường truyền tĩnh mạch', 'lần', 100000, 'iv', NULL, 4, 'Bản nháp'),
  ('DEFIB', 'Sốc điện', 'ca', 300000, 'defib', NULL, 5, 'Bản nháp'),
  ('ETT', 'Đặt nội khí quản', 'lần', 500000, 'ett', NULL, 6, 'Bản nháp'),
  ('LMA', 'Đặt mask thanh quản', 'lần', 300000, 'lma', NULL, 7, 'Bản nháp'),
  ('SUCTION', 'Hút đàm', 'lần', 50000, 'suction', NULL, 8, 'Bản nháp'),
  ('NEB', 'Phun khí dung', 'lần', 50000, 'nebulizer', NULL, 9, 'Bản nháp'),
  ('SPINE', 'Cố định cột sống', 'ca', 150000, 'spine', NULL, 10, 'Bản nháp'),
  ('GLUCOSE', 'Đo đường huyết mao mạch', 'lần', 30000, NULL, 'glucose', 11, 'Bản nháp'),
  ('ECG12', 'Điện tim 12 chuyển đạo', 'lần', 100000, NULL, 'ecg12', 12, 'Bản nháp');

-- Dòng dịch vụ, thuốc, vật tư tính tiền riêng (ngoài giá vận chuyển); km lấy từ khai báo hay GPS
ALTER TABLE charges ADD COLUMN extras jsonb NOT NULL DEFAULT '[]', ADD COLUMN km_source text CHECK (km_source IN ('khai', 'gps'));
