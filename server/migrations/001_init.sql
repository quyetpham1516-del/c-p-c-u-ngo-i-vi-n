-- Medone MVP: lược đồ dữ liệu lõi (CAD + ePCR + lưu vết)
-- Tham chiếu kế hoạch: mục 5.2 (16 mốc), 6.4 (lưu vết), 8.6 (một người bệnh – một bệnh án), 12.3, 15.1

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE stations (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  title         text,                       -- chức danh (BS, ĐD, CCVNV, lái xe, ĐPV...)
  license_no    text,                       -- số GPHN
  role          text NOT NULL CHECK (role IN ('calltaker','dispatcher','supervisor','crew','qa','admin')),
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Xe: mục 5.5 (5 xe chuyên biệt + 1 dự phòng), trạng thái S1–S9 theo phụ lục 15.1
CREATE TABLE vehicles (
  id                  text PRIMARY KEY,          -- ví dụ MD-ALS-01
  plate               text,
  type                text NOT NULL CHECK (type IN ('ALS','BLS','MSU','ECMO','VC','DP')),
  station_id          text NOT NULL REFERENCES stations(id),
  duty                text NOT NULL CHECK (duty IN ('24/7','office','reserve')),
  status              text NOT NULL DEFAULT 'S9' CHECK (status ~ '^S[1-9]$'),
  status_since        timestamptz NOT NULL DEFAULT now(),
  lat                 double precision,
  lng                 double precision,
  location_at         timestamptz,
  current_incident_id uuid,
  free_hint_at        timestamptz,               -- kíp báo "rảnh trong 5 phút"
  supplies_ok         boolean NOT NULL DEFAULT true,
  supplies_note       text
);

-- Kíp đang trực trên xe (đăng nhập đầu ca)
CREATE TABLE crew_shifts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  text NOT NULL REFERENCES vehicles(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  crew_role   text NOT NULL,                    -- trưởng kíp, điều dưỡng, lái xe...
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE UNIQUE INDEX crew_shifts_one_active ON crew_shifts(user_id) WHERE ended_at IS NULL;

CREATE TABLE vehicle_status_log (
  id          bigserial PRIMARY KEY,
  vehicle_id  text NOT NULL REFERENCES vehicles(id),
  status      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  incident_id uuid,
  user_id     uuid
);
CREATE INDEX vehicle_status_log_open ON vehicle_status_log(vehicle_id) WHERE ended_at IS NULL;

-- Ca (Incident): Mã ca sinh tại T0
CREATE TABLE incidents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   text NOT NULL UNIQUE,
  source                 text NOT NULL CHECK (source IN ('1800','115')),   -- nguồn ca bắt buộc (mục 1.2)
  source_ref             text,                                             -- mã ca bên 115 nếu có
  status                 text NOT NULL DEFAULT 'intake'
                         CHECK (status IN ('intake','awaiting_confirm','confirmed','dispatched','on_scene','transporting','at_hospital','closed','cancelled','transferred_115','advice_only')),
  caller_phone           text,
  callback_phone         text,
  caller_name            text,
  address                text,
  address_note           text,
  lat                    double precision,
  lng                    double precision,
  patient_count          int NOT NULL DEFAULT 1,
  chief_complaint        text,
  protocol_version       text,
  triage_answers         jsonb NOT NULL DEFAULT '{}'::jsonb,
  suggested_priority     text,
  suggested_vehicle_type text,
  suggested_lights       boolean,
  final_priority         text CHECK (final_priority IN ('P1','P2','P3','P4','HEN')),
  final_vehicle_type     text,
  final_lights           boolean,
  override_reason        text,
  confirmed_by           uuid REFERENCES users(id),
  confirmed_at           timestamptz,
  destination            text,
  notes                  text,
  duplicate_of           uuid REFERENCES incidents(id),
  notified_115_at        timestamptz,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  closed_at              timestamptz
);
CREATE INDEX incidents_open ON incidents(created_at) WHERE status NOT IN ('closed','cancelled','transferred_115','advice_only');

-- 16 mốc thời gian (mục 5.2)
CREATE TABLE incident_times (
  incident_id uuid NOT NULL REFERENCES incidents(id),
  code        text NOT NULL CHECK (code ~ '^T([0-9]|1[0-5])$'),
  at          timestamptz NOT NULL,
  source      text NOT NULL,                  -- tổng đài, CAD, máy tính bảng, GPS...
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, code)
);

-- Cuộc gọi: một ca có nhiều cuộc gọi
CREATE TABLE calls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid REFERENCES incidents(id),
  phone        text NOT NULL,
  line         text NOT NULL DEFAULT '1800',  -- '1800' hoặc '115' (đường dây nóng từ 115)
  state        text NOT NULL DEFAULT 'ringing' CHECK (state IN ('ringing','answered','ended','abandoned')),
  ringing_at   timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz,
  ended_at     timestamptz,
  operator_id  uuid REFERENCES users(id),
  recording_ref text,
  callback_done_at timestamptz
);
CREATE INDEX calls_waiting ON calls(ringing_at) WHERE state = 'ringing';

CREATE TABLE assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id      uuid NOT NULL REFERENCES incidents(id),
  vehicle_id       text NOT NULL REFERENCES vehicles(id),
  assigned_by      uuid NOT NULL REFERENCES users(id),
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  ended_at         timestamptz,
  end_reason       text
);
CREATE UNIQUE INDEX assignments_one_active_per_vehicle ON assignments(vehicle_id) WHERE ended_at IS NULL;

-- Bệnh án: một người bệnh – một bệnh án (mục 8.6)
CREATE TABLE patients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ba_number     text NOT NULL UNIQUE,               -- Số BA, giữ vĩnh viễn
  id_type       text NOT NULL CHECK (id_type IN ('CCCD','DDCN','PASSPORT','UNKNOWN')),
  id_enc        text,                               -- số định danh đã mã hóa AES-256-GCM
  id_hash       text,                               -- HMAC để tìm kiếm, không dùng làm khóa chính
  id_last4      text,
  nationality   text,
  full_name     text,
  dob           date,
  birth_year    int,
  sex           text CHECK (sex IN ('M','F','U')),
  phone         text,
  address       text,
  is_temporary  boolean NOT NULL DEFAULT false,     -- bệnh án tạm cho người chưa rõ danh tính
  merged_into   uuid REFERENCES patients(id),
  shared        jsonb NOT NULL DEFAULT '{}'::jsonb, -- dị ứng, tiền sử, thuốc, nhóm máu, liên hệ, ý nguyện
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX patients_id_hash ON patients(id_hash) WHERE id_hash IS NOT NULL AND merged_into IS NULL;
CREATE INDEX patients_name ON patients(lower(full_name));
CREATE INDEX patients_phone ON patients(phone);

-- Phiếu chuyển viện: mỗi lần cấp cứu/vận chuyển là một phiếu, chứa ePCR
CREATE TABLE transfers (
  id              uuid PRIMARY KEY,                 -- UUID do máy tính bảng sinh (offline, chống trùng)
  transfer_number text UNIQUE,                      -- Năm-Số thứ tự, cấp khi đồng bộ lên máy chủ
  patient_id      uuid REFERENCES patients(id),
  incident_id     uuid REFERENCES incidents(id),
  vehicle_id      text REFERENCES vehicles(id),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  epcr            jsonb NOT NULL DEFAULT '{}'::jsonb,
  version         int NOT NULL DEFAULT 1,
  device_id       text,
  author_id       uuid REFERENCES users(id),
  signed_by       uuid REFERENCES users(id),
  signed_at       timestamptz,
  payer           text CHECK (payer IN ('BHYT','THU_PHI','MIEN','GIAM','THAT_THU')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transfers_patient ON transfers(patient_id);
CREATE INDEX transfers_incident ON transfers(incident_id);

-- Bổ sung sau khi ký: không sửa trực tiếp, ghi phiên bản mới có lý do
CREATE TABLE transfer_amendments (
  id           bigserial PRIMARY KEY,
  transfer_id  uuid NOT NULL REFERENCES transfers(id),
  version      int NOT NULL,
  reason       text NOT NULL,
  epcr         jsonb NOT NULL,
  author_id    uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE counters (
  name   text NOT NULL,
  period text NOT NULL,
  value  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (name, period)
);

-- Hàng đợi gửi ra ngoài (thông báo 115, bệnh viện...) — mẫu outbox (mục 12.7)
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  attempts     int NOT NULL DEFAULT 0,
  last_error   text
);

-- Nhật ký sự kiện chỉ ghi thêm, chuỗi băm theo từng ca (mục 6.2, 6.4)
CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  scope       text NOT NULL,              -- 'incident:<uuid>' | 'patient:<uuid>' | 'system'
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id    uuid,
  actor_name  text,
  action      text NOT NULL,
  entity      text,
  entity_id   text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash   text NOT NULL,
  hash        text NOT NULL
);
CREATE INDEX audit_events_scope ON audit_events(scope, id);

CREATE FUNCTION audit_events_block_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events chỉ cho phép ghi thêm';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_block_change();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_block_change();

-- Gộp bệnh án tạm vào bệnh án thật (QLCL duyệt), tách lại được
CREATE TABLE patient_merges (
  id            bigserial PRIMARY KEY,
  from_id       uuid NOT NULL REFERENCES patients(id),
  into_id       uuid NOT NULL REFERENCES patients(id),
  transfer_ids  uuid[] NOT NULL,
  reason        text NOT NULL,
  merged_by     uuid REFERENCES users(id),
  merged_at     timestamptz NOT NULL DEFAULT now(),
  undone_by     uuid REFERENCES users(id),
  undone_at     timestamptz
);
