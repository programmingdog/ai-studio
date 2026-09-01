CREATE TABLE IF NOT EXISTS model_credit_pricing_config (
  id TINYINT UNSIGNED NOT NULL,
  cny_per_credit DECIMAL(16,6) NOT NULL DEFAULT 0.100000,
  auto_sync TINYINT(1) NOT NULL DEFAULT 0,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  last_sync_at DATETIME(3) NULL,
  last_sync_report JSON NULL,
  updated_by CHAR(36) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The example ratio is editable. Existing prices remain untouched until an admin enables sync.
INSERT IGNORE INTO model_credit_pricing_config (id) VALUES (1);
