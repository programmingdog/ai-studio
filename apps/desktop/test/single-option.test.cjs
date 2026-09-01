const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/services/singleOption.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const loaded = { exports: {} };
new Function('exports', 'module', compiled)(loaded.exports, loaded);
const { singleOptionValue } = loaded.exports;
test('single model and resolution are selected when asynchronous options arrive', () => {
  assert.equal(singleOptionValue([], ''), '');
  assert.equal(singleOptionValue(['image-model'], ''), 'image-model');
  assert.equal(singleOptionValue(['video-model'], ''), 'video-model');
  assert.equal(singleOptionValue(['2K'], ''), '2K');
});
test('multiple options require a choice and valid user choices remain unchanged', () => {
  assert.equal(singleOptionValue(['a', 'b'], ''), '');
  assert.equal(singleOptionValue(['a', 'b'], 'b'), 'b');
  assert.equal(singleOptionValue(['1K', '2K'], '2K'), '2K');
});
test('removed choices are not kept or replaced arbitrarily', () => {
  assert.equal(singleOptionValue([], 'old'), '');
  assert.equal(singleOptionValue(['new'], 'old'), 'new');
  assert.equal(singleOptionValue(['a', 'b'], 'old'), '');
});
