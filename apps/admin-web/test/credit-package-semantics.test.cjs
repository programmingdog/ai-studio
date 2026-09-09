const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('package editor explains that bonus credits do not discount the package price', () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/CreditsPanel.tsx'), 'utf8');
  assert.match(source, /套餐积分（不含赠送）/);
  assert.match(source, /额外赠送积分/);
  assert.match(source, /套餐原价（元，赠送不抵扣）/);
  assert.match(source, /赠送积分只增加支付后的到账积分/);
});
