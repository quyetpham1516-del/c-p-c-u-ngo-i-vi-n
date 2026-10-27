-- Giai đoạn AB3: báo cáo kho tự động. Nộp kiểm kê xong hệ thống tự lập báo cáo nhập, xuất, tồn và chênh lệch,
-- gửi người nhận: kho tổng cho quản trị, Ban Giám đốc, kế toán; kho điểm cho trưởng bộ phận cấp cứu.
CREATE TABLE inventory_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,                 -- BCK-2026-00001
  station_id    text NOT NULL REFERENCES stations(id),
  scope         text NOT NULL CHECK (scope IN ('kho_diem', 'kho_tong')),
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  session_id    uuid REFERENCES stocktake_sessions(id),
  summary       jsonb NOT NULL,                       -- số mặt hàng, số lô lệch, tổng nhập, xuất
  rows          jsonb NOT NULL,                       -- từng mặt hàng: đầu kỳ, nhập, xuất, điều chỉnh, sổ sách, đếm, chênh lệch
  recipients    uuid[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_reports_station ON inventory_reports(station_id, created_at DESC);
