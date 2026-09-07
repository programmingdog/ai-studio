const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

test("configuration center exposes IP/CIDR rule management", () => {
  const component = readFileSync(join(__dirname, "../components/IpAccessRulesPanel.tsx"), "utf8");
  const app = readFileSync(join(__dirname, "../components/AdminApp.tsx"), "utf8");
  assert.match(component, /\/admin\/configs\/ip-access-rules/);
  assert.match(component, /IP 地址或 CIDR 网段/);
  assert.match(component, /className="ip-access-submit"/);
  assert.match(component, /method: "PATCH"/);
  assert.match(component, /method: "DELETE"/);
  assert.match(app, /<IpAccessRulesPanel token=\{token\}/);
});

test("admin sign-in uses product-facing copy instead of architecture terms", () => {
  const app = readFileSync(join(__dirname, "../components/AdminApp.tsx"), "utf8");
  const loginScreen = app.slice(app.indexOf("function LoginScreen"), app.indexOf("function OverviewPanel"));
  assert.match(loginScreen, /让每一个灵感/);
  assert.match(loginScreen, /今天的灵感，就是明天的作品/);
  assert.doesNotMatch(loginScreen, /服务端|模块化单体|MySQL|零媒体存储/);
});

test("admin overview contains business-facing copy and no architecture status footer", () => {
  const app = readFileSync(join(__dirname, "../components/AdminApp.tsx"), "utf8");
  const overview = readFileSync(join(__dirname, "../components/DashboardOverview.tsx"), "utf8");
  assert.doesNotMatch(app, /className="sidebar-foot"/);
  assert.match(app, /<DashboardOverview token=\{token\}/);
  assert.match(overview, /运营驾驶舱/);
  assert.match(overview, /用户增长/);
  assert.match(overview, /创作任务/);
  assert.doesNotMatch(overview, /服务端|管理后台建设中|模块化单体|SERVER MEDIA FILES|客户端核心不动/);
});

test("admin profile exposes an authenticated password change dialog", () => {
  const app = readFileSync(join(__dirname, "../components/AdminApp.tsx"), "utf8");
  const dialog = app.slice(app.indexOf("function ChangePasswordModal"), app.indexOf("function ChangePasswordScreen"));
  assert.match(app, />修改密码<\/button>/);
  assert.match(app, /<ChangePasswordModal token=\{token\}/);
  assert.match(dialog, /\/admin\/auth\/change-password/);
  assert.match(dialog, /当前密码/);
  assert.match(dialog, /确认新密码/);
  assert.match(dialog, /minLength=\{12\}/);
  assert.match(dialog, /两次输入的新密码不一致/);
  assert.match(dialog, /密码修改成功/);
});
