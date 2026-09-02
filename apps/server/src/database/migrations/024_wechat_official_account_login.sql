ALTER TABLE wechat_payment_configs
  ADD COLUMN wechatpay_public_key_ciphertext MEDIUMTEXT NULL AFTER platform_certificate_uploaded_at,
  ADD COLUMN wechatpay_public_key_filename VARCHAR(255) NULL AFTER wechatpay_public_key_ciphertext,
  ADD COLUMN wechatpay_public_key_id VARCHAR(128) NOT NULL DEFAULT '' AFTER wechatpay_public_key_filename,
  ADD COLUMN wechatpay_public_key_uploaded_at DATETIME(3) NULL AFTER wechatpay_public_key_id,
  ADD COLUMN official_account_token_ciphertext TEXT NULL AFTER app_secret_hint,
  ADD COLUMN official_account_token_hint VARCHAR(64) NOT NULL DEFAULT '' AFTER official_account_token_ciphertext,
  ADD COLUMN official_account_encoding_aes_key_ciphertext TEXT NULL AFTER official_account_token_hint,
  ADD COLUMN official_account_encoding_aes_key_hint VARCHAR(64) NOT NULL DEFAULT '' AFTER official_account_encoding_aes_key_ciphertext,
  ADD COLUMN official_account_callback_url VARCHAR(500) NOT NULL DEFAULT '' AFTER official_account_encoding_aes_key_hint;
