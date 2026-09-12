const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const native = fs.readFileSync(path.join(__dirname, '../src-tauri/src/ai.rs'), 'utf8');
const records = fs.readFileSync(path.join(__dirname, '../src-tauri/src/database/generation_records.rs'), 'utf8');

test('workflow exposes per-shot retry and warns before replacing an active video', () => {
  assert.match(app, /canRetry \|\| canReplace/);
  assert.match(app, /单独重启/);
  assert.match(app, /停止并重新生成/);
  assert.match(app, /新任务会再次消耗积分/);
  assert.match(app, /replace_record_id: replaceRecordId/);
  assert.match(app, /status !== "FAILED"/);
});

test('replacement cancels the old record transactionally and ignores late results', () => {
  assert.match(native, /let transaction = connection\.transaction\(\)/);
  assert.match(native, /cancel_video\(&transaction, replace_id\)/);
  assert.match(native, /transaction\.commit\(\)/);
  assert.match(native, /sender\.send\(true\)/);
  assert.match(records, /if record\.status == STATUS_CANCELLED/);
  assert.match(records, /AND status != 'CANCELLED'/);
});
