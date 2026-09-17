INSERT INTO provider_models
  (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
   generation_endpoint, query_endpoint, credit_cost, billing_unit, credit_multiplier,
   max_reference_images, supports_reference_video, supports_real_person,
   supports_async_tasks, sort_order, description, status, parameter_schema_json, config_json)
SELECT UUID(), p.id, 'gem-3.8-flash', 'GEM 3.8 Flash', 'GEM 3.8 Flash 视频理解',
       'VIDEO_UNDERSTANDING', 'gemini', '/v1beta/models/{model}:generateContent', NULL,
       1, 'PER_REQUEST', 1.000000, 0, 1, 0, 0, 5,
       'WagaAI GEM 3.8 Flash 多模态视频理解模型，支持长上下文与高速内容分析。',
       'ACTIVE', JSON_ARRAY(),
       JSON_OBJECT(
         'source', 'builtin_wagaai_video_catalog',
         'source_type', 'chat',
         'tags', JSON_ARRAY('multimodal', 'video-understanding', 'long-context'),
         'input_hint', '使用 Gemini contents.parts 格式传入视频和分析提示词。',
         'docs_url', 'https://wagaga.cc/apidoc#model/gem-3.8-flash',
         'credit_cost_note', '每次消耗积分数；初始值为 1，后台人工修改和后续同步均会保留。'
       )
FROM providers p
WHERE LOWER(p.code) = 'wagaai'
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  model_alias = VALUES(model_alias),
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
  config_json = JSON_MERGE_PATCH(COALESCE(provider_models.config_json, JSON_OBJECT()), VALUES(config_json));
