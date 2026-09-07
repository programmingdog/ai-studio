const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const desktop = join(__dirname, "..");

test("desktop checks for signed updates on startup and supports mandatory upgrades", () => {
  const main = readFileSync(join(desktop, "src/main.tsx"), "utf8");
  const update = readFileSync(join(desktop, "src/components/DesktopUpdateHost.tsx"), "utf8");
  const tauri = JSON.parse(readFileSync(join(desktop, "src-tauri/tauri.conf.json"), "utf8"));
  const capability = JSON.parse(readFileSync(join(desktop, "src-tauri/capabilities/default.json"), "utf8"));
  assert.match(main, /<DesktopUpdateHost/);
  assert.match(update, /checkForUpdate\(\)/);
  assert.match(update, /downloadAndInstall/);
  assert.match(update, /rawJson\.mandatory/);
  assert.equal(tauri.bundle.createUpdaterArtifacts, true);
  assert.match(tauri.plugins.updater.endpoints[0], /\{\{current_version\}\}/);
  assert.ok(capability.permissions.includes("updater:default"));
  assert.ok(capability.permissions.includes("process:default"));
});

test("client no longer renders top-right log buttons", () => {
  const app = readFileSync(join(desktop, "src/App.tsx"), "utf8");
  assert.doesNotMatch(app, />\s*日志\s*<\/button>/);
  assert.doesNotMatch(app, /onOpenLogs/);
  assert.doesNotMatch(app, /setShowApplicationLogs/);
});
