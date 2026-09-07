UPDATE ai_default_model_config dc
INNER JOIN provider_models pm ON pm.id = dc.text_model_id
INNER JOIN providers p ON p.id = pm.provider_id
SET dc.text_model_id = NULL
WHERE p.code = 'wagaai' AND pm.model_code IN ('tt-5.6-luna', 'tt-5.6-sol');

UPDATE ai_default_model_config dc
INNER JOIN provider_models pm ON pm.id = dc.video_understanding_model_id
INNER JOIN providers p ON p.id = pm.provider_id
SET dc.video_understanding_model_id = NULL
WHERE p.code = 'wagaai' AND pm.model_code = 'gem-3.7-flash';

UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id
SET pm.status = 'DISABLED'
WHERE p.code = 'wagaai' AND pm.model_code IN ('tt-5.6-luna', 'tt-5.6-sol');

INSERT INTO provider_models
  (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
   generation_endpoint, query_endpoint, credit_cost, max_reference_images,
   supports_reference_video, supports_real_person, supports_async_tasks, sort_order,
   description, status, parameter_schema_json, config_json)
SELECT UUID(), p.id, model.model_code, model.display_name, model.model_alias,
       'TEXT_GENERATION', model.api_protocol, model.generation_endpoint, NULL, 1, 0,
       0, 0, 0, model.sort_order, model.description, 'ACTIVE', JSON_ARRAY(),
       JSON_OBJECT('source', 'builtin_wagaai_text_catalog')
FROM providers p
JOIN (
  SELECT 'gem-3.7-flash' AS model_code, 'GEM 3.7 Flash' AS display_name,
         'GEM 3.7 Flash' AS model_alias, 'gemini' AS api_protocol,
         '/v1beta/models/{model}:generateContent' AS generation_endpoint, 10 AS sort_order,
         'WagaAI GEM 3.7 Flash 文本生成模型' AS description
  UNION ALL
  SELECT 'kimi-k2.6', 'Kimi 2.6', 'Kimi 2.6', 'openai',
         '/v1/chat/completions', 20, 'WagaAI Kimi 2.6 文本生成模型'
  UNION ALL
  SELECT 'glm-5.3-flash', 'GLM-5.3 Flash', 'GLM-5.3 Flash', 'openai',
         '/v1/chat/completions', 30, 'WagaAI GLM-5.3 Flash 文本生成模型'
) model
WHERE p.code = 'wagaai'
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  model_alias = VALUES(model_alias),
  capability = VALUES(capability),
  api_protocol = VALUES(api_protocol),
  generation_endpoint = VALUES(generation_endpoint),
  query_endpoint = VALUES(query_endpoint),
  max_reference_images = VALUES(max_reference_images),
  supports_reference_video = VALUES(supports_reference_video),
  supports_real_person = VALUES(supports_real_person),
  supports_async_tasks = VALUES(supports_async_tasks),
  sort_order = VALUES(sort_order),
  description = VALUES(description),
  status = VALUES(status);
