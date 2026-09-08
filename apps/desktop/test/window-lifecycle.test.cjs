const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.join(__dirname, '..');
const tauriConfig = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
const capability = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'src-tauri/capabilities/default.json'), 'utf8'));
const appSource = fs.readFileSync(path.join(desktopRoot, 'src/App.tsx'), 'utf8');
const rustSource = fs.readFileSync(path.join(desktopRoot, 'src-tauri/src/lib.rs'), 'utf8');
const mainSource = fs.readFileSync(path.join(desktopRoot, 'src-tauri/src/main.rs'), 'utf8');
const cargo = fs.readFileSync(path.join(desktopRoot, 'src-tauri/Cargo.toml'), 'utf8');
const lifecycleSource = fs.readFileSync(path.join(desktopRoot, 'src/components/DesktopWindowLifecycle.tsx'), 'utf8');
const traySource = fs.readFileSync(path.join(desktopRoot, 'src-tauri/src/tray.rs'), 'utf8');
const mediaToolsSource = fs.readFileSync(path.join(desktopRoot, 'src-tauri/src/media_tools.rs'), 'utf8');
const workerSource = fs.readFileSync(path.join(desktopRoot, 'src-tauri/src/worker/python.rs'), 'utf8');

test('desktop starts with a compact centered login window', () => {
  const window = tauriConfig.app.windows[0];
  assert.deepEqual(
    { width: window.width, height: window.height, center: window.center, maximized: window.maximized, resizable: window.resizable },
    { width: 560, height: 720, center: true, maximized: false, resizable: false },
  );
  assert.equal(window.minWidth, 520);
  assert.equal(window.minHeight, 640);
});

test('authenticated app uses 80 percent of the current screen and centers; logout restores the centered login size', () => {
  for (const fragment of ['currentMonitor()', 'monitor?.workArea.size.toLogical(monitor.scaleFactor)', '* 0.8', 'appWindow.unmaximize()', 'new LogicalSize(560, 720)', 'appWindow.center()', 'appWindow.setResizable(false)']) {
    assert.ok(appSource.includes(fragment), `missing window transition: ${fragment}`);
  }
  assert.equal(appSource.includes('appWindow.maximize()'), false);
  for (const permission of ['core:window:allow-center', 'core:window:allow-current-monitor', 'core:window:allow-unmaximize', 'core:window:allow-set-size']) {
    assert.ok(capability.permissions.includes(permission), `missing capability: ${permission}`);
  }
});

test('official Windows installer is per-machine and the runtime is single-instance', () => {
  assert.equal(tauriConfig.bundle.windows.nsis.installMode, 'perMachine');
  assert.match(cargo, /tauri-plugin-single-instance\s*=\s*"2"/);
  assert.match(rustSource, /tauri_plugin_single_instance::init/);
  assert.match(rustSource, /get_webview_window\("main"\)/);
});

test('packaged Windows app and bundled command-line tools do not open console windows', () => {
  assert.match(mainSource, /cfg_attr\(not\(debug_assertions\), windows_subsystem = "windows"\)/);
  assert.match(mediaToolsSource, /CREATE_NO_WINDOW/);
  assert.match(workerSource, /media_tools::background_command/);
});

test('client version comes from Tauri and is shown at the bottom left only', () => {
  assert.match(appSource, /getVersion\(\)/);
  assert.match(appSource, /当前客户端版本/);
  assert.equal(appSource.includes('Local-first'), false);
  assert.equal(appSource.includes('V0.3'), false);
});

test('close asks whether to exit or hide, and tray double click restores the window', () => {
  assert.match(lifecycleSource, /onCloseRequested/);
  assert.match(lifecycleSource, /直接退出/);
  assert.match(lifecycleSource, /隐藏到系统托盘/);
  assert.match(lifecycleSource, /set_tray_status/);
  assert.match(traySource, /TrayIconEvent::DoubleClick/);
  assert.match(traySource, /window\.show\(\)/);
  assert.match(traySource, /set_tooltip/);
  assert.ok(capability.permissions.includes('core:window:allow-hide'));
});
