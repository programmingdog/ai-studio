-- MiniMax H3 官默认分辨率修正为 768P。
-- 059 已在部分环境执行，保留其历史校验值，通过本迁移完成增量修正。
UPDATE provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
SET pm.description = REPLACE(pm.description, '720P 视频', '768P 视频'),
    pm.parameter_schema_json = JSON_SET(
      pm.parameter_schema_json,
      '$[3].options', JSON_ARRAY('768P')
    ),
    pm.config_json = JSON_SET(
      COALESCE(pm.config_json, JSON_OBJECT()),
      '$.default_resolution', '768P'
    )
WHERE pm.model_code = 'minimax-h3-official'
  AND pm.capability = 'VIDEO_GENERATION';

INSERT INTO provider_model_resolution_prices
  (provider_model_id, resolution, credit_cost, sort_order)
SELECT pm.id, '768P', pm.credit_cost, 0
FROM provider_models pm
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
WHERE pm.model_code = 'minimax-h3-official'
  AND pm.capability = 'VIDEO_GENERATION'
ON DUPLICATE KEY UPDATE
  credit_cost = VALUES(credit_cost),
  sort_order = VALUES(sort_order);

DELETE rp
FROM provider_model_resolution_prices rp
INNER JOIN provider_models pm ON pm.id = rp.provider_model_id
INNER JOIN providers p ON p.id = pm.provider_id AND LOWER(p.code) = 'allaiin'
WHERE pm.model_code = 'minimax-h3-official'
  AND pm.capability = 'VIDEO_GENERATION'
  AND rp.resolution = '720P';
