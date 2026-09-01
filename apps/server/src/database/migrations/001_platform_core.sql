CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL,
  email VARCHAR(191) NULL,
  phone VARCHAR(32) NULL,
  password_hash VARCHAR(255) NULL,
  display_name VARCHAR(100) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_phone (phone),
  KEY idx_users_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_users (
  id CHAR(36) NOT NULL,
  email VARCHAR(191) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  mfa_required TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_users_email (email),
  KEY idx_admin_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_roles (
  id CHAR(36) NOT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_roles_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_permissions (
  id CHAR(36) NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_permissions_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_user_roles (
  admin_user_id CHAR(36) NOT NULL,
  role_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (admin_user_id, role_id),
  CONSTRAINT fk_admin_user_roles_user FOREIGN KEY (admin_user_id) REFERENCES admin_users(id),
  CONSTRAINT fk_admin_user_roles_role FOREIGN KEY (role_id) REFERENCES admin_roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_role_permissions (
  role_id CHAR(36) NOT NULL,
  permission_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_admin_role_permissions_role FOREIGN KEY (role_id) REFERENCES admin_roles(id),
  CONSTRAINT fk_admin_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES admin_permissions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS providers (
  id CHAR(36) NOT NULL,
  code VARCHAR(64) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  adapter_type VARCHAR(64) NOT NULL,
  base_url VARCHAR(500) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'DISABLED',
  config_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_providers_code (code),
  KEY idx_providers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_credentials (
  id CHAR(36) NOT NULL,
  provider_id CHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  secret_ref VARCHAR(500) NOT NULL,
  masked_hint VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_credentials_name (provider_id, name),
  CONSTRAINT fk_provider_credentials_provider FOREIGN KEY (provider_id) REFERENCES providers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_models (
  id CHAR(36) NOT NULL,
  provider_id CHAR(36) NOT NULL,
  model_code VARCHAR(191) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  capability VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'DISABLED',
  parameter_schema_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_models_code (provider_id, model_code),
  KEY idx_provider_models_capability_status (capability, status),
  CONSTRAINT fk_provider_models_provider FOREIGN KEY (provider_id) REFERENCES providers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS logical_models (
  id CHAR(36) NOT NULL,
  code VARCHAR(100) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  capability VARCHAR(64) NOT NULL,
  provider_model_id CHAR(36) NULL,
  fallback_provider_model_id CHAR(36) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'DISABLED',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_logical_models_code (code),
  KEY idx_logical_models_capability_status (capability, status),
  CONSTRAINT fk_logical_models_primary FOREIGN KEY (provider_model_id) REFERENCES provider_models(id),
  CONSTRAINT fk_logical_models_fallback FOREIGN KEY (fallback_provider_model_id) REFERENCES provider_models(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS config_sets (
  id CHAR(36) NOT NULL,
  config_key VARCHAR(191) NOT NULL,
  category VARCHAR(32) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(1000) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_config_sets_key (config_key),
  KEY idx_config_sets_category_status (category, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS config_versions (
  id CHAR(36) NOT NULL,
  config_set_id CHAR(36) NOT NULL,
  version INT UNSIGNED NOT NULL,
  value_json JSON NOT NULL,
  schema_json JSON NULL,
  checksum CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  change_note VARCHAR(500) NOT NULL DEFAULT '',
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_config_versions_set_version (config_set_id, version),
  KEY idx_config_versions_status (config_set_id, status),
  CONSTRAINT fk_config_versions_set FOREIGN KEY (config_set_id) REFERENCES config_sets(id),
  CONSTRAINT fk_config_versions_admin FOREIGN KEY (created_by) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS config_releases (
  id CHAR(36) NOT NULL,
  config_version_id CHAR(36) NOT NULL,
  channel VARCHAR(32) NOT NULL DEFAULT 'stable',
  min_client_version VARCHAR(32) NOT NULL DEFAULT '0.0.0',
  rollout_percent TINYINT UNSIGNED NOT NULL DEFAULT 100,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  effective_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_config_releases_channel_status (channel, status, effective_at),
  CONSTRAINT fk_config_releases_version FOREIGN KEY (config_version_id) REFERENCES config_versions(id),
  CONSTRAINT fk_config_releases_admin FOREIGN KEY (created_by) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_tasks (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  local_task_id CHAR(36) NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  task_type VARCHAR(64) NOT NULL,
  logical_model_code VARCHAR(100) NOT NULL,
  provider_id CHAR(36) NULL,
  provider_model_id CHAR(36) NULL,
  remote_task_id VARCHAR(191) NULL,
  status VARCHAR(32) NOT NULL,
  progress DECIMAL(5,4) NOT NULL DEFAULT 0,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  usage_json JSON NULL,
  estimated_credits DECIMAL(20,6) NOT NULL DEFAULT 0,
  settled_credits DECIMAL(20,6) NOT NULL DEFAULT 0,
  error_code VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_tasks_user_idempotency (user_id, idempotency_key),
  UNIQUE KEY uq_ai_tasks_user_local (user_id, local_task_id),
  KEY idx_ai_tasks_status_created (status, created_at),
  KEY idx_ai_tasks_remote (provider_id, remote_task_id),
  CONSTRAINT fk_ai_tasks_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_ai_tasks_provider FOREIGN KEY (provider_id) REFERENCES providers(id),
  CONSTRAINT fk_ai_tasks_model FOREIGN KEY (provider_model_id) REFERENCES provider_models(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_attempts (
  id CHAR(36) NOT NULL,
  task_id CHAR(36) NOT NULL,
  attempt_number INT UNSIGNED NOT NULL,
  provider_id CHAR(36) NULL,
  provider_model_id CHAR(36) NULL,
  remote_task_id VARCHAR(191) NULL,
  status VARCHAR(32) NOT NULL,
  error_code VARCHAR(100) NULL,
  usage_json JSON NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_task_attempts_number (task_id, attempt_number),
  CONSTRAINT fk_task_attempts_task FOREIGN KEY (task_id) REFERENCES ai_tasks(id),
  CONSTRAINT fk_task_attempts_provider FOREIGN KEY (provider_id) REFERENCES providers(id),
  CONSTRAINT fk_task_attempts_model FOREIGN KEY (provider_model_id) REFERENCES provider_models(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id CHAR(36) NOT NULL,
  owner_type VARCHAR(32) NOT NULL,
  owner_id CHAR(36) NOT NULL,
  account_type VARCHAR(64) NOT NULL,
  currency VARCHAR(16) NOT NULL DEFAULT 'CREDIT',
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_accounts_owner (owner_type, owner_id, account_type, currency)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id CHAR(36) NOT NULL,
  transaction_type VARCHAR(64) NOT NULL,
  reference_type VARCHAR(64) NOT NULL,
  reference_id VARCHAR(191) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'POSTED',
  metadata_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_transactions_reference (transaction_type, reference_type, reference_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id CHAR(36) NOT NULL,
  transaction_id CHAR(36) NOT NULL,
  account_id CHAR(36) NOT NULL,
  amount DECIMAL(20,6) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ledger_entries_transaction (transaction_id),
  KEY idx_ledger_entries_account_created (account_id, created_at),
  CONSTRAINT fk_ledger_entries_transaction FOREIGN KEY (transaction_id) REFERENCES ledger_transactions(id),
  CONSTRAINT fk_ledger_entries_account FOREIGN KEY (account_id) REFERENCES ledger_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS credit_holds (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  task_id CHAR(36) NOT NULL,
  amount DECIMAL(20,6) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_credit_holds_task (task_id),
  KEY idx_credit_holds_expiry (status, expires_at),
  CONSTRAINT fk_credit_holds_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_credit_holds_task FOREIGN KEY (task_id) REFERENCES ai_tasks(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_orders (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  out_trade_no VARCHAR(32) NOT NULL,
  wechat_transaction_id VARCHAR(64) NULL,
  description VARCHAR(127) NOT NULL,
  amount_fen BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  status VARCHAR(32) NOT NULL DEFAULT 'CREATED',
  code_url VARCHAR(500) NULL,
  expires_at DATETIME(3) NULL,
  paid_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_orders_trade_no (out_trade_no),
  UNIQUE KEY uq_payment_orders_wechat_id (wechat_transaction_id),
  KEY idx_payment_orders_user_created (user_id, created_at),
  KEY idx_payment_orders_status_created (status, created_at),
  CONSTRAINT fk_payment_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_notifications (
  id CHAR(36) NOT NULL,
  notification_id VARCHAR(64) NOT NULL,
  payment_order_id CHAR(36) NULL,
  body_sha256 CHAR(64) NOT NULL,
  signature_valid TINYINT(1) NOT NULL,
  processing_status VARCHAR(32) NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_notifications_notification (notification_id),
  KEY idx_payment_notifications_status (processing_status, received_at),
  CONSTRAINT fk_payment_notifications_order FOREIGN KEY (payment_order_id) REFERENCES payment_orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refunds (
  id CHAR(36) NOT NULL,
  payment_order_id CHAR(36) NOT NULL,
  out_refund_no VARCHAR(64) NOT NULL,
  wechat_refund_id VARCHAR(64) NULL,
  amount_fen BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'CREATED',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_refunds_out_refund_no (out_refund_no),
  UNIQUE KEY uq_refunds_wechat_id (wechat_refund_id),
  CONSTRAINT fk_refunds_order FOREIGN KEY (payment_order_id) REFERENCES payment_orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS announcements (
  id CHAR(36) NOT NULL,
  title VARCHAR(200) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  audience_json JSON NULL,
  published_at DATETIME(3) NULL,
  expires_at DATETIME(3) NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_announcements_status_publish (status, published_at),
  CONSTRAINT fk_announcements_admin FOREIGN KEY (created_by) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) NOT NULL,
  admin_user_id CHAR(36) NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(191) NULL,
  request_id VARCHAR(100) NULL,
  details_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_logs_admin_created (admin_user_id, created_at),
  KEY idx_audit_logs_entity_created (entity_type, entity_id, created_at),
  CONSTRAINT fk_audit_logs_admin FOREIGN KEY (admin_user_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO admin_roles (id, code, name, description)
VALUES ('00000000-0000-0000-0000-000000000001', 'SUPER_ADMIN', '超级管理员', '拥有后台全部权限');

INSERT IGNORE INTO admin_permissions (id, code, name) VALUES
('00000000-0000-0000-0000-000000000101', 'dashboard.read', '查看运营概览'),
('00000000-0000-0000-0000-000000000102', 'configs.manage', '管理客户端配置'),
('00000000-0000-0000-0000-000000000103', 'providers.manage', '管理供应商与模型'),
('00000000-0000-0000-0000-000000000104', 'users.read', '查看用户'),
('00000000-0000-0000-0000-000000000105', 'tasks.read', '查看任务元数据'),
('00000000-0000-0000-0000-000000000106', 'payments.read', '查看微信支付订单'),
('00000000-0000-0000-0000-000000000107', 'audit.read', '查看审计日志');

INSERT IGNORE INTO admin_role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000001', id FROM admin_permissions;
