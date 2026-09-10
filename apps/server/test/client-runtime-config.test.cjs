const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { ClientRuntimeConfigService } = require('../dist/common/client-runtime-config.service.js');

function fixture(initialRow = { recommended_video_concurrency: null, revision: 0, updated_at: 'now' }, environmentDefault = 4) {
  let row = { ...initialRow };
  const executions = [], audits = [];
  const database = {
    async query() { return [row]; },
    async transaction(operation) {
      return operation({
        async query() { return [[row]]; },
        async execute(sql, parameters) {
          executions.push({ sql, parameters });
          row = { ...row, recommended_video_concurrency: parameters[0], revision: row.revision + 1 };
        },
      });
    },
  };
  const environment = { values: { recommendedVideoConcurrency: environmentDefault } };
  const audit = { async record(input) { audits.push(input); } };
  return { service: new ClientRuntimeConfigService(database, environment, audit), executions, audits };
}

test('client runtime config follows the environment until an admin override exists', async () => {
  const { service } = fixture(undefined, 7);
  assert.deepEqual(await service.get(), {
    recommended_video_concurrency: 7,
    configured_video_concurrency: null,
    environment_default_video_concurrency: 7,
    source: 'environment',
    revision: 0,
    updated_at: 'now',
  });
});

test('zero and large safe integers are accepted without an arbitrary concurrency cap', async () => {
  const { service, executions, audits } = fixture({ recommended_video_concurrency: 3, revision: 2, updated_at: 'now' });
  let result = await service.update('admin-1', { recommendedVideoConcurrency: 0, revision: 2 });
  assert.equal(result.recommended_video_concurrency, 0);
  assert.equal(result.source, 'database');
  result = await service.update('admin-1', { recommendedVideoConcurrency: 1_000_000, revision: 3 });
  assert.equal(result.recommended_video_concurrency, 1_000_000);
  assert.deepEqual(executions.map(item => item.parameters), [[0, 'admin-1'], [1_000_000, 'admin-1']]);
  assert.equal(audits.at(-1).action, 'client_runtime_config.update');
});

test('null restores the environment default and stale revisions are rejected', async () => {
  const { service, executions } = fixture({ recommended_video_concurrency: 8, revision: 4, updated_at: 'now' }, 6);
  await assert.rejects(() => service.update('admin-1', { recommendedVideoConcurrency: 2, revision: 3 }), /配置已更新/);
  assert.equal(executions.length, 0);
  const result = await service.update('admin-1', { recommendedVideoConcurrency: null, revision: 4 });
  assert.equal(result.recommended_video_concurrency, 6);
  assert.equal(result.configured_video_concurrency, null);
  assert.equal(result.source, 'environment');
});

test('negative, fractional and unsafe values are rejected', async () => {
  const { service } = fixture();
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'invalid']) {
    await assert.rejects(() => service.update('admin-1', { recommendedVideoConcurrency: value, revision: 0 }), /必须是非负整数/);
  }
});

test('runtime config migration keeps the database override nullable for environment fallback', () => {
  const sql = readFileSync(join(__dirname, '../src/database/migrations/040_client_runtime_config.sql'), 'utf8');
  assert.match(sql, /recommended_video_concurrency BIGINT UNSIGNED NULL DEFAULT NULL/);
  assert.match(sql, /INSERT IGNORE INTO client_runtime_configs[\s\S]*VALUES \(1, NULL\)/);
});
