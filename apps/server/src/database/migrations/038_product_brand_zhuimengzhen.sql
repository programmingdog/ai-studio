-- 将仍使用历史默认值的产品品牌统一为“逐梦帧”。
-- 管理员已经自定义过的品牌不会被覆盖。
UPDATE product_brand_configs
SET chinese_name = '逐梦帧',
    english_name = '逐梦帧',
    revision = revision + 1
WHERE id = 1
  AND chinese_name = '影匠'
  AND english_name = 'Yingjiang';
