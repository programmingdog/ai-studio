-- 慧心 AI MiniMax H3 官（远端模型 ID 76）：按次计费，支持纯文字和多参考图视频生成。
-- 如果早期模型同步已经按远端 model_id 创建过该模型，先稳定其本地 model_code，保留原记录和路由关系。
UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
LEFT JOIN provider_models stable ON stable.provider_id = pm.provider_id AND stable.model_code = 'minimax-h3-official'
SET pm.model_code = 'minimax-h3-official'
WHERE JSON_UNQUOTE(JSON_EXTRACT(pm.config_json, '$.remote_numeric_id')) = '76'
  AND stable.id IS NULL;

INSERT INTO provider_models
  (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
   generation_endpoint, query_endpoint, credit_cost, billing_unit, credit_multiplier,
   max_reference_images, supports_reference_video, supports_real_person,
   supports_async_tasks, sort_order, description, status, parameter_schema_json, config_json)
SELECT UUID(), p.id, 'minimax-h3-official', 'MiniMax H3 官', 'MiniMax H3 官',
       'VIDEO_GENERATION', 'allaiin_rest', '/video/generations', '/tasks/{task_id}',
       GREATEST(1, CEIL((20 * 0.10) / NULLIF(pricing.cny_per_credit, 0))),
       'PER_REQUEST', 1.000000, 9, TRUE, FALSE, TRUE, 80,
       '慧心 AI MiniMax H3 官方通道，支持纯文字或多参考图生成 720P 视频，时长 4～15 秒。',
       'ACTIVE',
       JSON_ARRAY(
         JSON_OBJECT('name', 'prompt', 'label', '提示词', 'type', 'textarea', 'required', TRUE),
         JSON_OBJECT('name', 'size', 'label', '视频比例', 'type', 'select', 'required', FALSE,
           'options', JSON_ARRAY('16:9', '9:16', '1:1', '3:4', '4:3')),
         JSON_OBJECT('name', 'seconds', 'label', '视频时长', 'type', 'select', 'required', FALSE,
           'options', JSON_ARRAY(4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)),
         JSON_OBJECT('name', 'resolution', 'label', '分辨率', 'type', 'select', 'required', FALSE,
           'options', JSON_ARRAY('720P')),
         JSON_OBJECT('name', 'count', 'label', '生成数量', 'type', 'number', 'required', FALSE,
           'options', JSON_ARRAY(1, 2, 3, 4)),
         JSON_OBJECT('name', 'reference_image', 'label', '参考图', 'type', 'upload', 'required', FALSE),
         JSON_OBJECT('name', 'reference_images', 'label', '多张参考图', 'type', 'upload', 'required', FALSE),
         JSON_OBJECT('name', 'reference_audio', 'label', '参考音频', 'type', 'upload', 'required', FALSE,
           'description', '音频不能作为唯一参考输入。'),
         JSON_OBJECT('name', 'reference_audios', 'label', '多个参考音频', 'type', 'upload', 'required', FALSE),
         JSON_OBJECT('name', 'reference_video', 'label', '参考视频', 'type', 'upload', 'required', FALSE),
         JSON_OBJECT('name', 'reference_videos', 'label', '多个参考视频', 'type', 'upload', 'required', FALSE)
       ),
       JSON_OBJECT(
         'source', 'allaiin_api_center',
         'docs_url', 'https://ailingg.store/api-center',
         'remote_numeric_id', 76,
         'request_model_name', 'MiniMax H3 官',
         'reference_image_mode', 'reference_images',
         'video_duration_options', JSON_ARRAY(4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15),
         'aspect_ratio_options', JSON_ARRAY('16:9', '9:16', '1:1', '3:4', '4:3'),
         'credit_cost_note', '慧心 AI 原始报价为 20 积分/次（1 慧心积分 = ¥0.10）；迁移按当前系统每积分人民币金额换算，后台可再调整。'
       )
FROM providers p
INNER JOIN model_credit_pricing_config pricing ON pricing.id = 1
WHERE LOWER(p.code) = 'allaiin'
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  model_alias = VALUES(model_alias),
  capability = VALUES(capability),
  api_protocol = VALUES(api_protocol),
  generation_endpoint = VALUES(generation_endpoint),
  query_endpoint = VALUES(query_endpoint),
  billing_unit = VALUES(billing_unit),
  max_reference_images = VALUES(max_reference_images),
  supports_reference_video = VALUES(supports_reference_video),
  supports_real_person = VALUES(supports_real_person),
  supports_async_tasks = VALUES(supports_async_tasks),
  sort_order = VALUES(sort_order),
  description = VALUES(description),
  status = VALUES(status),
  parameter_schema_json = VALUES(parameter_schema_json),
  config_json = JSON_MERGE_PATCH(COALESCE(provider_models.config_json, JSON_OBJECT()), VALUES(config_json));

INSERT IGNORE INTO provider_model_resolution_prices
  (provider_model_id, resolution, credit_cost, sort_order)
SELECT pm.id, '720P', pm.credit_cost, 0
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
WHERE pm.model_code = 'minimax-h3-official'
  AND pm.capability = 'VIDEO_GENERATION';

INSERT INTO ai_default_media_models (capability, provider_model_id, sort_order, recommended)
SELECT 'VIDEO_GENERATION', pm.id,
       COALESCE((SELECT MAX(configured.sort_order) + 10 FROM ai_default_media_models configured WHERE configured.capability = 'VIDEO_GENERATION'), pm.sort_order),
       FALSE
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
WHERE pm.model_code = 'minimax-h3-official'
  AND pm.capability = 'VIDEO_GENERATION'
ON DUPLICATE KEY UPDATE provider_model_id = VALUES(provider_model_id);
