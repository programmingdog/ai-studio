-- 慧心 API 中心模型 83，2026-11-02 核对 bodyConfig/pricingConfig。
-- 720P，5/10/15/20/25/30 秒；组合价 4/8/12/16/20/24 慧心积分，折合 0.8 积分/秒。
-- 最多 7 图、1 视频；视频参考不加倍。基础 /models 价格为 0，不能用于自动定价。
-- 仅补正旧目录自动导入的零价占位，保留人工定价、启停、积分系数和既有默认推荐。
UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
LEFT JOIN provider_models stable ON stable.provider_id = pm.provider_id AND stable.model_code = 'muse-video'
SET pm.model_code = 'muse-video'
WHERE JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.remote_numeric_id')) = '83'
  AND pm.capability = 'VIDEO_GENERATION' AND stable.id IS NULL;

UPDATE provider_model_resolution_prices rp
INNER JOIN provider_models pm ON pm.id = rp.provider_model_id
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
INNER JOIN model_credit_pricing_config pricing ON pricing.id = 1
SET rp.credit_cost = GREATEST(1, CEIL((0.8 * 0.10) / NULLIF(pricing.cny_per_credit, 0)))
WHERE pm.model_code = 'muse-video' AND pm.capability = 'VIDEO_GENERATION'
  AND JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.source')) = 'allaiin_models_api'
  AND JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.source_points_cost')) = '0'
  AND JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.source_credit_cost')) = '1'
  AND pm.credit_cost = 1 AND rp.credit_cost = 1 AND LOWER(rp.resolution) = '720p';

UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
INNER JOIN model_credit_pricing_config pricing ON pricing.id = 1
SET pm.credit_cost = GREATEST(1, CEIL((0.8 * 0.10) / NULLIF(pricing.cny_per_credit, 0)))
WHERE pm.model_code = 'muse-video' AND pm.capability = 'VIDEO_GENERATION'
  AND JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.source')) = 'allaiin_models_api'
  AND JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.source_points_cost')) = '0'
  AND JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.source_credit_cost')) = '1'
  AND pm.credit_cost = 1;

INSERT INTO provider_models
  (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
   generation_endpoint, query_endpoint, credit_cost, billing_unit, credit_multiplier,
   max_reference_images, supports_reference_video, supports_real_person,
   supports_async_tasks, sort_order, description, status, parameter_schema_json, config_json)
SELECT UUID(), p.id, 'muse-video', 'Muse-video', 'Muse-video', 'VIDEO_GENERATION',
       'allaiin_rest', '/video/generations', '/tasks/{task_id}',
       GREATEST(1, CEIL((0.8 * 0.10) / NULLIF(pricing.cny_per_credit, 0))),
       'PER_SECOND', 1.000000, 7, TRUE, FALSE, TRUE, 110,
       'Muse-video 预览模型，5/10/15/20/25/30 秒、720P、横竖屏，最多 7 图和 1 视频参考；参考视频不加倍。',
       'ACTIVE',
       JSON_ARRAY(
         JSON_OBJECT('name', 'prompt', 'label', '提示词', 'type', 'textarea', 'required', TRUE),
         JSON_OBJECT('name', 'size', 'label', '视频比例', 'type', 'select', 'required', FALSE, 'options', JSON_ARRAY('9:16', '16:9')),
         JSON_OBJECT('name', 'seconds', 'label', '视频时长', 'type', 'select', 'required', TRUE, 'options', JSON_ARRAY(5, 10, 15, 20, 25, 30)),
         JSON_OBJECT('name', 'resolution', 'label', '分辨率', 'type', 'select', 'required', TRUE, 'options', JSON_ARRAY('720P')),
         JSON_OBJECT('name', 'count', 'label', '生成数量', 'type', 'select', 'required', FALSE, 'options', JSON_ARRAY(1, 2, 3, 4)),
         JSON_OBJECT('name', 'reference_image', 'label', '参考图', 'type', 'upload', 'required', FALSE),
         JSON_OBJECT('name', 'reference_images', 'label', '多张参考图', 'type', 'upload', 'required', FALSE, 'description', '最多 7 张公网图片 URL；分镜图排在第一张。'),
         JSON_OBJECT('name', 'reference_video', 'label', '参考视频', 'type', 'upload', 'required', FALSE, 'description', '最多 1 段公网视频 URL，费用不加倍。'),
         JSON_OBJECT('name', 'reference_videos', 'label', '参考视频数组', 'type', 'upload', 'required', FALSE, 'description', '最多 1 段，与单个参考视频合计。')
       ),
       JSON_OBJECT(
         'source', 'allaiin_api_center', 'docs_url', 'https://ailingg.store/api-center',
         'remote_numeric_id', 83, 'remote_model_id', 'muse-video', 'request_model_name', 'Muse-video',
         'reference_image_mode', 'reference_images', 'manual_resolution_pricing', TRUE,
         'video_duration_options', JSON_ARRAY(5, 10, 15, 20, 25, 30),
         'aspect_ratio_options', JSON_ARRAY('9:16', '16:9'), 'resolution_mapping', JSON_OBJECT('720p', '720P'),
         'source_points_cost', 0.8, 'source_point_cny', 0.10,
         'source_credit_cost', GREATEST(1, CEIL((0.8 * 0.10) / NULLIF(pricing.cny_per_credit, 0))),
         'source_cny_per_credit', pricing.cny_per_credit,
         'credit_cost_note', 'API 中心组合报价折合 0.8 慧心积分/秒，参考视频不加倍；基础目录价格为 0，自动同步保留后台定价。'
       )
FROM providers p
INNER JOIN model_credit_pricing_config pricing ON pricing.id = 1
WHERE LOWER(p.code) = 'allaiin'
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name), model_alias = VALUES(model_alias), capability = VALUES(capability),
  api_protocol = VALUES(api_protocol), generation_endpoint = VALUES(generation_endpoint), query_endpoint = VALUES(query_endpoint),
  billing_unit = VALUES(billing_unit), max_reference_images = VALUES(max_reference_images),
  supports_reference_video = VALUES(supports_reference_video), supports_real_person = VALUES(supports_real_person),
  supports_async_tasks = VALUES(supports_async_tasks), description = VALUES(description),
  parameter_schema_json = VALUES(parameter_schema_json),
  config_json = JSON_MERGE_PATCH(COALESCE(provider_models.config_json, JSON_OBJECT()), VALUES(config_json));

INSERT IGNORE INTO provider_model_resolution_prices (provider_model_id, resolution, credit_cost, sort_order)
SELECT pm.id, '720P', pm.credit_cost, 0
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
WHERE pm.model_code = 'muse-video' AND pm.capability = 'VIDEO_GENERATION'
  AND NOT EXISTS (SELECT 1 FROM provider_model_resolution_prices rp WHERE rp.provider_model_id = pm.id AND LOWER(rp.resolution) = '720p');

INSERT INTO ai_default_media_models (capability, provider_model_id, sort_order, recommended)
SELECT 'VIDEO_GENERATION', pm.id,
       COALESCE((SELECT MAX(configured.sort_order) + 10 FROM ai_default_media_models configured WHERE configured.capability = 'VIDEO_GENERATION'), pm.sort_order), FALSE
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
WHERE pm.model_code = 'muse-video' AND pm.capability = 'VIDEO_GENERATION'
ON DUPLICATE KEY UPDATE provider_model_id = VALUES(provider_model_id);
