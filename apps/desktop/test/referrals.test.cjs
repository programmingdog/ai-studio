const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { componentHarness, flush } = require('../../../tests/support/react-hooks.cjs');
const file = path.join(__dirname, '../src/components/ReferralPanel.tsx');
const base = { withdrawal_open: true, next_open_at: '2026-09-10T16:00:00Z', minimum_withdrawal_fen: 10000, available_fen: 20000 };
const prepare = async (summary = base, api = async () => ({ id: 'test' })) => {
  const calls = [];
  const h = componentHarness(file, 'WithdrawalForm', { summary }, { '../services/platform': { async applyReferralWithdrawal(input) { calls.push(input); return api(input); } } });
  const inputs = () => h.nodes().filter(x => x.type === 'input');
  h.edit(inputs()[0], '123.45'); h.edit(inputs()[1], '测试用户'); h.edit(inputs()[2], 'test@example.invalid');
  const previous = global.FileReader;
  global.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,TEST'; this.onload(); } };
  try { inputs()[3].props.onChange({ target: { files: [{ type: 'image/png', size: 100 }] } }); h.render(); }
  finally { global.FileReader = previous; }
  h.edit(inputs()[4], true);
  return { ...h, calls, inputs, submit: () => h.nodes().find(x => x.type === 'form').props.onSubmit({ preventDefault() {} }) };
};
test('withdrawal sends exact fen, consent and payee details; repeated click makes one request', async () => {
  const h = await prepare(); h.submit(); h.submit(); await h.ready();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].amount_fen, 12345);
  assert.equal(h.calls[0].alipay_account, 'test@example.invalid'); assert.match(h.calls[0].idempotency_key, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(h.inputs()[0].props.value, ''); assert.equal(h.inputs()[4].props.checked, false);
});
test('uncertain submission reuses the idempotency key until details change', async () => {
  const h = await prepare(base, async () => { throw Error('test timeout'); });
  h.submit(); await h.ready(); h.submit(); await h.ready();
  assert.equal(h.calls[0].idempotency_key, h.calls[1].idempotency_key);
  h.edit(h.inputs()[0], '124.00'); h.submit(); await h.ready();
  assert.notEqual(h.calls[1].idempotency_key, h.calls[2].idempotency_key);
});
test('non-Friday, sub-minimum, over-balance and missing consent never submit', async () => {
  for (const summary of [{ ...base, withdrawal_open: false }, { ...base, minimum_withdrawal_fen: 15000 }, { ...base, available_fen: 10000 }]) {
    const h = await prepare(summary); assert.equal(h.button('提交提现申请').props.disabled, true); h.submit(); await flush(); assert.equal(h.calls.length, 0);
  }
  const h = await prepare(); h.edit(h.inputs()[4], false); h.submit(); await flush(); assert.equal(h.calls.length, 0);
});
test('changing to invalid or oversized receipt clears previous valid image', async () => {
  const h = await prepare();
  h.inputs()[3].props.onChange({ target: { files: [{ type: 'image/svg+xml', size: 20 }] } }); h.render();
  assert.equal(h.button('提交提现申请').props.disabled, true); h.submit(); await flush(); assert.equal(h.calls.length, 0);
  h.inputs()[3].props.onChange({ target: { files: [{ type: 'image/png', size: 262145 }] } }); h.render();
  assert.equal(h.nodes().some(x => x.type === 'img'), false);
});
