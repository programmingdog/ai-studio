ALTER TABLE mail_service_configs
  ADD COLUMN delivery_method VARCHAR(16) NOT NULL DEFAULT 'HTTP' AFTER api_url,
  ADD COLUMN smtp_host VARCHAR(253) NOT NULL DEFAULT 'mail.yuntianxing.net' AFTER delivery_method,
  ADD COLUMN smtp_port SMALLINT UNSIGNED NOT NULL DEFAULT 25 AFTER smtp_host,
  ADD COLUMN smtp_security VARCHAR(16) NOT NULL DEFAULT 'STARTTLS' AFTER smtp_port;
