const assert = require("node:assert/strict");
const test = require("node:test");
const { buildThirtyDayOverviewTrends } = require("../dist/admin/admin.service");

test("dashboard trends contain exactly 30 China-calendar days and fill missing dates", () => {
  const result = buildThirtyDayOverviewTrends(
    [
      { date_key: "2026-08-05", value: "1250", count: "2" },
      { date_key: "2026-09-03", value: "880", count: "1" },
    ],
    [
      { date_key: "2026-08-05", value: "2" },
      { date_key: "2026-09-03", value: "1" },
    ],
    12,
    new Date("2026-09-02T17:00:00.000Z"),
  );
  assert.equal(result.revenue_trend.length, 30);
  assert.equal(result.user_growth_trend.length, 30);
  assert.equal(result.revenue_trend[0].date, "2026-08-05");
  assert.equal(result.revenue_trend[29].date, "2026-09-03");
  assert.deepEqual(result.revenue_trend[1], { date: "2026-08-06", revenue_fen: 0, paid_orders: 0 });
  assert.equal(result.revenue_trend[0].revenue_fen, 1250);
  assert.equal(result.user_growth_trend[0].total_users, 11);
  assert.equal(result.user_growth_trend[29].total_users, 12);
});
