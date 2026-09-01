ALTER TABLE users
  ADD COLUMN balance_fen BIGINT UNSIGNED NOT NULL DEFAULT 0
  COMMENT 'Remaining commission balance in CNY fen: available plus frozen, excluding paid withdrawals';

-- Existing balances are carried forward, never reset or granted again.
UPDATE users u
LEFT JOIN commission_wallets w ON w.user_id = u.id
SET u.balance_fen = COALESCE(w.available_fen, 0) + COALESCE(w.frozen_fen, 0);
