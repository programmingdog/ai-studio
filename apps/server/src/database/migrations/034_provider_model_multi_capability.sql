ALTER TABLE provider_models
  DROP INDEX uq_provider_models_code,
  ADD UNIQUE KEY uq_provider_models_code_capability (provider_id, model_code, capability);

INSERT INTO provider_models
  (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
   generation_endpoint, query_endpoint, credit_cost, max_reference_images,
   supports_reference_video, supports_real_person, supports_async_tasks, sort_order,
   description, status, parameter_schema_json, config_json)
SELECT UUID(), pm.provider_id, pm.model_code, pm.display_name,
       'GEM 3.7 Flash 视频理解', 'VIDEO_UNDERSTANDING', pm.api_protocol,
       pm.generation_endpoint, NULL, pm.credit_cost, 0, 1, 0, 0, 10,
       'WagaAI GEM 3.7 Flash 视频理解模型', 'ACTIVE',
       pm.parameter_schema_json, pm.config_json
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id
WHERE p.code = 'wagaai'
  AND pm.model_code = 'gem-3.7-flash'
  AND pm.capability = 'TEXT_GENERATION'
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  model_alias = VALUES(model_alias),
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

UPDATE ai_default_model_config dc
INNER JOIN provider_models pm
  ON pm.capability = 'VIDEO_UNDERSTANDING'
 AND pm.model_code = 'gem-3.7-flash'
INNER JOIN providers p ON p.id = pm.provider_id AND p.code = 'wagaai'
SET dc.video_understanding_model_id = pm.id
WHERE dc.id = 1 AND dc.video_understanding_model_id IS NULL;
