CREATE TABLE IF NOT EXISTS ip_access_rules (
  id CHAR(36) NOT NULL,
  cidr VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  address_family TINYINT UNSIGNED NOT NULL,
  prefix_length TINYINT UNSIGNED NOT NULL,
  note VARCHAR(200) NOT NULL DEFAULT '',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_by CHAR(36) NOT NULL,
  updated_by CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ip_access_rules_cidr (cidr),
  KEY idx_ip_access_rules_enabled (enabled, updated_at),
  CONSTRAINT fk_ip_access_rules_created_by FOREIGN KEY (created_by) REFERENCES admin_users(id),
  CONSTRAINT fk_ip_access_rules_updated_by FOREIGN KEY (updated_by) REFERENCES admin_users(id),
  CONSTRAINT chk_ip_access_rules_family CHECK (address_family IN (4, 6)),
  CONSTRAINT chk_ip_access_rules_prefix CHECK ((address_family = 4 AND prefix_length <= 32) OR (address_family = 6 AND prefix_length <= 128))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
