const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const native = fs.readFileSync(path.join(__dirname, '../src-tauri/src/ai.rs'), 'utf8');
const records = fs.readFileSync(path.join(__dirname, '../src-tauri/src/database/generation_records.rs'), 'utf8');
const media = fs.readFileSync(path.join(__dirname, '../src-tauri/src/platform_media.rs'), 'utf8');
const schemas = fs.readFileSync(path.join(__dirname, '../../../packages/schemas/src/index.ts'), 'utf8');

test('failed workflow shots expose original-model restart and new-model regeneration', () => {
  const restart = app.slice(app.indexOf('const retryShotVideo ='), app.indexOf('const closeWorkflowStart ='));
  const modal = app.slice(app.indexOf('function AutoProjectWorkflowModal('), app.indexOf('function StoryPage('));
  assert.match(modal, /onRetryShotVideo/);
  assert.match(app, /单独重启/);
  assert.match(app, /重新生成/);
  assert.ok(modal.indexOf('单独重启') < modal.indexOf('重新生成'));
  assert.match(restart, /lockSelection: true/);
  assert.match(restart, /requestMediaModel\("VIDEO_GENERATION"/);
  assert.match(restart, /mediaVideoDuration\(selection/);
  assert.match(restart, /createShotVideoGeneration/);
  assert.match(app, /停止并重新生成/);
  assert.match(app, /新任务会再次消耗积分/);
  assert.match(app, /replace_record_id: replaceRecordId/);
  assert.match(app, /status !== "FAILED"/);
});

test('automatic workflow retries each failed shot three times and persists the counter', () => {
  const runner = app.slice(app.indexOf('const runAutomaticWorkflow ='), app.indexOf('const stopAutomaticWorkflow ='));
  assert.match(app, /const AUTO_SHOT_VIDEO_RETRY_LIMIT = 3/);
  assert.match(runner, /videoRetryCounts\[record\.target_id\].*AUTO_SHOT_VIDEO_RETRY_LIMIT/);
  assert.match(runner, /videoRetryCounts\[record\.target_id\] = \(videoRetryCounts\[record\.target_id\] \?\? 0\) \+ 1/);
  assert.match(runner, /const submitVideoInputs = async[\s\S]*Promise\.allSettled\(prepared\.map/);
  assert.match(runner, /const retryInputs = failedRecords\.map/);
  assert.match(runner, /submitVideoInputs\(createVideoInputs\(retryInputs\)\)/);
  assert.match(runner, /stopForExhaustedVideoRetries/);
  assert.match(runner, /status: "CANCELLED"/);
  assert.match(runner, /video_retry_counts/);
  assert.match(schemas, /video_retry_counts\?: Record<string, number>/);
});

test('opening a running workflow survives the asynchronous resume hydration', () => {
  const resume = app.slice(app.indexOf('const active = activeWorkflowQuery.data;'), app.indexOf('const hasRunningWorkflow'));
  assert.match(resume, /setWorkflow\(\(current\) => \(\{/);
  assert.match(resume, /visible: current\.visible/);
  assert.doesNotMatch(resume, /visible: false/);
});

test('replacement cancels the old record transactionally and ignores late results', () => {
  assert.match(native, /let transaction = connection\.transaction\(\)/);
  assert.match(native, /cancel_video\(&transaction, replace_id\)/);
  assert.match(native, /transaction\.commit\(\)/);
  assert.match(native, /sender\.send\(true\)/);
  assert.match(records, /if record\.status == STATUS_CANCELLED/);
  assert.match(records, /AND status != 'CANCELLED'/);
});

test('uncertain submissions keep recovering the original idempotent task', () => {
  assert.match(media, /PLATFORM_TASK_RECOVERY_PENDING/);
  assert.match(media, /persisted_request_id = Some\(receipt\.request_id\)/);
  assert.match(media, /"idempotency_key": format!\("desktop-media-\{local_task_id\}"\)/);
  assert.doesNotMatch(media.slice(media.indexOf('async fn recover_request'), media.indexOf('async fn wait_for_result')), /workflow_credit::error/);
  assert.match(native, /task_recovery_pending_error\(&message\)[\s\S]*mark_recovery_pending/);
  assert.match(records, /暂时查不到已提交任务的结果/);
});
