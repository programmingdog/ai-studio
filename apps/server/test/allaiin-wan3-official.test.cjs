const assert = require("node:assert/strict");
const { test } = require("node:test");
require("reflect-metadata");
const { ModelGatewayService } = require("../dist/gateway/model-gateway.service");
const { ModelTestService } = require("../dist/admin/model-test.service");
const { allaiinWan3Official: profile, allaiinWan3OfficialSchema, wan3ReferenceVideoMultiplier } = require("../dist/common/allaiin-wan3-official");

const prices = { "480p": 15, "720p": 30, "1080p": 60 };
function target() {
  return {
    provider_code: "allaiin", base_url: "https://ailingg.store/api/v1", provider_config_json: {},
    model_id: "wan3-id", model_code: "wan3.0-video", model_alias: "Wan 3.0 官", capability: "VIDEO_GENERATION",
    api_protocol: "allaiin_rest", generation_endpoint: "/video/generations", query_endpoint: "/tasks/{task_id}",
    credit_cost: 30, billing_unit: "PER_SECOND", credit_multiplier: 1, max_reference_images: 30,
    model_config_json: { remote_numeric_id: 69, ...profile.config }, parameter_schema_json: allaiinWan3OfficialSchema(),
  };
}

test("Wan official sends ID 69, exact resolution casing and ordered multi-modal references without independent frame fields", () => {
  const gateway = new ModelGatewayService({}, {});
  for (const resolution of ["480p", "720p", "1080p"]) {
    for (const duration of [4, 24, 30]) {
      const request = gateway.request(target(), { prompt: "fixture", resolution, duration, aspect_ratio: "16:9",
        reference_images: [{ type: "scene", url: "https://example.com/scene.png" }, { type: "shot_first_frame", url: "https://example.com/shot.png" }],
        reference_video: "https://example.com/video.mp4", reference_audio: "https://example.com/audio.mp3",
      }, "fixture");
      assert.equal(request.body.model_id, 69);
      assert.equal(request.body.resolution, resolution.toUpperCase());
      assert.equal(request.body.seconds, duration);
      assert.equal(request.body.size, "16:9");
      assert.deepEqual(request.body.reference_images, ["https://example.com/shot.png", "https://example.com/scene.png"]);
      assert.equal(request.body.reference_video, "https://example.com/video.mp4");
      assert.equal(request.body.reference_audio, "https://example.com/audio.mp3");
      assert.equal(request.body.frame_start, undefined);
      assert.equal(request.body.frame_end, undefined);
    }
  }
  assert.equal(gateway.queryRequest(target(), "wan-task/1", "fixture").url, "https://ailingg.store/api/v1/tasks/wan-task%2F1");
});

test("Wan official quotes the selected per-second tier and doubles video-reference cost only", async () => {
  const database = { query: async (sql, params) => [{ credit_cost: prices[params[1].toLowerCase()] }] };
  const gateway = new ModelGatewayService(database, {});
  for (const [resolution, unit] of Object.entries(prices)) {
    for (const seconds of [4, 30]) {
      const payload = { resolution, seconds, reference_images: ["https://example.com/shot.png"] };
      assert.equal(await gateway.estimatedCredits(target(), payload), unit * seconds);
      assert.equal(await gateway.estimatedCredits(target(), { ...payload, reference_audio: "https://example.com/a.mp3" }), unit * seconds);
      for (const extra of [{ reference_video: "https://example.com/a.mp4" }, { reference_videos: ["https://example.com/a.mp4"] }, { params: { reference_video: "https://example.com/a.mp4" } }]) {
        const price = await gateway.estimatedPricing(target(), { ...payload, ...extra });
        assert.equal(price.credits, unit * seconds * 2);
        assert.equal(price.costCredits, unit * seconds * 2);
      }
    }
  }
  for (const seconds of [3, 31, 4.5]) await assert.rejects(() => gateway.estimatedCredits(target(), { resolution: "720p", seconds }), /时长须在模型支持的选项中/);
});

test("Wan reference validation rejects excess clips, private file inputs and audio-only references before charging", () => {
  assert.equal(wan3ReferenceVideoMultiplier({ reference_video: "", reference_videos: [] }), 1);
  assert.equal(wan3ReferenceVideoMultiplier({ reference_videos: Array(5).fill("https://example.com/a.mp4") }), 2);
  for (const payload of [{ reference_videos: Array(6).fill("https://example.com/a.mp4") }, { params: { reference_videos: ["file:///a.mp4"] } }, { reference_audio: "https://example.com/a.mp3" }, { reference_videos: "https://example.com/a.mp4" }]) assert.throws(() => wan3ReferenceVideoMultiplier(payload));
});

test("Wan admin schema exposes every supported integer duration and keeps its numeric model route", () => {
  const schema = allaiinWan3OfficialSchema();
  assert.deepEqual(schema.find(x => x.name === "seconds").options, Array.from({ length: 27 }, (_, i) => i + 4));
  assert.deepEqual(schema.find(x => x.name === "resolution").options, ["480P", "720P", "1080P"]);
  assert.equal(schema.some(x => x.name === "frame_start" || x.name === "frame_end"), false);
  const model = target();
  const request = new ModelTestService({}, {}, {}).createRequest(model, profile.alias, {
    prompt: "fixture", seconds: 30, size: "9:16", resolution: "1080P", reference_videos: ["https://example.com/a.mp4"],
  }, model.model_config_json, {}, "fixture");
  assert.equal(request.body.model_id, 69);
  assert.equal(request.body.resolution, "1080P");
  assert.equal(request.body.seconds, 30);
});
