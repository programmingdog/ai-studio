ALTER TABLE provider_models
  ADD COLUMN supports_real_person TINYINT(1) NOT NULL DEFAULT 0 AFTER supports_reference_video;
