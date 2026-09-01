CREATE TABLE registration_captchas (
  id CHAR(36) NOT NULL,
  email VARCHAR(191) NOT NULL,
  ip_hash CHAR(64) NOT NULL,
  answer_hash CHAR(64) NULL,
  token_hash CHAR(64) NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_registration_captcha_token (token_hash),
  KEY idx_registration_captcha_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE registration_email_codes (
  email VARCHAR(191) NOT NULL,
  send_id CHAR(36) NULL,
  code_hash CHAR(64) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NULL,
  next_send_at DATETIME(3) NOT NULL,
  PRIMARY KEY (email),
  KEY idx_registration_email_cleanup (next_send_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE registration_rate_limits (
  bucket_key CHAR(64) NOT NULL,
  hits INT UNSIGNED NOT NULL,
  window_ends_at DATETIME(3) NOT NULL,
  PRIMARY KEY (bucket_key),
  KEY idx_registration_limit_expiry (window_ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
