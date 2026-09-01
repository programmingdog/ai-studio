const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/services/workflowState.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
new Function('exports', 'module', compiled)(loaded.exports, loaded);
const { mergeTaskSnapshots, workflowErrorMessage } = loaded.exports;
const task = (id, time, status) => ({ id, created_at: id, updated_at: time, status });
test('slow queries cannot reset running tasks or remove newly submitted tasks', () => {
  const running = task('2', '20:02', 'RUNNING');
  assert.deepEqual(mergeTaskSnapshots([running], []), [running]);
  assert.deepEqual(mergeTaskSnapshots([running], [task('2', '20:01', 'PENDING')]), [running]);
  assert.equal(mergeTaskSnapshots([running], [task('2', '20:03', 'COMPLETED')])[0].status, 'COMPLETED');
});
test('same timestamp keeps current state and newer retries sort before original attempts', () => {
  assert.equal(mergeTaskSnapshots([task('1', 't', 'COMPLETED')], [task('1', 't', 'RUNNING')])[0].status, 'COMPLETED');
  assert.deepEqual(mergeTaskSnapshots([task('1', 'a', 'FAILED')], [task('2', 'b', 'RUNNING')]).map(t => t.id), ['2', '1']);
});
test('structured failures remain understandable rather than object Object', () => {
  assert.equal(workflowErrorMessage({ code: 'FAIL', message: '保存失败' }), '保存失败');
  assert.equal(workflowErrorMessage('{"message":"保存失败"}'), '保存失败');
  assert.equal(workflowErrorMessage(new Error('失败')), '失败');
  assert.equal(workflowErrorMessage('{"code":"FAIL"}'), '{"code":"FAIL"}');
});
