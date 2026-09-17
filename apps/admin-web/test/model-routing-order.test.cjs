const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

test('model routing editor exposes ordering and recommendation controls', () => {
  const panel = readFileSync(join(__dirname, '../components/ProvidersPanel.tsx'), 'utf8');
  assert.match(panel, /已选顺序即客户端顺序/);
  assert.match(panel, /recommended_image_model_id/);
  assert.match(panel, /recommended_video_model_id/);
  assert.match(panel, /aria-label={`上移 \$\{model\.model_alias\}`}/);
  assert.match(panel, /aria-label={`下移 \$\{model\.model_alias\}`}/);
  assert.match(panel, />推荐<\/label>/);
});

test('Gemini video understanding test UI supports every configured model version', () => {
  const panel = readFileSync(join(__dirname, '../components/ProvidersPanel.tsx'), 'utf8');
  const helper = panel.match(/function isGeminiVideoUnderstanding[\s\S]*?\n}/)?.[0] || '';
  assert.match(helper, /model\.capability === "VIDEO_UNDERSTANDING"/);
  assert.match(helper, /model\.api_protocol\.toLowerCase\(\) === "gemini"/);
  assert.doesNotMatch(helper, /gem-3\.7-flash/);
});
