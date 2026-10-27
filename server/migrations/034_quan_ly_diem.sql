-- Quản lý điểm: mỗi điểm một người chịu trách nhiệm (và một người thay khi vắng), chọn trong nhân viên làm ở điểm đó.
-- Quản lý điểm nhận thông báo, báo cáo kho, kiểm kê của điểm mình.
ALTER TABLE stations ADD COLUMN manager_id uuid REFERENCES users(id);
ALTER TABLE stations ADD COLUMN deputy_id uuid REFERENCES users(id);
ALTER TABLE stations ADD CONSTRAINT stations_manager_deputy CHECK (deputy_id IS NULL OR deputy_id IS DISTINCT FROM manager_id);
