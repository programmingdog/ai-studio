const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { componentHarness } = require('../../../tests/support/react-hooks.cjs');

test('product brand configuration is editable and used by admin and invitation UI', () => {
  const panel = readFileSync(join(__dirname, '../components/ProductBrandConfigPanel.tsx'), 'utf8');
  const provider = readFileSync(join(__dirname, '../components/ProductBrand.tsx'), 'utf8');
  const admin = readFileSync(join(__dirname, '../components/AdminApp.tsx'), 'utf8');
  const invitation = readFileSync(join(__dirname, '../components/InvitationRegister.tsx'), 'utf8');
  assert.match(panel, /\/admin\/configs\/product-brand/);
  assert.match(panel, /产品中文名/);
  assert.match(panel, /产品英文名/);
  assert.match(provider, /\/client-config\/product-brand/);
  assert.match(admin, /productBrand\.chinese_name/);
  assert.match(invitation, /productBrand\.chinese_name/);
  assert.doesNotMatch(admin, /<strong>Video Studio<\/strong>/);
  assert.doesNotMatch(invitation, /<strong>AI Video Studio<\/strong>/);
});

test('saving product brand sends both names and refreshes the shared brand immediately', async () => {
  const calls = [], applied = [];
  const setProductBrand = value => applied.push(value);
  const initial = { chinese_name: '影匠', english_name: 'Yingjiang', revision: 0, updated_at: '2026-09-03T00:00:00Z' };
  const file = join(__dirname, '../components/ProductBrandConfigPanel.tsx');
  const h = componentHarness(file, 'ProductBrandConfigPanel', { token: 'test-token' }, {
    '@/lib/api': { async apiRequest(...args) { calls.push(args); return args[1]?.method === 'PATCH' ? { ...JSON.parse(args[1].body), revision: 1 } : initial; } },
    '@/components/ProductBrand': { useProductBrand: () => ({ setProductBrand }) },
  });
  await h.ready();
  const inputs = () => h.nodes().filter(node => node.type === 'input');
  h.edit(inputs()[0], '新中文名'); h.edit(inputs()[1], 'New English Name');
  await h.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const save = calls.find(call => call[1]?.method === 'PATCH');
  assert.equal(save[0], '/admin/configs/product-brand');
  assert.deepEqual(JSON.parse(save[1].body), { chinese_name: '新中文名', english_name: 'New English Name' });
  assert.equal(applied.at(-1).english_name, 'New English Name');
});
