const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../../../packages/schemas/src/index.ts'), 'utf8');
const registry = fs.readFileSync(path.join(__dirname, '../src-tauri/src/project/registry.rs'), 'utf8');

test('first successfully created editable project shows project-center guidance once per user', () => {
  assert.match(app, /PROJECT_CENTER_GUIDANCE_KEY/);
  assert.match(app, /localStorage\.getItem\(storageKey\)/);
  assert.match(app, /localStorage\.setItem\(storageKey, "shown"\)/);
  assert.match(app, /if \(created\.canonical\) showProjectCenterGuidanceOnce\(\)/);
  assert.match(app, /已经生成的项目会自动保存在左侧“项目中心”/);
  assert.match(app, /知道了，继续编辑/);
});

test('background script project completion also triggers the first-time guidance', () => {
  assert.match(app, /setCreatedScriptTaskId\(task\.id\)/);
  assert.match(app, /createdTask\?\.status !== "COMPLETED"/);
  assert.match(app, /onProjectCreatedNotice\(\)/);
});

test('project cards show generated-over-total counts without separate image and video tags', () => {
  for (const field of ['scenes', 'characters', 'props', 'shots', 'generated_scenes', 'generated_characters', 'generated_props', 'generated_shots']) {
    assert.match(schema, new RegExp(`${field}: number`));
  }
  assert.match(app, /场景 <b>\{stats\.generated_scenes\}\/\{stats\.scenes\}<\/b>/);
  assert.match(app, /角色 <b>\{stats\.generated_characters\}\/\{stats\.characters\}<\/b>/);
  assert.match(app, /道具 <b>\{stats\.generated_props\}\/\{stats\.props\}<\/b>/);
  assert.match(app, /分镜 <b>\{stats\.generated_shots\}\/\{stats\.shots\}<\/b>/);
  assert.doesNotMatch(app, /stats\.generated_images/);
  assert.doesNotMatch(app, /stats\.generated_videos/);
  assert.match(styles, /\.project-list-stats/);
});

test('project statistics are read from each project database', () => {
  assert.match(registry, /SELECT COUNT\(\*\) FROM scenes/);
  assert.match(registry, /SELECT COUNT\(\*\) FROM characters/);
  assert.match(registry, /SELECT COUNT\(\*\) FROM props/);
  assert.match(registry, /SELECT COUNT\(\*\) FROM shots/);
  assert.match(registry, /SELECT COUNT\(\*\) FROM scenes AS scene WHERE EXISTS/);
  assert.match(registry, /SELECT COUNT\(\*\) FROM characters AS character WHERE EXISTS/);
  assert.match(registry, /SELECT COUNT\(\*\) FROM props AS prop WHERE EXISTS/);
  assert.match(registry, /SELECT COUNT\(\*\) FROM shots AS shot WHERE EXISTS/);
  assert.match(registry, /target_type = 'character_state'/);
  assert.match(registry, /media_type = 'video'[\s\S]*target_type = 'shot'/);
});
