const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "../src/components/ScriptLibraryPage.tsx"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
const backend = fs.readFileSync(path.join(__dirname, "../src-tauri/src/video_remix.rs"), "utf8");

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
