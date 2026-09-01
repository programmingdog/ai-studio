INSERT INTO providers (
  id,
  code,
  display_name,
  adapter_type,
  base_url,
  status,
  config_json
)
SELECT
  UUID(),
  'wagaai',
  'WagaAI',
  'wagaai',
  'https://configure.invalid/wagaai',
  'DISABLED',
  JSON_OBJECT(
    'setup_status', 'PENDING',
    'base_url_verified', FALSE,
    'credentials_configured', FALSE,
    'model_catalog_configured', FALSE,
    'note', '待补充 WagaAI 官方 API 地址、密钥引用与模型目录后启用'
  )
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM providers WHERE code = 'wagaai'
);
