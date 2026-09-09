const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const statusSource = fs.readFileSync(path.join(__dirname, '../src/i18n/statusLabels.ts'), 'utf8');
const statusCompiled = ts.transpileModule(statusSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const statusModule = { exports: {} };
new Function('require', 'module', 'exports', statusCompiled)(require, statusModule, statusModule.exports);
const { localizedStatusLabel } = statusModule.exports;

test('payment statuses follow the selected interface language', () => {
  assert.equal(localizedStatusLabel('CREATED', 'zh-CN'), '待支付');
  assert.equal(localizedStatusLabel('PAID', 'zh-CN'), '已支付');
  assert.equal(localizedStatusLabel('created', 'ja'), '支払い待ち');
  assert.equal(localizedStatusLabel('PAID', 'ja'), '支払い済み');
  assert.equal(localizedStatusLabel('EXPIRED', 'en'), 'Expired');
  assert.equal(localizedStatusLabel('CUSTOM_STATUS', 'ja'), 'CUSTOM_STATUS');
});

test('credit purchase uses a custom portal dialog, server expiry and serialized status refresh', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/AccountCenterModal.tsx'), 'utf8');
  assert.match(source, /createPortal\(<PaymentDialog purchase=\{activePurchase\}/);
  assert.match(source, /Math\.ceil\(\(expiryTime - Date\.now\(\)\) \/ 1000\)/);
  assert.match(source, /setActivePurchase\(current => current \? \{ \.\.\.current, status: "EXPIRED" \}/);
  assert.match(source, /localizedStatusLabel\(effectiveStatus, locale\)/);
  assert.doesNotMatch(source, /activePurchase && <section className="payment-card"/);
});

test('package cards keep bonus credits separate from the package price', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/AccountCenterModal.tsx'), 'utf8');
  assert.match(source, /<strong>\{item\.base_credits\}<small> 积分<\/small><\/strong>/);
  assert.match(source, /额外赠送 \{item\.bonus_credits\}，支付后实得 \{item\.total_credits\}/);
  assert.match(source, /赠送积分额外到账，不抵扣套餐售价/);
  assert.match(source, /\{money\(item\.price_fen\)\} 购买/);
  assert.doesNotMatch(source, /price_fen\s*[-+]\s*item\.bonus_credits/);
});
