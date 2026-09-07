const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const media = fs.readFileSync(path.join(__dirname, '../src-tauri/src/platform_media.rs'), 'utf8');

test('media model picker includes exact quotes, balance and the only user confirmation', () => {
  assert.match(app, /生成方案与积分确认/);
  assert.match(app, /getMediaCreditQuote\(selectedModelId, selectedResolution, item\.seconds\)/);
  assert.match(app, /queryKey: \["credit-balance"\]/);
  assert.match(app, /确认并开始生成（\$\{creditText\(total\)\} 积分）/);
  assert.match(app, /取消，不扣分/);
  assert.match(app, /creditRefundCopy/);
});

test('confirmed picker creates a verified item grant that bypasses the second dialog', () => {
  assert.match(app, /invoke<string>\("approve_workflow_credit"/);
  assert.match(app, /workflowCreditId/);
  assert.match(app, /key: `image:character_state:\$\{state\.id\}`/);
  assert.match(app, /key: `image:scene:\$\{scene\.id\}`/);
  assert.match(app, /key: `image:shot:\$\{selected\.id\}`/);
  assert.match(app, /key: `video:shot:\$\{selected\.id\}`, seconds: selected\.duration/);
  assert.match(media, /if let Some\(\(root, id, key\)\) = &workflow[\s\S]*crate::workflow_credit::reserve/);
  assert.match(media, /else \{ confirmed_quote\(/);
});

test('bulk video confirmation prices only shots that still need generation', () => {
  assert.match(app, /const plannedShots = canonical\.shots\.filter/);
  assert.match(app, /!completed && !active && !shot\.video_assets\?\.\[0\]/);
  assert.match(app, /plannedShots\.map\(\(shot\) => \(\{ key: `video:shot:\$\{shot\.id\}`, seconds: shot\.duration \}\)\)/);
});
