-- Common script genres distilled from mainstream web-fiction and short-drama catalogs.
-- Keep the original seed id so existing sample scripts retain their foreign key.
UPDATE script_library_categories
SET code = 'suspense-crime',
    name = '悬疑刑侦',
    description = '悬疑推理、刑侦探案、犯罪谜局与惊悚反转',
    sort_order = 90
WHERE id = '49000000-0000-0000-0000-000000000001'
  AND code = 'short-drama';

INSERT IGNORE INTO script_library_categories (id, code, name, description, sort_order, status) VALUES
  ('50000000-0000-0000-0000-000000000001', 'modern-city', '现代都市', '都市生活、现实情感、小人物成长与都市脑洞', 10, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000002', 'sweet-romance', '甜宠言情', '甜蜜恋爱、先婚后爱、破镜重圆与双向奔赴', 20, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000003', 'wealthy-ceo', '豪门总裁', '豪门恩怨、商业联姻、契约婚姻与身份反转', 30, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000004', 'comeback-revenge', '逆袭复仇', '逆风翻盘、打脸虐渣、强者归来与复仇爽剧', 40, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000005', 'family-emotion', '家庭情感', '家庭伦理、婚姻生活、亲情羁绊与家长里短', 50, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000006', 'female-growth', '女性成长', '大女主、自我救赎、事业成长与独立人生', 60, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000007', 'ancient-romance', '古装言情', '古代爱情、宫斗宅斗、王侯将相与古风世情', 70, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000008', 'rebirth-transmigration', '重生穿越', '重生归来、穿书快穿、时空之旅与命运改写', 80, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000009', 'fantasy-xianxia', '玄幻仙侠', '东方玄幻、修仙问道、异能觉醒与奇幻冒险', 100, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000010', 'system-imagination', '系统脑洞', '系统流、神豪、都市脑洞与超能力设定', 110, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000011', 'sci-fi-apocalypse', '科幻末世', '未来科技、末世求生、灾难危机与星际幻想', 120, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000012', 'period-rural', '年代乡村', '年代生活、乡村创业、种田经营与烟火日常', 130, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000013', 'workplace-business', '职场商战', '职场进阶、商战博弈、创业奋斗与行业故事', 140, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000014', 'youth-campus', '青春校园', '校园成长、青春友情、暗恋成真与热血逐梦', 150, 'ACTIVE'),
  ('50000000-0000-0000-0000-000000000015', 'light-comedy', '喜剧轻松', '轻松搞笑、欢喜冤家、荒诞日常与治愈故事', 160, 'ACTIVE');
