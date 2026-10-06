CREATE TABLE IF NOT EXISTS viral_remake_categories (
  id CHAR(36) NOT NULL PRIMARY KEY,
  type ENUM('FANS','COMMERCE') NOT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(1000) NOT NULL DEFAULT '',
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_by CHAR(36) NULL,
  updated_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_viral_category_code (type,code),
  UNIQUE KEY uq_viral_category_name (type,name),
  KEY idx_viral_categories_public (type,status,sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS viral_remake_templates (
  id CHAR(36) NOT NULL PRIMARY KEY,
  category_id CHAR(36) NOT NULL,
  title VARCHAR(200) NOT NULL,
  summary VARCHAR(1000) NOT NULL DEFAULT '',
  video_url VARCHAR(200) NOT NULL,
  original_share_url VARCHAR(2000) NOT NULL DEFAULT '',
  script_content MEDIUMTEXT NOT NULL,
  replacement_elements_json JSON NOT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_by CHAR(36) NULL,
  updated_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_viral_templates_public (category_id,status,sort_order,created_at),
  CONSTRAINT fk_viral_template_category FOREIGN KEY (category_id) REFERENCES viral_remake_categories(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO viral_remake_categories (id,type,code,name,description,sort_order,status) VALUES
  ('00000000-0000-0000-0000-000000001201','FANS','emotional-story','情感故事','亲情、友情、爱情与生活共鸣',10,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001202','FANS','comedy-drama','搞笑剧情','反转段子、日常喜剧与幽默短剧',20,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001203','FANS','suspense-reversal','悬疑反转','悬疑故事、推理与意外反转',30,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001204','FANS','knowledge-tips','知识科普','知识讲解、实用技巧与生活科普',40,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001205','FANS','workplace-life','职场生活','职场故事、工作经验与生活观察',50,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001206','FANS','inspiration-growth','励志成长','个人成长、积极表达与励志故事',60,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001207','FANS','pet-cute','萌宠趣事','宠物、动物故事与治愈场景',70,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001208','FANS','travel-food','旅行美食','旅行记录、美食发现与地方文化',80,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001209','COMMERCE','beauty-care','美妆个护','护肤、美妆与个人护理商品',10,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001210','COMMERCE','food-drink','食品饮料','零食、生鲜、饮品与日常食品',20,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001211','COMMERCE','fashion-accessories','服饰鞋包','服饰、鞋包、配饰与穿搭展示',30,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001212','COMMERCE','home-daily','家居日用','家居用品、清洁工具与日常好物',40,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001213','COMMERCE','digital-appliances','数码家电','数码产品、家电与智能设备',50,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001214','COMMERCE','mother-baby','母婴用品','母婴用品、儿童日用与亲子商品',60,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001215','COMMERCE','sports-outdoor','运动户外','运动装备、户外用品与健身商品',70,'ACTIVE'),
  ('00000000-0000-0000-0000-000000001216','COMMERCE','pet-supplies','宠物用品','宠物食品、用品与护理商品',80,'ACTIVE');

INSERT IGNORE INTO admin_permissions (id,code,name)
VALUES ('00000000-0000-0000-0000-000000000114','viral-remakes.manage','管理爆款复刻');

INSERT IGNORE INTO admin_role_permissions (role_id,permission_id)
SELECT '00000000-0000-0000-0000-000000000001',id
FROM admin_permissions WHERE code='viral-remakes.manage';
