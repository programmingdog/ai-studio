-- 慧心 API 中心模型 69：Wan 3.0 官（2026-11-01 核对）。
-- 支持 4～30 秒、480P/720P/1080P、30 张图、5 段音频或视频；参考视频费用翻倍。
-- 基础 /models 报价不是分辨率秒价，按 API 中心预置；后续保留后台人工定价。
UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
LEFT JOIN provider_models stable ON stable.provider_id = pm.provider_id AND stable.model_code = 'wan3.0-video'
SET pm.model_code = 'wan3.0-video'
WHERE JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.remote_numeric_id')) = '69'
  AND pm.capability = 'VIDEO_GENERATION' AND stable.id IS NULL;

-- 仅修正仍等于上次自动同步基准的旧统一价，保留人工修改的档位与倍率。
UPDATE provider_model_resolution_prices rp
INNER JOIN provider_models pm ON pm.id = rp.provider_model_id
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
INNER JOIN model_credit_pricing_config pricing ON pricing.id = 1
SET rp.credit_cost = GREATEST(1, CEIL((CASE LOWER(rp.resolution) WHEN '480p' THEN 1.5 WHEN '720p' THEN 3 ELSE 6 END * 0.10) / NULLIF(pricing.cny_per_credit, 0)))
WHERE pm.model_code = 'wan3.0-video' AND LOWER(rp.resolution) IN ('480p', '720p', '1080p')
  AND rp.credit_cost = COALESCE(
    CAST(JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.source_credit_cost')) AS DECIMAL(18,6)),
    GREATEST(1, ROUND(CAST(JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.source_points_cost')) AS DECIMAL(18,6)))));

UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
INNER JOIN model_credit_pricing_config pricing ON pricing.id = 1
SET pm.credit_cost = GREATEST(1, CEIL((3 * 0.10) / NULLIF(pricing.cny_per_credit, 0)))
WHERE pm.model_code = 'wan3.0-video'
  AND pm.credit_cost = COALESCE(
    CAST(JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.source_credit_cost')) AS DECIMAL(18,6)),
    GREATEST(1, ROUND(CAST(JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.source_points_cost')) AS DECIMAL(18,6)))));

INSERT INTO provider_models
  (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
   generation_endpoint, query_endpoint, credit_cost, billing_unit, credit_multiplier,
   max_reference_images, supports_reference_video, supports_real_person, supports_async_tasks,
   sort_order, description, status, parameter_schema_json, config_json)
SELECT UUID(), p.id, 'wan3.0-video', 'Wan 3.0 官', 'Wan 3.0 官', 'VIDEO_GENERATION',
       'allaiin_rest', '/video/generations', '/tasks/{task_id}',
       GREATEST(1, CEIL((3 * 0.10) / NULLIF(pricing.cny_per_credit, 0))),
       'PER_SECOND', 1.000000, 30, TRUE, FALSE, TRUE, 100,
       '慧心 AI Wan 3.0 官方通道，支持 4～30 秒、480P/720P/1080P、多模态参考；参考视频费用翻倍。', 'ACTIVE',
       JSON_ARRAY(
         JSON_OBJECT('name', 'prompt', 'label', '提示词', 'type', 'textarea', 'required', TRUE),
         JSON_OBJECT('name', 'size', 'label', '视频比例', 'type', 'select', 'required', FALSE,
           'options', JSON_ARRAY('9:16', '16:9', '3:4', '4:3', '1:1')),
         JSON_OBJECT('name', 'seconds', 'label', '视频时长', 'type', 'select', 'required', TRUE,
           'options', JSON_ARRAY(4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30)),
         JSON_OBJECT('name', 'resolution', 'label', '分辨率', 'type', 'select', 'required', TRUE,
           'options', JSON_ARRAY('480P', '720P', '1080P')),
         JSON_OBJECT('name', 'count', 'label', '生成数量', 'type', 'select', 'required', FALSE, 'options', JSON_ARRAY(1,2,3,4)),
         JSON_OBJECT('name', 'reference_image', 'label', '参考图', 'type', 'upload', 'required', FALSE),
         JSON_OBJECT('name', 'reference_images', 'label', '多张参考图', 'type', 'upload', 'required', FALSE, 'description', '最多 30 张公网图片 URL。'),
         JSON_OBJECT('name', 'reference_video', 'label', '参考视频', 'type', 'upload', 'required', FALSE, 'description', '最多 5 段；参考视频费用翻倍。'),
         JSON_OBJECT('name', 'reference_videos', 'label', '多个参考视频', 'type', 'upload', 'required', FALSE),
         JSON_OBJECT('name', 'reference_audio', 'label', '参考音频', 'type', 'upload', 'required', FALSE, 'description', '最多 5 段，不能作为唯一参考输入。'),
         JSON_OBJECT('name', 'reference_audios', 'label', '多个参考音频', 'type', 'upload', 'required', FALSE)
       ),
       JSON_OBJECT(
         'source', 'allaiin_api_center', 'docs_url', 'https://ailingg.store/api-center',
         'remote_numeric_id', 69, 'request_model_name', 'Wan 3.0 官', 'remote_model_id', 'wan3.0-video',
         'reference_image_mode', 'reference_images',
         'video_duration_options', JSON_ARRAY(4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30),
         'aspect_ratio_options', JSON_ARRAY('9:16', '16:9', '3:4', '4:3', '1:1'),
         'manual_resolution_pricing', TRUE, 'reference_video_credit_multiplier', 2,
         'source_points_by_resolution', JSON_OBJECT('480P', 1.5, '720P', 3, '1080P', 6),
         'source_points_cost', 3, 'source_point_cny', 0.10,
         'source_credit_cost', GREATEST(1, CEIL((3 * 0.10) / NULLIF(pricing.cny_per_credit, 0))),
         'source_cny_per_credit', pricing.cny_per_credit,
         'credit_cost_note', '按 API 中心预置每秒档位价，参考视频费用翻倍；基础目录不含分辨率报价，自动同步保留后台定价。'
       )
FROM providers p
INNER JOIN model_credit_pricing_config pricing ON pricing.id = 1
WHERE LOWER(p.code) = 'allaiin'
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name), model_alias = VALUES(model_alias), capability = VALUES(capability),
  api_protocol = VALUES(api_protocol), generation_endpoint = VALUES(generation_endpoint), query_endpoint = VALUES(query_endpoint),
  billing_unit = VALUES(billing_unit), max_reference_images = VALUES(max_reference_images), supports_reference_video = VALUES(supports_reference_video),
  supports_real_person = VALUES(supports_real_person), supports_async_tasks = VALUES(supports_async_tasks), description = VALUES(description),
  parameter_schema_json = VALUES(parameter_schema_json),
  config_json = JSON_MERGE_PATCH(COALESCE(provider_models.config_json, JSON_OBJECT()), VALUES(config_json));

INSERT IGNORE INTO provider_model_resolution_prices (provider_model_id, resolution, credit_cost, sort_order)
SELECT pm.id, rates.resolution, GREATEST(1, CEIL((rates.points * 0.10) / NULLIF(pricing.cny_per_credit, 0))), rates.sort_order
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
INNER JOIN model_credit_pricing_config pricing ON pricing.id = 1
CROSS JOIN (SELECT '480P' resolution, 1.5 points, 0 sort_order UNION ALL SELECT '720P', 3, 1 UNION ALL SELECT '1080P', 6, 2) rates
WHERE pm.model_code = 'wan3.0-video' AND pm.capability = 'VIDEO_GENERATION'
  AND NOT EXISTS (SELECT 1 FROM provider_model_resolution_prices rp WHERE rp.provider_model_id = pm.id AND LOWER(rp.resolution) = LOWER(rates.resolution));

INSERT INTO ai_default_media_models (capability, provider_model_id, sort_order, recommended)
SELECT 'VIDEO_GENERATION', pm.id,
       COALESCE((SELECT MAX(configured.sort_order) + 10 FROM ai_default_media_models configured WHERE configured.capability = 'VIDEO_GENERATION'), pm.sort_order), FALSE
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
WHERE pm.model_code = 'wan3.0-video' AND pm.capability = 'VIDEO_GENERATION'
ON DUPLICATE KEY UPDATE provider_model_id = VALUES(provider_model_id);
