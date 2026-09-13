import { cnyToCredits } from "../admin/credit-price-calculator";

export const ALLAIIN_POINT_CNY = 0.1;

export function allaiinPointsToCredits(points: number, cnyPerCredit: number): number {
  if (!Number.isFinite(points) || points < 0) throw new Error("AllAIIn 积分价格无效");
  return cnyToCredits(points * ALLAIIN_POINT_CNY, cnyPerCredit);
}

export function previousAllaiinSyncedCredits(config: Record<string, unknown>): number | null {
  const current = Number(config.source_credit_cost);
  if (config.source_credit_cost !== undefined && Number.isSafeInteger(current) && current > 0) return current;
  const legacy = Number(config.source_points_cost);
  if (config.source_points_cost !== undefined && Number.isFinite(legacy) && legacy >= 0) {
    // Before currency conversion, the sync initialized model and tier prices
    // directly from provider points, with a minimum of one system credit.
    return Math.max(1, Math.round(legacy));
  }
  return null;
}
