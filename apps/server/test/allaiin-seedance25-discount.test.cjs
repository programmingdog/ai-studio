const assert = require("node:assert/strict");
const { test } = require("node:test");
require("reflect-metadata");
const { ModelGatewayService } = require("../dist/gateway/model-gateway.service");
const { ModelTestService } = require("../dist/admin/model-test.service");
const { allaiinSeedance25Discount: profile, allaiinSeedance25DiscountSchema } = require("../dist/common/allaiin-seedance25-discount");

function target() {
  return {
    provider_code: "allaiin", base_url: "https://ailingg.store/api/v1", provider_config_json: {},
    model_id: "discount-id", model_code: profile.modelCode, model_alias: profile.alias,
    capability: "VIDEO_GENERATION", api_protocol: "allaiin_rest",
    generation_endpoint: "/video/generations", query_endpoint: "/tasks/{task_id}",
    credit_cost: 650, billing_unit: "PER_REQUEST", credit_multiplier: 1, max_reference_images: 30,
    model_config_json: { remote_numeric_id: 81, ...profile.config }, parameter_schema_json: allaiinSeedance25DiscountSchema(),
  };
}

test("Seedance discount submits model 81, 15/30 seconds, 720P and storyboard-first reference images", () => {
  const gateway = new ModelGatewayService({}, {});
  for (const seconds of [15, 30]) {
    const request = gateway.request(target(), {
      prompt: "人物从本分镜画面开始移动", resolution: "720p", aspect_ratio: "9:16", duration: seconds,
      reference_images: [
        { url: "https://example.com/scene.png", type: "scene", label: "场景" },
        { url: "https://example.com/tail.png", type: "shot_first_frame", label: "分镜图" },
        { url: "https://example.com/character.png", type: "character", label: "角色沈砚的三视图" },
      ],
    }, "fixture-key");
    assert.equal(request.url, "https://ailingg.store/api/v1/video/generations");
    assert.equal(request.body.model_id, 81);
    assert.equal(request.body.seconds, seconds);
    assert.equal(request.body.size, "9:16");
    assert.equal(request.body.resolution, "720P");
    assert.deepEqual(request.body.reference_images, ["https://example.com/tail.png", "https://example.com/scene.png", "https://example.com/character.png"]);
    assert.match(request.body.prompt, /图1.*分镜图/);
    assert.match(request.body.prompt, /图2.*场景/);
    assert.match(request.body.prompt, /图3.*沈砚/);
    for (const field of ["frame_start", "frame_end", "reference_video", "reference_audio"]) assert.equal(request.body[field], undefined);
  }
});

test("discount supports thirty references and rejects an oversized or non-public input", () => {
  const gateway = new ModelGatewayService({}, {});
  const payload = { prompt: "fixture", resolution: "720P", seconds: 30, reference_images: Array.from({ length: 30 }, (_, i) => `https://example.com/${i}.png`) };
  assert.equal(gateway.request(target(), payload, "fixture").body.reference_images.length, 30);
  assert.throws(() => gateway.request(target(), { ...payload, reference_images: [...payload.reference_images, "https://example.com/extra.png"] }, "fixture"), /最多支持 30 张/);
  assert.throws(() => gateway.request(target(), { ...payload, reference_images: ["file:///local.png"] }, "fixture"), /公网 URL/);
});

test("discount quotes per request for either duration, rejecting invalid duration/resolution", async () => {
  const database = { query: async () => [{ credit_cost: 650 }] };
  const gateway = new ModelGatewayService(database, {});
  for (const seconds of [15, 30]) assert.equal(await gateway.estimatedCredits(target(), { resolution: "720p", seconds }), 650);
  for (const seconds of [10, 16, 31]) await assert.rejects(() => gateway.estimatedCredits(target(), { resolution: "720p", seconds }), /时长须在模型支持的选项中/);
  await assert.rejects(() => gateway.estimatedCredits(target(), { resolution: "1080p", seconds: 30 }), /清晰度.*不可用/);
});

test("admin model test uses the same numeric identity and documented parameters", () => {
  const service = new ModelTestService({}, {}, {});
  const model = target();
  const request = service.createRequest(model, profile.alias, {
    prompt: "fixture", seconds: 30, resolution: "720p", size: "21:9", reference_images: ["https://example.com/shot.png"],
  }, model.model_config_json, {}, "fixture");
  assert.equal(request.body.model_id, 81);
  assert.equal(request.body.seconds, 30);
  assert.equal(request.body.resolution, "720P");
  assert.equal(request.body.size, "21:9");
  assert.deepEqual(request.body.reference_images, ["https://example.com/shot.png"]);
  const schema = allaiinSeedance25DiscountSchema();
  assert.deepEqual(schema.find(x => x.name === "seconds").options, [15, 30]);
  assert.deepEqual(schema.find(x => x.name === "resolution").options, ["720P"]);
  assert.equal(schema.some(x => ["frame_start", "frame_end", "reference_audio", "reference_video"].includes(x.name)), false);
});
