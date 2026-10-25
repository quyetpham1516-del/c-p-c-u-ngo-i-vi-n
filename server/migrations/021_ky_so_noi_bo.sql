-- Chữ ký số nội bộ (giai đoạn 1): Medone tự làm CA, cấp chứng thư cho từng người ký; phiếu ký xong mang chữ ký số ECDSA P-256.
-- Giai đoạn 2 thay bằng CA công cộng (MobiFone CA, VNPT SmartCA, Viettel MySign) qua cột provider, không đổi bảng.
CREATE TABLE pki_ca (
  id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  subject     text NOT NULL,
  cert_pem    text NOT NULL,
  key_enc     text NOT NULL,          -- khóa bí mật PKCS#8, mã hóa AES-GCM bằng MEDONE_DATA_KEY
  not_after   timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_certs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  provider     text NOT NULL DEFAULT 'noi_bo',
  serial       text NOT NULL UNIQUE,
  subject      text NOT NULL,
  cert_pem     text NOT NULL,
  key_enc      text,                  -- chỉ có với CA nội bộ; CA công cộng giữ khóa ở phía nhà cung cấp
  not_before   timestamptz NOT NULL,
  not_after    timestamptz NOT NULL,
  revoked_at   timestamptz,
  revoke_reason text,
  revoked_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- Mỗi người chỉ một chứng thư còn hiệu lực của mỗi nhà cung cấp
CREATE UNIQUE INDEX user_certs_active ON user_certs(user_id, provider) WHERE revoked_at IS NULL;

CREATE TABLE document_signatures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type    text NOT NULL,          -- 'transfer'
  doc_id      uuid NOT NULL,
  doc_version int NOT NULL,
  purpose     text NOT NULL,          -- 'ky_phieu' | 'bo_sung'
  user_id     uuid NOT NULL REFERENCES users(id),
  cert_id     uuid NOT NULL REFERENCES user_certs(id),
  provider    text NOT NULL,
  alg         text NOT NULL,
  payload     text NOT NULL,          -- chuỗi đã ký (gồm loại phiếu, mã phiếu, phiên bản, mã băm nội dung)
  signature   text NOT NULL,          -- base64
  signed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_signatures_doc ON document_signatures(doc_type, doc_id, signed_at);
