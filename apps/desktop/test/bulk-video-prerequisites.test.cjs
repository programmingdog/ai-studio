const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');

function section(start, end) {
  const startIndex = app.indexOf(start);
  const endIndex = app.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return app.slice(startIndex, endIndex);
}

test('shot video generation requires every scene and character state image', () => {
  const prerequisite = section('function videoAssetPrerequisite(', 'function videoAssetPrerequisiteMessage(');
  assert.match(prerequisite, /canonical\.scenes[\s\S]*preferredProjectAsset/);
  assert.match(prerequisite, /canonical\.characters\.flatMap[\s\S]*characterStates[\s\S]*characterStateImage/);

  const singleGeneration = section('const generateVideo = useMutation({', 'const bulkVideoGeneration = useMutation({');
  assert.match(singleGeneration, /await imageTasks\.refetch\(\)/);
  assert.match(singleGeneration, /videoAssetPrerequisite\(canonical, currentImageTasks\)/);
  assert.ok(singleGeneration.indexOf('if (!prerequisite.ready) throw') < singleGeneration.indexOf('requestMediaModel("VIDEO_GENERATION"'));
});

test('bulk generation and full regeneration always use a fresh model and credit confirmation', () => {
  const bulkGeneration = section('const bulkVideoGeneration = useMutation({', 'const composeVideo = useMutation({');
  const selectionIndex = bulkGeneration.indexOf('await requestMediaModel("VIDEO_GENERATION"');
  assert.ok(selectionIndex >= 0);
  assert.match(bulkGeneration, /mutationFn: async \(mode: BulkVideoGenerationMode\)/);
  assert.match(bulkGeneration, /mode === "regenerate" \? "重新生成所有分镜视频" : "生成所有分镜视频"/);
  assert.match(bulkGeneration, /if \(mode === "regenerate"\) return true/);
  assert.match(bulkGeneration, /mode === "missing" && \(completedRecord \|\| shot\.video_assets\?\.\[0\]\)/);
  assert.ok(bulkGeneration.indexOf('videoAssetPrerequisite(canonical, currentImageTasks)') < selectionIndex);
  assert.ok(bulkGeneration.indexOf('setBulkVideoLaunches(initial)') > selectionIndex);
  assert.ok(bulkGeneration.indexOf('setShowBulkVideoProgress(true)') > selectionIndex);

  const entry = section('const startBulkVideoGeneration = (mode: BulkVideoGenerationMode) => {', 'const bulkVideoBusy =');
  assert.match(entry, /bulkVideoGeneration\.reset\(\)/);
  assert.match(entry, /bulkVideoGeneration\.mutate\(mode\)/);
  assert.doesNotMatch(app, /GenerateAllVideosConfirmModal|showBulkVideoConfirm/);
  assert.match(app, /setSelectedModelId\(""\); setSelectedResolution\(""\); setApprovalError\(""\)/);
  assert.match(app, /queryKey: \["media-model-picker-quotes", request\?\.id/);
});

test('active backend records keep the bulk progress entry available after closing the modal', () => {
  const resolver = section('function shotVideoProgressRecord(', 'function GenerateAllVideosProgressModal(');
  assert.match(resolver, /record\.media_type === "video"/);
  assert.match(resolver, /record\.target_type === "shot"/);
  assert.match(resolver, /matching\.find\(\(record\) => activeGeneration\(record\)\)/);

  const progressModal = section('function GenerateAllVideosProgressModal(', 'function StoryboardPage(');
  assert.match(progressModal, /shotVideoProgressRecord\(records, shot\.id, trackedLaunch\?\.recordId\)/);

  const session = section('const bulkVideoSessionActive =', 'const startBulkVideoGeneration =');
  assert.match(session, /shotVideoProgressRecord\(records, shot\.id, launch\?\.recordId\)/);
  assert.match(session, /if \(activeGeneration\(record\)\) return true/);
  assert.match(session, /\["pending", "creating"\][\s\S]*return bulkVideoGeneration\.isPending/);
  assert.match(session, /\["created", "existing"\][\s\S]*return !record/);
});

test('completed and running projects expose the correct batch video actions', () => {
  assert.match(app, /bulkVideoBusy \|\| hasShotVideoTaskHistory[\s\S]*查看分镜视频任务进度/);
  assert.match(app, /!bulkVideoBusy && allShotVideosReady[\s\S]*重新一键生成所有分镜视频/);
  assert.match(app, /!bulkVideoBusy && !allShotVideosReady[\s\S]*一键生成所有分镜视频/);
  assert.match(app, /RegenerateAllVideosConfirmModal[\s\S]*重新生成全部分镜视频？/);
  assert.match(app, /confirmRegenerateAllVideos[\s\S]*startBulkVideoGeneration\("regenerate"\)/);
  assert.match(app, /showRegenerateAllVideosConfirm && <RegenerateAllVideosConfirmModal/);
});
