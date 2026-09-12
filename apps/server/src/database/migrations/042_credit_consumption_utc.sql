-- Earlier automatic model settlements used CURRENT_TIMESTAMP in the MySQL
-- session time zone, while mysql2 reads DATETIME values as UTC. Preserve the
-- original values so this correction can be audited or reversed if needed.
CREATE TABLE IF NOT EXISTS credit_consumption_time_backup_042 (
  consumption_record_id CHAR(36) NOT NULL PRIMARY KEY,
  original_occurred_at DATETIME(3) NOT NULL,
  offset_minutes SMALLINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO credit_consumption_time_backup_042
  (consumption_record_id, original_occurred_at, offset_minutes)
SELECT ccr.id, ccr.occurred_at,
       TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), CURRENT_TIMESTAMP())
FROM credit_consumption_records ccr
INNER JOIN ai_tasks task ON task.id = ccr.task_id
WHERE ccr.category = 'MODEL_TASK'
  AND ccr.metadata_json IS NULL
  AND task.finished_at IS NOT NULL
  AND ABS(TIMESTAMPDIFF(SECOND, task.finished_at, ccr.occurred_at)) <= 2
  AND TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), CURRENT_TIMESTAMP()) BETWEEN -720 AND 840;

UPDATE credit_consumption_records ccr
INNER JOIN credit_consumption_time_backup_042 backup
  ON backup.consumption_record_id = ccr.id
SET ccr.occurred_at = DATE_SUB(backup.original_occurred_at, INTERVAL backup.offset_minutes MINUTE)
WHERE ccr.occurred_at = backup.original_occurred_at;
