const assert = require("node:assert/strict");
const test = require("node:test");

const { splitScriptText, mergeScriptChunks } = require("../dist/gateway/script-chunking.js");
const { fixture } = require("./fixtures/normalized-script.cjs");

test("episode-aware splitting preserves every source character", () => {
  const source = `片名：长剧本\n第1集：开始\n${"角色对话与动作。\n".repeat(600)}第2集：转折\n${"第二集事件。\n".repeat(120)}`;
  const chunks = splitScriptText(source);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.map(chunk => chunk.text).join(""), source);
  assert.ok(chunks.some(chunk => chunk.episodeNumber === 2));
  assert.ok(chunks.every(chunk => chunk.text.length <= 3_800));
});

test("long scripts without episode headings are still bounded and lossless", () => {
  const source = "普通剧本内容与台词。\n".repeat(2_000);
  const chunks = splitScriptText(source);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.text.length <= 3_800));
  assert.equal(chunks.map(chunk => chunk.text).join(""), source);
});

test("dense preformatted storyboards keep at most four shots in each chunk", () => {
  const source = `标题：上面还有一层\n角色与场景设定\n${Array.from({ length: 30 }, (_, index) =>
    `第${index + 1}段（${index * 10}～${(index + 1) * 10}秒）\n画面：第${index + 1}段画面\n台词：原文对白\n\n`).join("")}`;
  const chunks = splitScriptText(source);
  assert.ok(chunks.length >= 8);
  assert.ok(chunks.every(chunk => chunk.text.length <= 3_800));
  assert.ok(chunks.every(chunk => (chunk.text.match(/^第\d+段（/gm) || []).length <= 4));
  assert.equal(chunks.map(chunk => chunk.text).join(""), source);
});

test("independent validated results merge with global IDs, time and episodes", () => {
  const chunks = [
    { index: 0, text: "第1集：雨夜\n林夏发现信件", label: "第1集", episodeNumber: 1, episodeTitle: "雨夜" },
    { index: 1, text: "第2集：来客\n林夏继续调查", label: "第2集", episodeNumber: 2, episodeTitle: "来客" },
  ];
  const merged = mergeScriptChunks(chunks, [fixture(), fixture()]);
  assert.equal(merged.characters.length, 1);
  assert.equal(merged.scenes.length, 1);
  assert.equal(merged.props.length, 1);
  assert.equal(merged.episodes.length, 2);
  assert.equal(merged.shots.length, 4);
  assert.equal(merged.shots[3].id, "SHOT_004");
  assert.equal(merged.shots[3].episode_id, "EP_002");
  assert.equal(merged.shots[3].time_range.start, 26);
  assert.equal(merged.shots[3].time_range.end, 38);
  assert.deepEqual(merged.episodes.map(item => item.duration), [19, 19]);
  assert.deepEqual(merged.sequences.map(item => item.shot_ids), [["SHOT_001", "SHOT_002"], ["SHOT_003", "SHOT_004"]]);
});

test("merge fails on missing segment rather than making a partial project", () => {
  const chunks = [
    { index: 0, text: "第一段", label: "第一段", episodeNumber: 1, episodeTitle: "第一集" },
    { index: 1, text: "第二段", label: "第二段", episodeNumber: 1, episodeTitle: "第一集" },
  ];
  assert.throws(() => mergeScriptChunks(chunks, [fixture()]), /结果数量不完整/);
});
