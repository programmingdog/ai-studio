const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../../../packages/schemas/src/index.ts'), 'utf8');
const migrations = fs.readFileSync(path.join(__dirname, '../src-tauri/src/database/migrations.rs'), 'utf8');
const assets = fs.readFileSync(path.join(__dirname, '../src-tauri/src/database/asset_library.rs'), 'utf8');

test('props are a standalone persisted project entity with required authoring fields', () => {
  assert.match(schema, /export interface Prop[\s\S]*name: string;[\s\S]*style: string;[\s\S]*description: string;/);
  assert.match(schema, /props\?: Prop\[\];/);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS props/);
  assert.match(app, /function PropsPage/);
  assert.match(app, /aria-label="道具名称"/);
  assert.match(app, /<label>风格<input/);
  assert.match(app, /<label>描述<textarea/);
});

test('prop navigation sits below characters and above storyboard', () => {
  assert.match(app, /\["characters", "characters", CircleUserRound\],[\s\S]*\["props", "props", WandSparkles\],[\s\S]*\["storyboard", "storyboard", Clapperboard\]/);
});

test('props can be generated, reused from the asset library, and attached to shots', () => {
  assert.match(app, /target_type: "prop"/);
  assert.match(app, /<AssetLibraryPickerModal assetType="prop"/);
  assert.match(app, /const selectedPropIds = selected \? shotPropIds\(selected\) : \[\]/);
  assert.match(app, /group: "prop"/);
  assert.match(app, /kind: "prop"/);
  assert.match(assets, /"prop" => "prop"/);
});

test('automatic workflow creates only scene and character assets, never props', () => {
  const start = app.indexOf('const createMissingAssets = async () => {');
  const end = app.indexOf('await createMissingAssets();', start);
  assert.ok(start >= 0 && end > start);
  const automaticAssetCreation = app.slice(start, end);
  assert.match(automaticAssetCreation, /sceneTasks/);
  assert.match(automaticAssetCreation, /characterTasks/);
  assert.doesNotMatch(automaticAssetCreation, /propImageTask|projectProps|canonical\.props/);
});

test('prop generation persists the current project before task creation', () => {
  assert.match(app, /const currentBundle = useStudioStore\.getState\(\)\.bundle;[\s\S]*await saveCanonical\(currentBundle\);[\s\S]*const created = await createImageGenerationTasks/);
});
