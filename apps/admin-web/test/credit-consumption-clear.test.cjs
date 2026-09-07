const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { componentHarness, flush } = require('../../../tests/support/react-hooks.cjs');

const file = path.join(__dirname, '../components/CreditsPanel.tsx');

test('consumption page uses a custom consequence dialog before clearing every record', async () => {
  const calls = [];
  let cleared = false;
  const row = {
    id: 'record-1', consumption_no: 'CC001', user_id: 'user-1', user_email: 'user@example.invalid',
    user_name: '测试用户', task_id: null, provider_model_id: null, model_alias: null, model_code: null,
    category: 'MODEL_TASK', credits_consumed: 2, status: 'CONFIRMED', description: '模型任务', notes: '',
    metadata_json: {}, occurred_at: '2026-09-05T08:00:00Z', created_at: '2026-09-05T08:00:00Z',
  };
  const apiRequest = async (url, options = {}) => {
    calls.push([url, options]);
    if (url === '/admin/users?limit=200') return [{ id: 'user-1', email: 'user@example.invalid', phone: null, display_name: '测试用户', status: 'ACTIVE' }];
    if (url === '/admin/credits/consumptions?limit=200') return cleared ? [] : [row];
    if (url === '/admin/credits/consumptions' && options.method === 'DELETE') { cleared = true; return { deleted: true, deleted_count: 1 }; }
    throw new Error(`unexpected request ${url}`);
  };
  const h = componentHarness(file, 'ConsumptionsManager', { token: 'test-token' }, { '@/lib/api': { apiRequest } });
  await h.ready();
  h.button('清空全部记录').props.onClick(); h.render();
  const dialog = h.nodes().find(node => node.type?.name === 'ClearConsumptionsModal');
  assert.ok(dialog);
  const modal = componentHarness(file, 'ClearConsumptionsModal', dialog.props, { '@/lib/api': { apiRequest } });
  const dialogText = modal.nodes().map(node => modal.text(node)).join('\n');
  assert.match(dialogText, /永久生效，无法恢复/);
  assert.match(dialogText, /不会返还或补发任何积分/);
  assert.match(dialogText, /不会删除积分账本流水、模型任务、套餐购买记录或用户资料/);
  dialog.props.onConfirm();
  await flush(); await h.ready();
  const deletion = calls.find(([url, options]) => url === '/admin/credits/consumptions' && options.method === 'DELETE');
  assert.ok(deletion);
  assert.deepEqual(JSON.parse(deletion[1].body), { confirmed: true, confirmation: 'CLEAR_ALL_CREDIT_CONSUMPTIONS' });
  assert.ok(h.nodes().some(node => h.text(node).includes('已清空 1 条积分消耗记录')));
});
