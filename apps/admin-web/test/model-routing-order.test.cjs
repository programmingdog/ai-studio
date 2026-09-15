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
