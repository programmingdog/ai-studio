const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modal = fs.readFileSync(path.join(__dirname, '../src/components/WorkflowStartModal.tsx'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');

test('image and video model lists load independently with visible progress', () => {
  assert.match(modal, /queryKey:\["workflow-start-models","IMAGE_GENERATION"\]/);
  assert.match(modal, /queryKey:\["workflow-start-models","VIDEO_GENERATION"\]/);
  assert.match(modal, /className="workflow-model-loading" role="status" aria-live="polite"/);
  assert.match(modal, /<LoaderCircle className="spin"/);
  assert.match(modal, /正在读取\{title\}…/);
  assert.match(modal, /正在获取可用大模型和清晰度/);
});

test('loading, empty, and error states are visually distinct from model choices', () => {
  assert.match(modal, /暂无可用的\{title\}/);
  assert.match(modal, /暂时无法加载\{title\}，请稍后再试/);
  assert.match(css, /\.workflow-model-loading\s*\{[^}]*min-height:\s*112px/);
  assert.match(css, /\.workflow-model-loading > svg\s*\{[^}]*color:\s*var\(--ui-accent\)/);
  assert.match(css, /\.workflow-model-message\.error\s*\{[^}]*color:\s*var\(--ui-danger\)/);
});
