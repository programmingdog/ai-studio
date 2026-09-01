ALTER TABLE provider_models
  CHANGE COLUMN credit_multiplier credit_cost INT UNSIGNED NOT NULL DEFAULT 1;
