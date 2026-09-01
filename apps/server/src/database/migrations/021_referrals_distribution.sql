ALTER TABLE users
  ADD COLUMN pid CHAR(36) NULL,
  ADD COLUMN invite_code CHAR(8) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE KEY uq_users_invite_code (invite_code),
  ADD KEY idx_users_pid (pid),
  ADD CONSTRAINT fk_users_parent FOREIGN KEY (pid) REFERENCES users(id);

ALTER TABLE wechat_auth_sessions ADD COLUMN inviter_id CHAR(36) NULL;
ALTER TABLE payment_orders ADD COLUMN payer_paid_amount_fen BIGINT UNSIGNED NULL;

CREATE TABLE distribution_configs (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  direct_rate_bps INT UNSIGNED NOT NULL DEFAULT 0,
  indirect_rate_bps INT UNSIGNED NOT NULL DEFAULT 0,
  minimum_withdrawal_fen BIGINT UNSIGNED NOT NULL DEFAULT 10000,
  invitation_reward_credits INT UNSIGNED NOT NULL DEFAULT 20,
  invite_page_base_url VARCHAR(500) NOT NULL DEFAULT '',
  windows_download_url VARCHAR(1000) NOT NULL DEFAULT '',
  macos_download_url VARCHAR(1000) NOT NULL DEFAULT '',
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  updated_by CHAR(36) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO distribution_configs (id) VALUES (1);

CREATE TABLE referral_rewards (
  id CHAR(36) NOT NULL PRIMARY KEY,
  inviter_id CHAR(36) NOT NULL,
  invited_user_id CHAR(36) NOT NULL,
  credits INT UNSIGNED NOT NULL,
  config_revision INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_referral_reward_user (invited_user_id),
  KEY idx_referral_reward_inviter (inviter_id, created_at),
  FOREIGN KEY (inviter_id) REFERENCES users(id),
  FOREIGN KEY (invited_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commission_wallets (
  user_id CHAR(36) NOT NULL PRIMARY KEY,
  available_fen BIGINT UNSIGNED NOT NULL DEFAULT 0,
  frozen_fen BIGINT UNSIGNED NOT NULL DEFAULT 0,
  earned_fen BIGINT UNSIGNED NOT NULL DEFAULT 0,
  paid_fen BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE distribution_settlements (
  payment_order_id CHAR(36) NOT NULL PRIMARY KEY,
  payer_id CHAR(36) NOT NULL,
  paid_amount_fen BIGINT UNSIGNED NOT NULL,
  enabled TINYINT(1) NOT NULL,
  direct_rate_bps INT UNSIGNED NOT NULL,
  indirect_rate_bps INT UNSIGNED NOT NULL,
  config_revision INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (payment_order_id) REFERENCES payment_orders(id),
  FOREIGN KEY (payer_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commission_records (
  id CHAR(36) NOT NULL PRIMARY KEY,
  payment_order_id CHAR(36) NOT NULL,
  beneficiary_id CHAR(36) NOT NULL,
  payer_id CHAR(36) NOT NULL,
  level TINYINT UNSIGNED NOT NULL,
  base_amount_fen BIGINT UNSIGNED NOT NULL,
  rate_bps INT UNSIGNED NOT NULL,
  amount_fen BIGINT UNSIGNED NOT NULL,
  config_revision INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_commission_order_level (payment_order_id, level),
  UNIQUE KEY uq_commission_order_user (payment_order_id, beneficiary_id),
  KEY idx_commission_user_created (beneficiary_id, created_at),
  FOREIGN KEY (payment_order_id) REFERENCES distribution_settlements(payment_order_id),
  FOREIGN KEY (beneficiary_id) REFERENCES users(id),
  FOREIGN KEY (payer_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE withdrawal_applications (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  idempotency_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) NOT NULL,
  amount_fen BIGINT UNSIGNED NOT NULL,
  minimum_fen_snapshot BIGINT UNSIGNED NOT NULL,
  config_revision INT UNSIGNED NOT NULL,
  payee_ciphertext MEDIUMTEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  review_note VARCHAR(500) NOT NULL DEFAULT '',
  reviewed_by CHAR(36) NULL,
  reviewed_at DATETIME(3) NULL,
  paid_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_withdrawal_user_key (user_id, idempotency_key),
  KEY idx_withdrawal_user_created (user_id, created_at),
  KEY idx_withdrawal_status_created (status, created_at),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (reviewed_by) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE manual_payout_records (
  id CHAR(36) NOT NULL PRIMARY KEY,
  withdrawal_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  amount_fen BIGINT UNSIGNED NOT NULL,
  alipay_trade_no VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operator_id CHAR(36) NOT NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_payout_withdrawal (withdrawal_id),
  UNIQUE KEY uq_payout_alipay_trade (alipay_trade_no),
  FOREIGN KEY (withdrawal_id) REFERENCES withdrawal_applications(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (operator_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commission_wallet_entries (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  reference_id CHAR(36) NOT NULL,
  available_delta_fen BIGINT NOT NULL,
  frozen_delta_fen BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_commission_wallet_event (event_type, reference_id),
  KEY idx_commission_wallet_user (user_id, created_at),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO admin_permissions (id, code, name) VALUES
  ('00000000-0000-0000-0000-000000000110', 'distribution.manage', '管理分润与提现审核'),
  ('00000000-0000-0000-0000-000000000111', 'payouts.manage', '查看提现收款资料与确认手动打款');
INSERT IGNORE INTO admin_role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000001', id FROM admin_permissions WHERE code IN ('distribution.manage', 'payouts.manage');
