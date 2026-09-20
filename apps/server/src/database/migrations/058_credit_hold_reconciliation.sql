-- Repair historical credit reservations that can otherwise make the client
-- show a negative available balance. This migration is intentionally
-- idempotent in its calculations: active workflow reservations are rebuilt
-- from their item state instead of being incremented.

ALTER TABLE workflow_quote_approvals
  ADD COLUMN display_name VARCHAR(191) NULL AFTER reserved_credits;

UPDATE workflow_quote_approvals
SET status = 'EXPIRED', reserved_credits = 0
WHERE status = 'ACTIVE' AND expires_at <= CURRENT_TIMESTAMP(3);

UPDATE credit_holds ch
INNER JOIN ai_tasks t ON t.id = ch.task_id
SET ch.status = 'RELEASED'
WHERE ch.status = 'ACTIVE' AND t.status IN ('FAILED', 'CANCELED');

UPDATE workflow_quote_approvals qa
LEFT JOIN (
  SELECT qi.approval_id,
         COALESCE(SUM(CASE
           WHEN qi.current_task_id IS NULL THEN qi.credits
           WHEN t.status IN ('FAILED', 'CANCELED')
             AND NOT EXISTS (
               SELECT 1 FROM credit_holds ch
               WHERE ch.task_id = qi.current_task_id AND ch.status IN ('ACTIVE', 'CAPTURED')
             ) THEN qi.credits
           ELSE 0
         END), 0) AS pending_credits
  FROM workflow_quote_items qi
  LEFT JOIN ai_tasks t ON t.id = qi.current_task_id
  GROUP BY qi.approval_id
) pending ON pending.approval_id = qa.id
SET qa.reserved_credits = COALESCE(pending.pending_credits, 0)
WHERE qa.status = 'ACTIVE' AND qa.expires_at > CURRENT_TIMESTAMP(3);
