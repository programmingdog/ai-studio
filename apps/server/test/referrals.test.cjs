const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const rules = require('../dist/referrals/referral-rules');
const { ReferralsService } = require('../dist/referrals/referrals.service');
const { ReferralsController } = require('../dist/referrals/referrals.controller');
const { ReferralsAdminController } = require('../dist/referrals/referrals-admin.controller');
const { UserAuthGuard } = require('../dist/user-auth/user-auth.guard');
const { AdminAuthGuard } = require('../dist/auth/admin-auth.guard');
const { PermissionsGuard } = require('../dist/auth/permissions.guard');
const { REQUIRED_PERMISSIONS } = require('../dist/auth/permissions.decorator');

test('invitation generator produces eight mixed characters; normalizer rejects malformed input', () => {
  const codes = new Set();
  for (let i = 0; i < 2000; i++) {
    const code = rules.generateInviteCode();
    assert.match(code, /^[A-Z0-9]{8}$/); assert.match(code, /[A-Z]/); assert.match(code, /[0-9]/); codes.add(code);
  }
  assert.equal(codes.size, 2000);
  assert.equal(rules.inviteCode(' abcd2345 '), 'ABCD2345');
  for (const value of ['ABC', 'ABCDEFGH1', 'ABCD/123', '<script>']) assert.throws(() => rules.inviteCode(value));
});
test('commission uses integer fen, floors sub-fen, and never rounds via floating point', () => {
  assert.equal(rules.commissionFen(1000, 1000), 100);
  assert.equal(rules.commissionFen(1000, 500), 50);
  assert.equal(rules.commissionFen(799, 3333), 266);
  assert.equal(rules.commissionFen(1, 9999), 0);
  assert.equal(rules.commissionFen(Number.MAX_SAFE_INTEGER, 10000), Number.MAX_SAFE_INTEGER);
  for (const amount of [-1, 1.1, Infinity, NaN, '100', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => rules.commissionFen(amount, 1000));
  assert.throws(() => rules.commissionFen(100, 10001));
});
test('withdrawal opens exactly Friday 00:00 through 23:59:59 China time', () => {
  assert.equal(rules.withdrawalWindow(new Date('2026-09-03T15:59:59.999Z')).withdrawal_open, false);
  assert.equal(rules.withdrawalWindow(new Date('2026-09-03T16:00:00Z')).withdrawal_open, true);
  assert.equal(rules.withdrawalWindow(new Date('2026-09-04T15:59:59.999Z')).withdrawal_open, true);
  const closed = rules.withdrawalWindow(new Date('2026-09-04T16:00:00Z'));
  assert.equal(closed.withdrawal_open, false); assert.equal(closed.next_open_at, '2026-09-10T16:00:00.000Z');
  assert.equal(closed.timezone, 'Asia/Shanghai');
});
test('public links reject scripts, embedded credentials, HTTP in production, and fragments', () => {
  assert.equal(rules.publicUrl('https://example.com/invite', 'url'), 'https://example.com/invite');
  assert.equal(rules.publicUrl('http://localhost:3200/invite', 'url'), 'http://localhost:3200/invite');
  for (const value of ['javascript:alert(1)', 'https://user:pass@example.com/', 'http://example.com/', 'https://example.com/#x', '//example.com']) assert.throws(() => rules.publicUrl(value, 'url'));
});
test('receipt accepts small raster data only, rejects SVG, spoofed type and oversized payloads', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=';
  assert.equal(rules.receiptImage(png), png);
  const maximum = Buffer.alloc(2 * 1024 * 1024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(maximum);
  const maximumPng = `data:image/png;base64,${maximum.toString('base64')}`;
  assert.equal(rules.receiptImage(maximumPng), maximumPng);
  for (const value of ['https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', png.replace('image/png', 'image/jpeg'), png + 'a', 'data:image/png;base64,' + Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')]) assert.throws(() => rules.receiptImage(value));
});
test('user endpoints take identity only from authenticated principal', async () => {
  const calls = [];
  const c = new ReferralsController({ summary: id => calls.push(id), records: (...args) => calls.push(args), applyWithdrawal: (...args) => calls.push(args) });
  const req = { user: { sub: 'current-user' } };
  await c.me(req); await c.records(req, 'withdrawals', '2'); await c.apply(req, { user_id: 'someone-else', amount_fen: 100 });
  assert.equal(calls[0], 'current-user'); assert.deepEqual(calls[1], ['withdrawals', 'current-user', '2']); assert.equal(calls[2][0], 'current-user');
  for (const method of ['me', 'records', 'apply']) assert.ok(Reflect.getMetadata('__guards__', ReferralsController.prototype[method]).includes(UserAuthGuard));
});
test('admin config, audit and payout actions require distinct server permissions', () => {
  const guards = Reflect.getMetadata('__guards__', ReferralsAdminController);
  assert.ok(guards.includes(AdminAuthGuard)); assert.ok(guards.includes(PermissionsGuard));
  for (const method of ['claim', 'release', 'paid', 'payee']) assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, ReferralsAdminController.prototype[method]), ['payouts.manage']);
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, ReferralsAdminController.prototype.review), ['distribution.manage']);
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, ReferralsAdminController.prototype.save), ['configs.manage', 'distribution.manage']);
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, ReferralsAdminController.prototype.downloads), ['configs.manage']);
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, ReferralsAdminController.prototype.saveDownloads), ['configs.manage']);
});
test('record pagination is bounded, allowlisted, ownership-filtered and excludes payee secrets', async () => {
  const calls = [];
  const service = new ReferralsService({ query: async (sql, args) => { calls.push([sql, args]); return Array.from({ length: 51 }, (_, i) => ({ id: String(i) })); } }, {}, {});
  const result = await service.records('withdrawals', 'my-user', '2', 'PROCESSING');
  assert.equal(result.items.length, 50); assert.equal(result.has_more, true);
  assert.match(calls[0][0], /user_id = \? AND status = \?/); assert.match(calls[0][0], /OFFSET 50$/);
  assert.doesNotMatch(calls[0][0], /payee_ciphertext|request_hash|SELECT \*/); assert.deepEqual(calls[0][1], ['my-user', 'PROCESSING']);
  for (const page of ['0', '-1', '1.5', 'Infinity', '100001', '1; DROP TABLE users']) await assert.rejects(service.records('withdrawals', 'my-user', page));
  await assert.rejects(service.records('users')); await assert.rejects(service.records('withdrawals', 'my-user', '1', 'INVALID'));
});
test('invite collision retries and already assigned codes are stable', async () => {
  let attempts = 0;
  const connection = { query: async () => [[{ invite_code: null }]], execute: async () => { if (++attempts === 1) throw Object.assign(Error('collision'), { code: 'ER_DUP_ENTRY' }); } };
  const service = new ReferralsService({}, {}, {});
  assert.match(await service.ensureInviteCode('u', connection), /^[A-Z0-9]{8}$/); assert.equal(attempts, 2);
  connection.query = async () => [[{ invite_code: 'ABCD2345' }]];
  assert.equal(await service.ensureInviteCode('u', connection), 'ABCD2345'); assert.equal(attempts, 2);
});
test('invalid distribution configuration is rejected before entering transaction', async () => {
  const service = new ReferralsService({ transaction: () => { throw Error('unexpected transaction'); } }, {}, {});
  const valid = { enabled: true, direct_rate_bps: 1000, indirect_rate_bps: 500, minimum_withdrawal_fen: 10000, invitation_reward_credits: 20, invitation_anti_abuse_enabled: true, invitation_daily_reward_limit: 20, invitation_monthly_reward_limit: 200, invite_page_base_url: 'https://example.com/invite', windows_download_url: '', macos_download_url: '', revision: 0 };
  for (const patch of [{ direct_rate_bps: 9900, indirect_rate_bps: 101 }, { direct_rate_bps: 0, indirect_rate_bps: 0 }, { minimum_withdrawal_fen: 0 }, { invitation_reward_credits: 1.5 }, { enabled: 'true' }, { invitation_anti_abuse_enabled: 'true' }, { invitation_daily_reward_limit: 0 }, { invitation_daily_reward_limit: 201 }, { invite_page_base_url: 'https://example.com/invite?code=abc' }]) await assert.rejects(service.saveConfig('admin', { ...valid, ...patch }), error => error.getStatus() === 400);
});

test('anti-abuse mode keeps registration reward pending and first real payment releases it within caps', async () => {
  const parent = 'parent', invited = 'invited', rewardId = 'reward', orderId = 'order';
  const executed = [];
  const config = { enabled: false, direct_rate_bps: 0, indirect_rate_bps: 0, minimum_withdrawal_fen: 10000, invitation_reward_credits: 20, invitation_anti_abuse_enabled: true, invitation_daily_reward_limit: 2, invitation_monthly_reward_limit: 10, invite_page_base_url: '', windows_download_url: '', macos_download_url: '', revision: 1 };
  const connection = {
    async execute(sql, parameters) { executed.push([sql, parameters]); return [{ affectedRows: 1 }]; },
    async query(sql) {
      if (sql.startsWith('SELECT id FROM users')) return [[{ id: parent }]];
      if (sql.startsWith('SELECT inviter_id')) return [[{ inviter_id: parent }]];
      if (sql.startsWith('SELECT status FROM users')) return [[{ status: 'ACTIVE' }]];
      if (sql.startsWith('SELECT * FROM referral_rewards')) return [[{ id: rewardId, inviter_id: parent, invited_user_id: invited, credits: 20, status: 'PENDING_PAYMENT', daily_limit_snapshot: 2, monthly_limit_snapshot: 10 }]];
      if (sql.startsWith('SELECT period_type')) return [[{ period_type: 'DAY', rewarded_count: 0 }, { period_type: 'MONTH', rewarded_count: 0 }]];
      if (sql.startsWith('SELECT id FROM ledger_accounts')) return [[{ id: 'account' }]];
      if (sql.startsWith('SELECT payment_order_id')) return [[]];
      return [[]];
    },
  };
  const service = new ReferralsService({}, {}, { values: { adminOrigin: 'https://example.invalid' } });
  service.ensureInviteCode = async () => 'CODE2345'; service.inviter = async () => parent; service.config = async () => config;
  await service.newUser(connection, invited, 'CODE2345');
  assert.ok(executed.some(([sql, parameters]) => sql.startsWith('INSERT INTO referral_rewards') && parameters.includes('PENDING_PAYMENT')));
  assert.equal(executed.some(([sql]) => sql.startsWith('INSERT INTO ledger_entries')), false);
  executed.length = 0;
  await service.settlePayment(connection, orderId, invited, 100);
  assert.ok(executed.some(([sql]) => sql.startsWith('INSERT INTO ledger_entries')));
  assert.ok(executed.some(([sql, parameters]) => sql.startsWith("UPDATE referral_rewards SET status = 'REWARDED'") && parameters.includes(orderId)));
});

test('disabled anti-abuse mode preserves immediate registration rewards', async () => {
  const executed = [], parent = 'parent', invited = 'invited';
  const connection = {
    async execute(sql, parameters) { executed.push([sql, parameters]); return [{ affectedRows: 1 }]; },
    async query(sql) {
      if (sql.startsWith('SELECT id FROM users')) return [[{ id: parent }]];
      if (sql.startsWith('SELECT id FROM ledger_accounts')) return [[{ id: 'account' }]];
      return [[]];
    },
  };
  const service = new ReferralsService({}, {}, { values: { adminOrigin: 'https://example.invalid' } });
  service.ensureInviteCode = async () => 'CODE2345'; service.inviter = async () => parent;
  service.config = async () => ({ invitation_reward_credits: 20, invitation_anti_abuse_enabled: false, invitation_daily_reward_limit: 2, invitation_monthly_reward_limit: 10, revision: 1 });
  await service.newUser(connection, invited, 'CODE2345');
  assert.ok(executed.some(([sql, parameters]) => sql.startsWith('INSERT INTO referral_rewards') && parameters.includes('REWARDED')));
  assert.ok(executed.some(([sql]) => sql.startsWith('INSERT INTO ledger_entries')));
});

test('anti-abuse cap marks a qualified invitation limited without issuing credits', async () => {
  const executed = [], parent = 'parent', invited = 'invited', orderId = 'order';
  const connection = {
    async execute(sql, parameters) { executed.push([sql, parameters]); return [{ affectedRows: 1 }]; },
    async query(sql) {
      if (sql.startsWith('SELECT payment_order_id')) return [[]];
      if (sql.startsWith('SELECT inviter_id')) return [[{ inviter_id: parent }]];
      if (sql.startsWith('SELECT status FROM users')) return [[{ status: 'ACTIVE' }]];
      if (sql.startsWith('SELECT * FROM referral_rewards')) return [[{ id: 'reward', inviter_id: parent, invited_user_id: invited, credits: 20, status: 'PENDING_PAYMENT', daily_limit_snapshot: 2, monthly_limit_snapshot: 10 }]];
      if (sql.startsWith('SELECT period_type')) return [[{ period_type: 'DAY', rewarded_count: 2 }, { period_type: 'MONTH', rewarded_count: 2 }]];
      return [[]];
    },
  };
  const service = new ReferralsService({}, {}, {});
  service.config = async () => ({ enabled: false, direct_rate_bps: 0, indirect_rate_bps: 0, revision: 1 });
  await service.settlePayment(connection, orderId, invited, 100);
  assert.equal(executed.some(([sql]) => sql.startsWith('INSERT INTO ledger_entries')), false);
  assert.ok(executed.some(([sql, parameters]) => sql.startsWith("UPDATE referral_rewards SET status = 'LIMITED'") && parameters.includes('已达到每日邀请奖励人数上限')));
});

test('software download settings validate URLs and update without changing distribution rules', async () => {
  const executed = [];
  const connection = {
    async query() { return [[{ revision: 5 }]]; },
    async execute(sql, parameters) { executed.push([sql, parameters]); },
  };
  const row = { enabled: 0, direct_rate_bps: 1000, indirect_rate_bps: 500, minimum_withdrawal_fen: 10000, invitation_reward_credits: 20, invite_page_base_url: 'https://example.invalid/invite', windows_download_url: 'https://download.example.invalid/app.exe', macos_download_url: '', revision: 6, updated_at: 'now' };
  const database = { async transaction(operation) { return operation(connection); }, async query() { return [row]; } };
  const service = new ReferralsService(database, {}, { values: { adminOrigin: 'https://example.invalid' } });
  const result = await service.saveDownloadConfig('admin-1', { windows_download_url: row.windows_download_url, macos_download_url: '', revision: 5 });
  assert.match(executed[0][0], /SET windows_download_url = \?, macos_download_url = \?/);
  assert.deepEqual(executed[0][1], [row.windows_download_url, '', 'admin-1']);
  assert.match(executed[1][0], /INSERT INTO audit_logs/);
  assert.equal(result.revision, 6);
  await assert.rejects(() => service.saveDownloadConfig('admin-1', { windows_download_url: '', macos_download_url: '', revision: 6 }), /至少需要配置一个/);
  await assert.rejects(() => service.saveDownloadConfig('admin-1', { windows_download_url: 'http:\/\/example.invalid\/app.exe', macos_download_url: '', revision: 6 }), /HTTPS/);
});
