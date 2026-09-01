CREATE TABLE mail_service_configs (
  id TINYINT UNSIGNED NOT NULL,
  api_url VARCHAR(500) NOT NULL,
  mail_from VARCHAR(191) NOT NULL DEFAULT '',
  password_ciphertext TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DISABLED',
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  updated_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_mail_service_config_admin FOREIGN KEY (updated_by) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO mail_service_configs (id, api_url)
VALUES (1, 'https://yuntianxing.net/mail_sys/send_mail_http.json');
