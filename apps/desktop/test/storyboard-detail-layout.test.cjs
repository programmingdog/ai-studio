const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
const pageStart = app.indexOf('function StoryboardPage(');
const pageEnd = app.indexOf('function JobsPage(', pageStart);
const page = app.slice(pageStart, pageEnd);
const rowStart = app.indexOf('function ShotListRow(');
const rowEnd = app.indexOf('function DeleteShotConfirmModal(', rowStart);
const shotRow = app.slice(rowStart, rowEnd);

test('shot detail center follows video, video prompt, image workspace, content order', () => {
  const video = page.indexOf('shot-video-media-card');
  const videoPrompt = page.indexOf('shot-video-generation-panel');
  const image = page.indexOf('shot-image-workspace');
  const content = page.indexOf('shot-content-editor', image);
  assert.ok(video >= 0 && video < videoPrompt && videoPrompt < image && image < content);
  assert.doesNotMatch(page, /shot-summary/);
  assert.match(css, /\.shot-image-workspace\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
});

test('shot list row only renders shot id and duration', () => {
  assert.match(shotRow, /<strong>\{shot\.id\}<\/strong><em>\{shot\.duration\}s<\/em>/);
  assert.doesNotMatch(shotRow, /shot\.action|<small>/);
});

test('shot content fields are single-column three-line scrolling editors', () => {
  assert.match(page, /className="shot-content-fields"[\s\S]*?画面<VisualMentionEditor[\s\S]*?动作<textarea rows=\{3\}[\s\S]*?台词<textarea rows=\{3\}[\s\S]*?声音<textarea rows=\{3\}/);
  assert.match(css, /\.shot-content-fields\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.shot-content-fields textarea\s*\{[^}]*height:\s*84px[^}]*overflow-y:\s*auto/);
});

test('inspector groups primary and camera controls into requested rows', () => {
  assert.match(page, /className="inspector-primary-grid"[\s\S]*?时长[\s\S]*?屏幕比例[\s\S]*?景别[\s\S]*?className="inspector-camera-grid"[\s\S]*?机位[\s\S]*?运镜/);
  assert.match(css, /\.inspector-primary-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3/);
  assert.match(css, /\.inspector-core-grid, \.inspector-camera-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
});

test('video prompt uses a fixed six-line scroll area', () => {
  assert.match(css, /\.shot-video-generation-panel \.shot-prompt-card\.video-prompt-card \.visual-mention-editor\.rich\s*\{[^}]*height:\s*calc\(10\.2em \+ 24px\)[^}]*overflow-y:\s*auto/);
});
