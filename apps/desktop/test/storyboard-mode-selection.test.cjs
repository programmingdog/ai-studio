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

test('link storyboard generation prefers the recommended detailed upload mode', () => {
  assert.match(app, /useState<VideoSubmissionMode>\("upload"\)/);
  assert.match(app, /<strong>详细模式<\/strong><em>推荐<\/em>/);
  assert.doesNotMatch(app, /<strong>极速模式<\/strong><em>推荐<\/em>/);
  const submissionOptions = app.slice(app.indexOf('<div className="submission-mode-options">'), app.indexOf('</div>', app.indexOf('<div className="submission-mode-options">')));
  assert.ok(submissionOptions.indexOf('详细模式') < submissionOptions.indexOf('极速模式'));
  assert.match(app, /解析效果更好、稳定性更高/);
  assert.match(app, /解析效果和稳定性不如详细模式/);
  assert.match(app, /等待超过 10 分钟时，会自动切换详细模式重试一次/);
  assert.match(app, /video_submission_mode: submissionMode/);
});

test('fixed-duration mode also fixes the final shot and carries the rule into project parsing', () => {
  assert.match(modeBuilder, /最后一个分镜也不例外/);
  assert.match(modeBuilder, /生成时长：\$\{seconds\}秒/);
  assert.doesNotMatch(modeBuilder, /最后一段不足\$\{seconds\}秒时按真实剩余时长输出/);
  assert.match(app, /storyboard_fixed_seconds: review\.fixedSeconds/);
  assert.match(agent, /"storyboard_fixed_seconds": fixed_seconds/);
});

test('video parsing and storyboard generation use one confirmed background task', () => {
  assert.match(app, /自动识别、解析并生成分镜/);
  assert.match(app, /VideoLinkCreditModal/);
  assert.match(app, /provider_model_id: videoLinkQuote\.data\.provider_model_id/);
  assert.match(app, /expected_credits: videoLinkQuote\.data\.credits/);
  assert.match(app, /setQueryData<DouyinUnderstandingTask\[]>\(\["douyin-understanding-tasks"\]/);
  assert.doesNotMatch(app, /<DouyinResult/);
});

test('free creation sits directly below the video link menu', () => {
  const videoLink = app.indexOf('selectSourceType("DOUYIN_URL")');
  const freeCreation = app.indexOf('onClick={onOpenFreeCreation}', videoLink);
  const localUnderstanding = app.indexOf('selectSourceType("VIDEO_UNDERSTANDING")', videoLink);
  assert.ok(videoLink >= 0 && freeCreation > videoLink && freeCreation < localUnderstanding);
});
