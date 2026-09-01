CREATE TABLE IF NOT EXISTS ai_default_model_config (
  id TINYINT UNSIGNED NOT NULL,
  text_model_id CHAR(36) NULL,
  video_understanding_model_id CHAR(36) NULL,
  updated_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_default_text_model FOREIGN KEY (text_model_id) REFERENCES provider_models(id) ON DELETE SET NULL,
  CONSTRAINT fk_default_video_understanding_model FOREIGN KEY (video_understanding_model_id) REFERENCES provider_models(id) ON DELETE SET NULL,
  CONSTRAINT fk_default_model_admin FOREIGN KEY (updated_by) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO ai_default_model_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS ai_default_media_models (
  capability VARCHAR(64) NOT NULL,
  provider_model_id CHAR(36) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (capability, provider_model_id),
  KEY idx_default_media_model (provider_model_id),
  CONSTRAINT fk_default_media_model FOREIGN KEY (provider_model_id) REFERENCES provider_models(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
