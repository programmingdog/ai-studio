const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(desktopRoot, "src", "App.tsx"), "utf8");
const freeCreation = fs.readFileSync(path.join(desktopRoot, "src", "components", "FreeCreationPage.tsx"), "utf8");
const mentionEditor = fs.readFileSync(path.join(desktopRoot, "src", "components", "VisualMentionEditor.tsx"), "utf8");
const backend = fs.readFileSync(path.join(desktopRoot, "src", "services", "backend.ts"), "utf8");
const commands = fs.readFileSync(path.join(desktopRoot, "src-tauri", "src", "commands.rs"), "utf8");
const assetLibrary = fs.readFileSync(path.join(desktopRoot, "src-tauri", "src", "database", "asset_library.rs"), "utf8");
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
  assert.match(mentionEditor, /const caretSentinel = "\\u200B"/);
  assert.match(mentionEditor, /if \(rich && endsWithMention\) fragment\.append\(document\.createTextNode\(caretSentinel\)\)/);
  assert.match(mentionEditor, /restoreCaret\(editor, start \+ token\.dataset\.mention\.length\)/);
});

test("free creation can add square reference images up to the selected model limit", () => {
  assert.match(freeCreation, /className="free-reference-picker"/);
  assert.match(freeCreation, /selectedAssets\.length >= maxReferences/);
  assert.match(freeCreation, /model\?\.max_reference_images/);
  assert.match(freeCreation, /chooseFreeCreationReferenceImage\(\)/);
  assert.match(freeCreation, /importAssetLibraryReferenceImage\(sourcePath\)/);
  assert.match(freeCreation, /setPrompt\(\(current\) => current\.includes\(token\)/);
  assert.match(styles, /\.free-reference-tile, \.free-reference-add \{[^}]*width: 76px;[^}]*height: 76px;/s);
  assert.match(styles, /\.free-reference-add \{[^}]*border: 1px dashed/s);
});

test("new free creation references are deduplicated into the asset library and remain available to mentions", () => {
  assert.match(backend, /invoke<AssetLibraryItem>\("import_asset_library_reference_image", \{ sourcePath \}\)/);
  assert.match(commands, /import_free_creation_reference\(&app, &PathBuf::from\(source_path\)\)/);
  assert.match(assetLibrary, /find\(\|asset\| same_image_content\(Path::new\(&asset\.image_path\), &bytes\)\)/);
  assert.match(assetLibrary, /'free_creation_reference'/);
  assert.match(freeCreation, /queryClient\.setQueryData<AssetLibraryItem\[]>\(\["asset-library"\], mergedAssets\)/);
  assert.match(freeCreation, /disabled: maxReferences !== undefined && selectedAssetIds\.size >= maxReferences/);
  assert.match(mentionEditor, /disabled=\{!item\.relativePath \|\| item\.disabled\}/);
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

test("free creation video preview is limited to 65 percent of the modal height", () => {
  assert.match(styles, /\.free-preview-modal \{[^}]*container-type: size;/s);
  assert.match(styles, /\.free-preview-modal video \{[^}]*max-height: 65cqh;[^}]*object-fit: contain;/s);
});
