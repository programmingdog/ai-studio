ALTER TABLE provider_credentials
  MODIFY COLUMN secret_ref VARCHAR(500) NOT NULL DEFAULT 'database_encrypted',
  ADD COLUMN api_key_ciphertext TEXT NULL AFTER secret_ref,
  ADD COLUMN balance DECIMAL(20,6) NULL AFTER status,
  ADD COLUMN balance_currency VARCHAR(32) NOT NULL DEFAULT 'CREDITS' AFTER balance,
  ADD COLUMN notes VARCHAR(1000) NOT NULL DEFAULT '' AFTER balance_currency,
  ADD COLUMN last_balance_synced_at DATETIME(3) NULL AFTER notes;

CREATE INDEX idx_provider_credentials_provider_status
  ON provider_credentials (provider_id, status);
