-- Giai đoạn AB2: lịch kiểm kê. Kho điểm kiểm toàn bộ mỗi ngày lúc 7:00; kho tổng kiểm ngày cuối tháng.
-- Có chênh lệch thì phiếu kiểm kê chờ người thứ hai duyệt (như phiếu kiểm kê hiện có). Kiểm mù (ẩn số sổ sách) tùy chọn.
CREATE TABLE stocktake_schedules (
  scope      text PRIMARY KEY CHECK (scope IN ('kho_diem', 'kho_tong')),
  frequency  text NOT NULL CHECK (frequency IN ('hang_ngay', 'hang_tuan', 'cuoi_thang')),
  at         time NOT NULL,
  blind      boolean NOT NULL DEFAULT false,
  active     boolean NOT NULL DEFAULT true
);
INSERT INTO stocktake_schedules(scope, frequency, at) VALUES ('kho_diem', 'hang_ngay', '07:00'), ('kho_tong', 'cuoi_thang', '07:00');

CREATE TABLE stocktake_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id    text NOT NULL REFERENCES stations(id),
  scope         text NOT NULL CHECK (scope IN ('kho_diem', 'kho_tong')),
  due_date      date NOT NULL,
  blind         boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'mo' CHECK (status IN ('mo', 'da_nop', 'qua_han')),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  voucher_id    uuid REFERENCES stock_vouchers(id),
  submitted_by  uuid REFERENCES users(id),
  submitted_at  timestamptz,
  UNIQUE (station_id, due_date)
);
CREATE INDEX stocktake_sessions_due ON stocktake_sessions(status, due_date);
