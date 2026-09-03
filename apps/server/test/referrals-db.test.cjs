// Opt-in MySQL integration: ALL fixtures and config changes stay in ONE transaction,
// with savepoints for service transactions and an unconditional final ROLLBACK.
// No HTTP, mail, WeChat orders, or Alipay transfers are made.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync, createSign, createCipheriv, randomBytes } = require('node:crypto');
const path = require('node:path');
require('reflect-metadata');
const rules = require('../dist/referrals/referral-rules');
const { ReferralsService } = require('../dist/referrals/referrals.service');
const { CreditsService } = require('../dist/credits/credits.service');
const { SecretCryptoService } = require('../dist/common/secret-crypto.service');
const { AdminService } = require('../dist/admin/admin.service');
const qr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=';

test('referral financial SQL integration (all data rolled back)', { skip: process.env.AIVS_TEST_DB !== '1' }, async t => {
  require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
  const { loadDatabaseConfig } = require('../dist/config/environment');
  const config = loadDatabaseConfig();
  const c = await require('mysql2/promise').createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, timezone: 'Z', charset: 'utf8mb4' });
  const ids = Array.from({ length: 7 }, () => randomUUID());
  const [a, b, child, fourth, other, admin, admin2] = ids;
  const environment = { values: { credentialEncryptionKey: 'integration-only-encryption-key-32-chars', adminOrigin: 'https://example.invalid' } };
  const crypto = new SecretCryptoService(environment);
  let savepoint = 0, queue = Promise.resolve();
  const db = {
    query: async (sql, params = []) => (await c.query(sql, params))[0], execute: async (sql, params = []) => (await c.execute(sql, params))[0],
    transaction: operation => {
      const run = queue.then(async () => {
        const name = `referral_test_${++savepoint}`;
        await c.query(`SAVEPOINT ${name}`);
        try { const result = await operation(c); await c.query(`RELEASE SAVEPOINT ${name}`); return result; }
        catch (error) { await c.query(`ROLLBACK TO SAVEPOINT ${name}`); await c.query(`RELEASE SAVEPOINT ${name}`); throw error; }
      });
      queue = run.catch(() => {}); return run;
    },
  };
  const service = new ReferralsService(db, crypto, environment);
  const adminService = new AdminService(db, {}, crypto, {});
  const window = rules.withdrawalWindow;
  const friday = () => { rules.withdrawalWindow = () => window(new Date('2026-09-04T08:00:00Z')); };
  const closed = () => { rules.withdrawalWindow = () => window(new Date('2026-09-05T08:00:00Z')); };
  const user = async id => {
    await c.execute("INSERT INTO users (id, display_name) VALUES (?, 'Rollback-only referral test')", [id]);
    await c.execute("INSERT INTO ledger_accounts (id, owner_type, owner_id, account_type, currency) VALUES (?, 'USER', ?, 'AVAILABLE', 'CREDIT')", [randomUUID(), id]);
    return service.ensureInviteCode(id, c);
  };
  const order = async (payer = child, amount = 100000) => {
    const id = randomUUID(), trade = randomUUID().replaceAll('-', ''), purchase = randomUUID();
    await c.execute("INSERT INTO payment_orders (id, user_id, out_trade_no, description, amount_fen) VALUES (?, ?, ?, 'Rollback-only test', ?)", [id, payer, trade, amount]);
    await c.execute("INSERT INTO credit_package_purchases (id, purchase_no, user_id, package_code_snapshot, package_name_snapshot, base_credits_snapshot, credits_granted, paid_amount_fen, payment_order_id) VALUES (?, ?, ?, 'test', 'test', 100, 100, ?, ?)", [purchase, randomUUID(), payer, amount, id]);
    return { id, trade, purchase, payer, amount };
  };
  const wallet = async id => {
    const [row] = await db.query('SELECT available_fen, frozen_fen, earned_fen, paid_fen FROM commission_wallets WHERE user_id = ?', [id]);
    const wallet = Object.fromEntries(Object.entries(row || { available_fen: 0, frozen_fen: 0, earned_fen: 0, paid_fen: 0 }).map(([key, value]) => [key, Number(value)]));
    const [user] = await db.query('SELECT balance_fen FROM users WHERE id = ?', [id]);
    assert.equal(Number(user.balance_fen), wallet.available_fen + wallet.frozen_fen, 'user balance must equal available plus frozen after every lifecycle transition');
    return wallet;
  };
  const input = (amount = 10000) => ({ amount_fen: amount, idempotency_key: randomUUID(), alipay_real_name: '测试收款人', alipay_account: 'test@example.invalid', alipay_qr_code: qr });
  const count = async (table, column, value) => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [value]))[0].n);
  await c.beginTransaction();
  try {
    for (const id of [admin, admin2]) await c.execute("INSERT INTO admin_users (id, email, password_hash, display_name) VALUES (?, ?, 'not-a-real-password-hash', 'Rollback test operator')", [id, `${id}@example.invalid`]);
    // The singleton is locked only during this short test, never committed.
    await c.execute('UPDATE distribution_configs SET enabled = 1, direct_rate_bps = 1000, indirect_rate_bps = 500, minimum_withdrawal_fen = 10000, invitation_reward_credits = 20, invitation_anti_abuse_enabled = 0, invitation_daily_reward_limit = 20, invitation_monthly_reward_limit = 200 WHERE id = 1');
    const aCode = await user(a), bCode = await user(b), childCode = await user(child); await user(fourth); await user(other);

    await t.test('verified new users bind once and award exactly 20 credit ledger units', async () => {
      await db.transaction(cx => service.newUser(cx, b, aCode));
      await db.transaction(cx => service.newUser(cx, child, bCode));
      await db.transaction(cx => service.newUser(cx, fourth, childCode));
      assert.equal((await db.query('SELECT pid FROM users WHERE id = ?', [child]))[0].pid, b);
      const [balance] = await db.query('SELECT SUM(le.amount) AS n FROM ledger_accounts la JOIN ledger_entries le ON le.account_id = la.id WHERE la.owner_id = ?', [b]);
      assert.equal(Number(balance.n), 20);
      await assert.rejects(db.transaction(cx => service.newUser(cx, child, aCode)), /重复绑定/);
      assert.equal(await count('referral_rewards', 'invited_user_id', child), 1);
      await assert.rejects(db.transaction(cx => service.newUser(cx, a, aCode)), /自己/);
      await assert.rejects(c.execute('UPDATE users SET invite_code = ? WHERE id = ?', [aCode, other]), e => e.code === 'ER_DUP_ENTRY');
    });
    await t.test('failed registration binding rolls all new rows back', async () => {
      const failed = randomUUID();
      await assert.rejects(db.transaction(async cx => {
        await cx.execute("INSERT INTO users (id) VALUES (?)", [failed]);
        await service.newUser(cx, failed, undefined, '00000000-0000-0000-0000-999999999999');
      }), /停用/);
      assert.equal(await count('users', 'id', failed), 0);
    });
    await t.test('public invitation exposes no profile; disabled inviters reject new binding', async () => {
      const invitation = await service.publicInvitation(aCode.toLowerCase());
      assert.deepEqual(Object.keys(invitation).sort(), ['invite_code', 'macos_download_url', 'windows_download_url']);
      assert.equal(invitation.invite_code, aCode);
      await c.execute("UPDATE users SET status = 'DISABLED' WHERE id = ?", [other]);
      const otherCode = await service.ensureInviteCode(other, c);
      await assert.rejects(service.publicInvitation(otherCode), /不存在或邀请人已停用/);
      await assert.rejects(db.transaction(cx => service.newUser(cx, a, otherCode)), /不存在或邀请人已停用/);
      await c.execute("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [other]);
    });
    await t.test('reward ledger failure rolls back parent binding and invitation reward', async () => {
      // Synthetic parent without a credit account exercises rollback after reward insert.
      const brokenParent = randomUUID();
      try {
        await c.query('SAVEPOINT broken_reward_fixture');
        await c.execute('INSERT INTO users (id) VALUES (?)', [brokenParent]);
        const brokenCode = await service.ensureInviteCode(brokenParent, c);
        await assert.rejects(db.transaction(cx => service.newUser(cx, other, brokenCode)), /积分账户不存在/);
        assert.equal((await db.query('SELECT pid FROM users WHERE id = ?', [other]))[0].pid, null);
        assert.equal(await count('referral_rewards', 'invited_user_id', other), 0);
      } finally { await c.query('ROLLBACK TO SAVEPOINT broken_reward_fixture'); await c.query('RELEASE SAVEPOINT broken_reward_fixture'); }
    });
    await t.test('admin directory and relation pages agree on parent and exact two-level counts', async () => {
      const first = await adminService.userRelations(a, '1');
      assert.equal(first.parent, null); assert.equal(first.direct_count, 1); assert.equal(first.indirect_count, 1);
      assert.deepEqual(first.items.map(x => x.id), [b]);
      const second = await adminService.userRelations(a, '2');
      assert.deepEqual(second.items.map(x => x.id), [child]); assert.equal(second.items[0].parent_id, b);
      assert.ok(!second.items.some(x => x.id === fourth));
      await c.execute("UPDATE users SET status = 'DISABLED' WHERE id = ?", [child]);
      try {
        const relatives = await adminService.userRelations(b, '1');
        assert.equal(relatives.parent.id, a); assert.equal(relatives.direct_count, 1); assert.equal(relatives.indirect_count, 1);
        assert.equal(relatives.items[0].status, 'DISABLED');
        const directory = (await adminService.listUsers('200')).find(x => x.id === b);
        assert.equal(directory.parent.id, a); assert.equal(directory.direct_count, relatives.direct_count); assert.equal(directory.indirect_count, relatives.indirect_count);
        assert.equal(directory.balance_fen, 0); assert.equal(directory.commission_frozen_fen, 0);
        const output = JSON.stringify([directory, relatives]); assert.ok(!output.includes('password_hash')); assert.ok(!output.includes('payee_ciphertext'));
      } finally { await c.execute("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [child]); }
      const leaf = await adminService.userRelations(fourth); assert.equal(leaf.parent.id, child); assert.equal(leaf.direct_count, 0); assert.deepEqual(leaf.items, []);
      await assert.rejects(adminService.userRelations(randomUUID()), /不存在/);
    });
    await t.test('relationship pagination uses all pid bindings, even without reward records', async () => {
      await c.query('SAVEPOINT relation_page_fixture');
      try {
        const fixtures = Array.from({ length: 51 }, () => [randomUUID(), other, 'Pagination fixture']);
        await c.query('INSERT INTO users (id, pid, display_name) VALUES ?', [fixtures]);
        const first = await adminService.userRelations(other, '1', '1'), second = await adminService.userRelations(other, '1', '2');
        assert.equal(first.direct_count, 51); assert.equal(first.total, 51); assert.equal(first.items.length, 50); assert.equal(first.has_more, true);
        assert.equal(second.items.length, 1); assert.equal(second.has_more, false); assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 51);
        assert.equal((await adminService.userRelations(other, '1', '3')).items.length, 0);
        assert.equal((await adminService.userRelations(other, '2')).total, 0);
        assert.equal(await count('referral_rewards', 'inviter_id', other), 0);
      } finally { await c.query('ROLLBACK TO SAVEPOINT relation_page_fixture'); await c.query('RELEASE SAVEPOINT relation_page_fixture'); }
    });
    await t.test('10 yuan pays direct 1 yuan and indirect 0.50; no third level', async () => {
      const purchase = await order(fourth, 1000);
      await db.transaction(cx => service.settlePayment(cx, purchase.id, fourth, 1000));
      const rows = await db.query('SELECT beneficiary_id, level, amount_fen FROM commission_records WHERE payment_order_id = ? ORDER BY level', [purchase.id]);
      assert.deepEqual(rows.map(x => [x.beneficiary_id, x.level, Number(x.amount_fen)]), [[child, 1, 100], [b, 2, 50]]);
      assert.equal((await wallet(a)).earned_fen, 0);
      await db.transaction(cx => service.settlePayment(cx, purchase.id, fourth, 1000));
      assert.equal(await count('commission_records', 'payment_order_id', purchase.id), 2);
    });
    await t.test('ledger failure rolls back wallet, user balance projection, settlement and commission records', async () => {
      const purchase = await order(); const beforeA = await wallet(a), beforeB = await wallet(b);
      const execute = c.execute;
      c.execute = function(sql, parameters) {
        if (sql.startsWith('INSERT INTO commission_wallet_entries')) return Promise.reject(Error('simulated wallet ledger failure'));
        return execute.call(this, sql, parameters);
      };
      try { await assert.rejects(db.transaction(cx => service.settlePayment(cx, purchase.id, child, 100000)), /simulated wallet ledger failure/); }
      finally { c.execute = execute; }
      assert.deepEqual(await wallet(a), beforeA); assert.deepEqual(await wallet(b), beforeB);
      assert.equal(await count('distribution_settlements', 'payment_order_id', purchase.id), 0);
      assert.equal(await count('commission_records', 'payment_order_id', purchase.id), 0);
    });
    await t.test('disabled and zero-paid orders never accrue or backfill on later enable', async () => {
      const purchase = await order();
      await c.execute('UPDATE distribution_configs SET enabled = 0 WHERE id = 1');
      await db.transaction(cx => service.settlePayment(cx, purchase.id, child, 100000));
      await c.execute('UPDATE distribution_configs SET enabled = 1 WHERE id = 1');
      await db.transaction(cx => service.settlePayment(cx, purchase.id, child, 100000));
      assert.equal(await count('commission_records', 'payment_order_id', purchase.id), 0);
      const free = await order(); await db.transaction(cx => service.settlePayment(cx, free.id, child, 0));
      assert.equal(await count('commission_records', 'payment_order_id', free.id), 0);
    });
    await t.test('inactive recipient is skipped without shifting levels or paying third ancestor', async () => {
      const purchase = await order(fourth, 1000);
      await c.execute("UPDATE users SET status = 'DISABLED' WHERE id = ?", [child]);
      try {
        await db.transaction(cx => service.settlePayment(cx, purchase.id, fourth, 1000));
        const rows = await db.query('SELECT beneficiary_id, level, amount_fen FROM commission_records WHERE payment_order_id = ?', [purchase.id]);
        assert.deepEqual(rows.map(row => [row.beneficiary_id, row.level, Number(row.amount_fen)]), [[b, 2, 50]]);
      } finally { await c.execute("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [child]); }
    });
    await t.test('real signature/decryption callback uses payer_total excluding coupon; duplicate notifications are harmless', async () => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const runtime = { merchantId: 'test-merchant', appId: 'test-app', verifierKey: publicKey.export({ type: 'spki', format: 'pem' }), verifierId: 'PUB_KEY_ID_TEST', apiV3Key: '12345678901234567890123456789012' };
      const credits = new CreditsService(db, crypto, service);
      credits.wechatRuntime = async () => runtime; // Only merchant config replaced, actual RSA/AES code runs.
      const signed = (purchase, overrides = {}, notificationId = randomUUID()) => {
        const transaction = { mchid: runtime.merchantId, appid: runtime.appId, trade_state: 'SUCCESS', out_trade_no: purchase.trade, transaction_id: randomUUID(), amount: { total: purchase.amount, currency: 'CNY', payer_total: 80000, payer_currency: 'CNY' }, ...overrides };
        const nonce = randomBytes(6).toString('hex'), aad = 'transaction';
        const cipher = createCipheriv('aes-256-gcm', Buffer.from(runtime.apiV3Key), Buffer.from(nonce)); cipher.setAAD(Buffer.from(aad));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]).toString('base64');
        const body = JSON.stringify({ id: notificationId, resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext, nonce, associated_data: aad } });
        const timestamp = String(Math.floor(Date.now() / 1000)), headerNonce = randomUUID();
        const signature = createSign('RSA-SHA256').update(`${timestamp}\n${headerNonce}\n${body}\n`).sign(privateKey, 'base64');
        return [{ 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': headerNonce, 'wechatpay-signature': signature, 'wechatpay-serial': runtime.verifierId }, body];
      };
      const purchase = await order(); const payload = signed(purchase);
      await assert.rejects(credits.handleWechatNotification(payload[0], payload[1] + ' '), /签名/);
      await credits.handleWechatNotification(...payload); await credits.handleWechatNotification(...payload);
      await credits.handleWechatNotification(...signed(purchase));
      const rows = await db.query('SELECT level, amount_fen, base_amount_fen FROM commission_records WHERE payment_order_id = ? ORDER BY level', [purchase.id]);
      assert.deepEqual(rows.map(x => [x.level, Number(x.amount_fen), Number(x.base_amount_fen)]), [[1, 8000, 80000], [2, 4000, 80000]]);
      assert.equal(Number((await db.query('SELECT payer_paid_amount_fen FROM payment_orders WHERE id = ?', [purchase.id]))[0].payer_paid_amount_fen), 80000);
      assert.equal(await count('ledger_transactions', 'reference_id', purchase.purchase), 1);
      const invalid = await order();
      for (const patch of [{ mchid: 'different' }, { amount: { total: 9999, payer_total: 9999, currency: 'CNY', payer_currency: 'CNY' } }, { amount: { total: 100000, currency: 'CNY' } }, { amount: { total: 100000, payer_total: 100001, currency: 'CNY', payer_currency: 'CNY' } }]) await assert.rejects(credits.handleWechatNotification(...signed(invalid, patch)));
      assert.equal(await count('ledger_transactions', 'reference_id', invalid.purchase), 0);
      const rollback = await order(); const retryPayload = signed(rollback);
      const settling = service.settlePayment;
      service.settlePayment = async () => { throw Error('simulated commission failure'); };
      try { await assert.rejects(credits.handleWechatNotification(...retryPayload), /simulated/); } finally { service.settlePayment = settling; }
      assert.equal((await db.query('SELECT status FROM payment_orders WHERE id = ?', [rollback.id]))[0].status, 'CREATED');
      assert.equal(await count('ledger_transactions', 'reference_id', rollback.purchase), 0);
      assert.equal(await count('payment_notifications', 'payment_order_id', rollback.id), 0);
      await credits.handleWechatNotification(...retryPayload);
      assert.equal(await count('commission_records', 'payment_order_id', rollback.id), 2);
    });
    // Large synthetic real-paid order funds only test beneficiaries; still uncommitted.
    const funds = await order(child, 10000000); await db.transaction(cx => service.settlePayment(cx, funds.id, child, 10000000));
    await t.test('configuration snapshots and optimistic revision prevent silent overwrite', async () => {
      const before = await service.config();
      const saved = await service.saveConfig(admin, { ...before, direct_rate_bps: 1200 });
      assert.equal(saved.revision, before.revision + 1);
      await assert.rejects(service.saveConfig(admin, before), /重新读取/);
      assert.equal(Number((await db.query('SELECT direct_rate_bps FROM distribution_settlements WHERE payment_order_id = ?', [funds.id]))[0].direct_rate_bps), 1000);
    });
    await t.test('server rejects non-Friday, below-minimum and insufficient-balance withdrawals', async () => {
      closed(); await assert.rejects(service.applyWithdrawal(b, input()), /周五/);
      friday(); await assert.rejects(service.applyWithdrawal(b, input(9999)), /最低/);
      await assert.rejects(service.applyWithdrawal(other, input()), /余额不足/);
      assert.equal(await count('withdrawal_applications', 'user_id', b), 0);
    });
    let pending;
    await t.test('withdrawal freeze is atomic and same request replays without double freeze', async () => {
      friday(); const request = input(); const before = await wallet(b);
      const results = await Promise.all([service.applyWithdrawal(b, request), service.applyWithdrawal(b, request)]);
      assert.equal(results[0].id, results[1].id); pending = results[0].id;
      assert.deepEqual(await wallet(b), { ...before, available_fen: before.available_fen - 10000, frozen_fen: before.frozen_fen + 10000 });
      closed(); assert.equal((await service.applyWithdrawal(b, request)).idempotent_replay, true);
      friday(); await assert.rejects(service.applyWithdrawal(b, { ...request, amount_fen: 20000 }), /相同请求标识/);
      const row = (await db.query('SELECT * FROM withdrawal_applications WHERE id = ?', [pending]))[0];
      assert.ok(!row.payee_ciphertext.includes('test@example.invalid')); assert.equal(JSON.parse(crypto.decrypt(row.payee_ciphertext)).alipay_account, request.alipay_account);
      assert.equal(Number(row.minimum_fen_snapshot), 10000);
    });
    await t.test('lists exclude payee data; sensitive view is audited and restricted to claimed operator for confirmation', async () => {
      const own = await service.records('withdrawals', b); assert.ok(own.items.some(x => x.id === pending));
      assert.ok(!JSON.stringify(own).includes('payee_ciphertext')); assert.ok(!JSON.stringify(own).includes('alipay_account'));
      assert.equal((await service.records('withdrawals', other)).items.length, 0);
      const payee = await service.payee(admin, pending); assert.equal(payee.alipay_account, 'test@example.invalid'); assert.equal(payee.can_confirm, false);
      assert.ok((await db.query("SELECT id FROM audit_logs WHERE entity_id = ? AND action = 'withdrawal.payee_view'", [pending])).length);
    });
    await t.test('rejection returns frozen balance once; cannot approve rejected application', async () => {
      const before = await wallet(b);
      await assert.rejects(service.review(admin, pending, 'REJECTED', ''), /原因/);
      await service.review(admin, pending, 'REJECTED', '测试驳回'); await service.review(admin, pending, 'REJECTED', '重试');
      assert.deepEqual(await wallet(b), { ...before, available_fen: before.available_fen + 10000, frozen_fen: before.frozen_fen - 10000 });
      await assert.rejects(service.review(admin, pending, 'APPROVED', ''), /状态/);
    });
    await t.test('approval keeps funds frozen; only one operator can claim and explicitly release unpaid task', async () => {
      pending = (await service.applyWithdrawal(b, input())).id;
      await assert.rejects(service.claimPayout(admin, pending), /尚未通过/);
      const before = await wallet(b); await service.review(admin, pending, 'APPROVED', '测试通过');
      assert.deepEqual(await wallet(b), before);
      const claims = await Promise.allSettled([service.claimPayout(admin, pending), service.claimPayout(admin2, pending)]);
      assert.equal(claims.filter(x => x.status === 'fulfilled').length, 1);
      assert.equal((await service.payee(admin, pending)).can_confirm, true); assert.equal((await service.payee(admin2, pending)).can_confirm, false);
      await assert.rejects(service.review(admin, pending, 'REJECTED', '不能退冻结'), /状态/);
      await assert.rejects(service.releasePayout(admin, pending, { note: 'test' }), /确认/);
      await assert.rejects(service.releasePayout(admin2, pending, { note: 'test', not_paid: true }), /只能/);
      await service.releasePayout(admin, pending, { note: '确认没有真实转账，仅测试', not_paid: true });
      await service.claimPayout(admin2, pending);
    });
    const trade = `TEST_${randomUUID()}`;
    await t.test('payout requires owner, explicit confirmation and unique trade; retries do not double-debit', async () => {
      const details = { alipay_trade_no: trade, note: 'Rollback-only simulation; no actual transfer', confirmed: true };
      await assert.rejects(service.confirmPayout(admin, pending, details), /领取人/);
      await assert.rejects(service.confirmPayout(admin2, pending, { ...details, confirmed: false }), /确认/);
      const before = await wallet(b);
      await service.confirmPayout(admin2, pending, details); await service.confirmPayout(admin2, pending, details);
      assert.deepEqual(await wallet(b), { ...before, frozen_fen: before.frozen_fen - 10000, paid_fen: before.paid_fen + 10000 });
      assert.equal(await count('manual_payout_records', 'withdrawal_id', pending), 1);
      await assert.rejects(service.confirmPayout(admin2, pending, { ...details, alipay_trade_no: `OTHER_${randomUUID()}` }), /其他流水号/);
      await assert.rejects(service.review(admin, pending, 'REJECTED', 'paid'), /状态/);
      const second = (await service.applyWithdrawal(b, input())).id;
      await service.review(admin, second, 'APPROVED', 'test'); await service.claimPayout(admin, second);
      const beforeDuplicate = await wallet(b);
      await assert.rejects(service.confirmPayout(admin, second, details), /不能重复记账/);
      assert.deepEqual(await wallet(b), beforeDuplicate);
      assert.equal((await db.query('SELECT status FROM withdrawal_applications WHERE id = ?', [second]))[0].status, 'PROCESSING');
    });
    await t.test('two different withdrawal requests cannot overspend available funds', async () => {
      const available = (await wallet(a)).available_fen;
      const outcomes = await Promise.allSettled([service.applyWithdrawal(a, input(available)), service.applyWithdrawal(a, input(available))]);
      assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1); assert.equal((await wallet(a)).available_fen, 0);
    });
    await t.test('wallet reconciles exactly with immutable entries and lifetime totals', async () => {
      for (const id of [a, b, child]) {
        const balance = await wallet(id);
        const [entries] = await db.query('SELECT COALESCE(SUM(available_delta_fen), 0) AS available, COALESCE(SUM(frozen_delta_fen), 0) AS frozen FROM commission_wallet_entries WHERE user_id = ?', [id]);
        assert.equal(balance.available_fen, Number(entries.available)); assert.equal(balance.frozen_fen, Number(entries.frozen));
        assert.equal(balance.earned_fen, balance.available_fen + balance.frozen_fen + balance.paid_fen);
      }
    });
  } finally {
    rules.withdrawalWindow = window;
    await c.rollback();
    try { for (const id of ids) assert.equal(await count('users', 'id', id), 0); }
    finally { await c.end(); }
  }
});
