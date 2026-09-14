const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/services/videoDuration.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUnderTest = { exports: {} };
vm.runInNewContext(compiled, { module: moduleUnderTest, exports: moduleUnderTest.exports, require }, { filename: "videoDuration.js" });
const { resolveVideoDuration, selectableVideoDurations } = moduleUnderTest.exports;

test("automatic workflow matches the shot and rounds only to a supported duration", () => {
  const model = { video_duration_options: [5, 10, 15] };
  assert.equal(resolveVideoDuration(10, model, "automatic"), 10);
  assert.equal(resolveVideoDuration(8, model, "automatic"), 10);
  assert.equal(resolveVideoDuration(12, model, "automatic"), 15);
});

test("automatic workflow uses ten seconds as the minimum for a short final shot", () => {
  const model = { video_duration_options: [] };
  assert.equal(resolveVideoDuration(6, model, "automatic"), 10);
  assert.equal(resolveVideoDuration(10, model, "automatic"), 10);
  assert.equal(resolveVideoDuration(12, model, "automatic"), 12);
});

test("manual generation disables configured options shorter than the shot", () => {
  const model = { video_duration_options: [15, 5, 10] };
  assert.deepEqual(Array.from(selectableVideoDurations(8, model), (item) => ({ ...item })), [
    { seconds: 5, disabled: true },
    { seconds: 10, disabled: false },
    { seconds: 15, disabled: false },
  ]);
  assert.equal(resolveVideoDuration(8, model, "manual"), 10);
});

test("generation stops before quoting when the model cannot cover the shot", () => {
  assert.throws(() => resolveVideoDuration(16, { video_duration_options: [5, 10, 15] }, "manual"), /最长只能生成 15 秒/);
});
