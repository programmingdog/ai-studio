CREATE TABLE IF NOT EXISTS desktop_releases (
  id CHAR(36) NOT NULL,
  version VARCHAR(32) NOT NULL,
  channel VARCHAR(32) NOT NULL DEFAULT 'stable',
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  notes TEXT NOT NULL,
  min_supported_version VARCHAR(32) NOT NULL DEFAULT '0.0.0',
  rollout_percent TINYINT UNSIGNED NOT NULL DEFAULT 100,
  created_by CHAR(36) NULL,
  published_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  published_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_desktop_releases_channel_version (channel, version),
  KEY idx_desktop_releases_public (channel, status, published_at),
  CONSTRAINT fk_desktop_releases_created_by FOREIGN KEY (created_by) REFERENCES admin_users(id),
  CONSTRAINT fk_desktop_releases_published_by FOREIGN KEY (published_by) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS desktop_release_artifacts (
  id CHAR(36) NOT NULL,
  release_id CHAR(36) NOT NULL,
  target VARCHAR(16) NOT NULL,
  arch VARCHAR(16) NOT NULL,
  url VARCHAR(1000) NOT NULL,
  signature VARCHAR(2000) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_desktop_release_artifact (release_id, target, arch),
  CONSTRAINT fk_desktop_release_artifacts_release FOREIGN KEY (release_id) REFERENCES desktop_releases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO admin_permissions (id, code, name)
VALUES ('00000000-0000-0000-0000-000000000108', 'releases.manage', '管理桌面客户端版本');

INSERT IGNORE INTO admin_role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000001', id
FROM admin_permissions
WHERE code = 'releases.manage';
