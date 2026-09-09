const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const picker = fs.readFileSync(path.join(__dirname, '../src/components/WorkflowStartModal.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('a stopped automatic workflow exposes a restart action in the modal footer', () => {
  const modal = section(app, 'function AutoProjectWorkflowModal(', 'function StoryPage(');
  assert.match(modal, /state\.cancelled && <button className="primary-button"[^>]*onClick=\{onRestart\}/);
  assert.match(modal, /重启工作流/);
  assert.ok(modal.indexOf('onClick={onClose}') < modal.indexOf('onClick={onRestart}'));
});

test('restart opens a locked model picker with a fresh exact credit quote', () => {
  assert.match(picker, /重启自动制作工作流/);
  assert.match(picker, /重新选择生成模型，只继续制作尚未完成的内容/);
  assert.match(picker, /disabled=\{busy \|\| restart\}/);
  assert.match(picker, /重启所需积分/);
  assert.match(picker, /确认并重启/);
  assert.match(picker, /services\.getMediaCreditQuote/);
});

test('restart creates a new run and continues only unfinished inactive media', () => {
  const start = section(app, 'const startAutoWorkflow =', 'useEffect(() => {');
  assert.match(start, /const restarting = Boolean\(restartWorkflowId\)/);
  assert.match(start, /!restarting && \(imageTasks\.some\(activeImageTask\) \|\| records\.some\(activeGeneration\)\)/);
  assert.match(start, /approve_workflow_credit/);
  assert.match(start, /createAutomaticWorkflow\([^]*mode: selectedMode/);
  assert.match(start, /正在重启自动制作工作流并检查未完成任务/);

  const planned = section(app, 'const planned: PlannedMedia[] = [', 'return <div className="story-page-layout">');
  assert.match(planned, /!activeImageTask\(latestTargetTask/);
  assert.match(planned, /!records\.some\(record=>record\.media_type==="video"[^]*activeGeneration\(record\)\)/);
});

test('every automatic workflow media region exposes a failed-task restart action', () => {
  const modal = section(app, 'function AutoProjectWorkflowModal(', 'function StoryPage(');
  for (const region of ['scenes', 'characters', 'shot-images', 'shot-videos', 'composition']) {
    assert.match(modal, new RegExp(`retryButton\\("${region}",`));
  }
  assert.match(modal, /重启失败任务/);
  assert.match(modal, /disabled = state\.running \|\| Boolean\(retryingRegion\) \|\| failedCount === 0/);
});

test('region restart only recreates latest failed tasks with a fresh scoped credit approval', () => {
  const retry = section(app, 'const retryFailedWorkflowRegion =', 'const closeWorkflowStart =');
  assert.match(retry, /task\?\.status === "FAILED"/);
  assert.match(retry, /latest\?\.status === "FAILED"/);
  assert.match(retry, /requestMediaModel\("IMAGE_GENERATION"/);
  assert.match(retry, /requestMediaModel\("VIDEO_GENERATION"/);
  assert.match(retry, /createImageGenerationTasks/);
  assert.match(retry, /createShotVideoGeneration/);
  assert.match(retry, /composeProjectVideo/);
});

test('failed workflow cards reveal the complete error on hover', () => {
  const modal = section(app, 'function AutoProjectWorkflowModal(', 'function StoryPage(');
  assert.match(modal, /className=\{failed \? "auto-workflow-task-error" : undefined\}/);
  assert.match(modal, /title=\{failed \? message : undefined\}/);
  assert.match(styles, /\.auto-workflow-task > div:nth-child\(2\) \.auto-workflow-task-error:hover[^}]*-webkit-line-clamp: unset/);
});
