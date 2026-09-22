-- MiniMax H3 官对用户展示为 768P，但慧心 API 的分辨率请求枚举为 720P。
-- 保留本地 768P 计费档位，通过模型配置在提交时转换为上游枚举。
UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
SET pm.config_json = JSON_SET(
  COALESCE(pm.config_json, JSON_OBJECT()),
  '$.resolution_mapping', JSON_OBJECT('768P', '720P')
)
WHERE pm.model_code = 'minimax-h3-official'
  AND pm.capability = 'VIDEO_GENERATION';
