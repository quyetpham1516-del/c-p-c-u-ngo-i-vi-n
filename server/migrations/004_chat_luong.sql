-- Đợt C: chất lượng và an toàn. Kiểm soát nhiễm khuẩn (QLCL-05), sự cố y khoa và hành động khắc phục (QLCL-03, QLCL-10),
-- khiếu nại (QLCL-07), khảo sát hài lòng (QLCL-08).

/* ---------------- Kiểm soát nhiễm khuẩn ---------------- */

-- Nguy cơ lây nhiễm của ca do điều phối hoặc kíp đánh dấu; quyết định mức khử khuẩn xe sau ca
ALTER TABLE incidents ADD COLUMN infection_risk text CHECK (infection_risk IN ('tiep_xuc', 'giot_ban', 'khong_khi'));

-- Phiếu khử khuẩn xe: tự tạo (chờ làm) khi xe xong ca; ca nghi lây nhiễm thì xe không về sẵn sàng khi chưa ký phiếu đủ mức
CREATE TABLE disinfections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id       text NOT NULL REFERENCES vehicles(id),
  incident_id      uuid REFERENCES incidents(id),
  level            text NOT NULL CHECK (level IN ('thuong_quy', 'tang_cuong', 'toan_dien')),
  required_level   text NOT NULL DEFAULT 'thuong_quy' CHECK (required_level IN ('thuong_quy', 'tang_cuong', 'toan_dien')),
  status           text NOT NULL DEFAULT 'cho_lam' CHECK (status IN ('cho_lam', 'da_ky')),
  checklist        jsonb NOT NULL DEFAULT '{}',
  chemical         text,
  concentration    text,
  contact_minutes  int,
  note             text,
  done_by          uuid REFERENCES users(id),
  done_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX disinfections_vehicle_incident_uq ON disinfections (vehicle_id, incident_id) WHERE incident_id IS NOT NULL;
CREATE INDEX disinfections_pending_idx ON disinfections (status, created_at) WHERE status = 'cho_lam';

-- Giám sát vệ sinh tay theo 5 thời điểm
CREATE TABLE hand_hygiene_obs (
  id          bigserial PRIMARY KEY,
  station_id  text REFERENCES stations(id),
  observer_id uuid NOT NULL REFERENCES users(id),
  staff_id    uuid REFERENCES users(id),
  staff_group text,                       -- bác sĩ, điều dưỡng, lái xe... khi không ghi tên
  moment      text NOT NULL CHECK (moment IN ('truoc_tiep_xuc', 'truoc_vo_khuan', 'sau_dich_co_the', 'sau_tiep_xuc', 'sau_moi_truong')),
  compliant   boolean NOT NULL,
  method      text CHECK (method IN ('chua_con', 'xa_phong', 'khong')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  note        text
);

-- Phơi nhiễm nghề nghiệp (kim đâm, máu bắn...): hồ sơ bảo mật, chỉ người báo, KSNK, ban giám đốc, quản trị xem
CREATE TABLE exposures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES users(id),
  reported_by   uuid NOT NULL REFERENCES users(id),
  occurred_at   timestamptz NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('kim_dam', 'vat_sac', 'mau_ban_niem_mac', 'mau_ban_da_ton_thuong', 'khac')),
  incident_id   uuid REFERENCES incidents(id),
  description   text NOT NULL,
  first_aid     text,
  source_status text,                     -- tình trạng nguồn lây nếu biết (HBV, HCV, HIV)
  pep_started_at timestamptz,             -- bắt đầu điều trị dự phòng sau phơi nhiễm
  followups     jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'dang_theo_doi' CHECK (status IN ('dang_theo_doi', 'ket_thuc')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Tiêm chủng nhân viên
CREATE TABLE vaccinations (
  id         bigserial PRIMARY KEY,
  staff_id   uuid NOT NULL REFERENCES users(id),
  vaccine    text NOT NULL,
  dose       text,
  given_on   date NOT NULL,
  next_due   date,
  note       text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Chất thải y tế theo điểm
CREATE TABLE medical_waste (
  id          bigserial PRIMARY KEY,
  station_id  text NOT NULL REFERENCES stations(id),
  on_date     date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('lay_nhiem', 'sac_nhon', 'nguy_hai', 'thong_thuong', 'tai_che')),
  kg          numeric NOT NULL CHECK (kg >= 0),
  handed_to   text,
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

/* ---------------- Sự cố y khoa và hành động khắc phục ---------------- */

-- Báo cáo sự cố theo TT 43/2018/TT-BYT: tự nguyện, cho phép ẩn danh (không lưu người báo)
CREATE TABLE adverse_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  reported_at      timestamptz NOT NULL DEFAULT now(),
  occurred_at      timestamptz NOT NULL,
  reporter_id      uuid REFERENCES users(id),           -- rỗng khi ẩn danh
  anonymous        boolean NOT NULL DEFAULT false,
  incident_id      uuid REFERENCES incidents(id),
  vehicle_id       text REFERENCES vehicles(id),
  station_id       text REFERENCES stations(id),
  category         text NOT NULL,
  description      text NOT NULL,
  immediate_action text,
  patient_affected boolean NOT NULL DEFAULT false,
  severity_reported text NOT NULL CHECK (severity_reported IN ('NC0', 'NC1', 'NC2', 'NC3')),
  severity         text CHECK (severity IN ('NC0', 'NC1', 'NC2', 'NC3')),   -- QLCL phân loại lại
  status           text NOT NULL DEFAULT 'moi' CHECK (status IN ('moi', 'dang_xu_ly', 'da_phan_tich', 'dong')),
  handler_id       uuid REFERENCES users(id),
  root_cause       text,
  factors          text[] NOT NULL DEFAULT '{}',          -- nhóm nguyên nhân: con người, quy trình, thiết bị, môi trường, tổ chức, người bệnh
  lessons          text,
  source_ref       text,                                  -- gợi ý tự động đã tạo ra báo cáo này (để không gợi ý lại)
  authority_reported_at timestamptz,                      -- sự cố nghiêm trọng (NC3): đã báo cơ quan quản lý (trong 24 giờ)
  closed_by        uuid REFERENCES users(id),
  closed_at        timestamptz,
  close_note       text
);
CREATE INDEX adverse_events_status_idx ON adverse_events (status, reported_at DESC);
CREATE UNIQUE INDEX adverse_events_source_uq ON adverse_events (source_ref) WHERE source_ref IS NOT NULL;

/* ---------------- Khiếu nại và hài lòng ---------------- */

CREATE TABLE complaints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  received_at   timestamptz NOT NULL DEFAULT now(),
  channel       text NOT NULL CHECK (channel IN ('dien_thoai', 'truc_tiep', 'email', 'mang_xa_hoi', 'khao_sat', 'khac')),
  complainant   text,
  phone         text,
  incident_id   uuid REFERENCES incidents(id),
  category      text NOT NULL CHECK (category IN ('thai_do', 'thoi_gian', 'chuyen_mon', 'chi_phi', 'khac')),
  content       text NOT NULL,
  urgent        boolean NOT NULL DEFAULT false,
  due_at        timestamptz NOT NULL,                 -- hạn phản hồi: 24 giờ (khẩn) hoặc 48 giờ
  status        text NOT NULL DEFAULT 'moi' CHECK (status IN ('moi', 'dang_xu_ly', 'da_phan_hoi', 'dong')),
  assigned_to   uuid REFERENCES users(id),
  response      text,
  responded_at  timestamptz,
  responded_by  uuid REFERENCES users(id),
  satisfied     boolean,
  created_by    uuid REFERENCES users(id)
);
CREATE INDEX complaints_status_idx ON complaints (status, due_at);

-- Hành động khắc phục, phòng ngừa (CAPA) cho sự cố hoặc khiếu nại
CREATE TABLE capa_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid REFERENCES adverse_events(id),
  complaint_id uuid REFERENCES complaints(id),
  kind         text NOT NULL DEFAULT 'khac_phuc' CHECK (kind IN ('khac_phuc', 'phong_ngua')),
  description  text NOT NULL,
  owner_id     uuid NOT NULL REFERENCES users(id),
  due_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'mo' CHECK (status IN ('mo', 'xong', 'huy')),
  done_at      timestamptz,
  evidence     text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (event_id IS NOT NULL OR complaint_id IS NOT NULL)
);

-- Khảo sát hài lòng gửi tới số gọi lại sau khi đóng ca; người bệnh/người nhà trả lời qua đường dẫn có mã riêng
CREATE TABLE surveys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid NOT NULL UNIQUE REFERENCES incidents(id),
  token        text NOT NULL UNIQUE,
  phone        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz,
  overall      int CHECK (overall BETWEEN 1 AND 5),
  timeliness   int CHECK (timeliness BETWEEN 1 AND 5),
  attitude     int CHECK (attitude BETWEEN 1 AND 5),
  care         int CHECK (care BETWEEN 1 AND 5),
  comment      text
);

-- Hàng đợi tin nhắn gửi ra ngoài (SMS/Zalo); bộ phận gửi đọc hàng đợi và đánh dấu đã gửi
CREATE TABLE message_outbox (
  id         bigserial PRIMARY KEY,
  channel    text NOT NULL DEFAULT 'sms',
  to_phone   text NOT NULL,
  body       text NOT NULL,
  purpose    text NOT NULL,
  ref_id     text,
  status     text NOT NULL DEFAULT 'cho_gui' CHECK (status IN ('cho_gui', 'da_gui', 'loi')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  error      text
);
