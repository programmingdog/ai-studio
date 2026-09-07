ALTER TABLE distribution_configs
  ADD COLUMN windows_download_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER invite_page_base_url,
  ADD COLUMN macos_download_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER windows_download_url;

UPDATE distribution_configs
SET windows_download_enabled = CASE WHEN windows_download_url <> '' THEN 1 ELSE 0 END,
    macos_download_enabled = CASE WHEN macos_download_url <> '' THEN 1 ELSE 0 END
WHERE id = 1;

ALTER TABLE client_auth_method_configs
  ADD COLUMN registration_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER id;
