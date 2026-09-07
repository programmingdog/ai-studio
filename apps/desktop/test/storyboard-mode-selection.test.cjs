const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');

test('video understanding mode highlights only the selected option', () => {
  assert.match(app, /storyboard-mode-option\$\{selectedMode === "standard" \? " active" : ""\}/);
  assert.doesNotMatch(app, /storyboard-mode-option recommended/);
  assert.doesNotMatch(styles, /storyboard-mode-option\.recommended/);
});

test('fixed-duration mode is the first and default video understanding option', () => {
  assert.match(app, /useState<StoryboardUnderstandingMode>\("fixed"\)/);
  const options = app.slice(app.indexOf('<div className="storyboard-mode-options">'), app.indexOf('</div>', app.indexOf('<div className="storyboard-mode-options">')));
  assert.ok(options.indexOf('固定秒数模式') < options.indexOf('标准模式'));
  assert.ok(options.indexOf('标准模式') < options.indexOf('详细模式'));
});
