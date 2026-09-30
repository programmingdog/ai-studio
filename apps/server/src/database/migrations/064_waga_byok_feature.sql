-- Review and deploy explicitly. Existing platform billing remains the default.
CREATE TABLE IF NOT EXISTS user_waga_byok_access (
  user_id CHAR(36) NOT NULL PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  updated_by CHAR(36) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_user_waga_byok_access_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Rollback (after reverting application code):
-- DROP TABLE user_waga_byok_access; (loses only these feature grants; export first)
