const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const tauriConfig = JSON.parse(fs.readFileSync(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));
const prepareMedia = fs.readFileSync(path.join(desktopRoot, "scripts", "prepare-media-binaries.mjs"), "utf8");
const debugLauncher = fs.readFileSync(path.resolve(desktopRoot, "..", "..", "start-debug.bat"), "utf8");

test("development accepts a PATH yt-dlp launcher without weakening release packaging", () => {
  assert.equal(packageJson.scripts["prepare:media:dev"], "node scripts/prepare-media-binaries.mjs --dev");
  assert.match(tauriConfig.build.beforeDevCommand, /^npm run prepare:media:dev\b/);
  assert.match(tauriConfig.build.beforeBuildCommand, /^npm run prepare:media\b/);
  assert.match(prepareMedia, /const developmentMode = process\.argv\.includes\("--dev"\)/);
  assert.match(prepareMedia, /if \(!developmentMode\) return statSync\(path\)\.size > 1_000_000/);
  assert.match(prepareMedia, /execFileSync\(path, \["--version"\]/);
  assert.match(prepareMedia, /pathCommand\(ytDlpFilename\)/);
  assert.match(prepareMedia, /ffmpegLicenseDestination = join\(binariesRoot, "FFMPEG_LICENSE\.txt"\)/);
  assert.match(prepareMedia, /copyFileSync\(ffmpegLicenseSource, ffmpegLicenseDestination\)/);
  assert.match(prepareMedia, /writeFileSync\(ffmpegBuildReadmeDestination/);
});

test("debug launcher loads the Visual Studio C++ environment when needed", () => {
  assert.match(debugLauncher, /setlocal EnableExtensions EnableDelayedExpansion/);
  assert.match(debugLauncher, /where link\.exe/);
  assert.match(debugLauncher, /vswhere\.exe/i);
  assert.match(debugLauncher, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64/);
  assert.match(debugLauncher, /VsDevCmd\.bat/);
  assert.match(debugLauncher, /Desktop development with C\+\+/);
});
