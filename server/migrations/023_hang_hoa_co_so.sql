-- Giai đoạn Z1–Z2: danh mục thuốc mở rộng thành danh mục hàng hóa chia nhóm (thuốc, dịch truyền, vật tư tiêu hao, dụng cụ, văn phòng phẩm)

CREATE TABLE item_groups (
  code  text PRIMARY KEY,
  name  text NOT NULL UNIQUE,
  sort  int NOT NULL DEFAULT 0
);
INSERT INTO item_groups(code, name, sort) VALUES
  ('duong_tho', 'Đường thở – Oxy', 10),
  ('tuan_hoan', 'Tuần hoàn – Truyền dịch', 20),
  ('thuoc_cap_cuu', 'Thuốc cấp cứu', 30),
  ('thuoc_kiem_soat', 'Thuốc kiểm soát đặc biệt', 40),
  ('bang_bo', 'Băng bó – Cố định – Vết thương', 50),
  ('san_nhi', 'Sản – Nhi', 60),
  ('bao_ho', 'Bảo hộ – Khử khuẩn', 70),
  ('van_phong_pham', 'Văn phòng phẩm – Giấy tờ', 80);

ALTER TABLE drugs
  ADD COLUMN kind       text NOT NULL DEFAULT 'thuoc' CHECK (kind IN ('thuoc', 'dich_truyen', 'vat_tu', 'dung_cu', 'van_phong_pham')),
  ADD COLUMN group_code text NOT NULL DEFAULT 'thuoc_cap_cuu' REFERENCES item_groups(code),
  ADD COLUMN code       text UNIQUE,                         -- mã hàng nội bộ (tùy chọn)
  ADD COLUMN track_lot  boolean NOT NULL DEFAULT true,       -- thuốc, dịch truyền theo số lô và hạn dùng; vật tư không hạn, văn phòng phẩm thì không
  ADD COLUMN billable   boolean NOT NULL DEFAULT false,      -- tính tiền riêng cho người bệnh
  ADD COLUMN sell_price numeric(14,0) CHECK (sell_price IS NULL OR sell_price >= 0);

UPDATE drugs SET kind = 'dich_truyen', group_code = 'tuan_hoan' WHERE name ~* '^(natri clorid 0,9% 500|ringer)';
UPDATE drugs SET group_code = 'thuoc_kiem_soat' WHERE controlled;
UPDATE drugs SET group_code = 'san_nhi' WHERE name ~* '^oxytocin';

-- Hàng không theo lô: một "lô" duy nhất mỗi nơi, hạn dùng xa (9999-12-31 nghĩa là không có hạn)
COMMENT ON COLUMN stock_lots.expiry IS '9999-12-31 = hàng không quản lý hạn dùng';
