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
  assert.match(update, /check\(\{[\s\S]*timeout: 15_000/);
  assert.doesNotMatch(update, /downloadAndInstall\([\s\S]*timeout:/);
  assert.match(update, /typeof cause === "string"/);
  assert.match(update, /rawJson\.mandatory/);
  assert.equal(tauri.bundle.createUpdaterArtifacts, true);
  assert.match(tauri.plugins.updater.endpoints[0], /\{\{current_version\}\}/);
  assert.ok(capability.permissions.includes("updater:default"));
  assert.ok(capability.permissions.includes("process:default"));
});

test("renamed NSIS installer migrates legacy installations without deleting user data", () => {
  const tauri = JSON.parse(readFileSync(join(desktop, "src-tauri/tauri.conf.json"), "utf8"));
  const hooks = readFileSync(join(desktop, "src-tauri/installer-hooks.nsh"), "utf8");
  const app = readFileSync(join(desktop, "src/App.tsx"), "utf8");
  const registry = readFileSync(join(desktop, "src-tauri/src/project/registry.rs"), "utf8");
  const session = readFileSync(join(desktop, "src-tauri/src/platform_session.rs"), "utf8");
  assert.equal(tauri.identifier, "studio.aivideo.desktop");
  assert.equal(tauri.bundle.windows.nsis.installerHooks, "installer-hooks.nsh");
  assert.match(hooks, /DetectLegacyInstall "影匠"/);
  assert.match(hooks, /StrCpy \$INSTDIR \$LegacyInstallDir/);
  assert.match(hooks, /uninstall\.exe\" \/UPDATE \/P/);
  assert.match(hooks, /DeleteRegKey SHCTX "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\$LegacyProductName"/);
  assert.doesNotMatch(hooks, /APPDATA|LOCALAPPDATA|AI Video Studio Projects/);
  assert.match(app, /C:\\\\AI Video Studio Projects/);
  assert.match(registry, /C:\\AI Video Studio Projects/);
  assert.match(session, /AI Video Studio Platform Session/);
});

test("client no longer renders top-right log buttons", () => {
  const app = readFileSync(join(desktop, "src/App.tsx"), "utf8");
  assert.doesNotMatch(app, />\s*日志\s*<\/button>/);
  assert.doesNotMatch(app, /onOpenLogs/);
  assert.doesNotMatch(app, /setShowApplicationLogs/);
});
