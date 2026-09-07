const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../src/manualShot.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText;
const testModule = { exports: {} };
new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(testModule.exports, require, testModule, sourcePath, path.dirname(sourcePath));
const { addManualShot } = testModule.exports;

function project() {
  return {
    story: { title: '测试', logline: '', genre: [], theme: '', synopsis: '', tone: '', aspect_ratio: '16:9', visual_style: '水墨' },
    episodes: [],
    characters: [],
    scenes: [{ id: 'SCENE_001', name: '庭院', description: '青砖庭院', location_type: '', time_of_day: '', lighting: '', layout: '', props: [], mood: '', reference_assets: [], locked: false }],
    sequences: [{ id: 'SEQ_001', scene_id: 'SCENE_001', order: 1, summary: '', character_ids: [], shot_ids: ['A-001'] }],
    shots: [{ id: 'A-001', sequence_id: 'SEQ_001', scene_id: 'SCENE_001', character_ids: [], duration: 8, shot_size: '全景', camera_angle: '平视', camera_movement: '固定', visual: '', action: '', emotion: '', dialogue: '', sound: '', image_prompt: '', video_prompt: '', negative_prompt: '', status: 'DRAFT', locked: false }],
  };
}

test('manual shot is inserted after the selected shot and linked to its sequence', () => {
  const result = addManualShot(project(), 'A-001');
  assert.equal(result.shotId, 'SHOT_001');
  assert.deepEqual(result.canonical.shots.map((shot) => shot.id), ['A-001', 'SHOT_001']);
  assert.deepEqual(result.canonical.sequences[0].shot_ids, ['A-001', 'SHOT_001']);
  assert.equal(result.canonical.shots[1].scene_id, 'SCENE_001');
  assert.equal(result.canonical.shots[1].aspect_ratio, '16:9');
  assert.equal(result.canonical.shots[1].visual_style, '水墨');
  assert.deepEqual(result.canonical.shots[1].character_state_ids, {});
});

test('manual shot ids remain unique and preserve numeric gaps', () => {
  const first = addManualShot(project(), 'A-001').canonical;
  const second = addManualShot(first, 'SHOT_001');
  assert.equal(second.shotId, 'SHOT_002');
  assert.deepEqual(second.canonical.sequences[0].shot_ids, ['A-001', 'SHOT_001', 'SHOT_002']);
});

test('manual shot creates a sequence when the scene has none', () => {
  const model = project();
  model.sequences = [];
  model.shots = [];
  const result = addManualShot(model);
  assert.equal(result.canonical.sequences[0].id, 'SEQ_001');
  assert.deepEqual(result.canonical.sequences[0].shot_ids, ['SHOT_001']);
  assert.equal(result.canonical.shots[0].sequence_id, 'SEQ_001');
});

test('storyboard page exposes the manual add control', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
  assert.match(app, /onClick=\{createManualShot\}/);
  assert.match(app, /<Plus size=\{14\} \/>添加分镜/);
});
