const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { componentHarness } = require('../../../tests/support/react-hooks.cjs');

test('client runtime configuration is available in the client settings tabs', () => {
  const app = readFileSync(join(__dirname, '../components/AdminApp.tsx'), 'utf8');
  const panel = readFileSync(join(__dirname, '../components/ClientRuntimeConfigPanel.tsx'), 'utf8');
  assert.match(app, /label: "运行参数", content: <ClientRuntimeConfigPanel/);
  assert.match(panel, /\/admin\/configs\/client-runtime/);
  assert.match(panel, /<strong>0<\/strong> 表示客户端不设置并发上限/);
  assert.match(panel, /min="0"/);
  assert.doesNotMatch(panel, /max="16"/);
});

test('saving zero sends an unlimited database override with optimistic revision', async () => {
  const calls = [];
  const initial = { recommended_video_concurrency: 4, configured_video_concurrency: 4, environment_default_video_concurrency: 4, source: 'database', revision: 3, updated_at: '2026-09-10T00:00:00Z' };
  const h = componentHarness(join(__dirname, '../components/ClientRuntimeConfigPanel.tsx'), 'ClientRuntimeConfigPanel', { token: 'test-token' }, {
    '@/lib/api': { async apiRequest(...args) { calls.push(args); return args[1]?.method === 'PATCH' ? { ...initial, recommended_video_concurrency: 0, configured_video_concurrency: 0, revision: 4 } : initial; } },
  });
  await h.ready();
  const numberInput = h.nodes().find(node => node.type === 'input' && node.props.type === 'number');
  h.edit(numberInput, '0');
  await h.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const save = calls.find(call => call[1]?.method === 'PATCH');
  assert.deepEqual(JSON.parse(save[1].body), { recommended_video_concurrency: 0, revision: 3 });
});

test('environment mode saves null so the server fallback becomes active again', async () => {
  const calls = [];
  const initial = { recommended_video_concurrency: 9, configured_video_concurrency: 9, environment_default_video_concurrency: 5, source: 'database', revision: 1, updated_at: 'now' };
  const h = componentHarness(join(__dirname, '../components/ClientRuntimeConfigPanel.tsx'), 'ClientRuntimeConfigPanel', { token: 'test-token' }, {
    '@/lib/api': { async apiRequest(...args) { calls.push(args); return args[1]?.method === 'PATCH' ? { ...initial, recommended_video_concurrency: 5, configured_video_concurrency: null, source: 'environment', revision: 2 } : initial; } },
  });
  await h.ready();
  const checkbox = h.nodes().find(node => node.type === 'input' && node.props.type === 'checkbox');
  h.edit(checkbox, true);
  await h.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const save = calls.find(call => call[1]?.method === 'PATCH');
  assert.deepEqual(JSON.parse(save[1].body), { recommended_video_concurrency: null, revision: 1 });
});
