INSERT INTO provider_models
  (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
   generation_endpoint, query_endpoint, credit_cost, billing_unit, credit_multiplier,
   max_reference_images, supports_reference_video, supports_real_person,
   supports_async_tasks, sort_order, description, status, parameter_schema_json, config_json)
SELECT UUID(), p.id, 'tt-image-2.5', 'TT Image 2.5', 'TT Image 2.5',
       'IMAGE_GENERATION', 'lingkeai_media', '/v1/media/generate',
       '/v1/skills/task-status', 4, 'PER_REQUEST', 1.000000, 16, 0, 0, 1, 5,
       'TT Image 2.5 图片生成与编辑模型，支持文生图、1～16 张参考图、1K/2K/4K、透明背景。',
       'ACTIVE',
       JSON_ARRAY(
         JSON_OBJECT('name', 'prompt', 'label', '提示词', 'type', 'textarea', 'required', TRUE),
         JSON_OBJECT('name', 'images', 'label', '参考图', 'type', 'upload', 'required', FALSE,
           'description', '支持 1～16 张参考图；不传时为纯文生图。'),
         JSON_OBJECT('name', 'version', 'label', '模型版本', 'type', 'select', 'required', TRUE,
           'options', JSON_ARRAY(
             JSON_OBJECT('value', 'flare', 'label', '标准版'),
             JSON_OBJECT('value', 'sunburst', 'label', '增强版')
           )),
         JSON_OBJECT('name', 'aspect_ratio', 'label', '画面比例', 'type', 'select', 'required', FALSE,
           'options', JSON_ARRAY(
             JSON_OBJECT('value', 'auto', 'label', '自适应'),
             JSON_OBJECT('value', '1:1', 'label', '1:1'),
             JSON_OBJECT('value', '16:9', 'label', '16:9'),
             JSON_OBJECT('value', '9:16', 'label', '9:16'),
             JSON_OBJECT('value', '4:3', 'label', '4:3'),
             JSON_OBJECT('value', '3:4', 'label', '3:4'),
             JSON_OBJECT('value', '3:2', 'label', '3:2'),
             JSON_OBJECT('value', '2:3', 'label', '2:3'),
             JSON_OBJECT('value', '5:4', 'label', '5:4'),
             JSON_OBJECT('value', '4:5', 'label', '4:5'),
             JSON_OBJECT('value', '2:1', 'label', '2:1'),
             JSON_OBJECT('value', '1:2', 'label', '1:2'),
             JSON_OBJECT('value', '21:9', 'label', '21:9'),
             JSON_OBJECT('value', '9:21', 'label', '9:21')
           )),
         JSON_OBJECT('name', 'resolution', 'label', '分辨率', 'type', 'select', 'required', TRUE,
           'options', JSON_ARRAY(
             JSON_OBJECT('value', 'auto', 'label', '自适应'),
             JSON_OBJECT('value', '1K', 'label', '1K'),
             JSON_OBJECT('value', '2K', 'label', '2K'),
             JSON_OBJECT('value', '4K', 'label', '4K')
           )),
         JSON_OBJECT('name', 'quality', 'label', '质量', 'type', 'select', 'required', FALSE,
           'options', JSON_ARRAY(
             JSON_OBJECT('value', 'auto', 'label', '自适应'),
             JSON_OBJECT('value', 'low', 'label', '低'),
             JSON_OBJECT('value', 'medium', 'label', '中'),
             JSON_OBJECT('value', 'high', 'label', '高'),
             JSON_OBJECT('value', 'xhigh', 'label', '超高'),
             JSON_OBJECT('value', 'max', 'label', '最高')
           )),
         JSON_OBJECT('name', 'background', 'label', '背景', 'type', 'select', 'required', FALSE,
           'options', JSON_ARRAY(
             JSON_OBJECT('value', 'opaque', 'label', '不透明'),
             JSON_OBJECT('value', 'transparent', 'label', '透明'),
             JSON_OBJECT('value', 'auto', 'label', '自适应')
           )),
         JSON_OBJECT('name', 'size', 'label', '自定义尺寸', 'type', 'input', 'required', FALSE)
       ),
       JSON_OBJECT(
         'source', 'wagaai_skills_api',
         'source_type', 'image',
         'input_hint', '支持纯文生图或 1～16 张参考图；标准版优先使用最低可用价格。',
         'credit_cost_note', '每次消耗积分数；初始成本按当前最低 ¥0.036 和系统 ¥0.01/积分向上取整为 4 积分，后续由实时价格同步更新。',
         'generation_parameters_by_resolution', JSON_OBJECT(
           '1K', JSON_OBJECT('version', 'flare', 'resolution', '1K'),
           '2K', JSON_OBJECT('version', 'flare', 'resolution', '2K'),
           '4K', JSON_OBJECT('version', 'flare', 'resolution', '4K')
         )
       )
FROM providers p
WHERE LOWER(p.code) = 'wagaai'
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
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
  parameter_schema_json = VALUES(parameter_schema_json),
  config_json = JSON_MERGE_PATCH(COALESCE(provider_models.config_json, JSON_OBJECT()), VALUES(config_json));

INSERT IGNORE INTO provider_model_resolution_prices
  (provider_model_id, resolution, credit_cost, sort_order)
SELECT pm.id, tiers.resolution, 4, tiers.sort_order
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'wagaai'
CROSS JOIN (
  SELECT '1K' AS resolution, 0 AS sort_order
  UNION ALL SELECT '2K', 1
  UNION ALL SELECT '4K', 2
) tiers
WHERE pm.model_code = 'tt-image-2.5'
  AND pm.capability = 'IMAGE_GENERATION';
