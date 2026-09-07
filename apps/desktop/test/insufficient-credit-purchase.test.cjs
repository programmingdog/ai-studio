const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
const app = read('App.tsx');
const main = read('main.tsx');
const confirmation = read('components/CreditConfirmationHost.tsx');
const purchaseHost = read('components/CreditPurchaseHost.tsx');
const account = read('components/AccountCenterModal.tsx');
const workflowStart = read('components/WorkflowStartModal.tsx');
const css = read('styles.css');

test('a global purchase flow preserves the interrupted dialog and refreshes every active balance query', () => {
  assert.match(main, /<CreditPurchaseHost \/>/);
  assert.match(purchaseHost, /window\.dispatchEvent\(new CustomEvent\(CREDIT_PURCHASE_EVENT/);
  assert.match(purchaseHost, /<AccountCenterModal initialSection="credits" purchaseFlow/);
  assert.match(purchaseHost, /refetchQueries\(\{ queryKey: \["credit-balance"\], type: "active" \}\)/);
  assert.match(account, /activePurchase\.status === "PAID"/);
  assert.match(account, /purchaseFlow \? "完成并继续" : "完成并关闭"/);
});

test('every credit-gated desktop confirmation exposes an immediate purchase action', () => {
  assert.match(confirmation, /purchaseRequired && <div className="insufficient-credit-callout"[^]*<ImmediateCreditPurchaseButton/);
  assert.match(app, /const purchaseRequired = insufficient \|\| isInsufficientBalanceError\(approvalError\)/);
  assert.match(app, /function ScriptAnalysisCreditModal[^]*const purchaseRequired = insufficient \|\| isInsufficientBalanceError\(error\)[^]*<ImmediateCreditPurchaseButton/);
  assert.match(workflowStart, /const purchaseRequired=insufficient\|\|isInsufficientCreditError\(error\)[^]*<ImmediateCreditPurchaseButton/);
  assert.match(app, /purchaseRequired = state\.cancelled && isInsufficientBalanceError\(state\.message\)[^]*立即购买积分并继续/);
});

test('purchase UI is prominent and always stacks above the blocked dialog', () => {
  assert.match(css, /\.insufficient-credit-callout[^{]*\{[^}]*border:\s*1px solid var\(--ui-danger-border\)[^}]*background:\s*var\(--ui-danger-soft\)/);
  assert.match(css, /\.insufficient-credit-callout \.immediate-credit-purchase\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.account-modal-backdrop\.credit-purchase-backdrop\s*\{\s*z-index:\s*1800/);
  assert.match(css, /\.payment-dialog-backdrop\.credit-purchase-payment-backdrop\s*\{\s*z-index:\s*1810/);
});
