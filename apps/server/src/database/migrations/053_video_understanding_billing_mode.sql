ALTER TABLE script_analysis_config
  ADD COLUMN extraction_billing_mode VARCHAR(32) NOT NULL DEFAULT 'OVERALL' AFTER credit_cost;

CREATE TABLE IF NOT EXISTS video_understanding_billing_groups (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  provider_model_id CHAR(36) NOT NULL,
  billing_mode VARCHAR(32) NOT NULL,
  segment_count INT UNSIGNED NOT NULL,
  unit_credits DECIMAL(20,6) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_video_understanding_billing_user_created (user_id, created_at),
  CONSTRAINT fk_video_understanding_billing_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_video_understanding_billing_model FOREIGN KEY (provider_model_id) REFERENCES provider_models(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE ai_tasks
  ADD COLUMN extraction_billing_group_id CHAR(36) NULL AFTER workflow_quote_item_key,
  ADD COLUMN extraction_segment_index INT UNSIGNED NULL AFTER extraction_billing_group_id,
  ADD UNIQUE KEY uq_ai_tasks_extraction_segment (user_id, extraction_billing_group_id, extraction_segment_index),
  ADD CONSTRAINT fk_ai_tasks_extraction_billing_group FOREIGN KEY (extraction_billing_group_id)
    REFERENCES video_understanding_billing_groups(id);
