ALTER TABLE provider_models
  ADD COLUMN model_alias VARCHAR(100) NOT NULL DEFAULT '' AFTER display_name,
  ADD COLUMN api_protocol VARCHAR(64) NOT NULL DEFAULT 'openai' AFTER capability,
  ADD COLUMN generation_endpoint VARCHAR(500) NOT NULL DEFAULT '' AFTER api_protocol,
  ADD COLUMN query_endpoint VARCHAR(500) NULL AFTER generation_endpoint,
  ADD COLUMN credit_multiplier INT UNSIGNED NOT NULL DEFAULT 1 AFTER query_endpoint,
  ADD COLUMN max_reference_images TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER credit_multiplier,
  ADD COLUMN supports_reference_video TINYINT(1) NOT NULL DEFAULT 0 AFTER max_reference_images,
  ADD COLUMN supports_async_tasks TINYINT(1) NOT NULL DEFAULT 0 AFTER supports_reference_video,
  ADD COLUMN sort_order INT UNSIGNED NOT NULL DEFAULT 100 AFTER supports_async_tasks,
  ADD COLUMN description VARCHAR(1000) NOT NULL DEFAULT '' AFTER sort_order,
  ADD COLUMN config_json JSON NULL AFTER parameter_schema_json;

CREATE INDEX idx_provider_models_provider_sort
  ON provider_models (provider_id, sort_order, display_name);
