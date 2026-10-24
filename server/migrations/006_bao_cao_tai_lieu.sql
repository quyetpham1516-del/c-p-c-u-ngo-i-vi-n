-- Đợt E: báo cáo và kiểm soát tài liệu (quy trình, hướng dẫn, biểu mẫu có phiên bản, hạn rà soát)

CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL,                       -- QT-DP-01, HD-KSNK-03, BM-...
  title           text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('quy_trinh', 'huong_dan', 'bieu_mau', 'quy_dinh', 'phac_do', 'khac')),
  version         text NOT NULL,
  owner_unit      text,                                -- đơn vị soạn thảo, chịu trách nhiệm
  effective_on    date,
  review_months   int NOT NULL DEFAULT 12 CHECK (review_months BETWEEN 1 AND 120),
  url             text,                                -- đường dẫn tệp (Drive, máy chủ tài liệu)
  status          text NOT NULL DEFAULT 'du_thao' CHECK (status IN ('du_thao', 'hieu_luc', 'het_hieu_luc')),
  change_note     text,
  created_by      uuid REFERENCES users(id),
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX documents_code_version_uq ON documents(code, version);
CREATE UNIQUE INDEX documents_one_effective_uq ON documents(code) WHERE status = 'hieu_luc';
CREATE INDEX audit_events_at ON audit_events(at);
