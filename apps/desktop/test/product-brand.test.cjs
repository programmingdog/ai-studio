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
