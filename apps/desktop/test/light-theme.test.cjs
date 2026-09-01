const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const desktop = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(desktop, 'src/styles.css'), 'utf8');
const root = postcss.parse(css);
const tokens = new Map();
root.walkDecls(/^--ui-/, d => tokens.set(d.prop, d.value));
const rgb = hex => {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
};
const luminance = values => values.map(c => {
  const s = c / 255;
  return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
}).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
const contrast = (foreground, background) => {
  const a = luminance(rgb(foreground)), b = luminance(rgb(background));
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};

test('web and native client explicitly select the light color scheme', () => {
  const html = fs.readFileSync(path.join(desktop, 'index.html'), 'utf8');
  const native = JSON.parse(fs.readFileSync(path.join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.match(html, /name="color-scheme" content="light"/);
  assert.match(html, /name="theme-color" content="#f5f6fa"/);
  for (const window of native.app.windows) {
    assert.equal(window.theme, 'Light');
    assert.ok(luminance(rgb(window.backgroundColor)) > .8);
  }
  root.walkDecls('color-scheme', d => assert.equal(d.value, 'light'));
  root.walkAtRules('media', r => assert.doesNotMatch(r.params, /prefers-color-scheme\s*:\s*dark/));
});

test('all shared palette references exist and contain valid CSS colors', () => {
  assert.ok(tokens.size >= 20);
  for (const reference of css.matchAll(/var\((--ui-[\w-]+)\)/g)) assert.ok(tokens.has(reference[1]), reference[1]);
  for (const color of css.matchAll(/#[\da-f]+\b/gi)) assert.ok([4, 5, 7, 9].includes(color[0].length), color[0]);
});

test('light surface and semantic text tokens have readable contrast', () => {
  for (const text of ['text', 'text-muted', 'accent', 'success', 'warning', 'danger', 'info']) {
    const backgrounds = ['surface', 'surface-subtle', 'surface-muted'];
    if (tokens.has(`--ui-${text}-soft`)) backgrounds.push(`${text}-soft`);
    for (const bg of backgrounds) assert.ok(contrast(tokens.get(`--ui-${text}`), tokens.get(`--ui-${bg}`)) >= 4.5, `${text} on ${bg}`);
  }
});

test('no original dark surface remains, including rules masked by later overrides', () => {
  // Saturated brand buttons, tiny indicators and progress fills are intentional;
  // content panels, controls, tags, previews and dialogs are never exempted.
  const accents = /^(?:\.brand-mark|nav button\.active::before|\.status-dot|\.welcome-glow|\.primary-button(?:,|$)|\.account-identity-avatar|\.asset-library-card\.selected \.asset-selection-check|\.progress i|\.agent-run-progress b|\.generation-record-progress i|\.auto-workflow-overall b|\.bulk-video-overall-progress b|\.idea-workflow-overall b|\.idea-segment-progress i\.(?:active|completed)|\.douyin-task-state > i b|\.video-remix-progress i|\.creative-type-group-mark)$/;
  root.walkDecls(/^background/, d => {
    if (d.parent.selector.startsWith('::-webkit-scrollbar-thumb')) return;
    if (accents.test(d.parent.selector.split(',')[0].trim())) return;
    if (d.prop === 'background-image' && /grid|::before/.test(d.parent.selector)) return;
    const value = d.value.replace(/var\((--ui-[\w-]+)\)/g, (_, t) => tokens.get(t));
    for (const hex of value.match(/#[\da-f]{3,8}\b/gi) || []) {
      let alpha = 1;
      if (hex.length === 5) alpha = parseInt(hex.slice(-1).repeat(2), 16) / 255;
      if (hex.length === 9) alpha = parseInt(hex.slice(-2), 16) / 255;
      const composite = rgb(hex).map((c, i) => c * alpha + [245, 246, 250][i] * (1 - alpha));
      assert.ok(luminance(composite) >= .65, `${d.parent.selector}: ${d.value}`);
    }
    for (const match of value.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?\)/g)) {
      if (match[4] && Number(match[4]) < .2) continue;
      assert.ok(luminance(match.slice(1, 4).map(Number)) >= .65, `${d.parent.selector}: ${d.value}`);
    }
  });
});

test('component paint is not hidden by blanket important background resets', () => {
  root.walkRules(r => {
    if (/^(?:body\s+:where|button$)/.test(r.selector)) {
      r.walkDecls(/^background/, d => assert.ok(!d.important, r.selector));
    }
  });
  assert.match(css, /\.media-resolution-list label:has\(input:checked\)/);
  assert.match(css, /button:focus-visible/);
});
