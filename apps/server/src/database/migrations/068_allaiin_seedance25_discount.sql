-- 慧心 AI Seedance 2.5 特惠版，API 中心模型 81（2026-11-01 核对）。
-- 15/30 秒、720P、最多 30 张参考图；按次计费，不支持独立首尾帧/参考音视频。
-- 保留已有模型主键、路由、人工积分定价与启停状态。
UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
LEFT JOIN provider_models stable ON stable.provider_id = pm.provider_id AND stable.model_code = 'xh-seedance-2.5-c-zk'
SET pm.model_code = 'xh-seedance-2.5-c-zk'
WHERE JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.remote_numeric_id')) = '81'
  AND pm.capability = 'VIDEO_GENERATION' AND stable.id IS NULL;

INSERT INTO provider_models
  (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
   generation_endpoint, query_endpoint, credit_cost, billing_unit, credit_multiplier,
   max_reference_images, supports_reference_video, supports_real_person,
   supports_async_tasks, sort_order, description, status, parameter_schema_json, config_json)
SELECT UUID(), p.id, 'xh-seedance-2.5-c-zk', 'Seedance 2.5 特惠版', 'Seedance 2.5 特惠版',
       'VIDEO_GENERATION', 'allaiin_rest', '/video/generations', '/tasks/{task_id}',
       GREATEST(1, CEIL((65 * 0.10) / NULLIF(pricing.cny_per_credit, 0))),
       'PER_REQUEST', 1.000000, 30, FALSE, FALSE, TRUE, 90,
       '慧心 AI Seedance 2.5 特惠版，支持 15/30 秒、720P、多参考图；不支持独立首尾帧或参考音视频。',
       'ACTIVE',
       JSON_ARRAY(
         JSON_OBJECT('name', 'prompt', 'label', '提示词', 'type', 'textarea', 'required', TRUE),
         JSON_OBJECT('name', 'size', 'label', '视频比例', 'type', 'select', 'required', FALSE,
           'options', JSON_ARRAY('9:16', '16:9', '4:3', '3:4', '1:1', '21:9')),
         JSON_OBJECT('name', 'seconds', 'label', '视频时长', 'type', 'select', 'required', TRUE,
           'options', JSON_ARRAY(15, 30)),
         JSON_OBJECT('name', 'resolution', 'label', '分辨率', 'type', 'select', 'required', FALSE,
           'options', JSON_ARRAY('720P')),
         JSON_OBJECT('name', 'count', 'label', '生成数量', 'type', 'select', 'required', FALSE,
           'options', JSON_ARRAY(1, 2, 3, 4)),
         JSON_OBJECT('name', 'reference_image', 'label', '参考图', 'type', 'upload', 'required', FALSE),
         JSON_OBJECT('name', 'reference_images', 'label', '多张参考图', 'type', 'upload', 'required', FALSE,
           'description', '最多 30 张公网图片 URL；分镜图排在第一张。')
       ),
       JSON_OBJECT(
         'source', 'allaiin_api_center', 'docs_url', 'https://ailingg.store/api-center',
         'remote_numeric_id', 81, 'request_model_name', 'Seedance 2.5 特惠版',
         'remote_model_id', 'xh-seedance-2.5-c-zk', 'reference_image_mode', 'reference_images',
         'video_duration_options', JSON_ARRAY(15, 30),
         'aspect_ratio_options', JSON_ARRAY('9:16', '16:9', '4:3', '3:4', '1:1', '21:9'),
         'resolution_mapping', JSON_OBJECT('720p', '720P'),
         'source_points_cost', 65, 'source_point_cny', 0.10,
         'source_credit_cost', GREATEST(1, CEIL((65 * 0.10) / NULLIF(pricing.cny_per_credit, 0))),
         'source_cny_per_credit', pricing.cny_per_credit,
         'credit_cost_note', '慧心 AI 原始基础报价 65 积分/次，按系统积分汇率换算；15/30 秒均按次计费，后台可调整。'
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
WHERE pm.model_code = 'xh-seedance-2.5-c-zk' AND pm.capability = 'VIDEO_GENERATION'
  AND NOT EXISTS (SELECT 1 FROM provider_model_resolution_prices rp WHERE rp.provider_model_id = pm.id AND LOWER(rp.resolution) = '720p');

INSERT INTO ai_default_media_models (capability, provider_model_id, sort_order, recommended)
SELECT 'VIDEO_GENERATION', pm.id,
       COALESCE((SELECT MAX(configured.sort_order) + 10 FROM ai_default_media_models configured WHERE configured.capability = 'VIDEO_GENERATION'), pm.sort_order), FALSE
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
WHERE pm.model_code = 'xh-seedance-2.5-c-zk' AND pm.capability = 'VIDEO_GENERATION'
ON DUPLICATE KEY UPDATE provider_model_id = VALUES(provider_model_id);
