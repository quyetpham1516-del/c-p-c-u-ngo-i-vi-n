/* Giai đoạn N: chấm công bằng mã QR tại trạm (mã đổi mỗi 30 giây trên máy tính bảng đặt ở trạm, kèm vị trí GPS) */

CREATE TABLE station_attendance (
  station_id     text PRIMARY KEY REFERENCES stations(id),
  secret_enc     text NOT NULL,                 -- khóa ký mã QR, mã hóa AES-GCM
  kiosk_key_hash text NOT NULL,                 -- SHA-256 khóa của máy chiếu mã ở trạm
  radius_m       int NOT NULL DEFAULT 300 CHECK (radius_m BETWEEN 50 AND 5000),
  require_gps    boolean NOT NULL DEFAULT true, -- bắt buộc gửi vị trí khi quét
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE attendance ADD COLUMN station_id     text REFERENCES stations(id);
ALTER TABLE attendance ADD COLUMN in_distance_m  int;
ALTER TABLE attendance ADD COLUMN in_accuracy_m  int;
ALTER TABLE attendance ADD COLUMN out_station_id text REFERENCES stations(id);
ALTER TABLE attendance ADD COLUMN out_distance_m int;
ALTER TABLE attendance ADD COLUMN source_out     text;
-- Cần nhân sự xem lại: vị trí xa trạm, không có vị trí, ra ở trạm khác...
ALTER TABLE attendance ADD COLUMN flags          text[] NOT NULL DEFAULT '{}';
CREATE INDEX attendance_checkin ON attendance(check_in);
