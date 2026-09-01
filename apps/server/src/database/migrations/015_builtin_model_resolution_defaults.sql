-- Correct the initial resolution labels of the built-in fixed-format models.
INSERT IGNORE INTO provider_model_resolution_prices (provider_model_id, resolution, credit_cost, sort_order)
SELECT rp.provider_model_id, '768P', rp.credit_cost, rp.sort_order
FROM provider_model_resolution_prices rp INNER JOIN provider_models pm ON pm.id = rp.provider_model_id
WHERE pm.model_code = 'hailuo-h3-cankaosheng' AND rp.resolution = '720p';

DELETE rp FROM provider_model_resolution_prices rp INNER JOIN provider_models pm ON pm.id = rp.provider_model_id
WHERE pm.model_code = 'hailuo-h3-cankaosheng' AND rp.resolution = '720p';

INSERT IGNORE INTO provider_model_resolution_prices (provider_model_id, resolution, credit_cost, sort_order)
SELECT rp.provider_model_id, 'default', rp.credit_cost, rp.sort_order
FROM provider_model_resolution_prices rp INNER JOIN provider_models pm ON pm.id = rp.provider_model_id
WHERE pm.model_code = 'omni_flash-10s' AND rp.resolution = '720p';

DELETE rp FROM provider_model_resolution_prices rp INNER JOIN provider_models pm ON pm.id = rp.provider_model_id
WHERE pm.model_code = 'omni_flash-10s' AND rp.resolution = '720p';
