-- Đăng nhập một lần (SSO) theo chuẩn OpenID Connect: Keycloak, Microsoft Entra ID, Google Workspace...
-- Tài khoản vẫn do quản trị tạo trong Medone; lần đầu đăng nhập SSO thì nối theo tên đăng nhập, từ đó nhận theo mã "sub" của máy chủ SSO.
ALTER TABLE users ADD COLUMN sso_issuer text, ADD COLUMN sso_subject text, ADD COLUMN sso_linked_at timestamptz;
CREATE UNIQUE INDEX users_sso ON users(sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL;

-- Phiên đăng nhập SSO đang dở (state, nonce, PKCE): dùng một lần, hết hạn sau 10 phút
CREATE TABLE sso_states (
  state       text PRIMARY KEY,
  nonce       text NOT NULL,
  verifier    text NOT NULL,
  redirect_uri text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
