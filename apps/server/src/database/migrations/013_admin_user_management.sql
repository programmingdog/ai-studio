INSERT IGNORE INTO admin_permissions (id, code, name)
VALUES ('00000000-0000-0000-0000-000000000109', 'users.manage', '管理用户资料与积分');

INSERT IGNORE INTO admin_role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000001', id
FROM admin_permissions
WHERE code = 'users.manage';
