const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
const page = fs.readFileSync(path.join(__dirname, "../src/components/ScriptLibraryPage.tsx"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
const commands = fs.readFileSync(path.join(__dirname, "../src-tauri/src/commands.rs"), "utf8");
const example = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/data/standard-script-example.json"), "utf8"));

test("standard script example covers the canonical project format", () => {
  assert.equal(example.schema_version, "aivs-script-v1");
  for (const key of ["story", "episodes", "characters", "scenes", "props", "sequences", "shots"]) assert.ok(key in example);
  assert.ok(example.characters.length && example.scenes.length && example.props.length && example.shots.length);
});

test("JSON scripts bypass AI analysis and are imported directly", () => {
  assert.match(app, /isStandardScript/);
  assert.match(app, /规范文件免费导入/);
  assert.match(app, /saveTextAsJson/);
  assert.match(commands, /import_standard_script_file/);
  assert.match(commands, /create_canonical_project/);
});

test("script library searches, confirms credits and creates a canonical local project", () => {
  assert.match(app, /sourceType === "SCRIPT_LIBRARY"/);
  assert.match(page, /listScriptLibrary/);
  assert.match(page, /useScriptLibraryItem/);
  assert.match(page, /getCreditBalance/);
  assert.match(page, /createCanonicalProject/);
  assert.match(page, /const PAGE_SIZE = 12/);
  assert.match(page, /script-library-category-tabs/);
  assert.match(page, /script-library-pagination/);
  assert.match(page, /nearbyPages/);
  assert.match(page, /script-library-page-numbers/);
  assert.match(page, /event\.key === "Enter"/);
  assert.match(page, /aria-label="跳转页码"/);
  assert.match(page, /HOT_CATEGORY_CODE = "hot-fans"/);
  assert.match(page, /hot-script-category/);
  assert.match(page, /hot-script-card/);
  assert.match(styles, /article\.hot-script-card/);
  assert.match(styles, /border: 1px solid rgba\(225,105,67,\.42\)/);
  assert.doesNotMatch(page, /path-input|chooseProjectDirectory|onRootPathChange/);
  assert.doesNotMatch(app, /<label>项目根目录|<label>新项目根目录|t\("projectRoot"\)/);
  assert.ok(app.indexOf("项目中心<small>") < app.indexOf("剧本库<small>"));
});
