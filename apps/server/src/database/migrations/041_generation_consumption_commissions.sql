ALTER TABLE distribution_configs
  ADD COLUMN commission_notice VARCHAR(1000) NOT NULL DEFAULT '' AFTER indirect_rate_bps;

CREATE TABLE distribution_consumption_settlements (
  consumption_record_id CHAR(36) NOT NULL PRIMARY KEY,
  task_id CHAR(36) NOT NULL,
  consumer_id CHAR(36) NOT NULL,
  capability VARCHAR(32) NOT NULL,
  credits_consumed DECIMAL(20,6) NOT NULL,
  base_amount_fen BIGINT UNSIGNED NOT NULL,
  enabled TINYINT(1) NOT NULL,
  direct_rate_bps INT UNSIGNED NOT NULL,
  indirect_rate_bps INT UNSIGNED NOT NULL,
  config_revision INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_distribution_consumption_user_created (consumer_id, created_at),
  CONSTRAINT fk_distribution_consumption_task FOREIGN KEY (task_id) REFERENCES ai_tasks(id),
  CONSTRAINT fk_distribution_consumption_user FOREIGN KEY (consumer_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE commission_records
  MODIFY COLUMN payment_order_id CHAR(36) NULL,
  ADD COLUMN consumption_record_id CHAR(36) NULL AFTER payment_order_id,
  ADD COLUMN source_capability VARCHAR(32) NULL AFTER payer_id,
  ADD COLUMN source_credits DECIMAL(20,6) NULL AFTER source_capability,
  ADD UNIQUE KEY uq_commission_consumption_level (consumption_record_id, level),
  ADD UNIQUE KEY uq_commission_consumption_user (consumption_record_id, beneficiary_id),
  ADD CONSTRAINT fk_commission_consumption_settlement FOREIGN KEY (consumption_record_id) REFERENCES distribution_consumption_settlements(consumption_record_id),
  ADD CONSTRAINT chk_commission_source CHECK (payment_order_id IS NOT NULL OR consumption_record_id IS NOT NULL);
