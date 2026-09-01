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

test('settings tabs follow their labels instead of filling equal-width columns', () => {
  const tabs = declarations('.settings-tabs');
  assert.equal(tabs.display, 'flex');
  assert.equal(tabs['flex-wrap'], 'wrap');
  assert.equal(tabs['grid-template-columns'], undefined);
  const button = declarations('.settings-tabs > button');
  assert.equal(button.width, 'fit-content');
  assert.equal(button.flex, '0 1 auto');
  assert.equal(button['max-width'], '100%');
  css.walkRules(rule => {
    if (rule.selectors.includes('.settings-tabs')) {
      rule.walkDecls('grid-template-columns', () => assert.fail('responsive rules must not restore equal-width tabs'));
    }
  });
});

test('settings dropdowns use content sizing with intrinsic-width fallback and container bounds', () => {
  const select = declarations('.settings-body select');
  assert.equal(select['field-sizing'], 'content');
  assert.equal(select.width, 'auto');
  assert.equal(select['justify-self'], 'start');
  assert.equal(select['max-width'], '100%');
  assert.equal(declarations('.settings-prompt-field textarea')['field-sizing'], undefined);
});

test('language and region panel and its cards follow content instead of stretching to a fixed width', () => {
  const panel = declarations('.language-settings-panel');
  assert.equal(panel.width, 'fit-content');
  assert.equal(panel['max-width'], '100%');
  assert.equal(panel['justify-self'], 'start');
  assert.equal(panel['justify-items'], 'start');
  const card = declarations('.language-settings-panel > *');
  assert.equal(card.width, 'fit-content');
  assert.equal(card['max-width'], '100%');
  assert.equal(card['overflow-wrap'], 'anywhere');
});

test('settings actions remain content-sized and can wrap within narrow windows', () => {
  for (const selector of ['.settings-prompt-heading button', '.settings-modal > footer button']) {
    const button = declarations(selector);
    assert.equal(button.width, 'fit-content');
    assert.equal(button.flex, '0 1 auto');
    assert.equal(button['max-width'], '100%');
  }
  assert.equal(declarations('.settings-prompt-heading')['flex-wrap'], 'wrap');
  assert.equal(declarations('.settings-modal > footer')['flex-wrap'], 'wrap');
});
