const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
require("reflect-metadata");

const { ModelGatewayService } = require("../dist/gateway/model-gateway.service");

const durations = Array.from({ length: 12 }, (_, index) => index + 4);
const ratios = ["16:9", "9:16", "1:1", "3:4", "4:3"];
const reference = "https://example.com/reference.png";

function target() {
  return {
    provider_code: "allaiin",
    base_url: "https://ailingg.store/api/v1",
    provider_config_json: {},
    model_id: "provider-model-id",
    model_code: "minimax-h3-official",
    model_alias: "MiniMax H3 官",
    capability: "VIDEO_GENERATION",
    api_protocol: "allaiin_rest",
    generation_endpoint: "/video/generations",
    query_endpoint: "/tasks/{task_id}",
    credit_cost: 200,
    billing_unit: "PER_REQUEST",
    credit_multiplier: 1,
    max_reference_images: 9,
    supports_async_tasks: 1,
    model_config_json: {
      remote_numeric_id: 76,
      reference_image_mode: "reference_images",
      video_duration_options: durations,
      aspect_ratio_options: ratios,
    },
    parameter_schema_json: [
      { name: "resolution", options: ["768P"] },
      { name: "size", options: ratios },
      { name: "seconds", options: durations },
    ],
  };
}

test("MiniMax H3 official sends the documented AllAIIn payload", () => {
  const gateway = new ModelGatewayService({}, {}, {}, {}, {});
  const request = gateway.request(target(), {
    prompt: "海边日落延时摄影",
    aspect_ratio: "16:9",
    seconds: 4,
    resolution: "768p",
    reference_images: [
      { url: reference, type: "shot_first_frame" },
      { url: "https://example.com/character.png", type: "character" },
    ],
  }, "fixture-key");

  assert.equal(request.url, "https://ailingg.store/api/v1/video/generations");
  assert.equal(request.body.model_id, 76);
  assert.equal(request.body.size, "16:9");
  assert.equal(request.body.seconds, 4);
  assert.equal(request.body.resolution, "768P");
  assert.deepEqual(request.body.reference_images, [reference, "https://example.com/character.png"]);
  assert.equal(request.body.frame_start, undefined);
});

test("MiniMax H3 official rejects reference counts above the configured client limit", () => {
  const gateway = new ModelGatewayService({}, {}, {}, {}, {});
  assert.throws(() => gateway.request(target(), {
    prompt: "fixture",
    aspect_ratio: "9:16",
    seconds: 10,
    resolution: "768P",
    reference_images: Array.from({ length: 10 }, (_, index) => `https://example.com/${index}.png`),
  }, "fixture-key"), /最多支持 9 张参考图/);
});

test("sync and migration keep MiniMax H3 official configuration aligned", () => {
  const sync = fs.readFileSync(path.join(__dirname, "../src/scripts/sync-allaiin-models.ts"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../src/database/migrations/059_allaiin_minimax_h3_official.sql"), "utf8");
  const correction = fs.readFileSync(path.join(__dirname, "../src/database/migrations/060_allaiin_minimax_h3_768p.sql"), "utf8");
  for (const source of [sync, migration]) {
    assert.match(source, /minimax-h3-official/);
    assert.match(source, /MiniMax H3 官/);
    assert.match(source, /reference_image_mode[\s\S]*reference_images/);
    assert.match(source, /video_duration_options/);
    assert.match(source, /aspect_ratio_options/);
  }
  assert.match(sync, /\[76, "minimax-h3-official"\]/);
  assert.match(migration, /'remote_numeric_id', 76/);
  assert.match(migration, /'PER_REQUEST'/);
  assert.match(sync, /"768P"/);
  assert.match(correction, /'768P'/);
  assert.match(correction, /resolution = '720P'/);
  assert.match(migration, /JSON_ARRAY\(4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15\)/);
  assert.match(migration, /INSERT INTO ai_default_media_models/);
});
