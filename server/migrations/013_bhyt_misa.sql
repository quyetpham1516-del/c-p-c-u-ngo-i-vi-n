/* Giai đoạn M: bảng kê BHYT xuất XML theo QĐ 130/QĐ-BYT (sửa đổi QĐ 4750/QĐ-BYT), xuất phiếu thu, phiếu chi sang MISA */

-- Thông tin thẻ BHYT kế toán nhập cho khoản thu đối tượng BHYT:
-- {cardNo, dkbd, validFrom, validTo, mucHuong, khuVuc, doiTuongKcb, noiDi}
ALTER TABLE charges ADD COLUMN bhyt jsonb;
ALTER TABLE charges ADD COLUMN bhyt_exported_at timestamptz;

CREATE TABLE bhyt_exports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_date   date NOT NULL,
  to_date     date NOT NULL,
  charge_ids  uuid[] NOT NULL,
  total_bv    numeric(14,0) NOT NULL,
  total_bhtt  numeric(14,2) NOT NULL,
  sha256      text NOT NULL,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
