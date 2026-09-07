UPDATE providers
SET adapter_type = 'lingkeai',
    base_url = 'https://api.lk888.ai',
    config_json = JSON_SET(
      COALESCE(config_json, JSON_OBJECT()),
      '$.base_url_verified', TRUE,
      '$.guide_endpoint', '/v1/skills/guide',
      '$.model_catalog_source', '/v1/skills/models',
      '$.balance_endpoint', '/v1/skills/balance',
      '$.media_generation_endpoint', '/v1/media/generate',
      '$.task_query_endpoint', '/v1/skills/task-status'
    )
WHERE LOWER(code) = 'wagaai';

UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id
SET pm.api_protocol = 'lingkeai_media',
    pm.generation_endpoint = '/v1/media/generate',
    pm.query_endpoint = '/v1/skills/task-status',
    pm.supports_async_tasks = 1
WHERE LOWER(p.code) = 'wagaai'
  AND pm.capability IN ('IMAGE_GENERATION', 'VIDEO_GENERATION');

UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id
SET pm.api_protocol = 'gemini',
    pm.generation_endpoint = '/v1beta/models/{model}:generateContent',
    pm.query_endpoint = NULL,
    pm.supports_async_tasks = 0
WHERE LOWER(p.code) = 'wagaai'
  AND pm.model_code = 'gem-3.7-flash'
  AND pm.capability IN ('TEXT_GENERATION', 'VIDEO_UNDERSTANDING');

UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id
SET pm.api_protocol = 'openai',
    pm.generation_endpoint = '/v1/chat/completions',
    pm.query_endpoint = NULL,
    pm.supports_async_tasks = 0
WHERE LOWER(p.code) = 'wagaai'
  AND pm.model_code IN ('kimi-k2.6', 'glm-5.3-flash')
  AND pm.capability = 'TEXT_GENERATION';
