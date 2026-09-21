const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "../src/components/ScriptLibraryPage.tsx"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
const backend = fs.readFileSync(path.join(__dirname, "../src-tauri/src/video_remix.rs"), "utf8");
const ai = fs.readFileSync(path.join(__dirname, "../src-tauri/src/ai.rs"), "utf8");
const platform = fs.readFileSync(path.join(__dirname, "../src-tauri/src/platform_media.rs"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
const visualStyleSelect = fs.readFileSync(path.join(__dirname, "../src/components/GroupedVisualStyleSelect.tsx"), "utf8");

test("script library detail actions place remix before the rightmost create action", () => {
  assert.match(page, /className="script-library-detail-actions"[\s\S]*?>二次创作<\/button>[\s\S]*?>一键生成项目<\/button>/);
  assert.match(styles, /\.script-library-detail-actions[\s\S]*?justify-content: flex-end/);
  assert.match(styles, /\.script-library-detail-actions \.primary-button,[\s\S]*?width: auto/);
  assert.match(styles, /min-width: max-content/);
});

test("script library remix reuses the local remix task workflow with a source snapshot", () => {
  assert.match(page, /source_type: "script_library"/);
  assert.match(page, /source_text: source\.content/);
  assert.match(page, /createVideoRemixTask/);
  assert.match(page, /listVideoRemixTasks/);
  assert.match(page, /retryVideoRemixTask/);
  assert.match(page, /createVideoRemixProject/);
  assert.match(backend, /input\.source_text/);
  assert.match(backend, /二次创作来源内容为空/);
});

test("paid remix confirmation stacks above the remix modal", () => {
  const confirmationLayer = Number(styles.match(/\.credit-confirmation-backdrop\s*\{\s*z-index:\s*(\d+)/)?.[1]);
  const remixLayer = Number(styles.match(/\.script-library-remix-backdrop\s*\{\s*z-index:\s*(\d+)/)?.[1]);
  assert.ok(Number.isFinite(confirmationLayer));
  assert.ok(Number.isFinite(remixLayer));
  assert.ok(confirmationLayer > remixLayer);
});

test("both remix entry points use the dedicated server-side feature price", () => {
  assert.match(page, /ModelCreditNotice capability="VIDEO_REMIX" action="二创"/);
  assert.match(app, /ModelCreditNotice capability="VIDEO_REMIX" action="二创"/);
  assert.match(ai, /generate_video_remix[\s\S]*video_remix_completion/);
  assert.match(backend, /confirmed_video_remix_quote[\s\S]*for attempt in 1\.\.=MAX_GENERATION_ATTEMPTS/);
  assert.match(backend, /MAX_AUTOMATIC_RETRIES: usize = 3/);
  assert.match(backend, /finalize_video_remix[\s\S]*CLIENT_CONTENT_INVALID/);
  assert.match(platform, /Some\("VIDEO_REMIX"\)/);
  assert.match(platform, /create_path = if capability == Some\("VIDEO_REMIX"\)/);
  assert.match(platform, /"\/tasks\/video-remix"/);
});

test("script library remix uses the same grouped visual style presets as video remix", () => {
  assert.match(app, /<ScriptLibraryPage[\s\S]*?visualStyles=\{visualStyles\.data \?\? \[\]\}/);
  assert.match(page, /<GroupedVisualStyleSelect value=\{visualStyle\} onChange=\{setVisualStyle\} presets=\{visualStyles\}/);
  assert.doesNotMatch(page, /<label>画风设定<input/);
  assert.match(visualStyleSelect, /presets\.filter\(\(preset\) => preset\.category === category\)/);
  assert.match(visualStyleSelect, /当前自定义画风/);
});

test("both remix entry points offer and submit a fixed fifteen-second storyboard mode", () => {
  assert.match(app, /<option value="fixed_15">固定时长（每镜15秒）<\/option>/);
  assert.match(page, /<option value="fixed_15">固定时长（每镜15秒）<\/option>/);
  assert.match(app, /storyboard_duration_mode === "fixed_15" \? "固定15秒"/);
  assert.match(page, /storyboard_duration_mode === "fixed_15" \? "固定15秒"/);
  assert.match(ai, /"fixed_15" => \([\s\S]*?target_duration \/ 15\.0[\s\S]*?每个分镜时长必须严格等于15秒/);
  assert.match(backend, /"fixed" \| "fixed_15" \| "adaptive"/);
});
