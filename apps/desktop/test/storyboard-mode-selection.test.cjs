const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
const modeBuilder = fs.readFileSync(path.join(__dirname, '../src/videoUnderstandingModes.ts'), 'utf8');
const agent = fs.readFileSync(path.join(__dirname, '../src-tauri/src/agent.rs'), 'utf8');

test('video understanding mode highlights only the selected option', () => {
  assert.match(app, /storyboard-mode-option\$\{selectedMode === "standard" \? " active" : ""\}/);
  assert.doesNotMatch(app, /storyboard-mode-option recommended/);
  assert.doesNotMatch(styles, /storyboard-mode-option\.recommended/);
});

test('fixed-duration mode is the first and default video understanding option', () => {
  assert.match(app, /useState<StoryboardUnderstandingMode>\("fixed"\)/);
  const options = app.slice(app.indexOf('<div className="storyboard-mode-options">'), app.indexOf('</div>', app.indexOf('<div className="storyboard-mode-options">')));
  assert.ok(options.indexOf('固定秒数模式') < options.indexOf('标准模式'));
  assert.ok(options.indexOf('标准模式') < options.indexOf('逐秒分镜模式'));
});

test('link storyboard generation asks for a recommended fast URL mode or detailed upload mode', () => {
  assert.match(app, /useState<VideoSubmissionMode>\("url"\)/);
  assert.match(app, /<strong>极速模式<\/strong><em>推荐<\/em>/);
  assert.match(app, /<strong>详细模式<\/strong>/);
  assert.match(app, /极速模式可能生成失败/);
  assert.match(app, /video_submission_mode: submissionMode/);
});

test('fixed-duration mode also fixes the final shot and carries the rule into project parsing', () => {
  assert.match(modeBuilder, /最后一个分镜也不例外/);
  assert.match(modeBuilder, /生成时长：\$\{seconds\}秒/);
  assert.doesNotMatch(modeBuilder, /最后一段不足\$\{seconds\}秒时按真实剩余时长输出/);
  assert.match(app, /storyboard_fixed_seconds: review\.fixedSeconds/);
  assert.match(agent, /"storyboard_fixed_seconds": fixed_seconds/);
});

test('video parsing action uses the immediate-generation label', () => {
  assert.match(app, /"立即生成分镜"/);
  assert.doesNotMatch(app, /"后台生成分镜"/);
});
