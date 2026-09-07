const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../src/videoPromptReferences.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText;
const testModule = { exports: {} };
new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(testModule.exports, require, testModule, sourcePath, path.dirname(sourcePath));
const { prepareVideoPromptSubmission } = testModule.exports;

test('orders scene, character, prop and storyboard images and resolves mentions to matching ordinals', () => {
  const result = prepareVideoPromptSubmission(
    '让@角色图2拿起@道具图1走入@场景图，构图参考@分镜图。',
    [
      { relative_path: 'shots/one.png', label: '分镜图', kind: 'shot_reference' },
      { relative_path: 'characters/one.png', label: '角色一', kind: 'character' },
      { relative_path: 'characters/two.png', label: '角色二', kind: 'character' },
      { relative_path: 'props/sword.png', label: '长剑', kind: 'prop' },
      { relative_path: 'scenes/one.png', label: '场景图', kind: 'scene' },
    ],
    [
      { token: '@场景图', relativePath: 'scenes/one.png', kind: 'scene' },
      { token: '@角色图1', relativePath: 'characters/one.png', kind: 'character' },
      { token: '@角色图2', relativePath: 'characters/two.png', kind: 'character' },
      { token: '@道具图1', relativePath: 'props/sword.png', kind: 'prop' },
      { token: '@分镜图', relativePath: 'shots/one.png', kind: 'shot_reference' },
    ],
  );
  assert.deepEqual(result.references.map((item) => item.kind), ['scene', 'character', 'character', 'prop', 'shot_reference']);
  assert.equal(result.prompt, '让参考图3拿起参考图4走入参考图1，构图参考参考图5。');
});

test('does not replace a mention when its image is unavailable', () => {
  const result = prepareVideoPromptSubmission('@角色图1保持一致', [], [
    { token: '@角色图1', kind: 'character' },
  ]);
  assert.equal(result.prompt, '@角色图1保持一致');
});
