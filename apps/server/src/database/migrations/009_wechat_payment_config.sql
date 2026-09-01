CREATE TABLE wechat_payment_configs (
  id CHAR(36) NOT NULL,
  merchant_id VARCHAR(32) NOT NULL DEFAULT '',
  merchant_key_ciphertext TEXT NULL,
  merchant_key_hint VARCHAR(64) NOT NULL DEFAULT '',
  certificate_ciphertext MEDIUMTEXT NULL,
  certificate_filename VARCHAR(255) NULL,
  certificate_uploaded_at DATETIME(3) NULL,
  private_key_ciphertext MEDIUMTEXT NULL,
  private_key_filename VARCHAR(255) NULL,
  private_key_uploaded_at DATETIME(3) NULL,
  official_account_name VARCHAR(100) NOT NULL DEFAULT '',
  app_id VARCHAR(64) NOT NULL DEFAULT '',
  app_secret_ciphertext TEXT NULL,
  app_secret_hint VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'DISABLED',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO wechat_payment_configs (id)
VALUES ('82000000-0000-0000-0000-000000000001');

INSERT IGNORE INTO admin_permissions (id, code, name)
VALUES ('00000000-0000-0000-0000-000000000109', 'payments.manage', '管理微信支付配置');

INSERT IGNORE INTO admin_role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000001', id
FROM admin_permissions WHERE code = 'payments.manage';
