ALTER TABLE provider_credentials
  ADD COLUMN last_selected_at DATETIME(3) NULL AFTER status;

ALTER TABLE ai_tasks
  ADD COLUMN provider_credential_id CHAR(36) NULL AFTER provider_model_id,
  ADD COLUMN workflow_quote_approval_id CHAR(36) NULL AFTER provider_credential_id,
  ADD COLUMN workflow_quote_item_key VARCHAR(191) NULL AFTER workflow_quote_approval_id,
  ADD KEY idx_ai_tasks_credential_status (provider_credential_id, status),
  ADD CONSTRAINT fk_ai_tasks_credential FOREIGN KEY (provider_credential_id) REFERENCES provider_credentials(id) ON DELETE SET NULL;

ALTER TABLE task_attempts
  ADD COLUMN provider_credential_id CHAR(36) NULL AFTER provider_model_id,
  ADD KEY idx_task_attempts_credential_status (provider_credential_id, status),
  ADD CONSTRAINT fk_task_attempts_credential FOREIGN KEY (provider_credential_id) REFERENCES provider_credentials(id) ON DELETE SET NULL;

-- Legacy tasks did not record their exact Key, so do not fabricate a binding.
-- Every task created after this migration persists the selected credential.

CREATE TABLE IF NOT EXISTS workflow_quote_approvals (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_workflow_quote_approvals_user_status (user_id, status, expires_at),
  CONSTRAINT fk_workflow_quote_approvals_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS workflow_quote_items (
  approval_id CHAR(36) NOT NULL,
  item_key VARCHAR(191) NOT NULL,
  provider_model_id CHAR(36) NOT NULL,
  capability VARCHAR(64) NOT NULL,
  resolution VARCHAR(64) NOT NULL,
  seconds DECIMAL(12,3) NULL,
  credits DECIMAL(20,6) NOT NULL,
  current_task_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (approval_id, item_key),
  KEY idx_workflow_quote_items_task (current_task_id),
  CONSTRAINT fk_workflow_quote_items_approval FOREIGN KEY (approval_id) REFERENCES workflow_quote_approvals(id) ON DELETE CASCADE,
  CONSTRAINT fk_workflow_quote_items_model FOREIGN KEY (provider_model_id) REFERENCES provider_models(id),
  CONSTRAINT fk_workflow_quote_items_task FOREIGN KEY (current_task_id) REFERENCES ai_tasks(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
