const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('reflect-metadata');
const { CreditsService } = require('../dist/credits/credits.service');

test('bonus credits increase the grant without reducing the configured package price', async () => {
  const writes = [];
  const packageRow = {
    id: 'package-3000', code: 'standard-3000', name: '3000 积分套餐', description: '',
    base_credits: 3000, bonus_credits: 200, price_fen: 30000, currency: 'CNY', status: 'ACTIVE',
  };
  const database = {
    query: async () => [packageRow],
    transaction: async (callback) => callback({ execute: async (sql, args) => writes.push({ sql, args }) }),
    execute: async (sql, args) => writes.push({ sql, args }),
  };
  const service = new CreditsService(database, {}, {});
  service.purchaseByIdempotencyKey = async () => null;
  service.wechatRuntime = async () => ({ merchantId: 'merchant', notifyUrl: 'https://example.invalid/notify', appId: 'app', verifierId: 'serial' });
  service.authorization = () => 'test-authorization';
  service.verifyWechatSignature = () => {};

  const originalFetch = global.fetch;
  let paymentRequest;
  global.fetch = async (_url, init) => {
    paymentRequest = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code_url: 'weixin://pay/test' }),
      headers: { get: () => 'test' },
    };
  };
  try {
    const result = await service.createPurchase('user-1', packageRow.id, 'idempotency-1');
    assert.equal(result.credits, 3200);
    assert.equal(result.amount_fen, 30000);
    assert.equal(paymentRequest.amount.total, 30000);

    const orderInsert = writes.find((entry) => entry.sql.includes('INSERT INTO payment_orders'));
    assert.equal(orderInsert.args[6], 30000);
    assert.equal(orderInsert.args[7], 3200);
    const purchaseInsert = writes.find((entry) => entry.sql.includes('INSERT INTO credit_package_purchases'));
    assert.deepEqual(purchaseInsert.args.slice(6, 10), [3000, 200, 3200, 30000]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('migration upgrades the known legacy standard package without changing arbitrary packages', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/database/migrations/037_credit_package_bonus_semantics.sql'), 'utf8');
  assert.match(sql, /SET base_credits = 3000,[\s\S]*bonus_credits = 200,[\s\S]*price_fen = 30000/);
  assert.match(sql, /code = 'standard-3000'/);
  assert.match(sql, /base_credits = 2800/);
  assert.match(sql, /price_fen IN \(4990, 28000\)/);
});
