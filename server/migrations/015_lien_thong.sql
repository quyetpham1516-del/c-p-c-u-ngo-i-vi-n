/* Giai đoạn O: đường dẫn chia sẻ cho bệnh viện nhận (báo trước, có sinh hiệu và giờ dự kiến tới) và cho người nhà (xe đang tới) */

CREATE TABLE share_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('benh_vien', 'nguoi_nha')),
  incident_id    uuid NOT NULL REFERENCES incidents(id),
  token_hash     text NOT NULL UNIQUE,          -- SHA-256 của mã trong đường dẫn; mã chỉ hiện một lần lúc tạo
  hospital       text,
  department     text,
  phone          text,                          -- số đã gửi tin nhắn (nếu gửi)
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  views          int NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  response       text CHECK (response IN ('san_sang', 'khong_nhan')),
  response_by    text,
  response_note  text,
  responded_at   timestamptz
);
CREATE INDEX share_links_incident ON share_links(incident_id);

-- Tin nhắn gửi qua cổng SMS: số lần thử
ALTER TABLE message_outbox ADD COLUMN attempts int NOT NULL DEFAULT 0;
