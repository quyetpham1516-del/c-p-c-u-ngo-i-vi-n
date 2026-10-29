-- Giai đoạn AB1: một kho tổng dùng chung phát cho kho điểm.
-- Kho điểm lập phiếu lĩnh, kho tổng duyệt rồi xuất; kho tổng cũng tự phát theo định mức tối thiểu của từng điểm.
-- Xuất là trừ kho tổng ngay; kho điểm xác nhận số thực nhận mới cộng vào kho điểm, chênh lệch thì báo kho tổng và quản trị.
CREATE TABLE inventory_settings (
  id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  central_station_id  text REFERENCES stations(id),     -- để trống: lấy điểm loại "kho trung tâm", không có thì trụ sở
  auto_issue          boolean NOT NULL DEFAULT false,   -- mỗi ngày tự lập phiếu phát cho điểm dưới định mức
  auto_issue_at       time NOT NULL DEFAULT '06:00',
  last_auto_issue_on  date
);
INSERT INTO inventory_settings DEFAULT VALUES;

CREATE TABLE stock_requisitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,                   -- PL-2026-00001
  station_id    text NOT NULL REFERENCES stations(id),  -- kho điểm nhận
  central_id    text NOT NULL REFERENCES stations(id),  -- kho tổng xuất
  source        text NOT NULL CHECK (source IN ('kho_diem', 'tu_dong')),
  status        text NOT NULL CHECK (status IN ('cho_duyet', 'da_duyet', 'da_xuat', 'da_nhan', 'tu_choi', 'huy')),
  note          text,
  created_by    uuid REFERENCES users(id),              -- trống: hệ thống tự lập theo định mức
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text,
  issued_by     uuid REFERENCES users(id),
  issued_at     timestamptz,
  witness       text,
  received_by   uuid REFERENCES users(id),
  received_at   timestamptz,
  receive_note  text,
  discrepancy   boolean NOT NULL DEFAULT false
);
CREATE INDEX stock_requisitions_station ON stock_requisitions(station_id, status, created_at DESC);

CREATE TABLE stock_requisition_lines (
  id              bigserial PRIMARY KEY,
  requisition_id  uuid NOT NULL REFERENCES stock_requisitions(id) ON DELETE CASCADE,
  drug_id         int NOT NULL REFERENCES drugs(id),
  requested_qty   numeric NOT NULL CHECK (requested_qty > 0),
  approved_qty    numeric CHECK (approved_qty >= 0),
  UNIQUE (requisition_id, drug_id)
);

-- Lô thực xuất cho từng dòng (theo hạn dùng sớm nhất trước), số kho điểm thực nhận
CREATE TABLE stock_requisition_issues (
  id            bigserial PRIMARY KEY,
  line_id       bigint NOT NULL REFERENCES stock_requisition_lines(id) ON DELETE CASCADE,
  from_lot_id   uuid NOT NULL REFERENCES stock_lots(id),
  lot           text NOT NULL,
  expiry        date NOT NULL,
  qty           numeric NOT NULL CHECK (qty > 0),
  received_qty  numeric CHECK (received_qty >= 0),
  to_lot_id     uuid REFERENCES stock_lots(id)
);

ALTER TABLE stock_moves DROP CONSTRAINT IF EXISTS stock_moves_reason_check;
ALTER TABLE stock_moves ADD CONSTRAINT stock_moves_reason_check CHECK (reason IN (
  'nhap_kho', 'dung_cho_nguoi_benh', 'dieu_chinh', 'cap_xe', 'tra_kho', 'dieu_chuyen', 'kiem_ke', 'huy', 'xuat_kho_diem', 'nhan_kho_tong'));
ALTER TABLE stock_moves ADD COLUMN requisition_id uuid REFERENCES stock_requisitions(id);
