const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const editor = fs.readFileSync(path.join(__dirname, '../src/components/VisualMentionEditor.tsx'), 'utf8');

test('canonical edits are debounced into the serialized automatic-save queue', () => {
  assert.match(app, /saveQueue\.current\.catch\(\(\) => undefined\)\.then/);
  assert.match(app, /window\.setTimeout\(\(\) => \{[\s\S]*enqueueSave\(snapshot, snapshotRevision\)[\s\S]*\}, 650\)/);
  assert.match(app, /markSaved\(snapshotRevision\)/);
});

test('storyboard video prompt exposes the full-screen reference editor and removes the old hint', () => {
  assert.match(app, /<Maximize2 size=\{14\} \/>全屏编辑/);
  assert.match(app, /<VideoPromptFullscreenEditor/);
  assert.match(app, /className="shot-prompt-card video-prompt-card"[\s\S]*?<VisualMentionEditor value=\{videoPrompt\}[\s\S]*?rich/);
  assert.doesNotMatch(app, /先选视频清晰度，开始前会告诉你需要多少积分/);
  assert.match(editor, /提交顺序：场景图 → 角色图 → 道具图 → 分镜图/);
  assert.match(editor, /dataset\.mentionRemove/);
});
