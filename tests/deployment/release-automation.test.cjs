const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '../..');
const script = fs.readFileSync(path.join(root, 'tools/release.ps1'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(root, 'tools/release.config.example.json'), 'utf8'));

test('release automation covers the complete production sequence', () => {
  for (const stage of ['Prepare', 'DeployPlatform', 'BuildClient', 'UploadClient', 'PublishClient', 'Verify', 'Promote']) {
    assert.match(script, new RegExp(`"${stage}"`));
  }
  assert.match(script, /Invoke-Prepare\s*\n\s*Invoke-DeployPlatform\s*\n\s*Test-PlatformHealth\s*\n\s*Invoke-BuildClient\s*\n\s*Invoke-UploadClient\s*\n\s*Invoke-PublishClient\s*\n\s*Invoke-Verify/);
});

test('release automation uses versioned immutable client paths and signed updater artifacts', () => {
  assert.equal(config.remote_client_root, '/var/www/aivs-public/client');
  assert.equal(config.site_origin, 'https://ai-studio.yuntianxing.net');
  assert.match(script, /test ! -e \$remoteDirectory/);
  assert.match(script, /\.nsis\.zip/);
  assert.match(script, /\.nsis\.zip\.sig/);
  assert.match(script, /Get-FileHash/);
});

test('release configuration does not contain secret values', () => {
  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /password|token/i);
  assert.doesNotMatch(serialized, /BEGIN (?:OPENSSH|PRIVATE)/);
  assert.equal(config.publish_update_automatically, true);
  assert.equal(config.initial_rollout_percent, 10);
});

test('production mutations require runtime credentials and configuration is ignored', () => {
  assert.match(script, /AIVS_GITHUB_TOKEN/);
  assert.match(script, /AIVS_ADMIN_PASSWORD/);
  assert.match(script, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(gitignore, /^tools\/release\.config\.json$/m);
});

test('Windows launcher invokes the PowerShell all-stage release', () => {
  const launcher = fs.readFileSync(path.join(root, 'tools/start-release.bat'), 'utf8');
  assert.match(launcher, /pwsh\.exe/);
  assert.match(launcher, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(launcher, /-Stage All -Version "%RELEASE_VERSION%"/);
  assert.doesNotMatch(launcher, /AIVS_(?:GITHUB_TOKEN|ADMIN_PASSWORD)\s*=/);
});

test('release script remains compatible with built-in Windows PowerShell', () => {
  assert.match(script, /^\uFEFF?#requires -Version 5\.1/m);
  assert.doesNotMatch(script, /-SkipHttpErrorCheck/);
  assert.match(script, /Tls12/);
});
