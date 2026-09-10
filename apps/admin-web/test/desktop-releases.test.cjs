const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

test("admin includes immutable signed desktop release management", () => {
  const app = readFileSync(join(__dirname, "../components/AdminApp.tsx"), "utf8");
  const panel = readFileSync(join(__dirname, "../components/DesktopReleasePanel.tsx"), "utf8");
  assert.match(app, /client-releases/);
  assert.match(app, /label: "下载与版本"/);
  assert.match(app, /label: "版本发布"/);
  assert.match(panel, /\/admin\/desktop-releases/);
  assert.match(panel, /Windows x64/);
  assert.match(panel, /macOS Apple Silicon/);
  assert.match(panel, /最低可运行版本/);
  assert.match(panel, /发布后版本号、更新包与签名将不可修改/);
  assert.match(panel, /编辑更新说明/);
  assert.match(panel, /desktop-releases\/\$\{release\.id\}\/notes/);
});
