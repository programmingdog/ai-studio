const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildFinancialReport } = require("../dist/admin/admin.service.js");

test("financial report subtracts model cost and all commissions without double-subtracting payouts", () => {
  const report = buildFinancialReport([{ date: "2026-09-16", cash_revenue_fen: 10000, recognized_revenue_fen: 8000,
    model_cost_fen: 3000, commission_fen: 1000, payout_fen: 700, consumed_credits: 800,
    consumption_count: 4, paid_orders: 2, unpriced_credits: 0, unpriced_records: 0 }], new Date("2026-09-16T08:00:00Z"));
  assert.equal(report.periods.today.gross_profit_fen, 5000);
  assert.equal(report.periods.today.net_profit_fen, 4000);
  assert.equal(report.periods.today.payout_fen, 700);
  assert.equal(report.periods.today.cash_revenue_fen, 10000);
});

test("financial migration snapshots value and cost on every consumption record", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../src/database/migrations/051_financial_accounting_snapshots.sql"), "utf8");
  assert.match(sql, /revenue_cny_per_credit/);
  assert.match(sql, /cost_credits/);
  assert.match(sql, /INNER JOIN ai_tasks/);
  assert.match(sql, /category = 'SCRIPT_LIBRARY'/);
});
