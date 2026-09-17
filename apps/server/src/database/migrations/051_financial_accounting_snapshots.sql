-- Snapshot the RMB value and upstream model cost at consumption time so later
-- pricing changes never rewrite historical revenue and profit.
ALTER TABLE credit_consumption_records
  ADD COLUMN revenue_cny_per_credit DECIMAL(16,6) NULL AFTER credits_consumed,
  ADD COLUMN cost_credits DECIMAL(20,6) NULL AFTER revenue_cny_per_credit,
  ADD KEY idx_credit_consumption_financials (status, occurred_at, revenue_cny_per_credit);

UPDATE credit_consumption_records ccr
INNER JOIN ai_tasks task ON task.id = ccr.task_id
SET ccr.revenue_cny_per_credit = task.commission_cny_per_credit,
    ccr.cost_credits = task.commission_cost_credits
WHERE ccr.category = 'MODEL_TASK'
  AND ccr.status = 'CONFIRMED'
  AND ccr.revenue_cny_per_credit IS NULL;

UPDATE credit_consumption_records ccr
INNER JOIN model_credit_pricing_config pricing ON pricing.id = 1
SET ccr.revenue_cny_per_credit = pricing.cny_per_credit,
    ccr.cost_credits = 0
WHERE ccr.category = 'SCRIPT_LIBRARY'
  AND ccr.status = 'CONFIRMED'
  AND ccr.revenue_cny_per_credit IS NULL;
