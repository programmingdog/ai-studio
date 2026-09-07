const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tasks = fs.readFileSync(path.join(__dirname, '../src-tauri/src/douyin_tasks.rs'), 'utf8');
const start = tasks.indexOf('fn spawn_task(');
const end = tasks.indexOf('fn spawn_local_task(', start);
assert.notEqual(start, -1, 'missing link video task');
assert.notEqual(end, -1, 'missing local video task boundary');
const linkTask = tasks.slice(start, end);

test('link understanding downloads and uploads real video bytes instead of forwarding a temporary CDN URL', () => {
  assert.match(linkTask, /download_douyin_auto/);
  assert.match(linkTask, /download_douyin\(/);
  assert.match(linkTask, /compress_video_for_inline_analysis/);
  assert.match(linkTask, /understand_uploaded_file/);
  assert.doesNotMatch(linkTask, /understand_public_url/);
});

test('temporary source and compressed video copies are cleaned after analysis', () => {
  assert.match(linkTask, /remove_file\(&downloaded_path\)/);
  assert.match(linkTask, /remove_file\(&compressed_path\)/);
});
