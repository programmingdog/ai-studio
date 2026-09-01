ALTER TABLE withdrawal_applications
  ADD COLUMN processing_by CHAR(36) NULL,
  ADD COLUMN processing_at DATETIME(3) NULL,
  ADD CONSTRAINT fk_withdrawal_processing_admin FOREIGN KEY (processing_by) REFERENCES admin_users(id);
