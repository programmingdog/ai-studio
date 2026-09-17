const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
const backend = fs.readFileSync(path.join(__dirname, "../src/services/backend.ts"), "utf8");
const commands = fs.readFileSync(path.join(__dirname, "../src-tauri/src/commands.rs"), "utf8");
const ai = fs.readFileSync(path.join(__dirname, "../src-tauri/src/ai.rs"), "utf8");
const library = fs.readFileSync(path.join(__dirname, "../src-tauri/src/database/asset_library.rs"), "utf8");
const runtime = fs.readFileSync(path.join(__dirname, "../src-tauri/src/lib.rs"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");

test("asset library places add asset before batch deletion", () => {
  const actions = app.slice(app.indexOf('className="asset-library-batch-actions"'));
  assert.ok(actions.indexOf("asset-add-entry") < actions.indexOf("asset-batch-delete-entry"));
  assert.match(app, />添加资产</);
  assert.match(app, /setShowAddAsset\(true\)/);
});

test("custom add modal supports metadata, upload and AI generation", () => {
  assert.match(app, /function AddAssetLibraryModal/);
  assert.match(app, /资产名称/);
  assert.match(app, /资产类型/);
  assert.match(app, /提示词/);
  assert.match(app, /上传图片/);
  assert.match(app, /AI 生成/);
  assert.match(app, /chooseAssetLibraryImage/);
  assert.match(app, /importAssetLibraryItem/);
  assert.match(app, /requestMediaModel\("IMAGE_GENERATION"/);
  assert.match(app, /generateAssetLibraryItem/);
  assert.match(app, /image:asset:\$\{requestId\}/);
  assert.match(styles, /\.asset-add-modal/);
  assert.match(styles, /\.asset-add-upload-picker/);
  assert.match(styles, /\.asset-add-entry,[\s\S]*\.asset-batch-delete-entry \{ flex: 0 0 92px;[\s\S]*width: 92px;[\s\S]*height: 34px/);
});

test("native asset creation validates and stores uploaded or generated images", () => {
  assert.match(backend, /invoke<AssetLibraryItem>\("import_asset_library_item"/);
  assert.match(backend, /invoke<AssetLibraryItem>\("generate_asset_library_item"/);
  assert.match(commands, /pub fn import_asset_library_item/);
  assert.match(ai, /pub async fn generate_asset_library_item/);
  assert.match(ai, /workflow_credit_id/);
  assert.match(library, /pub fn store_custom/);
  assert.match(library, /FROM asset_library WHERE source_key = \?1/);
  assert.match(library, /manual_upload/);
  assert.match(ai, /manual_ai/);
  assert.match(ai, /manual_ai:\{\}/);
  assert.match(runtime, /commands::import_asset_library_item/);
  assert.match(runtime, /ai::generate_asset_library_item/);
});
