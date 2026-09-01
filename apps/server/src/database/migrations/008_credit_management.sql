CREATE TABLE credit_packages (
  id CHAR(36) NOT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  base_credits BIGINT UNSIGNED NOT NULL,
  bonus_credits BIGINT UNSIGNED NOT NULL DEFAULT 0,
  price_fen BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_credit_packages_code (code),
  KEY idx_credit_packages_status_sort (status, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE credit_package_purchases (
  id CHAR(36) NOT NULL,
  purchase_no VARCHAR(64) NOT NULL,
  user_id CHAR(36) NOT NULL,
  package_id CHAR(36) NULL,
  package_code_snapshot VARCHAR(64) NOT NULL,
  package_name_snapshot VARCHAR(100) NOT NULL,
  base_credits_snapshot BIGINT UNSIGNED NOT NULL,
  bonus_credits_snapshot BIGINT UNSIGNED NOT NULL DEFAULT 0,
  credits_granted BIGINT UNSIGNED NOT NULL,
  paid_amount_fen BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  payment_order_id CHAR(36) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'CREATED',
  purchased_at DATETIME(3) NULL,
  notes VARCHAR(1000) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_credit_package_purchases_no (purchase_no),
  KEY idx_credit_package_purchases_user_created (user_id, created_at),
  KEY idx_credit_package_purchases_status_created (status, created_at),
  CONSTRAINT fk_credit_package_purchases_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_credit_package_purchases_package FOREIGN KEY (package_id) REFERENCES credit_packages(id) ON DELETE SET NULL,
  CONSTRAINT fk_credit_package_purchases_payment FOREIGN KEY (payment_order_id) REFERENCES payment_orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE credit_consumption_records (
  id CHAR(36) NOT NULL,
  consumption_no VARCHAR(64) NOT NULL,
  user_id CHAR(36) NOT NULL,
  task_id CHAR(36) NULL,
  provider_model_id CHAR(36) NULL,
  category VARCHAR(64) NOT NULL DEFAULT 'MODEL_TASK',
  credits_consumed DECIMAL(20,6) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'CONFIRMED',
  description VARCHAR(500) NOT NULL DEFAULT '',
  notes VARCHAR(1000) NOT NULL DEFAULT '',
  metadata_json JSON NULL,
  occurred_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_credit_consumption_records_no (consumption_no),
  KEY idx_credit_consumption_user_occurred (user_id, occurred_at),
  KEY idx_credit_consumption_status_occurred (status, occurred_at),
  CONSTRAINT fk_credit_consumption_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_credit_consumption_task FOREIGN KEY (task_id) REFERENCES ai_tasks(id) ON DELETE SET NULL,
  CONSTRAINT fk_credit_consumption_model FOREIGN KEY (provider_model_id) REFERENCES provider_models(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO credit_packages
  (id, code, name, description, base_credits, bonus_credits, price_fen, currency, status, sort_order)
VALUES
  ('81000000-0000-0000-0000-000000000001', 'starter-500', '体验积分包', '适合首次体验图片与短视频生成功能', 500, 0, 990, 'CNY', 'ACTIVE', 10),
  ('81000000-0000-0000-0000-000000000002', 'standard-3000', '标准积分包', '适合日常内容创作与批量生成', 2800, 200, 4990, 'CNY', 'ACTIVE', 20),
  ('81000000-0000-0000-0000-000000000003', 'pro-6800', '专业积分包', '适合高频视频创作与团队使用', 6000, 800, 9990, 'CNY', 'ACTIVE', 30);

INSERT IGNORE INTO admin_permissions (id, code, name)
VALUES ('00000000-0000-0000-0000-000000000108', 'credits.manage', '管理积分套餐与积分记录');

INSERT IGNORE INTO admin_role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000001', id
FROM admin_permissions WHERE code = 'credits.manage';
