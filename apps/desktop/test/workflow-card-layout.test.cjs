const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');

test('automatic workflow task groups use a ten-column wrapping card grid', () => {
  assert.match(css, /\.auto-workflow-task-list\s*\{[^}]*grid-template-columns:\s*repeat\(10,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.auto-workflow-task\s*\{[^}]*grid-template-rows:\s*auto auto auto/);
  assert.match(css, /\.auto-workflow-preview\s*\{[^}]*grid-column:\s*1 \/ -1[^}]*width:\s*100%[^}]*height:\s*auto/);
  assert.match(css, /\.auto-workflow-preview \.generated-asset-image,[^}]*\.auto-workflow-preview \.shot-generated-video\s*\{[^}]*width:\s*100%[^}]*height:\s*auto[^}]*object-fit:\s*contain/);
});

test('image and video cards place media above text and retain progress bars', () => {
  const modalStart = app.indexOf('function AutoProjectWorkflowModal(');
  const modalEnd = app.indexOf('function StoryPage(', modalStart);
  const modal = app.slice(modalStart, modalEnd);
  assert.match(modal, /className="auto-workflow-preview"[^]*ProjectAssetPreview/);
  assert.match(modal, /className="auto-workflow-preview"[^]*ShotGeneratedMedia/);
  assert.match(app, /<video className="shot-generated-video" src=\{asset\.data\} controls preload="metadata" \/>/);
  assert.match(modal, /<i[^>]*><b style=\{\{ width: `\$\{row\.progress \* 100\}%` \}\} \/><\/i>/);
  assert.ok(modal.indexOf('className="auto-workflow-preview"') < modal.indexOf('<strong>{row.id} · {row.name}</strong>'));
  assert.ok(modal.indexOf('mediaType="video"') < modal.indexOf('<strong>{row.id}</strong>'));
});
