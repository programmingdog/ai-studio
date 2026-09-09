const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');

test('all story workflow actions live in the top-right header', () => {
  const start = app.indexOf('function StoryPage(');
  const end = app.indexOf('function ProjectAssetPreview(', start);
  const storyPage = app.slice(start, end);
  const actionsStart = storyPage.indexOf('<header className="story-auto-header">');
  const firstField = storyPage.indexOf('<input className="title-input"');

  assert.notEqual(actionsStart, -1);
  assert.ok(actionsStart < firstField, 'workflow actions should render above story fields');
  assert.doesNotMatch(storyPage, /story-auto-footer/);
  assert.match(storyPage, /story-auto-header[^]*播放合成视频[^]*打开正在进行的工作流[^]*一键自动创作/);
  assert.match(css, /\.story-auto-header\s*\{[^}]*justify-content:\s*flex-end[^}]*margin-bottom:\s*14px/);
  assert.match(css, /\.story-auto-actions\s*\{[^}]*margin-left:\s*auto/);
});
