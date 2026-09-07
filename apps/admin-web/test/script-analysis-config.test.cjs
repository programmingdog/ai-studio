const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

test('script analysis configuration belongs to its AI capability page instead of client defaults or providers', () => {
  const panel = readFileSync(join(__dirname, '../components/ScriptAnalysisConfigPanel.tsx'), 'utf8');
  const app = readFileSync(join(__dirname, '../components/AdminApp.tsx'), 'utf8');
  const providers = readFileSync(join(__dirname, '../components/ProvidersPanel.tsx'), 'utf8');
  const controller = readFileSync(join(__dirname, '../../server/src/admin/admin.controller.ts'), 'utf8');

  assert.match(panel, /\/admin\/configs\/script-analysis/);
  assert.match(app, /view === "script-analysis".*<ScriptAnalysisConfigPanel/s);
  assert.doesNotMatch(app, /view === "configs".*<ScriptAnalysisConfigPanel/s);
  assert.doesNotMatch(providers, /ScriptAnalysisConfigPanel|script-analysis-config/);
  assert.match(controller, /@Get\("configs\/script-analysis"\)\s+@RequirePermissions\("configs\.manage"\)/);
  assert.match(controller, /@Patch\("configs\/script-analysis"\)\s+@RequirePermissions\("configs\.manage"\)/);
  assert.doesNotMatch(controller, /providers\/script-analysis-config/);
});
