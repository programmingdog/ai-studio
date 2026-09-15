const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(desktopRoot, "src", "App.tsx"), "utf8");
const freeCreation = fs.readFileSync(path.join(desktopRoot, "src", "components", "FreeCreationPage.tsx"), "utf8");
const mentionEditor = fs.readFileSync(path.join(desktopRoot, "src", "components", "VisualMentionEditor.tsx"), "utf8");
const styles = fs.readFileSync(path.join(desktopRoot, "src", "styles.css"), "utf8");

test("homepage free creation stays inside the homepage workspace", () => {
  const homepageBranch = app.indexOf("if (!bundle?.canonical)");
  const projectFreeCreationBranch = app.indexOf("if (freeCreationOpen)", homepageBranch);
  assert.ok(homepageBranch >= 0 && projectFreeCreationBranch > homepageBranch);
  assert.match(app, /showFreeCreation \? <FreeCreationPage \/> : showAssetLibrary/);
  assert.match(app, /className=\{showFreeCreation \? "active" : ""\} onClick=\{onOpenFreeCreation\}/);
});

test("asset picker occupies 80 percent of the main window and uses content-width tabs", () => {
  assert.match(styles, /\.free-mention-modal \{[^}]*width: 80vw;[^}]*height: 80vh;/s);
  assert.match(styles, /\.free-mention-modal > nav \{[^}]*display: flex;/s);
  assert.match(styles, /\.free-mention-modal > nav button \{[^}]*flex: 0 0 auto;[^}]*width: max-content;/s);
});

test("free creation references render as removable rich mention tags", () => {
  assert.match(freeCreation, /<VisualMentionEditor[^>]*rich picker="asset-modal"/s);
  assert.match(mentionEditor, /mention\.className = rich \? "visual-mention-token rich"/);
  assert.match(mentionEditor, /remove\.dataset\.mentionRemove = "true"/);
  assert.match(mentionEditor, /rich && \(event\.key === "Backspace" \|\| event\.key === "Delete"\)/);
  assert.match(mentionEditor, /item\?\.imageSource/);
});

test("completed free creation task cards expose a download action", () => {
  assert.match(freeCreation, /task\.record\.status === "COMPLETED" && <button className="free-task-download"/);
  assert.match(freeCreation, /saveGenerationRecordAsset\(workspace\.data\.project_path, task\.record\)/);
  assert.match(freeCreation, /savingTaskId === task\.id \? "保存中…" : "下载"/);
  assert.match(styles, /\.free-task-download \{/);
});

test("free creation tasks without preview media use the first two prompt characters as a text cover", () => {
  assert.match(freeCreation, /Array\.from\(task\.prompt\.trim\(\)\)\.slice\(0, 2\)\.join\(""\)/);
  assert.match(freeCreation, /className="free-task-text-cover"/);
  assert.match(styles, /\.free-task-text-cover \{/);
});
