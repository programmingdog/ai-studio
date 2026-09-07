CREATE TABLE IF NOT EXISTS product_brand_configs (
  id TINYINT UNSIGNED NOT NULL,
  chinese_name VARCHAR(32) NOT NULL,
  english_name VARCHAR(64) NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  updated_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_product_brand_config_admin FOREIGN KEY (updated_by) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO product_brand_configs (id, chinese_name, english_name) VALUES (1, '影匠', 'Yingjiang');
