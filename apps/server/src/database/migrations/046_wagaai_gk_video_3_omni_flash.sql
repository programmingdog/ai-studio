INSERT INTO provider_models
  (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
   generation_endpoint, query_endpoint, credit_cost, billing_unit, credit_multiplier,
   max_reference_images, supports_reference_video, supports_real_person,
   supports_async_tasks, sort_order, description, status, parameter_schema_json, config_json)
SELECT UUID(), p.id, models.model_code, models.display_name, models.model_alias,
       'VIDEO_GENERATION', 'lingkeai_media', '/v1/media/generate', '/v1/skills/task-status',
       models.credit_cost, 'PER_SECOND', 1.000000, models.max_reference_images, 0, 0, 1,
       models.sort_order, models.description, 'ACTIVE', models.parameter_schema_json, models.config_json
FROM providers p
CROSS JOIN (
  SELECT 'gk-video-3' AS model_code, 'GK-video-3' AS display_name, 'GK-video-3' AS model_alias,
         6 AS credit_cost, 1 AS max_reference_images, 15 AS sort_order,
         'GK-video-3 视频生成模型，支持纯文生视频或单张首帧参考图、720P、6/10 秒。' AS description,
         JSON_ARRAY(
           JSON_OBJECT('name', 'prompt', 'label', '提示词', 'type', 'textarea', 'required', TRUE),
           JSON_OBJECT('name', 'images', 'label', '首帧参考图', 'type', 'upload', 'required', FALSE,
             'description', '可选 1 张首帧参考图；不传时为纯文生视频。'),
           JSON_OBJECT('name', 'aspect_ratio', 'label', '画面比例', 'type', 'radio', 'required', TRUE,
             'options', JSON_ARRAY(
               JSON_OBJECT('value', '9:16', 'label', '竖屏 9:16'),
               JSON_OBJECT('value', '16:9', 'label', '横屏 16:9'),
               JSON_OBJECT('value', '2:3', 'label', '竖屏 2:3'),
               JSON_OBJECT('value', '3:2', 'label', '横屏 3:2'),
               JSON_OBJECT('value', '1:1', 'label', '方形 1:1')
             )),
           JSON_OBJECT('name', 'size', 'label', '清晰度', 'type', 'radio', 'required', TRUE,
             'options', JSON_ARRAY(JSON_OBJECT('value', '720P', 'label', '720P'))),
           JSON_OBJECT('name', 'duration', 'label', '视频时长', 'type', 'select', 'required', TRUE,
             'options', JSON_ARRAY(
               JSON_OBJECT('value', '6', 'label', '6 秒'),
               JSON_OBJECT('value', '10', 'label', '10 秒')
             ))
         ) AS parameter_schema_json,
         JSON_OBJECT(
           'source', 'wagaai_skills_api',
           'source_type', 'video',
           'input_hint', '支持纯文生视频，或上传 1 张首帧参考图增强画面控制。',
           'resolution_parameter', 'size',
           'video_duration_options', JSON_ARRAY(6, 10),
           'credit_cost_note', '每秒消耗积分数；初始成本按当前最低 ¥0.06/秒和系统 ¥0.01/积分向上取整为 6 积分/秒，后续由实时价格同步更新。'
         ) AS config_json
  UNION ALL
  SELECT 'omni-flash', 'omni-flash', 'Omni-Flash', 8, 3, 65,
         'Omni-Flash 多模态视频生成模型，支持纯文生视频或 1～3 张参考图、原生音频、4/6/8/10 秒。',
         JSON_ARRAY(
           JSON_OBJECT('name', 'prompt', 'label', '提示词', 'type', 'textarea', 'required', TRUE),
           JSON_OBJECT('name', 'images', 'label', '参考图', 'type', 'upload', 'required', FALSE,
             'description', '可选 1～3 张角色、物体或场景参考图；不传时为纯文生视频。'),
           JSON_OBJECT('name', 'aspect_ratio', 'label', '画面比例', 'type', 'radio', 'required', TRUE,
             'options', JSON_ARRAY(
               JSON_OBJECT('value', '16:9', 'label', '横屏 16:9'),
               JSON_OBJECT('value', '9:16', 'label', '竖屏 9:16')
             )),
           JSON_OBJECT('name', 'duration', 'label', '视频时长', 'type', 'radio', 'required', TRUE,
             'options', JSON_ARRAY(
               JSON_OBJECT('value', '4', 'label', '4 秒'),
               JSON_OBJECT('value', '6', 'label', '6 秒'),
               JSON_OBJECT('value', '8', 'label', '8 秒'),
               JSON_OBJECT('value', '10', 'label', '10 秒')
             )),
           JSON_OBJECT('name', 'enhance_prompt', 'label', '增强提示词', 'type', 'switch', 'required', FALSE,
             'options', JSON_ARRAY(
               JSON_OBJECT('value', 'false', 'label', '关闭'),
               JSON_OBJECT('value', 'true', 'label', '开启')
             )),
           JSON_OBJECT('name', 'enable_upsample', 'label', '视频升采样', 'type', 'switch', 'required', FALSE,
             'options', JSON_ARRAY(
               JSON_OBJECT('value', 'false', 'label', '关闭'),
               JSON_OBJECT('value', 'true', 'label', '开启')
             ))
         ),
         JSON_OBJECT(
           'source', 'wagaai_skills_api',
           'source_type', 'video',
           'input_hint', '支持纯文生视频或 1～3 张多图参考，输出带音频的视频。',
           'fixed_output_resolution', TRUE,
           'video_duration_options', JSON_ARRAY(4, 6, 8, 10),
           'credit_cost_note', '每秒消耗积分数；当前按次价格可线性折算为 ¥0.072/秒，初始按系统 ¥0.01/积分向上取整为 8 积分/秒，后续由实时价格同步更新。'
         )
) models
WHERE LOWER(p.code) = 'wagaai'
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
SELECT pm.id,
       CASE pm.model_code WHEN 'gk-video-3' THEN '720P' ELSE 'default' END,
       pm.credit_cost,
       0
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'wagaai'
WHERE pm.model_code IN ('gk-video-3', 'omni-flash')
  AND pm.capability = 'VIDEO_GENERATION';
