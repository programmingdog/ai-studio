CREATE TABLE IF NOT EXISTS script_library_config (
  id TINYINT UNSIGNED NOT NULL,
  credit_cost DECIMAL(20,6) NOT NULL DEFAULT 20,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by CHAR(36) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_script_library_config_admin FOREIGN KEY (updated_by) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO script_library_config (id, credit_cost) VALUES (1, 20);

CREATE TABLE IF NOT EXISTS script_library_categories (
  id CHAR(36) NOT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_script_library_categories_code (code),
  KEY idx_script_library_categories_status_sort (status, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS script_library_scripts (
  id CHAR(36) NOT NULL,
  category_id CHAR(36) NOT NULL,
  title VARCHAR(200) NOT NULL,
  duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  summary VARCHAR(1000) NOT NULL DEFAULT '',
  content LONGTEXT NOT NULL,
  canonical_json JSON NOT NULL,
  heat_score INT UNSIGNED NOT NULL DEFAULT 0,
  use_count INT UNSIGNED NOT NULL DEFAULT 0,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_script_library_scripts_category_status (category_id, status, sort_order),
  KEY idx_script_library_scripts_heat (status, heat_score),
  FULLTEXT KEY ft_script_library_scripts_search (title, summary, content),
  CONSTRAINT fk_script_library_scripts_category FOREIGN KEY (category_id) REFERENCES script_library_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS script_library_usages (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  script_id CHAR(36) NULL,
  script_id_snapshot CHAR(36) NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  title_snapshot VARCHAR(200) NOT NULL,
  duration_seconds_snapshot INT UNSIGNED NOT NULL DEFAULT 0,
  canonical_snapshot JSON NOT NULL,
  credits_consumed DECIMAL(20,6) NOT NULL,
  consumption_record_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_script_library_usages_user_key (user_id, idempotency_key),
  KEY idx_script_library_usages_script (script_id, created_at),
  CONSTRAINT fk_script_library_usages_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_script_library_usages_script FOREIGN KEY (script_id) REFERENCES script_library_scripts(id) ON DELETE SET NULL,
  CONSTRAINT fk_script_library_usages_consumption FOREIGN KEY (consumption_record_id) REFERENCES credit_consumption_records(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO script_library_categories (id, code, name, description, sort_order, status)
VALUES ('49000000-0000-0000-0000-000000000001', 'short-drama', '竖屏短剧', '适合短视频平台的紧凑剧情剧本', 10, 'ACTIVE');

INSERT IGNORE INTO script_library_scripts
  (id, category_id, title, duration_seconds, summary, content, canonical_json, heat_score, sort_order, status)
VALUES (
  '49000000-0000-0000-0000-000000000101',
  '49000000-0000-0000-0000-000000000001',
  '雨夜来信', 12,
  '年轻记者在雨夜收到一封改变调查方向的匿名信。',
  '第一场 夜 内景 编辑部\n窗外下着大雨，林夏独自在编辑部加班。一个潮湿的旧信封出现在桌上。\n林夏拿起信封：谁送来的？',
  '{"schema_version":"aivs-script-v1","story":{"title":"雨夜来信","logline":"年轻记者在雨夜收到一封匿名信。","genre":["悬疑","剧情"],"theme":"真相与选择","synopsis":"林夏在编辑部收到匿名信。","tone":"紧张","aspect_ratio":"9:16","visual_style":"电影写实","beats":[]},"episodes":[{"id":"EP_001","order":1,"title":"匿名信","duration":12,"content":"林夏收到匿名信。"}],"characters":[{"id":"CHAR_001","name":"林夏","role":"主角","gender":"女","age_range":"25-30岁","appearance":{"face":"清秀","hair":"黑色短发","body":"中等身材","clothes":"米色风衣","accessories":"黑框眼镜"},"personality":"冷静","motivation":"查明真相","voice":"清晰","story_function":"推动调查","reference_assets":[],"states":[],"locked":false}],"scenes":[{"id":"SCENE_001","name":"雨夜编辑部","location_type":"室内","time_of_day":"夜晚","description":"窗外大雨的编辑部","lighting":"冷白顶灯","layout":"工位整齐排列","props":["匿名信"],"mood":"紧张","reference_assets":[],"locked":false}],"props":[{"id":"PROP_001","name":"匿名信","style":"旧牛皮纸信封","description":"封口被雨水打湿","reference_assets":[],"locked":false}],"sequences":[{"id":"SEQ_001","scene_id":"SCENE_001","order":1,"summary":"林夏发现匿名信","character_ids":["CHAR_001"],"shot_ids":["SHOT_001"]}],"shots":[{"id":"SHOT_001","sequence_id":"SEQ_001","scene_id":"SCENE_001","character_ids":["CHAR_001"],"prop_ids":["PROP_001"],"duration":12,"aspect_ratio":"9:16","shot_size":"中景","camera_angle":"平视","camera_movement":"缓慢推进","visual":"林夏拿起桌上的旧信封","action":"拿起信封","emotion":"警觉","dialogue":"谁送来的？","sound":"雨声","image_prompt":"雨夜编辑部，林夏拿起旧信封","video_prompt":"林夏拿起信封，镜头缓慢推进","negative_prompt":"","status":"DRAFT","locked":false}]}',
  FLOOR(1000 + RAND() * 90000), 10, 'ACTIVE'
);

INSERT IGNORE INTO admin_permissions (id, code, name)
VALUES ('00000000-0000-0000-0000-000000000109', 'scripts.manage', '管理剧本库');

INSERT IGNORE INTO admin_role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000001', id
FROM admin_permissions WHERE code = 'scripts.manage';
