-- Quản lý điểm: mỗi điểm một người chịu trách nhiệm (và một người thay khi vắng), chọn trong nhân viên làm ở điểm đó.
-- Quản lý điểm nhận thông báo, báo cáo kho, kiểm kê của điểm mình.
ALTER TABLE stations ADD COLUMN manager_id uuid REFERENCES users(id);
ALTER TABLE stations ADD COLUMN deputy_id uuid REFERENCES users(id);
ALTER TABLE stations ADD CONSTRAINT stations_manager_deputy CHECK (deputy_id IS NULL OR deputy_id IS DISTINCT FROM manager_id);

-- Hai loại phiếu: phiếu đề xuất (điểm xin khi thiếu, nguồn kho_diem) và phiếu lĩnh (kho tổng phát định kỳ, nguồn tu_dong).
-- Phiếu đề xuất khẩn: kíp lập khi quản lý điểm và người thay đều vắng; gắn nhãn, báo quản lý điểm.
ALTER TABLE stock_requisitions ADD COLUMN urgent boolean NOT NULL DEFAULT false;

-- Kíp báo thiếu cho quản lý điểm; quản lý gộp vào phiếu đề xuất
CREATE TABLE station_shortages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id      text NOT NULL REFERENCES stations(id),
  drug_id         int REFERENCES drugs(id),
  item_text       text,                                -- mặt hàng chưa có trong danh mục
  qty             numeric CHECK (qty > 0),
  note            text,
  reported_by     uuid NOT NULL REFERENCES users(id),
  reported_at     timestamptz NOT NULL DEFAULT now(),
  requisition_id  uuid REFERENCES stock_requisitions(id),
  closed_by       uuid REFERENCES users(id),
  closed_at       timestamptz,
  close_note      text,
  CHECK (drug_id IS NOT NULL OR item_text IS NOT NULL)
);
CREATE INDEX station_shortages_open ON station_shortages(station_id) WHERE closed_at IS NULL;
