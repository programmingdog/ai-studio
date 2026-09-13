const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { componentHarness, flush } = require('../../../tests/support/react-hooks.cjs');
const file = path.join(__dirname, '../src/components/ReferralPanel.tsx');
const base = { withdrawal_open: true, next_open_at: '2026-09-10T16:00:00Z', minimum_withdrawal_fen: 10000, available_fen: 20000 };
const prepare = async (summary = base, api = async () => ({ id: 'test' })) => {
  const calls = [];
  const h = componentHarness(file, 'WithdrawalForm', { summary }, { '../services/platform': { async applyReferralWithdrawal(input) { calls.push(input); return api(input); } }, './RecordPagination': { RecordPagination: () => null } });
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
  h.inputs()[3].props.onChange({ target: { files: [{ type: 'image/png', size: 2 * 1024 * 1024 + 1 }] } }); h.render();
  assert.equal(h.nodes().some(x => x.type === 'img'), false);
});
test('referral records are grouped into dedicated tabs with duplicated pagination', () => {
  const source = require('node:fs').readFileSync(file, 'utf8');
  const account = require('node:fs').readFileSync(path.join(__dirname, '../src/components/AccountCenterModal.tsx'), 'utf8');
  assert.match(account, />分润记录<\/button>/); assert.match(account, />提现记录<\/button>/); assert.match(account, />邀请记录<\/button>/);
  assert.match(source, /提现申请.*打款记录/);
  assert.match(source, /邀请奖励.*下级用户/);
  assert.match(source, /getReferralSubordinates\(level, page\)/);
  assert.match(source, /直接下级/); assert.match(source, /间接下级/);
  assert.match(source, /money\(user\.consumption_fen\)/);
  assert.match(source, /user\.generation_count/);
  assert.ok((source.match(/position="top"/g) || []).length >= 2);
  assert.ok((source.match(/position="bottom"/g) || []).length >= 2);
});
test('commission rates, generation-only rule and administrator notice appear in promotion instead of account center', () => {
  const source = require('node:fs').readFileSync(file, 'utf8');
  const promotion = require('node:fs').readFileSync(path.join(__dirname, '../src/components/PromotionPosterModal.tsx'), 'utf8');
  assert.match(source, /累计分润 \{money\(summary\.data\.earned_fen\)\}/);
  assert.doesNotMatch(source, /summary\.data\.(?:direct_rate_bps|indirect_rate_bps|commission_notice)/);
  assert.match(promotion, /summary\.data\.direct_rate_bps/);
  assert.match(promotion, /summary\.data\.indirect_rate_bps/);
  assert.match(promotion, /summary\.data\.commission_notice/);
  assert.match(promotion, /仅对下级图片、视频生成的利润积分计提/);
  assert.match(promotion, /充值和其他模型消耗不参与分润/);
  assert.ok(promotion.indexOf('className="promotion-link-card"') < promotion.indexOf('className="promotion-rules-card"'));
  assert.ok(promotion.indexOf('className="promotion-rules-card"') < promotion.indexOf('className="promotion-poster-workspace"'));
});
