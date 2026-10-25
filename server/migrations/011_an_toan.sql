/* Giai đoạn K: an toàn kíp (báo khẩn), chữ ký điện tử trên phiếu, mã xác thực phiếu chuyển viện */

/* ---------------- Báo khẩn của kíp ---------------- */

CREATE TABLE crew_sos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,                         -- BK-YYYY-NNNN
  user_id      uuid NOT NULL REFERENCES users(id),
  vehicle_id   text REFERENCES vehicles(id),
  incident_id  uuid REFERENCES incidents(id),
  lat          double precision,
  lng          double precision,
  accuracy_m   double precision,
  located_at   timestamptz,                                  -- lần cập nhật vị trí gần nhất
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  acked_at     timestamptz,
  acked_by     uuid REFERENCES users(id),
  ack_note     text,                                         -- EOC đã làm gì: gọi công an 113, điều xe hỗ trợ...
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users(id),
  resolution   text,
  false_alarm  boolean NOT NULL DEFAULT false
);
CREATE INDEX crew_sos_open ON crew_sos(created_at) WHERE resolved_at IS NULL;
-- Mỗi người chỉ có một báo khẩn đang mở
CREATE UNIQUE INDEX crew_sos_one_open ON crew_sos(user_id) WHERE resolved_at IS NULL;

/* ---------------- Mã xác thực phiếu chuyển viện ---------------- */

ALTER TABLE transfers ADD COLUMN verify_code text UNIQUE;          -- cấp khi ký, in kèm QR trên phiếu
ALTER TABLE transfers ADD COLUMN content_hash text;                -- SHA-256 nội dung phiếu lúc ký (và sau mỗi lần bổ sung)

CREATE TABLE transfer_verifications (
  id          bigserial PRIMARY KEY,
  transfer_id uuid REFERENCES transfers(id),
  code        text NOT NULL,
  found       boolean NOT NULL,
  ip          text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transfer_verifications_transfer ON transfer_verifications(transfer_id);
