const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(desktopRoot, "src", "App.tsx"), "utf8");
const tasks = fs.readFileSync(path.join(desktopRoot, "src-tauri", "src", "douyin_tasks.rs"), "utf8");
const mediaTools = fs.readFileSync(path.join(desktopRoot, "src-tauri", "src", "media_tools.rs"), "utf8");

test("link metadata is resolved before a long-video task is confirmed", () => {
  assert.match(app, /resolveDouyinAuto\(sourceText\.trim\(\)\)/);
  assert.match(app, /video_info: videoInfo/);
  assert.match(app, /long_video_confirmed: segmentCount > 1/);
  assert.match(app, /视频超过 5 分钟/);
  assert.match(app, /showSubmissionMode \? "将先完整下载，再" : "将从本地文件"/);
  assert.match(app, /请保持客户端运行且不要中途退出/);
});

test("videos over five minutes are uploaded as segments and merged", () => {
  assert.match(tasks, /LONG_VIDEO_THRESHOLD_SECONDS: f64 = 5\.0 \* 60\.0/);
  assert.match(tasks, /compress_video_segment_for_inline_analysis/);
  assert.match(tasks, /segment-\{}-of-\{segment_count\}/);
  assert.match(tasks, /merge_long_video_results/);
  assert.match(mediaTools, /pub fn compress_video_segment_for_inline_analysis/);
});

test("the confirmation follows the configured overall or per-segment billing mode", () => {
  assert.match(app, /quote\.extraction_billing_mode === "PER_SEGMENT" \? segmentCount : 1/);
  assert.match(app, /const totalCredits = quote\.credits \* chargeCount/);
  assert.match(app, /下载后拆分 \{segmentCount\} 段解析并自动合并/);
  assert.match(tasks, /VideoUnderstandingBilling/);
  assert.match(tasks, /expected_mode: &input\.extraction_billing_mode/);
});

test("local video understanding also splits videos over five minutes", () => {
  assert.match(tasks, /fn spawn_local_task/);
  assert.match(tasks, /let segment_count = long_video_segment_count\(metadata\.duration\)/);
  assert.match(tasks, /本地长视频共 \{segment_count\} 段/);
  assert.match(tasks, /merge_long_video_results\(/);
});
