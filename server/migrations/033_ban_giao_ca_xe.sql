-- Giai đoạn AB4: bàn giao xe mỗi ca. Người giao, người nhận theo vị trí trong kíp; cả hai xác nhận số lượng, tình trạng thì biên bản khóa.
-- Kíp mới được nhận ca ngay. Có ca cấp cứu thì cứ đi, về rồi bàn giao. Không có ca mà quá 30 phút sau lúc nhắc chưa ký thì xe bị khóa.
CREATE TABLE handover_settings (
  id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  position       text NOT NULL DEFAULT 'Trưởng kíp',   -- vị trí chịu trách nhiệm giao (kíp cũ) và nhận (kíp mới)
  grace_minutes  int NOT NULL DEFAULT 30 CHECK (grace_minutes BETWEEN 5 AND 240)
);
INSERT INTO handover_settings DEFAULT VALUES;

CREATE TABLE vehicle_handovers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id          text NOT NULL REFERENCES vehicles(id),
  outgoing            uuid[] NOT NULL,                  -- kíp giao
  incoming            uuid[] NOT NULL,                  -- kíp nhận
  status              text NOT NULL DEFAULT 'cho_giao' CHECK (status IN ('cho_giao', 'cho_nhan', 'da_khoa')),
  reminded_at         timestamptz NOT NULL DEFAULT now(),
  items               jsonb NOT NULL DEFAULT '[]',      -- thuốc, vật tư: cơ số chuẩn, số trên sổ, số đếm, tình trạng
  equipment           jsonb NOT NULL DEFAULT '[]',      -- thiết bị trên xe: tình trạng
  giver_id            uuid REFERENCES users(id),
  giver_note          text,
  giver_signed_at     timestamptz,
  receiver_id         uuid REFERENCES users(id),
  receiver_note       text,
  receiver_signed_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vehicle_handovers_open ON vehicle_handovers(vehicle_id) WHERE status <> 'da_khoa';
