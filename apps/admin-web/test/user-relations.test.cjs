const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { componentHarness } = require('../../../tests/support/react-hooks.cjs');
const root = { id: '11111111-1111-4111-8111-111111111111', pid: '22222222-2222-4222-8222-222222222222', display_name: '当前用户', email: 'root@example.invalid', invite_code: 'TEST2345', status: 'ACTIVE', balance_fen: 35850, created_at: '2026-09-04T00:00:00Z' };
const parent = { ...root, id: root.pid, pid: null, display_name: '上级用户' };
const child = { ...root, id: '33333333-3333-4333-8333-333333333333', pid: root.id, display_name: '下级用户', parent_id: root.id, parent_display_name: root.display_name };
const page = (user = root, level = 1) => ({ user, parent: user.id === root.id ? parent : null, direct_count: 1, indirect_count: 2, items: [child], level, page: 1, total: level === 1 ? 1 : 2, has_more: false });
const file = path.join(__dirname, '../components/UserRelationsModal.tsx');

test('directory shows cash separate from credits, parent and both descendant counts', async () => {
  const row = { ...root, parent, direct_count: 1, indirect_count: 2, credit_balance: 50, held_credits: 0, available_credits: 50, commission_available_fen: 25850, commission_frozen_fen: 10000 };
  const h = componentHarness(path.join(__dirname, '../components/UsersPanel.tsx'), 'UsersPanel', { token: 'test' }, { '@/lib/api': { async apiRequest() { return [row]; } }, './UserRelationsModal': { UserRelationsModal: 'RelationsModal' } });
  await h.ready();
  const text = h.nodes().map(h.text).join(' ');
  assert.match(text, /¥358\.50/); assert.match(text, /可提现 ¥258\.50/); assert.match(text, /冻结 ¥100\.00/);
  assert.ok(h.button('上级：上级用户')); assert.ok(h.button('直接下级 1 人')); assert.ok(h.button('间接下级 2 人'));
  h.button('间接下级 2 人').props.onClick(); h.render();
  const modal = h.nodes().find(x => x.type === 'RelationsModal'); assert.equal(modal.props.userId, root.id); assert.equal(modal.props.initialLevel, 2);
});
test('relations start on requested level, use authenticated GET and switch levels from page one', async () => {
  const calls = [];
  const h = componentHarness(file, 'UserRelationsModal', { token: 'test-token', userId: root.id, initialLevel: 2, onClose() {} }, { '@/lib/api': { async apiRequest(...args) { calls.push(args); return page(root, args[0].includes('level=2') ? 2 : 1); } } });
  await h.ready(); assert.ok(calls[0][0].endsWith('?level=2&page=1')); assert.equal(calls[0][2], 'test-token'); assert.equal(calls[0][1].method, undefined);
  assert.equal(h.button('间接下级（2）').props['aria-pressed'], true);
  h.button('直接下级（1）').props.onClick(); h.render(); await h.ready();
  assert.ok(calls.at(-1)[0].endsWith('?level=1&page=1')); assert.equal(h.button('直接下级（1）').props['aria-pressed'], true);
  assert.equal(h.nodes().some(x => x.type === 'input'), false);
});
test('parent and child drilldown reset level/page and can navigate back', async () => {
  const calls = [];
  const h = componentHarness(file, 'UserRelationsModal', { token: 'test', userId: root.id, onClose() {} }, { '@/lib/api': { async apiRequest(url) { calls.push(url); return page(url.includes(parent.id) ? parent : url.includes(child.id) ? child : root); } } });
  await h.ready(); h.button('查看上级的关系').props.onClick(); h.render(); await h.ready();
  assert.ok(calls.at(-1).includes(parent.id)); assert.equal(h.button('返回上一用户').props.disabled, false);
  h.button('返回上一用户').props.onClick(); h.render(); await h.ready(); assert.ok(calls.at(-1).includes(root.id));
  h.button('查看此用户关系').props.onClick(); h.render(); await h.ready(); assert.ok(calls.at(-1).includes(child.id));
});
test('stale relation responses are aborted and cannot replace newly selected user data', async () => {
  const calls = []; let resolveOld;
  const h = componentHarness(file, 'UserRelationsModal', { token: 'test', userId: root.id, onClose() {} }, { '@/lib/api': { apiRequest(url, options) { calls.push([url, options]); return calls.length === 2 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(page(url.includes(parent.id) ? parent : root)); } } });
  await h.ready(); h.button('查看上级的关系').props.onClick(); h.render();
  // Tree still contains prior controls at this point; emulate a rapid second selection.
  h.button('直接下级（1）').props.onClick(); h.render();
  h.unmount(); assert.equal(calls.at(-1)[1].signal.aborted, true);
  resolveOld(page({ ...parent, display_name: '不得显示的过期响应' })); await h.ready();
  assert.ok(!h.nodes().map(h.text).join(' ').includes('不得显示的过期响应'));
});
