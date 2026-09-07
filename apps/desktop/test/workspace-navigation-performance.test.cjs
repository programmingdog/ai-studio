const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
const nativeCommands = fs.readFileSync(path.join(__dirname, '../src-tauri/src/commands.rs'), 'utf8');

test('workspace navigation paints a target-page loading shell before mounting heavy content', () => {
  assert.match(app, /onClick=\{\(\) => navigateWorkspacePage\(id\)\}/);
  assert.match(app, /setPage\(target\);\s*setRenderedPage\(null\);/);
  assert.match(app, /requestAnimationFrame\(\(\) => \{\s*navigationFrame\.current = window\.requestAnimationFrame/);
  assert.match(app, /renderedPage === null && <WorkspacePageLoading/);
  assert.match(css, /\.workspace-page-loading-grid[\s\S]*animation: workspace-loading-pulse/);
});

test('workspace data is prefetched concurrently without blocking the navigation event', () => {
  assert.match(app, /void Promise\.allSettled\(requests\);/);
  assert.match(app, /\["image-generation-tasks", projectPath\]/);
  assert.match(app, /\["generation-records", projectPath\]/);
  assert.match(app, /onPointerEnter=\{\(\) => prefetchWorkspacePage\(id\)\}/);
});

test('large character, prop, scene and storyboard lists render progressively', () => {
  assert.match(app, /visibleCharacters\.map/);
  assert.match(app, /visibleProps\.map/);
  assert.match(app, /visibleScenes\.map/);
  assert.match(app, /visibleShots\.map/);
  assert.match(app, /setVisibleCount\(\(current\) => Math\.min\(total, current \+ batchSize\)\)/);
});

test('project center paints its shell before background loading and renders projects in batches', () => {
  assert.match(app, /setShowProjectCenter\(true\);\s*setShowAssetLibrary\(false\);\s*setProjectCenterPreparing\(true\);/);
  assert.match(app, /projectCenterFrame\.current = window\.requestAnimationFrame\(\(\) => \{\s*projectCenterFrame\.current = window\.requestAnimationFrame/);
  assert.match(app, /projectList\.mutateAsync\(\)/);
  assert.match(app, /const visibleProjects = projectsWithoutExamples\.slice\(0, visibleProjectCount\)/);
  assert.match(app, /正在后台加载项目，不会阻塞其他界面操作/);
  assert.match(nativeCommands, /pub async fn list_projects[\s\S]*crate::background::run\("读取项目列表"/);
});
