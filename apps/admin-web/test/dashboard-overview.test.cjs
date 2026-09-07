const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

test("dashboard renders all distribution summaries and two 30-day charts", () => {
  const component = readFileSync(join(__dirname, "../components/DashboardOverview.tsx"), "utf8");
  const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
  assert.match(component, /\/admin\/dashboard\/overview/);
  for (const label of ["邀请数据", "分润数据", "提现申请", "打款数据", "每日收入趋势", "每日新增用户"]) {
    assert.match(component, new RegExp(label));
  }
  assert.match(component, /revenue_trend/);
  assert.match(component, /user_growth_trend/);
  assert.match(component, /data\.recent\.invitations/);
  assert.match(component, /data\.recent\.commissions/);
  assert.match(component, /data\.recent\.withdrawals/);
  assert.match(component, /data\.recent\.payouts/);
  assert.match(css, /\.dashboard-content \{[^}]*height: calc\(100vh - 92px\)[^}]*overflow: hidden/);
  assert.match(css, /grid-template-columns: repeat\(4,minmax\(0,1fr\)\)/);
});
