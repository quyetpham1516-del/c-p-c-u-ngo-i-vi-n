-- Ca tự đến bệnh viện (người dân tự đưa tới khoa cấp cứu, không qua xe 115): tài khoản bệnh viện tạo ca mới trong biểu mẫu
-- nghiên cứu, điền đủ các phần. Ca dùng chung danh sách, báo cáo, file xuất với ca xe 115; biết bệnh viện nào, ai nhập để thanh toán.
ALTER TABLE registry_cases ALTER COLUMN transfer_id DROP NOT NULL;
ALTER TABLE registry_cases ADD COLUMN source text NOT NULL DEFAULT 'xe_115' CHECK (source IN ('xe_115', 'tu_den'));
ALTER TABLE registry_cases ADD COLUMN hospital_record_no text;          -- số hồ sơ, số vào viện của bệnh viện (chặn nhập trùng)
ALTER TABLE registry_cases ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE registry_cases ADD COLUMN completed_by uuid REFERENCES users(id);  -- người lưu lần làm biểu mẫu đủ
ALTER TABLE registry_cases ADD COLUMN paid_at timestamptz;              -- đã thanh toán cho người nhập (mỗi ca một lần)
ALTER TABLE registry_cases ADD COLUMN paid_by uuid REFERENCES users(id);
ALTER TABLE registry_cases ADD COLUMN paid_amount numeric(14,0);
ALTER TABLE registry_cases ADD CONSTRAINT registry_cases_source_ck CHECK (
  (source = 'xe_115' AND transfer_id IS NOT NULL) OR (source = 'tu_den' AND hospital_id IS NOT NULL AND hospital_record_no IS NOT NULL));
CREATE UNIQUE INDEX registry_cases_walkin_uq ON registry_cases(registry, hospital_id, hospital_record_no) WHERE source = 'tu_den';
-- Ca cũ đã đủ: ghi người hoàn tất là người sửa cuối
UPDATE registry_cases SET completed_by = updated_by WHERE status = 'du';

-- Đơn giá trả cho mỗi ca đủ (để trống là chưa đặt); admin, Ban Giám đốc nhập
ALTER TABLE registry_settings ADD COLUMN rate_walk_in numeric(14,0) CHECK (rate_walk_in >= 0);  -- ca tự đến: bệnh viện nhập cả phiếu
ALTER TABLE registry_settings ADD COLUMN rate_ems numeric(14,0) CHECK (rate_ems >= 0);          -- ca xe 115: bệnh viện điền phần trong viện
