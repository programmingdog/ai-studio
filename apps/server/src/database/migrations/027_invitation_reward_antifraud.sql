ALTER TABLE distribution_configs
  ADD COLUMN invitation_anti_abuse_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER invitation_reward_credits,
  ADD COLUMN invitation_daily_reward_limit INT UNSIGNED NOT NULL DEFAULT 20 AFTER invitation_anti_abuse_enabled,
  ADD COLUMN invitation_monthly_reward_limit INT UNSIGNED NOT NULL DEFAULT 200 AFTER invitation_daily_reward_limit;

ALTER TABLE referral_rewards
  ADD COLUMN status VARCHAR(24) NOT NULL DEFAULT 'REWARDED' AFTER config_revision,
  ADD COLUMN daily_limit_snapshot INT UNSIGNED NOT NULL DEFAULT 20 AFTER status,
  ADD COLUMN monthly_limit_snapshot INT UNSIGNED NOT NULL DEFAULT 200 AFTER daily_limit_snapshot,
  ADD COLUMN qualified_payment_order_id CHAR(36) NULL AFTER monthly_limit_snapshot,
  ADD COLUMN qualified_at DATETIME(3) NULL AFTER qualified_payment_order_id,
  ADD COLUMN rewarded_at DATETIME(3) NULL AFTER qualified_at,
  ADD COLUMN status_note VARCHAR(100) NOT NULL DEFAULT '' AFTER rewarded_at,
  ADD UNIQUE KEY uq_referral_reward_payment (qualified_payment_order_id),
  ADD KEY idx_referral_reward_cap (inviter_id, status, rewarded_at),
  ADD CONSTRAINT fk_referral_reward_payment FOREIGN KEY (qualified_payment_order_id) REFERENCES payment_orders(id);

UPDATE referral_rewards SET rewarded_at = created_at WHERE status = 'REWARDED' AND rewarded_at IS NULL;

CREATE TABLE invitation_reward_usage (
  inviter_id CHAR(36) NOT NULL,
  period_type VARCHAR(8) NOT NULL,
  period_key DATE NOT NULL,
  rewarded_count INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (inviter_id, period_type, period_key),
  CONSTRAINT fk_invitation_reward_usage_user FOREIGN KEY (inviter_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO invitation_reward_usage (inviter_id, period_type, period_key, rewarded_count)
SELECT inviter_id, 'DAY', DATE(DATE_ADD(rewarded_at, INTERVAL 8 HOUR)), COUNT(*)
FROM referral_rewards WHERE status = 'REWARDED' AND credits > 0
GROUP BY inviter_id, DATE(DATE_ADD(rewarded_at, INTERVAL 8 HOUR));

INSERT INTO invitation_reward_usage (inviter_id, period_type, period_key, rewarded_count)
SELECT inviter_id, 'MONTH', DATE_FORMAT(DATE_ADD(rewarded_at, INTERVAL 8 HOUR), '%Y-%m-01'), COUNT(*)
FROM referral_rewards WHERE status = 'REWARDED' AND credits > 0
GROUP BY inviter_id, DATE_FORMAT(DATE_ADD(rewarded_at, INTERVAL 8 HOUR), '%Y-%m-01');
