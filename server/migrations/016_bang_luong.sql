/* Giai đoạn P: bảng lương tháng từ lịch trực, chấm công, ca trên xe; BHXH, thuế TNCN; phiếu lương cá nhân */

-- Hồ sơ lương từng nhân viên (chỉ nhân sự, kế toán, Ban Giám đốc xem được)
CREATE TABLE staff_salary (
  staff_id         uuid PRIMARY KEY REFERENCES staff(id),
  pay_type         text NOT NULL DEFAULT 'thang' CHECK (pay_type IN ('thang', 'ca')),  -- lương tháng hoặc theo ca (cộng tác viên)
  base_salary      numeric(14,0) NOT NULL DEFAULT 0 CHECK (base_salary >= 0),         -- lương theo hợp đồng / tháng
  insurance_salary numeric(14,0) CHECK (insurance_salary >= 0),                       -- lương đóng BHXH (trống = lương cơ bản)
  shift_rate       numeric(14,0) NOT NULL DEFAULT 0 CHECK (shift_rate >= 0),          -- tiền mỗi ca khi trả theo ca
  allowances       jsonb NOT NULL DEFAULT '[]'::jsonb,                                -- [{name, amount, taxable, insurable}]
  dependents       int NOT NULL DEFAULT 0 CHECK (dependents BETWEEN 0 AND 20),        -- người phụ thuộc đã đăng ký giảm trừ
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payroll_periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month       text NOT NULL UNIQUE CHECK (month ~ '^\d{4}-\d{2}$'),
  status      text NOT NULL DEFAULT 'nhap' CHECK (status IN ('nhap', 'da_duyet', 'da_chi')),
  settings    jsonb NOT NULL,                  -- tham số dùng khi tính (giữ lại để đối chiếu về sau)
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  computed_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  paid_by     uuid REFERENCES users(id),
  paid_at     timestamptz
);

CREATE TABLE payroll_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id   uuid NOT NULL REFERENCES payroll_periods(id),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  input       jsonb NOT NULL,                  -- hồ sơ lương và số liệu công lúc tính
  adjustments jsonb NOT NULL DEFAULT '[]'::jsonb, -- thưởng, truy thu, trừ tạm ứng... [{name, amount, taxable}]
  result      jsonb NOT NULL,                  -- từng khoản đã tính
  gross       numeric(14,0) NOT NULL,
  ins_emp     numeric(14,0) NOT NULL,
  ins_er      numeric(14,0) NOT NULL,
  pit         numeric(14,0) NOT NULL,
  net         numeric(14,0) NOT NULL,
  UNIQUE (period_id, staff_id)
);
