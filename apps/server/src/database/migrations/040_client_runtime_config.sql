CREATE TABLE IF NOT EXISTS client_runtime_configs (
  id TINYINT UNSIGNED NOT NULL,
  recommended_video_concurrency BIGINT UNSIGNED NULL DEFAULT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  updated_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_client_runtime_config_admin FOREIGN KEY (updated_by) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NULL means that the runtime follows RECOMMENDED_VIDEO_CONCURRENCY.
INSERT IGNORE INTO client_runtime_configs (id, recommended_video_concurrency) VALUES (1, NULL);
