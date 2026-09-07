ALTER TABLE provider_models
  ADD COLUMN credit_multiplier DECIMAL(10,6) UNSIGNED NOT NULL DEFAULT 1.000000 AFTER credit_cost;
