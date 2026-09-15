ALTER TABLE ai_default_media_models
  ADD COLUMN recommended BOOLEAN NOT NULL DEFAULT FALSE AFTER sort_order;

-- Preserve the existing client order and choose the first configured model as
-- the initial recommendation for each media capability.
UPDATE ai_default_media_models current_model
INNER JOIN (
  SELECT configured.capability, MIN(configured.provider_model_id) AS provider_model_id
  FROM ai_default_media_models configured
  INNER JOIN (
    SELECT capability, MIN(sort_order) AS first_sort_order
    FROM ai_default_media_models
    GROUP BY capability
  ) first_position ON first_position.capability = configured.capability
    AND first_position.first_sort_order = configured.sort_order
  GROUP BY configured.capability
) first_model ON first_model.capability = current_model.capability
  AND first_model.provider_model_id = current_model.provider_model_id
SET current_model.recommended = TRUE;
