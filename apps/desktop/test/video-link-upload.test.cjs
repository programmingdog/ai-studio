const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tasks = fs.readFileSync(path.join(__dirname, '../src-tauri/src/douyin_tasks.rs'), 'utf8');
const platformUnderstanding = fs.readFileSync(path.join(__dirname, '../src-tauri/src/platform_video_understanding.rs'), 'utf8');
const serverGateway = fs.readFileSync(path.join(__dirname, '../../server/src/gateway/model-gateway.service.ts'), 'utf8');
const start = tasks.indexOf('fn spawn_task(');
const end = tasks.indexOf('fn spawn_local_task(', start);
assert.notEqual(start, -1, 'missing link video task');
assert.notEqual(end, -1, 'missing local video task boundary');
const linkTask = tasks.slice(start, end);

test('link understanding supports both direct URL and validated upload submission modes', () => {
  assert.match(linkTask, /resolve_link_video/);
  assert.match(linkTask, /"resolving"/);
  assert.match(linkTask, /video_submission_mode == "url"/);
  assert.match(linkTask, /understand_public_url_confirmed/);
  assert.match(linkTask, /download_douyin_auto/);
  assert.match(linkTask, /download_douyin\(/);
  assert.match(linkTask, /compress_video_for_inline_analysis/);
  assert.match(linkTask, /probe_video_metadata/);
  assert.match(linkTask, /understand_uploaded_file_confirmed/);
  assert.match(linkTask, /"fallback"/);
  assert.match(linkTask, /极速模式失败或超时/);
});

test('temporary source and compressed video copies are cleaned after analysis', () => {
  assert.match(linkTask, /remove_file\(&downloaded_path\)/);
  assert.match(linkTask, /remove_file\(&compressed_path\)/);
});

test('video understanding provider calls have a server-owned ten minute deadline', () => {
  assert.match(serverGateway, /providerTimeoutMs: 10 \* 60_000/);
  assert.match(platformUnderstanding, /timeout\(Duration::from_secs\(10 \* 60 \+ 15\)\)/);
  assert.match(platformUnderstanding, /idempotency_key/);
});

test('fast understanding progress only describes the active work', () => {
  assert.match(linkTask, /"fast_analyzing",\s*0\.24,\s*"正在分析理解视频"/s);
  assert.doesNotMatch(linkTask, /极速模式：正在理解视频并生成分镜，最长等待 10 分钟/);
});
