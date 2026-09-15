-- WagaAI Vidu Q3 Turbo 参考生：文生/多图参考有声视频，按分辨率每秒计费。
INSERT INTO provider_models
  (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
   generation_endpoint, query_endpoint, credit_cost, billing_unit, max_reference_images,
   supports_reference_video, supports_real_person, supports_async_tasks, sort_order,
   description, status, parameter_schema_json, config_json)
SELECT UUID(), p.id, 'viduq3-turbo-cankaosheng', 'Vidu Q3 Turbo 参考生', 'Vidu Q3 Turbo 参考生',
       'VIDEO_GENERATION', 'lingkeai_media', '/v1/media/generate', '/v1/skills/task-status',
       15, 'PER_SECOND', 7, FALSE, FALSE, TRUE, 75,
       'Vidu Q3 Turbo 参考生极速有声视频模型，支持纯文生视频或 1～7 张主体参考图、540P/720P/1080P、3～16 秒。',
       'ACTIVE',
       JSON_ARRAY(
         JSON_OBJECT('name', 'prompt', 'label', '提示词', 'type', 'textarea', 'required', TRUE),
         JSON_OBJECT('name', 'images', 'label', '参考图', 'type', 'upload', 'required', FALSE,
           'description', '可选上传 1～7 张主体参考图；不传时按提示词生成视频。'),
         JSON_OBJECT('name', 'resolution', 'label', '分辨率', 'type', 'radio', 'required', TRUE,
           'options', JSON_ARRAY(
             JSON_OBJECT('value', '540p', 'label', '540P'),
             JSON_OBJECT('value', '720p', 'label', '720P'),
             JSON_OBJECT('value', '1080p', 'label', '1080P')
           )),
         JSON_OBJECT('name', 'duration', 'label', '视频时长', 'type', 'radio', 'required', TRUE,
           'options', JSON_ARRAY(
             JSON_OBJECT('value', '3', 'label', '3 秒'),
             JSON_OBJECT('value', '4', 'label', '4 秒'),
             JSON_OBJECT('value', '5', 'label', '5 秒'),
             JSON_OBJECT('value', '6', 'label', '6 秒'),
             JSON_OBJECT('value', '7', 'label', '7 秒'),
             JSON_OBJECT('value', '8', 'label', '8 秒'),
             JSON_OBJECT('value', '9', 'label', '9 秒'),
             JSON_OBJECT('value', '10', 'label', '10 秒'),
             JSON_OBJECT('value', '11', 'label', '11 秒'),
             JSON_OBJECT('value', '12', 'label', '12 秒'),
             JSON_OBJECT('value', '13', 'label', '13 秒'),
             JSON_OBJECT('value', '14', 'label', '14 秒'),
             JSON_OBJECT('value', '15', 'label', '15 秒'),
             JSON_OBJECT('value', '16', 'label', '16 秒')
           )),
         JSON_OBJECT('name', 'aspect_ratio', 'label', '画面比例', 'type', 'radio', 'required', TRUE,
           'options', JSON_ARRAY(
             JSON_OBJECT('value', '9:16', 'label', '竖屏 9:16'),
             JSON_OBJECT('value', '16:9', 'label', '横屏 16:9'),
             JSON_OBJECT('value', '3:4', 'label', '竖向 3:4'),
             JSON_OBJECT('value', '4:3', 'label', '横向 4:3'),
             JSON_OBJECT('value', '1:1', 'label', '正方形 1:1')
           )),
         JSON_OBJECT('name', 'off_peak', 'label', '错峰模式', 'type', 'switch', 'required', FALSE,
           'options', JSON_ARRAY(
             JSON_OBJECT('value', 'false', 'label', '关闭'),
             JSON_OBJECT('value', 'true', 'label', '开启')
           ))
       ),
       JSON_OBJECT(
         'source', 'wagaai_skills_api',
         'source_type', 'video',
         'input_hint', '支持纯文生视频或 1～7 张主体参考图，输出带声音的视频。',
         'video_duration_options', JSON_ARRAY(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16),
         'aspect_ratio_options', JSON_ARRAY('9:16', '16:9', '3:4', '4:3', '1:1'),
         'generation_parameters_by_resolution', JSON_OBJECT(
           '540p', JSON_OBJECT('resolution', '540p', 'off_peak', 'false'),
           '720p', JSON_OBJECT('resolution', '720p', 'off_peak', 'false'),
           '1080p', JSON_OBJECT('resolution', '1080p', 'off_peak', 'false')
         ),
         'credit_cost_note', '每秒消耗积分数；初始按正常时段价格 ¥0.144/¥0.228/¥0.276 与系统 ¥0.01/积分向上取整，后续由实时价格同步更新。'
       )
FROM providers p
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
SELECT pm.id, tiers.resolution, tiers.credit_cost, tiers.sort_order
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'wagaai'
CROSS JOIN (
  SELECT '540p' AS resolution, 15 AS credit_cost, 0 AS sort_order
  UNION ALL SELECT '720p', 23, 1
  UNION ALL SELECT '1080p', 28, 2
) AS tiers
WHERE pm.model_code = 'viduq3-turbo-cankaosheng'
  AND pm.capability = 'VIDEO_GENERATION';
