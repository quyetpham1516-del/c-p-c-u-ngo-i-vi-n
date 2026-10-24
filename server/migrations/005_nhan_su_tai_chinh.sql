-- Đợt D: nhân sự (hồ sơ, chứng chỉ hành nghề, đào tạo, lịch trực, chấm công, nghỉ phép)
-- và tài chính (bảng giá, khách hàng hợp đồng, phiếu thu từ phiếu chuyển viện, công nợ, hóa đơn, đề xuất chi 2 cấp duyệt, chi phí, xuất kế toán).
-- Tên bảng theo tài liệu tái cấu trúc MedOne: staff, staff_docs, shifts (ở đây là roster), payments, invoices, expenses, price_lists, proposals.

-- Ngày hiện tại theo giờ Việt Nam (máy chủ CSDL có thể chạy giờ UTC)
CREATE FUNCTION vn_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date $$;

/* ---------------- Nhân sự ---------------- */

-- Hồ sơ nhân viên; nhân viên có thể chưa có tài khoản đăng nhập (user_id rỗng)
CREATE TABLE staff (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid UNIQUE REFERENCES users(id),
  code           text NOT NULL UNIQUE,                 -- mã nhân viên NV-0001
  full_name      text NOT NULL,
  title          text,                                 -- Bác sĩ, Điều dưỡng, Lái xe...
  department     text,
  station_id     text REFERENCES stations(id),
  phone          text,
  email          text,
  birth_date     date,
  hire_date      date,
  contract_type  text CHECK (contract_type IN ('thu_viec', 'xac_dinh', 'khong_xac_dinh', 'cong_tac_vien')),
  contract_end   date,
  status         text NOT NULL DEFAULT 'dang_lam' CHECK (status IN ('dang_lam', 'tam_nghi', 'nghi_viec')),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Giấy tờ hành nghề: chứng chỉ/giấy phép hành nghề, bằng lái, BLS/ACLS...; hết hạn thì chặn nhận ca trên xe
CREATE TABLE staff_docs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  kind        text NOT NULL CHECK (kind IN ('gphn', 'bang_lai', 'bls', 'acls', 'phtls', 'ksnk', 'pccc', 'khac')),
  number      text,
  issuer      text,
  issued_on   date,
  expires_on  date,
  suspended   boolean NOT NULL DEFAULT false,            -- bị đình chỉ, thu hồi
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_docs_staff ON staff_docs(staff_id);

-- Đào tạo, cập nhật kiến thức y khoa liên tục
CREATE TABLE trainings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES staff(id),
  course        text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('cme', 'bls', 'acls', 'phtls', 'ksnk', 'pccc', 'dieu_phoi', 'lai_xe', 'khac')),
  hours         numeric(6,1) NOT NULL DEFAULT 0 CHECK (hours >= 0),
  completed_on  date NOT NULL,
  provider      text,
  certificate   text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trainings_staff ON trainings(staff_id);

-- Lịch trực (phân ca kế hoạch)
CREATE TABLE roster (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  work_date   date NOT NULL,
  shift       text NOT NULL CHECK (shift IN ('ngay', 'dem', 'truc_24', 'hanh_chinh')),
  station_id  text REFERENCES stations(id),
  vehicle_id  text REFERENCES vehicles(id),
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, work_date, shift)
);
CREATE INDEX roster_date ON roster(work_date);

-- Chấm công cho nhân viên không đi xe (kíp đã có giờ thực tế từ crew_shifts)
CREATE TABLE attendance (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   uuid NOT NULL REFERENCES staff(id),
  check_in   timestamptz NOT NULL,
  check_out  timestamptz,
  source     text NOT NULL DEFAULT 'web',
  note       text,
  CHECK (check_out IS NULL OR check_out > check_in)
);
CREATE UNIQUE INDEX attendance_open_uq ON attendance(staff_id) WHERE check_out IS NULL;

CREATE TABLE leave_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  kind        text NOT NULL CHECK (kind IN ('phep_nam', 'om', 'viec_rieng', 'khong_luong', 'thai_san', 'khac')),
  from_date   date NOT NULL,
  to_date     date NOT NULL,
  reason      text,
  status      text NOT NULL DEFAULT 'cho_duyet' CHECK (status IN ('cho_duyet', 'da_duyet', 'tu_choi', 'huy')),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date)
);

-- Mỗi tài khoản có một hồ sơ nhân viên: tạo cho tài khoản đã có và tự tạo khi thêm tài khoản; số GPHN chuyển thành giấy tờ hành nghề
CREATE SEQUENCE staff_code_seq;
CREATE FUNCTION staff_from_user() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid;
BEGIN
  INSERT INTO staff(user_id, code, full_name, title, station_id)
  VALUES (NEW.id, 'NV-' || lpad(nextval('staff_code_seq')::text, 4, '0'), NEW.full_name, NEW.title, NEW.station_id)
  ON CONFLICT (user_id) DO NOTHING RETURNING id INTO sid;
  IF sid IS NOT NULL AND coalesce(NEW.license_no, '') <> '' THEN
    INSERT INTO staff_docs(staff_id, kind, number, note) VALUES (sid, 'gphn', NEW.license_no, 'Chuyển từ số GPHN trên tài khoản');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_staff AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION staff_from_user();
DO $$ DECLARE u users; BEGIN
  FOR u IN SELECT * FROM users ORDER BY created_at, username LOOP
    INSERT INTO staff(user_id, code, full_name, title, station_id)
    VALUES (u.id, 'NV-' || lpad(nextval('staff_code_seq')::text, 4, '0'), u.full_name, u.title, u.station_id);
    IF coalesce(u.license_no, '') <> '' THEN
      INSERT INTO staff_docs(staff_id, kind, number, note) SELECT id, 'gphn', u.license_no, 'Chuyển từ số GPHN trên tài khoản' FROM staff WHERE user_id = u.id;
    END IF;
  END LOOP;
END $$;

/* ---------------- Tài chính ---------------- */

CREATE TABLE finance_settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);

-- Bảng giá theo loại xe: giá mở cửa gồm số km đầu, km tiếp theo, chờ theo giờ, phụ thu đêm
CREATE TABLE price_lists (
  id                  serial PRIMARY KEY,
  name                text NOT NULL,
  vehicle_type        text NOT NULL,
  base_fee            numeric(14,0) NOT NULL CHECK (base_fee >= 0),
  base_km             numeric(6,1) NOT NULL DEFAULT 0,
  per_km              numeric(14,0) NOT NULL DEFAULT 0,
  wait_per_hour       numeric(14,0) NOT NULL DEFAULT 0,
  night_surcharge_pct numeric(5,2) NOT NULL DEFAULT 0,
  vat_rate            numeric(5,2) NOT NULL DEFAULT 0,      -- dịch vụ y tế thường không chịu thuế GTGT; kế toán chỉnh nếu cần
  effective_from      date NOT NULL DEFAULT vn_today(),
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX price_lists_active_uq ON price_lists(vehicle_type) WHERE active;

-- Khách hàng hợp đồng: bệnh viện, bảo hiểm, doanh nghiệp, sự kiện
CREATE TABLE customers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('benh_vien', 'bao_hiem', 'doanh_nghiep', 'su_kien', 'ca_nhan', 'khac')),
  tax_code       text,
  address        text,
  contact        text,
  phone          text,
  email          text,
  contract_no    text,
  contract_from  date,
  contract_to    date,
  discount_pct   numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  payment_days   int NOT NULL DEFAULT 0 CHECK (payment_days BETWEEN 0 AND 365),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE incidents ADD COLUMN customer_id uuid REFERENCES customers(id);

-- Khoản phải thu: tự sinh khi ký phiếu chuyển viện
CREATE TABLE charges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,                -- KT-YYYY-NNNNN
  transfer_id     uuid UNIQUE REFERENCES transfers(id),
  incident_id     uuid REFERENCES incidents(id),
  vehicle_id      text REFERENCES vehicles(id),
  station_id      text REFERENCES stations(id),
  customer_id     uuid REFERENCES customers(id),
  payer_kind      text NOT NULL CHECK (payer_kind IN ('BHYT', 'THU_PHI', 'MIEN', 'GIAM', 'THAT_THU', 'HOP_DONG')),
  payer_name      text,
  price_list_id   int REFERENCES price_lists(id),
  service_date    date NOT NULL,
  km              numeric(7,1),
  wait_hours      numeric(5,1) NOT NULL DEFAULT 0,
  night           boolean NOT NULL DEFAULT false,
  lines           jsonb NOT NULL DEFAULT '[]',         -- [{label, qty, unit_price, amount}]
  subtotal        numeric(14,0) NOT NULL DEFAULT 0,
  discount        numeric(14,0) NOT NULL DEFAULT 0,    -- giảm theo hợp đồng
  vat             numeric(14,0) NOT NULL DEFAULT 0,
  total           numeric(14,0) NOT NULL DEFAULT 0,
  paid            numeric(14,0) NOT NULL DEFAULT 0,
  waived          numeric(14,0) NOT NULL DEFAULT 0,    -- miễn, giảm, thất thu đã duyệt
  due_date        date,
  status          text NOT NULL DEFAULT 'cho_thu' CHECK (status IN ('thieu_thong_tin', 'cho_thu', 'thu_mot_phan', 'da_thu', 'mien_giam', 'that_thu', 'huy')),
  waiver_kind     text CHECK (waiver_kind IN ('mien', 'giam', 'that_thu')),
  waiver_amount   numeric(14,0),
  waiver_reason   text,
  waiver_status   text CHECK (waiver_status IN ('cho_duyet', 'da_duyet', 'tu_choi')),
  waiver_by       uuid REFERENCES users(id),
  waiver_decided_by uuid REFERENCES users(id),
  waiver_decided_at timestamptz,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX charges_status ON charges(status);
CREATE INDEX charges_date ON charges(service_date);

-- Phiếu thu tiền
CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,                   -- PT-YYYY-NNNNN
  charge_id    uuid NOT NULL REFERENCES charges(id),
  amount       numeric(14,0) NOT NULL CHECK (amount > 0),
  method       text NOT NULL CHECK (method IN ('tien_mat', 'chuyen_khoan', 'the', 'bhyt')),
  reference    text,
  payer_name   text,
  received_by  uuid NOT NULL REFERENCES users(id),
  received_at  timestamptz NOT NULL DEFAULT now(),
  voided       boolean NOT NULL DEFAULT false,
  void_reason  text
);
CREATE INDEX payments_charge ON payments(charge_id);

-- Hóa đơn (số hóa đơn điện tử ghi lại từ nhà cung cấp)
CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,                  -- HD-YYYY-NNNNN (số nội bộ)
  customer_id   uuid REFERENCES customers(id),
  buyer_name    text NOT NULL,
  buyer_tax_code text,
  buyer_address text,
  issued_on     date NOT NULL DEFAULT vn_today(),
  subtotal      numeric(14,0) NOT NULL,
  vat           numeric(14,0) NOT NULL,
  total         numeric(14,0) NOT NULL,
  status        text NOT NULL DEFAULT 'nhap' CHECK (status IN ('nhap', 'da_phat_hanh', 'huy')),
  einvoice_no   text,
  einvoice_symbol text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invoice_charges (
  invoice_id  uuid NOT NULL REFERENCES invoices(id),
  charge_id   uuid NOT NULL REFERENCES charges(id),
  PRIMARY KEY (invoice_id, charge_id)
);

-- Đề xuất chi: cấp 1 kế toán kiểm soát, cấp 2 Ban Giám đốc khi từ ngưỡng trở lên
CREATE TABLE proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,                   -- DX-YYYY-NNNNN
  kind         text NOT NULL CHECK (kind IN ('mua_sam', 'sua_chua', 'chi_phi', 'tam_ung', 'khac')),
  title        text NOT NULL,
  description  text,
  amount       numeric(14,0) NOT NULL CHECK (amount > 0),
  station_id   text REFERENCES stations(id),
  vehicle_id   text REFERENCES vehicles(id),
  status       text NOT NULL DEFAULT 'cho_duyet_1' CHECK (status IN ('cho_duyet_1', 'cho_duyet_2', 'da_duyet', 'tu_choi', 'da_chi', 'huy')),
  created_by   uuid NOT NULL REFERENCES users(id),
  l1_by        uuid REFERENCES users(id),
  l1_at        timestamptz,
  l1_note      text,
  l2_by        uuid REFERENCES users(id),
  l2_at        timestamptz,
  l2_note      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Chi phí thực tế (phiếu chi)
CREATE TABLE expenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,                   -- PC-YYYY-NNNNN
  category     text NOT NULL CHECK (category IN ('nhien_lieu', 'sua_chua_xe', 'bao_duong_tb', 'thuoc_vat_tu', 'luong', 'thue_mat_bang', 'dien_nuoc', 'cau_duong', 'bao_hiem', 'khac')),
  amount       numeric(14,0) NOT NULL CHECK (amount > 0),
  spent_on     date NOT NULL,
  method       text NOT NULL CHECK (method IN ('tien_mat', 'chuyen_khoan', 'cong_no')),
  payee        text,
  doc_no       text,                                   -- số hóa đơn của bên bán
  station_id   text REFERENCES stations(id),
  vehicle_id   text REFERENCES vehicles(id),
  proposal_id  uuid REFERENCES proposals(id),
  note         text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_date ON expenses(spent_on);
