-- Reference image lifetime follows every consuming task, not provider acceptance.
CREATE TABLE IF NOT EXISTS temporary_reference_images (
  nonce CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_fingerprint CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mime_type VARCHAR(32) NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  upload_expires_at DATETIME(3) NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (nonce)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_reference_images (
  image_nonce CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_id CHAR(36) NOT NULL,
  PRIMARY KEY (image_nonce, task_id),
  KEY idx_task_reference_images_task (task_id),
  CONSTRAINT fk_task_reference_image FOREIGN KEY (image_nonce) REFERENCES temporary_reference_images(nonce) ON DELETE CASCADE,
  CONSTRAINT fk_task_reference_task FOREIGN KEY (task_id) REFERENCES ai_tasks(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
