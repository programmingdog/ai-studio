const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const backend = fs.readFileSync(path.join(__dirname, '../src/services/backend.ts'), 'utf8');
const commands = fs.readFileSync(path.join(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
const tasks = fs.readFileSync(path.join(__dirname, '../src-tauri/src/douyin_tasks.rs'), 'utf8');

test('completed link-understanding tasks expose reparse beside their result action', () => {
  assert.match(app, /variant === "link" && task\.status === "COMPLETED" && onReparse/);
  assert.match(app, /查看结果[\s\S]*重新解析/);
  assert.match(app, /重新解析会再次调用视频理解模型并消耗相应积分/);
  assert.match(app, /delete next\[taskId\]/);
});

test('retry and reparse loading ids only remain active while their mutations are pending', () => {
  assert.match(app, /retryingTaskId=\{retryDouyinTask\.isPending \? retryDouyinTask\.variables : undefined\}/);
  assert.match(app, /retryingTaskId=\{retryLocalVideoTask\.isPending \? retryLocalVideoTask\.variables : undefined\}/);
  assert.match(app, /reparsingTaskId=\{reparseDouyinTask\.isPending \? reparseDouyinTask\.variables : undefined\}/);
  assert.doesNotMatch(app, /retryingTaskId=\{retryDouyinTask\.variables\}/);
});

test('reparse is a dedicated command restricted to completed link tasks', () => {
  assert.match(backend, /invoke<DouyinUnderstandingTask>\("reparse_douyin_understanding_task", \{ taskId \}\)/);
  assert.match(commands, /douyin_tasks::reparse_douyin_understanding_task/);
  assert.match(tasks, /pub fn reparse_douyin_understanding_task/);
  assert.match(tasks, /source_kind = 'LINK' AND status = 'COMPLETED'/);
  assert.match(tasks, /spawn_task\(app\.clone\(\), task_id\.clone\(\)\)/);
});
