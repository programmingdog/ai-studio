const assert = require("node:assert/strict");
const test = require("node:test");
const { allaiinPointsToCredits, previousAllaiinSyncedCredits } = require("../dist/scripts/allaiin-credit-pricing.js");

test("AllAIIn points convert through CNY and the configured system credit ratio", () => {
  assert.equal(allaiinPointsToCredits(8, 0.01), 80);
  assert.equal(allaiinPointsToCredits(8, 0.05), 16);
  assert.equal(allaiinPointsToCredits(0.3, 0.01), 3);
  assert.equal(allaiinPointsToCredits(0, 0.01), 1);
  assert.throws(() => allaiinPointsToCredits(-1, 0.01), /价格无效/);
});

test("the old raw-point baseline can be refreshed while later manual prices stay distinct", () => {
  assert.equal(previousAllaiinSyncedCredits({ source_points_cost: 8 }), 8);
  assert.equal(previousAllaiinSyncedCredits({ source_points_cost: 0 }), 1);
  assert.equal(previousAllaiinSyncedCredits({ source_points_cost: 8, source_credit_cost: 80 }), 80);
  assert.equal(previousAllaiinSyncedCredits({}), null);
});
