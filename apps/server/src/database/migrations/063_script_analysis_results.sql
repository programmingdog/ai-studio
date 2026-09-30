CREATE TABLE script_analysis_results (
  task_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  analysis_json LONGTEXT NOT NULL,
  normalized_script LONGTEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (task_id),
  KEY idx_script_analysis_results_user (user_id),
  CONSTRAINT fk_script_analysis_results_task FOREIGN KEY (task_id) REFERENCES ai_tasks(id) ON DELETE CASCADE,
  CONSTRAINT fk_script_analysis_results_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
