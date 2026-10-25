/* Giai đoạn T: nối tổng đài SIP (Asterisk) và ghi âm cuộc gọi */

-- Máy lẻ của nhân viên tiếp nhận/điều phối: tổng đài báo máy lẻ nào nhấc máy, phần mềm biết là ai
CREATE TABLE sip_extensions (
  ext        text PRIMARY KEY CHECK (ext ~ '^[0-9]{2,6}$'),
  user_id    uuid UNIQUE REFERENCES users(id),
  label      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE calls
  ADD COLUMN pbx_id            text UNIQUE,                         -- mã cuộc gọi bên tổng đài (UNIQUEID của Asterisk)
  ADD COLUMN direction         text NOT NULL DEFAULT 'in' CHECK (direction IN ('in', 'out')),
  ADD COLUMN extension         text,                                -- máy lẻ đã nhấc máy hoặc gọi ra
  ADD COLUMN recording_file    text,                                -- tên tệp ghi âm trong thư mục MEDONE_RECORDINGS_DIR
  ADD COLUMN recording_bytes   bigint,
  ADD COLUMN recording_sha256  text,                                -- băm tệp lúc gác máy, để phát hiện tệp bị sửa
  ADD COLUMN duration_s        int,
  ADD COLUMN hangup_cause      text;
CREATE INDEX calls_incident ON calls(incident_id);
