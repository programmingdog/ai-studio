const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { componentHarness, flush } = require('../../../tests/support/react-hooks.cjs');
const file = path.join(__dirname, '../components/DistributionPanel.tsx');
const base = { enabled: false, direct_rate_bps: 1000, indirect_rate_bps: 500, minimum_withdrawal_fen: 10000, invitation_reward_credits: 20, invitation_anti_abuse_enabled: true, invitation_daily_reward_limit: 20, invitation_monthly_reward_limit: 200, invite_page_base_url: 'https://example.invalid/invite', windows_download_url: '', macos_download_url: '', revision: 2 };
test('config converts percentages and yuan to integers and preserves optimistic revision', async () => {
  const calls = [];
  const h = componentHarness(file, 'DistributionConfigPanel', { token: 'test-token' }, { '@/lib/api': { async apiRequest(...args) { calls.push(args); return { ...base }; } } });
  await h.ready();
  const decimal = () => h.nodes().filter(x => x.type === 'input' && x.props.inputMode === 'decimal');
  h.edit(decimal()[0], '12.34'); h.edit(decimal()[1], '5.67'); h.edit(decimal()[2], '88.99');
  await h.nodes().find(x => x.type === 'form').props.onSubmit({ preventDefault() {} });
  const body = JSON.parse(calls[1][1].body);
  assert.equal(body.direct_rate_bps, 1234); assert.equal(body.indirect_rate_bps, 567); assert.equal(body.minimum_withdrawal_fen, 8899); assert.equal(body.revision, 2);
  assert.equal(body.invitation_anti_abuse_enabled, true); assert.equal(body.invitation_daily_reward_limit, 20); assert.equal(body.invitation_monthly_reward_limit, 200);
  h.edit(decimal()[0], '1.234'); await h.nodes().find(x => x.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 2);
});
test('anti-abuse switch explains both reward strategies and exposes daily and monthly limits', async () => {
  const h = componentHarness(file, 'DistributionConfigPanel', { token: 'test-token' }, { '@/lib/api': { async apiRequest() { return { ...base }; } } });
  await h.ready();
  assert.ok(h.nodes().some(node => h.text(node).includes('首笔真实支付')));
  const checkbox = h.nodes().find(node => node.type === 'input' && node.props.type === 'checkbox');
  h.edit(checkbox, false);
  assert.ok(h.nodes().some(node => h.text(node).includes('注册成功立即发放')));
});
test('approved record explicitly claims task before fetching payee, rapid duplicate clicks are suppressed', async () => {
  const calls = [], row = { id: 'withdrawal', status: 'APPROVED', amount_fen: 10000, created_at: '2026-09-04T08:00:00Z' };
  const h = componentHarness(file, 'DistributionRecordsPanel', { token: 'test', kind: 'withdrawals' }, { '@/lib/api': { async apiRequest(url) { calls.push(url); return url.includes('/records/') ? { items: [row] } : { ...row, can_confirm: true, status: 'PROCESSING' }; } } });
  await h.ready();
  const click = h.button('领取打款任务').props.onClick; click(); click(); await h.ready();
  assert.equal(calls.filter(x => x.endsWith('/claim')).length, 1);
  assert.ok(calls.indexOf('/admin/distribution/withdrawals/withdrawal/claim') < calls.indexOf('/admin/distribution/withdrawals/withdrawal/payee'));
  assert.equal(h.nodes().find(x => x.type.name === 'PayoutDialog').props.row.can_confirm, true);
});
test('payout view is read-only without ownership and only records after explicit confirmation', async () => {
  const calls = [], row = { id: 'withdrawal', status: 'PROCESSING', amount_fen: 10000, can_confirm: false };
  const imports = { '@/lib/api': { async apiRequest(...args) { calls.push(args); return {}; } } };
  const props = { token: 'test', row, onClose() {}, async onSaved() {} };
  const readonly = componentHarness(file, 'PayoutDialog', props, imports);
  assert.equal(readonly.nodes().filter(x => x.type === 'form').length, 0);
  const h = componentHarness(file, 'PayoutDialog', { ...props, row: { ...row, can_confirm: true } }, imports);
  const form = () => h.nodes().find(x => x.type === 'form');
  await form().props.onSubmit({ preventDefault() {} }); assert.equal(calls.length, 0);
  h.edit(h.nodes().find(x => x.type === 'input' && x.props.minLength === 6), 'TEST_ALIPAY_123');
  h.edit(h.nodes().find(x => x.type === 'textarea'), '仅测试，非真实转账');
  h.edit(h.nodes().find(x => x.type === 'input' && x.props.type === 'checkbox'), true);
  const submit = form().props.onSubmit; submit({ preventDefault() {} }); submit({ preventDefault() {} }); await flush();
  assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0][1].body).confirmed, true);
});
test('releasing payout claim requires separate unpaid confirmation and explanation', async () => {
  const calls = [];
  const h = componentHarness(file, 'PayoutDialog', { token: 'test', row: { id: 'w', can_confirm: true }, onClose() {}, async onSaved() {} }, { '@/lib/api': { async apiRequest(...args) { calls.push(args); } } });
  h.button('确认未打款，释放任务').props.onClick(); await flush(); assert.equal(calls.length, 0);
  h.edit(h.nodes().filter(x => x.type === 'input' && x.props.type === 'checkbox')[1], true);
  assert.equal(h.button('确认已打款并记账').props.disabled, true);
  h.edit(h.nodes().find(x => x.type === 'textarea'), '核对流水后确认未打款');
  await h.button('确认未打款，释放任务').props.onClick();
  assert.equal(JSON.parse(calls[0][1].body).not_paid, true); assert.ok(calls[0][0].endsWith('/release'));
});
test('invitation registration sends fixed route invitation and discards its temporary web session', async () => {
  const calls = [];
  const h = componentHarness(path.join(__dirname, '../components/InvitationRegister.tsx'), 'InvitationRegister', { code: 'TEST2345' }, { '@/lib/api': { ApiError: class extends Error {}, async apiRequest(...args) { calls.push(args); return args[0].startsWith('/referrals/') ? { invite_code: 'TEST2345', windows_download_url: '', macos_download_url: '' } : { access_token: 'temporary-test-token' }; } }, '@/components/ProductBrand': { useProductBrand: () => ({ chinese_name: '影匠', english_name: 'Yingjiang' }) } });
  await h.ready();
  const inputs = () => h.nodes().filter(x => x.type === 'input');
  h.edit(inputs()[0], 'New@Example.invalid'); h.edit(inputs()[1], 'Password123'); h.edit(inputs()[3], '012345');
  const submit = h.nodes().find(x => x.type === 'form').props.onSubmit;
  submit({ preventDefault() {} }); submit({ preventDefault() {} }); await h.ready();
  const registrations = calls.filter(x => x[0] === '/auth/register/email'); assert.equal(registrations.length, 1);
  const body = JSON.parse(registrations[0][1].body); assert.equal(body.invite_code, 'TEST2345'); assert.equal(body.email, 'new@example.invalid'); assert.equal(body.pid, undefined);
  assert.ok(calls.some(x => x[0] === '/auth/logout' && x[2] === 'temporary-test-token'));
  assert.equal(h.nodes().filter(x => x.type === 'input' && x.props.type === 'password').length, 0);
});

test('invitation page does not disclose internal inviter binding or rewards', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '../components/InvitationRegister.tsx'), 'utf8');
  assert.doesNotMatch(source, /注册成功即绑定|已有账户不重新绑定|邀请人会获得|自动绑定邀请人|创建账户并绑定邀请/);
  assert.match(source, /请立即下载客户端/);
});

test('software download settings save independently with optimistic revision', async () => {
  const calls = [];
  const downloadFile = path.join(__dirname, '../components/SoftwareDownloadConfigPanel.tsx');
  const initial = { windows_download_url: '', macos_download_url: 'https://download.example.invalid/app.dmg', revision: 5, updated_at: '2026-09-05T00:00:00Z' };
  const h = componentHarness(downloadFile, 'SoftwareDownloadConfigPanel', { token: 'test-token' }, { '@/lib/api': { async apiRequest(...args) { calls.push(args); return args[1]?.method === 'PATCH' ? { ...JSON.parse(args[1].body), revision: 6 } : initial; } } });
  await h.ready();
  const inputs = h.nodes().filter(node => node.type === 'input' && node.props.type === 'url');
  h.edit(inputs[0], 'https://download.example.invalid/app.exe');
  await h.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(calls[1][0], '/admin/distribution/downloads');
  const body = JSON.parse(calls[1][1].body);
  assert.equal(body.windows_download_url, 'https://download.example.invalid/app.exe');
  assert.equal(body.macos_download_url, initial.macos_download_url);
  assert.equal(body.revision, 5);
});
