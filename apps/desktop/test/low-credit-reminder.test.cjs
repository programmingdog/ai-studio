const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const filename = path.join(__dirname, '../src/services/lowCreditReminder.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleValue = { exports: {} };
new Function('exports', 'module', compiled)(moduleValue.exports, moduleValue);
const { isLowCredit, nextLowCreditState: next, initialLowCreditState: initial } = moduleValue.exports;

test('strictly below 10 triggers; zero counts, unknown balances never count as zero', () => {
  for (const value of [0, 9, 9.999999, -1]) assert.equal(isLowCredit(value), true);
  for (const value of [10, 10.000001, 100, undefined, NaN, Infinity]) assert.equal(isLowCredit(value), false);
});
test('login at low balance opens once; polling and dismissing do not repeatedly open it', () => {
  let state = next(initial, 'user-a', 9, false);
  assert.equal(state.open, true);
  state = { ...state, open: false };
  for (const value of [9, 8, 0]) {
    state = next(state, 'user-a', value, false);
    assert.equal(state.open, false);
    assert.equal(state.notified, true);
  }
});
test('recovering to 10 re-arms the next low balance warning', () => {
  let state = next(initial, 'user-a', 9, false);
  state = next(state, 'user-a', 10, false);
  assert.equal(state.open, false);
  assert.equal(state.notified, false);
  assert.equal(next(state, 'user-a', 9.5, false).open, true);
});
test('waits for existing dialogs to close without consuming the reminder', () => {
  const state = next(initial, 'user-a', 1, true);
  assert.equal(state.open, false);
  assert.equal(state.notified, false);
  assert.equal(next(state, 'user-a', 1, false).open, true);
});
test('login and account changes isolate reminders and logout closes them', () => {
  const state = { ...next(initial, 'user-a', 1, false), open: false };
  assert.equal(next(state, 'user-b', 9, false).open, true);
  assert.deepEqual(next(state, null, 1, false), initial);
  assert.equal(next(state, 'user-b', undefined, false).open, false);
});
test('balance failures never open a warning; valid recovery can still warn', () => {
  const unknown = next(initial, 'user-a', undefined, false);
  assert.equal(unknown.open, false);
  assert.equal(next(unknown, 'user-a', 2, false).open, true);
});
