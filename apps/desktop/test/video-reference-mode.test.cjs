const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/videoPromptReferences.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUnderTest = { exports: {} };
vm.runInNewContext(compiled, { module: moduleUnderTest, exports: moduleUnderTest.exports, require }, { filename: "videoPromptReferences.js" });
const { pureTextVideoPrompt, videoReferenceContext } = moduleUnderTest.exports;

test("pure text mode removes every reference image and first frame", () => {
  const references = [{ relative_path: "scene.png", kind: "scene" }, { relative_path: "character.png", kind: "character" }];
  const result = videoReferenceContext("pure_text", references, "shot.png");
  assert.deepEqual(Array.from(result.references), []);
  assert.equal(result.shotImagePath, undefined);
});

test("existing reference mode keeps available images without requiring a complete set", () => {
  const references = [{ relative_path: "scene.png", kind: "scene" }];
  const result = videoReferenceContext("references", references);
  assert.deepEqual(Array.from(result.references, (item) => ({ ...item })), references);
  assert.equal(result.shotImagePath, undefined);
});

test("pure text prompt removes image instructions and mention tokens", () => {
  const prompt = [
    "画面：角色走进房间，参考@角色图1",
    "约束：角色、场景与参考图一致",
    "场景参考图：客厅",
    "道具参考图：手提箱",
    "首帧要求：使用当前分镜图作为视频第一帧。",
    "分镜图参考要求：保持画面一致。",
  ].join("\n");
  const result = pureTextVideoPrompt(prompt);
  assert.equal(result.includes("@角色图"), false);
  assert.equal(result.includes("参考图："), false);
  assert.equal(result.includes("首帧要求："), false);
  assert.equal(result.includes("分镜图参考要求："), false);
  assert.match(result, /角色与场景在视频中保持一致/);
});
