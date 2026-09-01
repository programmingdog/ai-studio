ALTER TABLE users
  ADD COLUMN avatar_url VARCHAR(1000) NULL AFTER display_name,
  ADD COLUMN bio VARCHAR(500) NOT NULL DEFAULT '' AFTER avatar_url,
  ADD COLUMN last_login_at DATETIME(3) NULL AFTER status;

CREATE TABLE user_refresh_tokens (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  device_name VARCHAR(100) NOT NULL DEFAULT '',
  expires_at DATETIME(3) NOT NULL,
  last_used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_refresh_tokens_hash (token_hash),
  KEY idx_user_refresh_tokens_user_created (user_id, created_at),
  KEY idx_user_refresh_tokens_expiry (expires_at),
  CONSTRAINT fk_user_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_external_identities (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  provider_user_id VARCHAR(191) NOT NULL,
  union_id VARCHAR(191) NULL,
  display_name_snapshot VARCHAR(100) NOT NULL DEFAULT '',
  avatar_url_snapshot VARCHAR(1000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_external_identity_provider (provider, provider_user_id),
  KEY idx_user_external_identity_union (provider, union_id),
  KEY idx_user_external_identity_user (user_id),
  CONSTRAINT fk_user_external_identity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wechat_auth_sessions (
  id CHAR(36) NOT NULL,
  state_hash CHAR(64) NOT NULL,
  user_id CHAR(36) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  error_message VARCHAR(500) NULL,
  expires_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  token_delivered_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_wechat_auth_sessions_state (state_hash),
  KEY idx_wechat_auth_sessions_expiry (status, expires_at),
  CONSTRAINT fk_wechat_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE payment_orders
  ADD COLUMN credit_package_id CHAR(36) NULL AFTER user_id,
  ADD COLUMN client_idempotency_key VARCHAR(191) NULL AFTER credit_package_id,
  ADD COLUMN credits_to_grant BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER amount_fen,
  ADD COLUMN payment_channel VARCHAR(32) NOT NULL DEFAULT 'WECHAT_NATIVE' AFTER currency,
  ADD UNIQUE KEY uq_payment_orders_user_idempotency (user_id, client_idempotency_key),
  ADD CONSTRAINT fk_payment_orders_credit_package FOREIGN KEY (credit_package_id) REFERENCES credit_packages(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX uq_credit_package_purchases_payment_order
  ON credit_package_purchases (payment_order_id);

ALTER TABLE wechat_payment_configs
  ADD COLUMN payment_notify_url VARCHAR(500) NOT NULL DEFAULT '' AFTER merchant_id,
  ADD COLUMN platform_certificate_ciphertext MEDIUMTEXT NULL AFTER private_key_uploaded_at,
  ADD COLUMN platform_certificate_filename VARCHAR(255) NULL AFTER platform_certificate_ciphertext,
  ADD COLUMN platform_certificate_serial VARCHAR(128) NULL AFTER platform_certificate_filename,
  ADD COLUMN platform_certificate_uploaded_at DATETIME(3) NULL AFTER platform_certificate_serial,
  ADD COLUMN open_platform_app_id VARCHAR(64) NOT NULL DEFAULT '' AFTER app_secret_hint,
  ADD COLUMN open_platform_app_secret_ciphertext TEXT NULL AFTER open_platform_app_id,
  ADD COLUMN open_platform_app_secret_hint VARCHAR(64) NOT NULL DEFAULT '' AFTER open_platform_app_secret_ciphertext,
  ADD COLUMN open_platform_redirect_uri VARCHAR(500) NOT NULL DEFAULT '' AFTER open_platform_app_secret_hint;
