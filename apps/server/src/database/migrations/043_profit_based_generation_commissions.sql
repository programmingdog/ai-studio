-- Keep the cost and exchange rate accepted when the task was created.
-- Existing in-flight tasks have no reliable cost snapshot and remain non-commissionable.
ALTER TABLE ai_tasks
  ADD COLUMN commission_cost_credits DECIMAL(20,6) NULL AFTER settled_credits,
  ADD COLUMN commission_cny_per_credit DECIMAL(16,6) NULL AFTER commission_cost_credits;

ALTER TABLE distribution_consumption_settlements
  ADD COLUMN cost_credits DECIMAL(20,6) NULL AFTER credits_consumed,
  ADD COLUMN profit_credits DECIMAL(20,6) NULL AFTER cost_credits,
  ADD COLUMN cny_per_credit DECIMAL(16,6) NULL AFTER profit_credits;
