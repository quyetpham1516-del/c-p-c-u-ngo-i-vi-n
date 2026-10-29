-- Giai đoạn AB0b: tài khoản theo loại, nhiệm vụ từng vị trí trong kíp.
-- Cá nhân: số căn cước 12 số (mã hóa, chỉ hiện 4 số cuối). Tổ chức: mã số thuế 10 hoặc 13 số.
-- Chứng chỉ hành nghề chỉ bắt buộc với chức danh Bác sĩ, Y sĩ, Điều dưỡng.
ALTER TABLE users ADD COLUMN account_type text NOT NULL DEFAULT 'ca_nhan' CHECK (account_type IN ('ca_nhan', 'to_chuc'));
ALTER TABLE users ADD COLUMN tax_code text CHECK (tax_code ~ '^\d{10}(\d{3})?$');
ALTER TABLE users ADD COLUMN cccd_enc text;
ALTER TABLE users ADD COLUMN cccd_last4 text;
ALTER TABLE users ADD COLUMN cccd_hash text;
CREATE UNIQUE INDEX users_cccd_hash ON users(cccd_hash) WHERE cccd_hash IS NOT NULL;

ALTER TABLE hospitals ADD COLUMN tax_code text CHECK (tax_code ~ '^\d{10}(\d{3})?$');

-- Vị trí trong kíp tách Điều dưỡng 1, Điều dưỡng 2 để giao việc cụ thể
INSERT INTO crew_roles(name, sort) VALUES ('Điều dưỡng 1', 3), ('Điều dưỡng 2', 3) ON CONFLICT DO NOTHING;

-- Nhiệm vụ của từng vị trí: đầu ca, tại hiện trường, sau ca. Trưởng nhóm đề xuất thay đổi, quản trị duyệt.
CREATE TABLE crew_duty_tasks (
  id        serial PRIMARY KEY,
  position  text NOT NULL REFERENCES crew_roles(name) ON UPDATE CASCADE,
  phase     text NOT NULL CHECK (phase IN ('dau_ca', 'hien_truong', 'sau_ca')),
  sort      int NOT NULL DEFAULT 0,
  task      text NOT NULL
);
CREATE INDEX crew_duty_tasks_position ON crew_duty_tasks(position, phase, sort);

-- Bản nháp ban đầu để trưởng nhóm sửa
INSERT INTO crew_duty_tasks(position, phase, sort, task) VALUES
  ('Trưởng kíp', 'dau_ca', 1, 'Nhận bàn giao xe, kiểm tra đủ người theo vị trí'),
  ('Trưởng kíp', 'dau_ca', 2, 'Kiểm tra máy sốc điện, monitor, oxy'),
  ('Trưởng kíp', 'hien_truong', 1, 'Đánh giá an toàn hiện trường, phân việc cho kíp'),
  ('Trưởng kíp', 'hien_truong', 2, 'Khám, chỉ định xử trí, quyết định nơi chuyển'),
  ('Trưởng kíp', 'hien_truong', 3, 'Báo trước cho bệnh viện nhận'),
  ('Trưởng kíp', 'sau_ca', 1, 'Ký phiếu chăm sóc, phiếu chuyển viện'),
  ('Trưởng kíp', 'sau_ca', 2, 'Bàn giao xe cho kíp sau'),
  ('Điều dưỡng 1', 'dau_ca', 1, 'Kiểm thuốc, dụng cụ trên xe theo cơ số'),
  ('Điều dưỡng 1', 'hien_truong', 1, 'Lấy ven, đặt đường truyền'),
  ('Điều dưỡng 1', 'hien_truong', 2, 'Cho thuốc theo y lệnh, ghi giờ dùng thuốc'),
  ('Điều dưỡng 1', 'sau_ca', 1, 'Bổ sung thuốc, dụng cụ đã dùng'),
  ('Điều dưỡng 2', 'dau_ca', 1, 'Kiểm tra bình oxy, máy hút, cáng'),
  ('Điều dưỡng 2', 'hien_truong', 1, 'Theo dõi dấu hiệu sinh tồn, hỗ trợ đường thở'),
  ('Điều dưỡng 2', 'hien_truong', 2, 'Cố định, vận chuyển người bệnh'),
  ('Điều dưỡng 2', 'sau_ca', 1, 'Vệ sinh, khử khuẩn xe và thiết bị'),
  ('Lái xe', 'dau_ca', 1, 'Kiểm tra nhiên liệu, đèn, còi, lốp'),
  ('Lái xe', 'hien_truong', 1, 'Đỗ xe an toàn, hỗ trợ khiêng cáng'),
  ('Lái xe', 'sau_ca', 1, 'Đổ nhiên liệu, ghi số km, báo hỏng hóc');
