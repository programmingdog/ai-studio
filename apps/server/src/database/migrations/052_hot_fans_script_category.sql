INSERT INTO script_library_categories (id, code, name, description, sort_order, status)
VALUES (
  '52000000-0000-0000-0000-000000000001',
  'hot-fans',
  '热门爆粉',
  '精选高热度、高传播潜力的完整剧本',
  0,
  'ACTIVE'
)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  sort_order = VALUES(sort_order),
  status = VALUES(status);
