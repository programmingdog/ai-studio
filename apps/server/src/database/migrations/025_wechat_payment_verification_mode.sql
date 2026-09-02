ALTER TABLE wechat_payment_configs
  ADD COLUMN payment_verification_mode VARCHAR(32) NOT NULL DEFAULT 'PLATFORM_CERTIFICATE'
  AFTER wechatpay_public_key_uploaded_at;

UPDATE wechat_payment_configs
SET payment_verification_mode = 'WECHATPAY_PUBLIC_KEY'
WHERE wechatpay_public_key_ciphertext IS NOT NULL;
