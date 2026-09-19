ALTER TABLE script_analysis_config
  ADD COLUMN remix_credit_cost DECIMAL(20,6) NOT NULL DEFAULT 20 AFTER credit_cost;
