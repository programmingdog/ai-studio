const assert = require("node:assert/strict");
const { test } = require("node:test");
require("reflect-metadata");
const { ModelGatewayService } = require("../dist/gateway/model-gateway.service");
const { ModelTestService } = require("../dist/admin/model-test.service");
const { ClientConfigService } = require("../dist/client-config/client-config.service");
const { AdminService } = require("../dist/admin/admin.service");
const { allaiinMuseVideo: profile, allaiinMuseVideoSchema: schema } = require("../dist/common/allaiin-muse-video");

function target() {
  return {
    provider_code: "allaiin", base_url: "https://ailingg.store/api/v1", provider_config_json: {},
    model_id: "muse-id", model_code: profile.modelCode, model_alias: profile.alias,
    capability: "VIDEO_GENERATION", api_protocol: "allaiin_rest", generation_endpoint: "/video/generations", query_endpoint: "/tasks/{task_id}",
    credit_cost: 8, billing_unit: "PER_SECOND", credit_multiplier: 1, max_reference_images: 7,
    model_config_json: { remote_numeric_id: 83, ...profile.config }, parameter_schema_json: schema(),
  };
}
const payload = () => ({ prompt: "参考图2中的人物走进场景", resolution: "720p", duration: 15, aspect_ratio: "9:16", reference_images: [
  { url: "https://example.com/scene.png", type: "scene", label: "车站" },
  { url: "https://example.com/person.png", type: "character", label: "角色沈砚" },
  { url: "https://example.com/tail.png", type: "shot_first_frame", label: "分镜图" },
] });

test("Muse uses model 83, every documented duration and ratio, preserving storyboard-first references and prompt numbering", () => {
  const gateway = new ModelGatewayService({}, {});
  for (const seconds of [5, 10, 15, 20, 25, 30]) for (const size of ["16:9", "9:16"]) {
    const request = gateway.request(target(), { ...payload(), seconds, size }, "fixture");
    assert.equal(request.url, "https://ailingg.store/api/v1/video/generations");
    assert.equal(request.body.model_id, 83);
    assert.equal(request.body.seconds, seconds);
    assert.equal(request.body.size, size);
    assert.equal(request.body.resolution, "720P");
    assert.equal(request.body.count, 1);
    assert.deepEqual(request.body.reference_images, ["https://example.com/tail.png", "https://example.com/scene.png", "https://example.com/person.png"]);
    assert.match(request.body.prompt, /参考图3中的人物/);
    assert.match(request.body.prompt, /图1是本视频的分镜图/);
    assert.match(request.body.prompt, /图2为本视频场景/);
    assert.match(request.body.prompt, /图3为角色沈砚的三视图/);
    for (const key of ["frame_start", "frame_end", "reference_audio", "params", "duration", "model"]) assert.equal(request.body[key], undefined);
  }
  assert.equal(gateway.queryRequest(target(), "muse/task", "fixture").url, "https://ailingg.store/api/v1/tasks/muse%2Ftask");
});

test("Muse quotes 720P at the configured per-second tier with no reference video surcharge", async () => {
  const database = { query: async () => [{ credit_cost: 8 }] };
  const gateway = new ModelGatewayService(database, {});
  for (const [seconds, credits] of [[5, 40], [10, 80], [15, 120], [20, 160], [25, 200], [30, 240]]) {
    for (const refs of [{}, { reference_video: "https://example.com/a.mp4" }, { reference_videos: ["https://example.com/a.mp4"] }]) {
      assert.deepEqual(await gateway.estimatedPricing(target(), { ...payload(), seconds, ...refs }), { credits, costCredits: credits });
    }
  }
  const multiplied = { ...target(), credit_multiplier: 1.5 };
  assert.deepEqual(await gateway.estimatedPricing(multiplied, payload()), { credits: 180, costCredits: 120 });
  // Mixed legacy aliases must quote the same normalized duration that gets submitted.
  const mixed = { ...payload(), duration: 15, params: { seconds: 30 } };
  assert.equal(gateway.request(target(), mixed, "fixture").body.seconds, 30);
  assert.equal(await gateway.estimatedCredits(target(), mixed), 240);
});

test("Muse accepts text-only, seven images, singular references and nested compatibility inputs", () => {
  const gateway = new ModelGatewayService({}, {});
  const minimal = { resolution: "720P", seconds: 10, prompt: "海边日落" };
  assert.equal(gateway.request(target(), minimal, "fixture").body.reference_images, undefined);
  const images = Array.from({ length: 7 }, (_, i) => `https://example.com/${i}.png`);
  assert.deepEqual(gateway.request(target(), { params: { ...minimal, reference_images: images, reference_videos: ["https://example.com/a.mp4"] } }, "fixture").body,
    { model_id: 83, prompt: "海边日落\n【参考图片对应关系】\n图片编号严格对应本次实际提交的附件顺序：\n" + images.map((_, i) => `图${i + 1}为参考图。`).join("\n") + "\n【参考图片对应关系结束】", size: "9:16", seconds: 10, resolution: "720P", count: 1, reference_images: images, reference_video: "https://example.com/a.mp4" });
  assert.deepEqual(gateway.request(target(), { ...minimal, reference_image: images[0] }, "fixture").body.reference_images, [images[0]]);
});

test("Muse rejects unsupported input before pricing DB reads and submission, instead of silently dropping references", async () => {
  let queries = 0;
  const gateway = new ModelGatewayService({ query: async () => { queries++; return [{ credit_cost: 8 }]; } }, {});
  for (const invalid of [
    { seconds: 6 }, { seconds: 30.5 }, { resolution: "1080P" }, { size: "1:1" }, { count: 2 },
    { reference_images: Array(8).fill("https://example.com/a.png") },
    { reference_image: "https://example.com/a.png", reference_images: Array(7).fill("https://example.com/a.png") },
    { reference_videos: Array(2).fill("https://example.com/a.mp4") },
    { reference_video: "https://example.com/a.mp4", reference_videos: ["https://example.com/b.mp4"] },
    { reference_images: ["file:///a.png"] }, { reference_videos: ["data:video/mp4;base64,abc"] },
    { reference_images: "https://example.com/a.png" }, { frame_start: "https://example.com/a.png" },
    { frame_end: "https://example.com/a.png" }, { reference_audio: "https://example.com/a.mp3" },
    { reference_audios: ["https://example.com/a.mp3"] },
  ]) {
    await assert.rejects(() => gateway.estimatedPricing(target(), { ...payload(), ...invalid }), /Muse-video/);
    assert.throws(() => gateway.request(target(), { ...payload(), ...invalid }, "fixture"));
  }
  assert.equal(queries, 0);
});

test("Muse admin test uses the same body contract, allows documented batch counts and rejects unsupported media", () => {
  const service = new ModelTestService({}, {}, {});
  const model = target();
  const input = { ...payload(), count: 4, reference_video: "https://example.com/a.mp4", model_id: 69 };
  const request = service.createRequest(model, profile.alias, input, model.model_config_json, {}, "fixture");
  assert.equal(request.body.model_id, 83);
  assert.equal(request.body.count, 4);
  assert.equal(request.body.resolution, "720P");
  assert.equal(request.body.reference_images[0], "https://example.com/tail.png");
  assert.equal(request.body.reference_video, "https://example.com/a.mp4");
  assert.throws(() => service.createRequest(model, profile.alias, { ...input, reference_audio: "https://example.com/a.mp3" }, model.model_config_json, {}, "fixture"), /不支持/);
});

test("Muse client catalog exposes exact durations, ratio, limits, preview notice and priced 720P tier", async () => {
  const database = { query: async (sql) => sql.includes("SELECT rp.provider_model_id")
    ? [{ provider_model_id: "muse-id", resolution: "720P", credit_cost: 8 }, { provider_model_id: "muse-id", resolution: "1080P", credit_cost: 8 }]
    : [{ ...target(), id: "muse-id", config_json: target().model_config_json, supports_reference_video: 1, supports_real_person: 0, supports_async_tasks: 1, sort_order: 10 }] };
  const [model] = await new ClientConfigService(database).models();
  assert.deepEqual(model.video_duration_options, [5, 10, 15, 20, 25, 30]);
  assert.deepEqual(model.aspect_ratio_options, ["9:16", "16:9"]);
  assert.equal(model.max_reference_images, 7);
  assert.equal(model.supports_reference_video, true);
  assert.equal(model.billing_unit, "PER_SECOND");
  assert.match(model.generation_notice, /预览模型/);
  assert.deepEqual(model.resolution_prices.map(p => [p.resolution, p.credit_cost]), [["720P", 8]]);
  assert.equal(model.config_json, undefined);
});

test("Muse schema can be saved in the existing admin configuration without enabling unsupported frame/audio inputs", () => {
  const validated = AdminService.prototype.validateProviderModel({
    modelCode: profile.modelCode, displayName: profile.alias, modelAlias: profile.alias, capability: "VIDEO_GENERATION",
    apiProtocol: "allaiin_rest", generationEndpoint: "/video/generations", queryEndpoint: "/tasks/{task_id}", creditCost: 8, billingUnit: "PER_SECOND",
    creditMultiplier: 1, maxReferenceImages: 7, supportsReferenceVideo: true, supportsRealPerson: false, supportsAsyncTasks: true,
    sortOrder: 110, status: "ACTIVE", parameterSchema: schema(), config: target().model_config_json,
    resolutionPrices: [{ resolution: "720P", creditCost: 8 }], videoDurationOptions: profile.durations,
  });
  assert.deepEqual(validated.config.video_duration_options, profile.durations);
  assert.equal(validated.config.manual_resolution_pricing, true);
  assert.equal(schema().some(item => ["frame_start", "frame_end", "reference_audio", "reference_audios"].includes(item.name)), false);
});
