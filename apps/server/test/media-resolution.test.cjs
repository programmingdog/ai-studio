const assert = require("node:assert/strict");
const { test } = require("node:test");
require("reflect-metadata");
const { resolveMediaResolution } = require("../dist/gateway/media-resolution");
const { ModelGatewayService } = require("../dist/gateway/model-gateway.service");
const defaultMultipliers = { get: async () => ({ multipliers: { TEXT_GENERATION: 1, VIDEO_UNDERSTANDING: 1, IMAGE_GENERATION: 1, VIDEO_GENERATION: 1 } }) };

const definition = (field, values) => [{ name: field, options: values }];
function resolve(overrides = {}) {
  return resolveMediaResolution({ resolution: "2K", aspectRatio: "9:16", schema: [], config: {}, protocol: "lingkeai_media", capability: "IMAGE_GENERATION", modelCode: "test-model", ...overrides });
}
function target(overrides = {}) {
  return { model_id: "model-id", model_code: "test-model", base_url: "https://provider.example", generation_endpoint: "/v1/images/generations", api_protocol: "lingkeai_media", capability: "IMAGE_GENERATION", model_config_json: {}, provider_config_json: {}, parameter_schema_json: [], ...overrides };
}
const gateway = new ModelGatewayService({}, {});
function request(model, payload) { return gateway.request(model, payload, "fake-test-key"); }

test("uses provider enum value casing, not the UI label", () => {
  assert.deepEqual(resolve({ schema: definition("resolution", [{ label: "2K", value: "2k" }]) }), { field: "resolution", value: "2k" });
  assert.deepEqual(resolve({ resolution: "1080P", capability: "VIDEO_GENERATION", schema: definition("resolution", [{ label: "1080P", value: "1080p" }]) }), { field: "resolution", value: "1080p" });
});

test("supports string enums and nested JSON Schema definitions", () => {
  assert.deepEqual(resolve({ resolution: "720p", schema: { properties: { params: { properties: { resolution: { enum: ["480P", "720P"] } } } } } }), { field: "resolution", value: "720P" });
});

test("supports explicit mapping for providers without an enum", () => {
  assert.deepEqual(resolve({ config: { resolution_mapping: { "2k": "2k" } } }), { field: "resolution", value: "2k" });
  assert.deepEqual(resolve({ config: { resolution_parameter: "size", resolution_mapping: { "2K": { "9:16": "1440x2560" } } } }), { field: "size", value: "1440x2560" });
  assert.equal(resolve().value, "2K");
});

test("rejects unsupported or unavailable tiers instead of silently downgrading", () => {
  assert.throws(() => resolve({ schema: definition("resolution", ["1k"]) }), /不支持分辨率/);
  assert.throws(() => resolve({ schema: definition("resolution", [{ value: "2k", currently_unavailable: true }]) }), /未开放/);
  assert.throws(() => resolve({ config: { resolution_parameter: "size", resolution_mapping: { "2K": { "16:9": "2560x1440" } } } }), /缺少当前画面比例/);
});

test("maps image tiers and aspect ratios to exact pixel options", () => {
  const schema = definition("size", [{ label: "Portrait (9:16)", value: "1088x1920" }, { label: "2K Portrait (9:16)", value: "1440x2560" }, { label: "2K Landscape (16:9)", value: "2560x1440" }]);
  assert.equal(resolve({ schema }).value, "1440x2560");
  assert.equal(resolve({ schema, aspectRatio: "16:9" }).value, "2560x1440");
  assert.equal(resolve({ schema, resolution: "1k" }).value, "1088x1920");
});

test("media image and video wire requests use the matched value", () => {
  const payload = { prompt: "test", resolution: "1080P", params: { resolution: "1080p" } };
  const model = target({ capability: "VIDEO_GENERATION", parameter_schema_json: definition("resolution", ["1080p"]) });
  assert.equal(request(model, payload).body.params.resolution, "1080p");
  assert.equal(payload.resolution, "1080P");
  const image = request(target({ parameter_schema_json: definition("imageSize", ["2k"]) }), { prompt: "test", resolution: "2K" });
  assert.equal(image.body.params.imageSize, "2k");
  assert.equal(image.body.params.resolution, undefined);
});

test("REST and generic video requests normalize top-level and nested values", () => {
  for (const api_protocol of ["allaiin_rest", "openai"]) {
    const result = request(target({ api_protocol, capability: "VIDEO_GENERATION", parameter_schema_json: definition("resolution", ["720P"]) }), { resolution: "720p", params: { resolution: "720p" }, size: "9:16" });
    assert.equal(result.body.resolution, "720P");
    assert.equal(result.body.params.resolution, "720P");
    assert.equal(result.body.size, "9:16");
  }
});

test("Gemini applies chosen imageSize even with prebuilt contents", () => {
  const result = request(target({ api_protocol: "gemini", parameter_schema_json: definition("imageSize", ["2K"]) }), { resolution: "2k", contents: [{ parts: [{ text: "test" }] }], generationConfig: { temperature: 0.5, imageConfig: { imageSize: "1K", aspectRatio: "9:16" } } });
  assert.equal(result.body.generationConfig.imageConfig.imageSize, "2K");
  assert.equal(result.body.generationConfig.temperature, 0.5);
});

test("OpenAI-style JSON and multipart image requests do not discard the chosen resolution", () => {
  const model = target({ api_protocol: "openai", parameter_schema_json: definition("resolution", ["2k"]) });
  const payload = { resolution: "2K", prompt: "test" };
  assert.equal(request(model, payload).body.resolution, "2k");
  const multipart = request(model, { ...payload, reference_images: [{ data_url: "data:image/png;base64,aGVsbG8=" }] });
  assert.ok(multipart.body instanceof FormData);
  assert.equal(multipart.body.get("resolution"), "2k");
  assert.equal(multipart.body.get("size"), null);
  assert.equal(multipart.body.getAll("image[]").length, 1);
});

test("pixel-size APIs receive the chosen tier rather than a fixed default", () => {
  const model = target({ api_protocol: "openai", parameter_schema_json: definition("size", [{ label: "2K Portrait (9:16)", value: "1440x2560" }]) });
  assert.equal(request(model, { resolution: "2K", aspect_ratio: "9:16" }).body.size, "1440x2560");
});

test("conflicting top-level and nested tiers cannot bypass selected resolution", () => {
  assert.throws(() => request(target(), { resolution: "2K", params: { resolution: "4K" } }), /不一致/);
});

test("fixed-output resolution and duration are omitted from provider payload", () => {
  const model = target({ model_code: "omni_flash-10s", capability: "VIDEO_GENERATION" });
  assert.equal(request(model, { resolution: "default", duration: 10 }).body.params.resolution, undefined);
  assert.equal(request(model, { resolution: "720P", duration: 10 }).body.params.resolution, undefined);
});

test("billing continues to look up the selected tier before provider case mapping", async () => {
  let parameters;
  const service = new ModelGatewayService({ query: async (_sql, values) => { parameters = values; return [{ credit_cost: 7 }]; } }, {}, defaultMultipliers);
  const payload = { resolution: "1080P", duration: 10 };
  const price = await service.estimatedCredits(target({ capability: "VIDEO_GENERATION" }), payload);
  assert.equal(price, 70);
  assert.deepEqual(parameters, ["model-id", "1080P"]);
  assert.deepEqual(payload, { resolution: "1080P", duration: 10 });
});

test("invalid provider resolution is rejected before reserving credits or submitting", async () => {
  const model = target({ parameter_schema_json: definition("resolution", ["768P"]) });
  let reserved = false;
  const service = new ModelGatewayService({
    query: async (sql) => sql.includes("provider_model_resolution_prices") ? [{ credit_cost: 7 }] : sql.includes("FROM provider_models pm") ? [model] : [],
    transaction: async () => { reserved = true; throw new Error("must not reserve"); },
  }, { decrypt: () => "fake-test-key" }, defaultMultipliers);
  await assert.rejects(service.create("test-user", { idempotencyKey: "test-request", providerModelId: "model-id", payload: { resolution: "720p", prompt: "test" } }), error => {
    assert.match(error.message, /720p.*不可用/);
    assert.equal(error.getResponse().code, 'TASK_NOT_SUBMITTED');
    assert.equal(error.getResponse().retryable, false);
    return true;
  });
  assert.equal(reserved, false);
});

test('Hailuo H3 catalog excludes obsolete 720p prices without inventing a 768P price', async () => {
  const { ClientConfigService } = require('../dist/client-config/client-config.service');
  const schema = definition('resolution', ['768P', '1080P', '2K', '4K']);
  const model = { ...target({ capability: 'VIDEO_GENERATION', model_code: 'hailuo-h3-quannengcankao' }), id: 'model-id', credit_cost: 1, parameter_schema_json: schema, config_json: {} };
  const prices = [{ provider_model_id: 'model-id', resolution: '720p', credit_cost: 1 }, { provider_model_id: 'model-id', resolution: '2k', credit_cost: 3 }];
  const service = new ClientConfigService({ query: async sql => sql.includes('FROM provider_model_resolution_prices') ? prices : [model] }, defaultMultipliers);
  const list = await service.models();
  assert.deepEqual(list[0].resolution_prices.map(p => p.resolution), ['2k']);
  assert.equal(list[0].resolution_prices[0].credit_cost, 3);
  assert.deepEqual(prices.map(p => p.resolution), ['720p', '2k']);
  assert.equal(list[0].config_json, undefined);
});

test('Hailuo quote rejects 720p before workflow starts and 2k submits as 2K', async () => {
  const model = target({ capability: 'VIDEO_GENERATION', model_code: 'hailuo-h3-quannengcankao', parameter_schema_json: definition('resolution', ['768P', '1080P', '2K', '4K']) });
  const service = new ModelGatewayService({ query: async () => [{ credit_cost: 3 }] }, {}, defaultMultipliers);
  service.target = async () => model;
  service.call = () => assert.fail('quote must never generate');
  service.database.transaction = () => assert.fail('quote must never reserve');
  await assert.rejects(service.quote({ providerModelId: 'model-id', payload: { resolution: '720p', seconds: 10 } }), /720p.*不可用/);
  assert.equal((await service.quote({ providerModelId: 'model-id', payload: { resolution: '2k', seconds: 10 } })).credits, 30);
  assert.equal(request(model, { prompt: 'test', resolution: '2k', duration: 10, reference_images: ['https://example.com/ref.png'] }).body.params.resolution, '2K');
});

test('catalog validation respects configured pixel mappings for non-default aspect ratios', () => {
  const { supportsMediaResolution } = require('../dist/gateway/media-resolution');
  assert.equal(supportsMediaResolution({ resolution: '2K', config: { resolution_parameter: 'size', resolution_mapping: { '2K': { '2:3': '1024x1536' } } }, schema: [], protocol: 'openai', capability: 'IMAGE_GENERATION', modelCode: 'image' }), true);
});
