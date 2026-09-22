ALTER TABLE announcements
  ADD COLUMN is_pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER status,
  ADD KEY idx_announcements_public (status, is_pinned, published_at);

INSERT IGNORE INTO admin_permissions (id, code, name)
VALUES ('00000000-0000-0000-0000-000000000112', 'announcements.manage', '管理通知公告');

INSERT IGNORE INTO admin_role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000001', id
FROM admin_permissions
WHERE code = 'announcements.manage';
