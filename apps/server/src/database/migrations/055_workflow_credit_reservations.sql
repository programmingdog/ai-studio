-- Reserve the complete, user-confirmed automatic-workflow budget up front.
-- Each media task atomically transfers its item from this reservation into a
-- normal credit hold, so concurrent submissions cannot fail halfway through
-- a workflow whose displayed total was affordable.
ALTER TABLE workflow_quote_approvals
  ADD COLUMN reserved_credits DECIMAL(20,6) NOT NULL DEFAULT 0 AFTER status;

-- Preserve resumability for workflows that were already active during the
-- upgrade. Active provider tasks already have their own credit hold, while
-- unsubmitted or safely released items return to the workflow reservation.
UPDATE workflow_quote_approvals qa
LEFT JOIN (
  SELECT qi.approval_id,
         COALESCE(SUM(CASE
           WHEN qi.current_task_id IS NULL THEN qi.credits
           WHEN t.status IN ('FAILED', 'CANCELED')
             AND NOT EXISTS (
               SELECT 1 FROM credit_holds ch
               WHERE ch.task_id = qi.current_task_id AND ch.status = 'ACTIVE'
             ) THEN qi.credits
           ELSE 0
         END), 0) AS pending_credits
  FROM workflow_quote_items qi
  LEFT JOIN ai_tasks t ON t.id = qi.current_task_id
  GROUP BY qi.approval_id
) pending ON pending.approval_id = qa.id
SET qa.reserved_credits = COALESCE(pending.pending_credits, 0)
WHERE qa.status = 'ACTIVE' AND qa.expires_at > CURRENT_TIMESTAMP(3);
