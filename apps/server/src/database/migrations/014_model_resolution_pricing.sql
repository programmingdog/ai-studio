CREATE TABLE IF NOT EXISTS provider_model_resolution_prices (
  provider_model_id CHAR(36) NOT NULL,
  resolution VARCHAR(32) NOT NULL,
  credit_cost DECIMAL(20,6) NOT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (provider_model_id, resolution),
  CONSTRAINT fk_model_resolution_price_model FOREIGN KEY (provider_model_id) REFERENCES provider_models(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO provider_model_resolution_prices (provider_model_id, resolution, credit_cost, sort_order)
SELECT id, '1K', credit_cost, 0 FROM provider_models WHERE capability = 'IMAGE_GENERATION';

INSERT IGNORE INTO provider_model_resolution_prices (provider_model_id, resolution, credit_cost, sort_order)
SELECT id, '720p', credit_cost, 0 FROM provider_models WHERE capability = 'VIDEO_GENERATION';
