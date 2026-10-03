CREATE TABLE IF NOT EXISTS tutorials (
  id CHAR(36) NOT NULL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  video_type ENUM('NONE','UPLOAD','BILIBILI') NOT NULL DEFAULT 'NONE',
  video_url TEXT NULL,
  status ENUM('DRAFT','PUBLISHED') NOT NULL DEFAULT 'DRAFT',
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_by CHAR(36) NULL,
  updated_by CHAR(36) NULL,
  published_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_tutorials_public (status,sort_order,published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tutorial_media (
  id CHAR(36) NOT NULL PRIMARY KEY,
  storage_name VARCHAR(50) NOT NULL UNIQUE,
  mime_type VARCHAR(50) NOT NULL,
  media_type ENUM('IMAGE','VIDEO') NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO admin_permissions (id,code,name)
VALUES ('00000000-0000-0000-0000-000000000113','tutorials.manage','管理教程');

INSERT IGNORE INTO admin_role_permissions (role_id,permission_id)
SELECT '00000000-0000-0000-0000-000000000001',id
FROM admin_permissions WHERE code='tutorials.manage';
