const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { componentHarness } = require('../../../tests/support/react-hooks.cjs');

test('user switch posts only selected user and revision, not global settings', async () => {
  const calls = [];
  const h = componentHarness(join(__dirname, '../components/WagaByokConfigPanel.tsx'), 'WagaByokConfigPanel', { token: 'admin', userId: 'user-A' }, {
    '@/lib/api': { async apiRequest(url, options) { calls.push({ url, options }); return { enabled: options.method === 'PATCH', revision: options.method === 'PATCH' ? 1 : 0, migration_required: false }; } },
  });
  await h.ready();
  h.edit(h.nodes().find(n => n.type === 'input' && n.props.type === 'checkbox'), true);
  await h.nodes().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  const saved = calls.find(c => c.options.method === 'PATCH');
  assert.equal(saved.url, '/admin/users/user-A/waga-byok');
  assert.deepEqual(JSON.parse(saved.options.body), { enabled: true, revision: 0 });
  assert.ok(calls.every(c => c.url.includes('/users/user-A/')));
  h.unmount();
});
