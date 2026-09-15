const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

test('client media models follow server order and display recommendation labels', () => {
  const platform = readFileSync(join(__dirname, '../src/services/platform.ts'), 'utf8');
  const app = readFileSync(join(__dirname, '../src/App.tsx'), 'utf8');
  const freeCreation = readFileSync(join(__dirname, '../src/components/FreeCreationPage.tsx'), 'utf8');
  const workflow = readFileSync(join(__dirname, '../src/components/WorkflowStartModal.tsx'), 'utf8');
  assert.match(platform, /Number\(left\.sort_order\) - Number\(right\.sort_order\)/);
  assert.match(app, /model\.recommended && <em>推荐<\/em>/);
  assert.match(freeCreation, /item\.recommended \? "（推荐）"/);
  assert.match(workflow, /m\.recommended \? "（推荐）"/);
});

test('free creation uses the selected model duration, resolution, aspect-ratio and reference capabilities', () => {
  const platform = readFileSync(join(__dirname, '../src/services/platform.ts'), 'utf8');
  const freeCreation = readFileSync(join(__dirname, '../src/components/FreeCreationPage.tsx'), 'utf8');
  assert.match(platform, /aspect_ratio_options\?: FreeCreationAspectRatio\[\]/);
  assert.match(freeCreation, /model\?\.aspect_ratio_options\?\.length \? model\.aspect_ratio_options : fallbackAspectRatios/);
  assert.match(freeCreation, /aspectRatioOptions\.map\(\(ratio\) => <option/);
  assert.match(freeCreation, /selectedAssets\.length > model\.max_reference_images/);
});
