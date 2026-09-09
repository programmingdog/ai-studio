const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

test('desktop reads product branding and localizes Chinese versus other interface languages', () => {
  const brand = readFileSync(join(__dirname, '../src/brand/index.tsx'), 'utf8');
  const platform = readFileSync(join(__dirname, '../src/services/platform.ts'), 'utf8');
  const account = readFileSync(join(__dirname, '../src/components/AccountCenterModal.tsx'), 'utf8');
  assert.match(platform, /\/client-config\/product-brand/);
  assert.match(brand, /locale === "zh-CN" \|\| locale === "zh-TW"/);
  assert.match(brand, /setTitle\(productName\)/);
  assert.match(account, /`登录 \$\{productName\}`/);
  assert.doesNotMatch(account, /登录 AI Video Studio/);
});

test('native client and published installer consistently use the 逐梦帧 name', () => {
  const tauri = JSON.parse(readFileSync(join(__dirname, '../src-tauri/tauri.conf.json'), 'utf8'));
  const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
  const tray = readFileSync(join(__dirname, '../src-tauri/src/tray.rs'), 'utf8');
  const release = readFileSync(join(__dirname, '../../../tools/release.ps1'), 'utf8');
  assert.equal(tauri.productName, '逐梦帧');
  assert.equal(tauri.mainBinaryName, '逐梦帧');
  assert.equal(tauri.app.windows[0].title, '逐梦帧');
  assert.equal(tauri.identifier, 'studio.aivideo.desktop');
  assert.match(html, /<title>逐梦帧<\/title>/);
  assert.match(tray, /逐梦帧 · 当前没有运行中的任务/);
  assert.equal((release.match(/\$baseName = "逐梦帧-\$Version-x64-setup"/g) || []).length, 2);
});
