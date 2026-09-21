const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const file = path.join(__dirname, '../lib/admin-date-time.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, loaded, loaded.exports);
const dates = loaded.exports;

test('database wall timestamps are not shifted by another eight hours', () => {
  assert.equal(dates.formatDatabaseDateTime('2026-09-20T22:35:19.260Z'), '2026/09/20 22:35:19');
  assert.equal(dates.formatDatabaseShortDate('2026-09-20T22:35:19.260Z'), '09-20');
  assert.equal(dates.databaseDateTimeLocalValue('2026-09-20T22:35:19.260Z'), '2026-09-20T22:35');
});

test('genuine UTC instants are converted to China time exactly once', () => {
  assert.equal(dates.formatInstantDateTime('2026-09-20T14:35:19.260Z'), '2026/09/20 22:35:19');
  assert.equal(dates.instantDateTimeLocalValue('2026-09-20T14:35:19.260Z'), '2026-09-20T22:35');
  assert.equal(dates.chinaDateTimeLocalToIso('2026-09-20T22:35'), '2026-09-20T14:35:00.000Z');
});

test('empty and malformed values retain safe fallbacks', () => {
  assert.equal(dates.formatDatabaseDateTime(null), '—');
  assert.equal(dates.formatDatabaseDateTime('not-a-date'), 'not-a-date');
  assert.equal(dates.formatInstantDateTime('not-a-date'), 'not-a-date');
  assert.equal(dates.chinaDateTimeLocalToIso('not-a-date'), null);
});

test('admin timestamp displays use the audited formatter instead of browser-local parsing', () => {
  const components = path.join(__dirname, '../components');
  const source = fs.readdirSync(components, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.tsx'))
    .map(entry => fs.readFileSync(path.join(components, entry.name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /new Date\([^\n]*\)\.toLocale(?:String|DateString)/);
  for (const name of ['CreditsPanel.tsx', 'UsersPanel.tsx', 'DistributionPanel.tsx', 'DashboardOverview.tsx']) {
    assert.match(fs.readFileSync(path.join(components, name), 'utf8'), /admin-date-time/);
  }
});
