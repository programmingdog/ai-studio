const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const css = postcss.parse(fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8'));
function declarations(selector) {
  const result = {};
  css.walkRules(rule => {
    if (rule.parent.type === 'root' && rule.selectors.includes(selector)) {
      rule.walkDecls(declaration => { result[declaration.prop] = declaration.value; });
    }
  });
  return result;
}
test('account modal stays at 80 percent of the parent window height', () => {
  const modal = declarations('.account-modal');
  assert.equal(modal.height, '80vh');
  assert.equal(modal.overflow, 'hidden');
});

test('required login fills the window without changing the optional account dialog', () => {
  const component = fs.readFileSync(path.join(__dirname, '../src/components/AccountCenterModal.tsx'), 'utf8');
  assert.match(component, /required \? " account-login-backdrop" : ""/);
  const backdrop = declarations('.account-login-backdrop');
  assert.equal(backdrop.display, 'flex');
  assert.equal(backdrop.padding, '0');
  const modal = declarations('.account-login-backdrop > .account-modal');
  assert.equal(modal.width, '100%');
  assert.equal(modal.height, '100%');
  assert.equal(modal['min-width'], '0');
  assert.equal(modal['min-height'], '0');
  assert.equal(modal['border-radius'], '0');
  assert.equal(modal['box-shadow'], 'none');
});

test('required login and registration forms can scroll within the compact window height', () => {
  const panel = declarations('.account-login-backdrop .auth-panel');
  assert.equal(panel.flex, '1 1 auto');
  assert.equal(panel['min-height'], '0');
  assert.equal(panel.overflow, 'auto');
  assert.equal(panel['overscroll-behavior'], 'contain');
});
test('account header and tabs cannot shrink when content grows', () => {
  assert.equal(declarations('.account-modal > header').flex, '0 0 auto');
  const tabs = declarations('.account-tabs');
  assert.equal(tabs.flex, '0 0 55px');
  assert.equal(tabs.height, '55px');
  assert.equal(tabs['min-height'], '55px');
  assert.equal(tabs['overflow-y'], 'hidden');
  assert.equal(declarations('.account-tabs button').height, '45px');
});
test('only account content shrinks and scrolls; sidebar active marker does not leak into tabs', () => {
  const body = declarations('.account-body');
  assert.equal(body.flex, '1 1 auto');
  assert.equal(body['min-height'], '0');
  assert.equal(body.overflow, 'auto');
  assert.equal(body['overscroll-behavior'], 'contain');
  assert.equal(declarations('.account-tabs button.active::before').content, 'none');
});
