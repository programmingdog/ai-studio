const assert = require("node:assert/strict");
const { test } = require("node:test");
require("reflect-metadata");
const { ModelGatewayService } = require("../dist/gateway/model-gateway.service");

const tail = "https://example.com/previous-video-last.png";
const scene = "https://example.com/scene.png";
const shen = "https://example.com/shen-yan.png";
const prop = "https://example.com/prop.png";
const references = [
  { url: shen, type: "character", label: "角色“沈砚”·白衣" },
  { url: prop, type: "prop", label: "道具“玉佩”" },
  { url: scene, type: "scene", label: "场景“雨夜庭院”" },
  { url: tail, type: "shot_first_frame", label: "分镜图（视频首帧）" },
];
const original = "剧情：沈砚转身。\n参考图对应关系：\n第1张：旧场景\n第2张：旧角色\n";
function target(protocol, overrides = {}) {
  return { provider_code: "fixture", base_url: "https://example.com", provider_config_json: {},
    model_id: "fixture-model", model_code: "fixture-video", model_alias: "测试视频模型", capability: "VIDEO_GENERATION",
    api_protocol: protocol, generation_endpoint: "/generate", query_endpoint: "/tasks/{task_id}",
    model_config_json: {}, parameter_schema_json: [{ name: "resolution", options: ["720p"] }],
    max_reference_images: 9, supports_async_tasks: 1, credit_cost: 1, credit_multiplier: 1, billing_unit: "PER_REQUEST", ...overrides };
}
function request(model, refs = references, prompt = original) {
  const gateway = new ModelGatewayService({}, {}, {}, {}, {});
  return gateway.request(model, { prompt, aspect_ratio: "9:16", resolution: "720p", duration: 10, seconds: 10, reference_images: refs }, "fixture-key").body;
}
function assertGuide(prompt) {
  assert.match(prompt, /图1是本视频的分镜图，并作为视频首帧/);
  assert.match(prompt, /图2为本视频场景“雨夜庭院”/);
  assert.match(prompt, /图3为角色沈砚的三视图（状态：白衣）/);
  assert.match(prompt, /图4为道具“玉佩”/);
  assert.equal(prompt.includes("旧场景"), false);
  assert.equal(prompt.includes("旧角色"), false);
  assert.equal(prompt.split("【参考图片对应关系】").length - 1, 1);
}

test("AllAIIn sends the previous tail as reference image 1 and preserves the dedicated first-frame field", () => {
  for (const mode of [undefined, "reference_images"]) {
    const body = request(target("allaiin_rest", { model_config_json: { reference_image_mode: mode } }));
    assert.deepEqual(body.reference_images, [tail, scene, shen, prop]);
    assert.equal(body.frame_start, mode ? undefined : tail);
    assertGuide(body.prompt);
  }
});

test("Waga profile and generic relay request arrays agree with every prompt image number", () => {
  const generic = request(target("lingkeai_media"));
  assert.deepEqual(generic.params.images, [tail, scene, shen, prop]);
  assertGuide(generic.prompt);
  const profiled = request(target("lingkeai_media", { model_code: "kwvideo-v2-quannengcankao",
    parameter_schema_json: [
      { name: "image_url", required: true }, { name: "duration", options: ["10"], required: true },
      { name: "resolution", options: ["720p"], required: true },
      { name: "aspect_ratio", options: ["9:16"] }, { name: "version", options: ["Mini"] },
    ] }));
  assert.deepEqual(profiled.params.image_url, [tail, scene, shen, prop]);
  assertGuide(profiled.prompt);
  const genericWire = request(target("openai"));
  assert.deepEqual(genericWire.reference_images.map(ref => ref.url), [tail, scene, shen, prop]);
  assertGuide(genericWire.prompt);
});

test("Gemini inline attachments and prompt follow the same first-frame order", () => {
  const refs = references.map((ref, index) => ({ ...ref, data_url: `data:image/png;base64,${Buffer.from(String(index)).toString("base64")}` }));
  const body = request(target("gemini"), refs);
  const parts = body.contents[0].parts;
  assertGuide(parts[0].text);
  assert.deepEqual(parts.slice(1).map(part => Buffer.from(part.inlineData.data, "base64").toString()), ["3", "2", "0", "1"]);
});

test("Gemini rejects missing inline references instead of silently dropping the first frame", () => {
  assert.throws(() => request(target("gemini")), /GEM 视频参考图必须包含有效的内嵌图片数据/);
  const refs = references.map(ref => ({ ...ref, data_url: "data:image/png;base64,YQ==" }));
  delete refs[3].data_url;
  assert.throws(() => request(target("gemini"), refs), /GEM 视频参考图必须包含有效的内嵌图片数据/);
  assert.doesNotThrow(() => request(target("gemini"), []));
});

test("Distinct characters sharing an image keep their own image numbers and the guide is refreshed once", () => {
  const refs = [...references, { url: shen, type: "character", label: "角色“林鸢”·黑衣" }];
  const prompt = "沈砚和林鸢交谈。\n【参考图片对应关系】\n图1为本视频场景旧庭院\n【参考图片对应关系结束】";
  const body = request(target("lingkeai_media"), refs, prompt);
  assert.deepEqual(body.params.images, [tail, scene, shen, shen, prop]);
  assert.match(body.prompt, /图3为角色沈砚的三视图/);
  assert.match(body.prompt, /图4为角色林鸢的三视图/);
  assert.match(body.prompt, /图5为道具“玉佩”/);
  assert.equal(body.prompt.includes("旧庭院"), false);
  assert.equal(body.prompt.split("【参考图片对应关系】").length - 1, 1);
});

test("Text-only requests do not retain generated image mappings", () => {
  const body = request(target("lingkeai_media"), [], "剧情继续。\n【参考图片对应关系】\n图1是本视频的分镜图\n【参考图片对应关系结束】");
  assert.deepEqual(body.params.images, []);
  assert.equal(body.prompt, "剧情继续。");
});

test("Legacy numbered prose moves with the images without changing character mention names", () => {
  const prompt = "参考图1中的沈砚拿起图2的玉佩，在参考图3的庭院里转身；以图4为首帧。角色图1和@道具图1保留名称。";
  for (const protocol of ["allaiin_rest", "lingkeai_media", "openai"]) {
    const body = request(target(protocol), references, prompt);
    assert.match(body.prompt, /^参考图3中的沈砚拿起图4的玉佩，在参考图2的庭院里转身；以图1为首帧。角色图1和@道具图1保留名称。/);
    assertGuide(body.prompt);
  }
});

test("Custom actions following an image identity declaration remain in the submitted prompt", () => {
  const body = request(target("lingkeai_media"), references, "图1为角色沈砚的三视图，沈砚随后拔剑向前走。\n镜头推近，画面逐渐暗下。");
  assert.match(body.prompt, /^图3为角色沈砚的三视图，沈砚随后拔剑向前走。\n镜头推近，画面逐渐暗下。/);
  assertGuide(body.prompt);
});
