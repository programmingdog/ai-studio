const assert = require("node:assert/strict");
const { test } = require("node:test");
require("reflect-metadata");
const { multiplyCredits, roundedModelCredits, storedModelCreditMultiplier, validateModelCreditMultiplier } = require("../dist/common/model-credit");
const { ModelGatewayService } = require("../dist/gateway/model-gateway.service");
const { ClientConfigService } = require("../dist/client-config/client-config.service");
const { AdminService } = require("../dist/admin/admin.service");

const model = (capability, multiplier = 1) => ({
  model_id: "m1", id: "m1", model_code: "demo", model_alias: "Demo", capability,
  credit_cost: 10, credit_multiplier: multiplier, supports_async_tasks: 0,
});

test("each model multiplier defaults to 1 in storage and invalid factors fail closed", () => {
  for (const invalid of [0, -1, null, true, "", "1e2", "0.0000001", 1001, Infinity, NaN]) {
    assert.throws(() => validateModelCreditMultiplier(invalid));
  }
  assert.equal(validateModelCreditMultiplier("0.5"), 0.5);
  assert.equal(storedModelCreditMultiplier("1.000000"), 1);
  assert.throws(() => storedModelCreditMultiplier(undefined), /配置无效/);
  const admin = new AdminService({}, {}, {});
  const input = { modelCode: "demo", displayName: "Demo", modelAlias: "Demo", capability: "TEXT_GENERATION",
    apiProtocol: "openai", generationEndpoint: "/v1/chat/completions", creditCost: 1, maxReferenceImages: 0,
    supportsReferenceVideo: false, supportsRealPerson: false, supportsAsyncTasks: false, sortOrder: 1, resolutionPrices: [] };
  assert.equal(admin.validateProviderModel(input).creditMultiplier, 1);
  assert.throws(() => admin.validateProviderModel({ ...input, creditMultiplier: 0 }));
});

test("multiplication preserves fractional credits without floating point artifacts", () => {
  assert.equal(multiplyCredits(3, 1.5), 4.5);
  assert.equal(multiplyCredits(1, 0.5), 0.5);
  assert.equal(multiplyCredits(0.07, 0.1), 0.007);
  assert.equal(multiplyCredits(0.000001, 0.5), 0.000001);
  assert.equal(multiplyCredits(10, 1e-8), 0.000001);
  assert.equal(multiplyCredits(0, 1.5), 0);
  assert.throws(() => multiplyCredits(Infinity, 1));
});

test("billable model prices round fractional credits upward", () => {
  assert.equal(roundedModelCredits(3, 1.5), 5);
  assert.equal(roundedModelCredits(1, 0.5), 1);
  assert.equal(roundedModelCredits(10, 0.3), 3);
  assert.equal(roundedModelCredits(0, 1.5), 0);
});

test("gateway charges each model's own factor; media uses resolution prices and video seconds", async () => {
  const service = new ModelGatewayService({ query: async () => [{ credit_cost: 4 }] }, {});
  assert.equal(await service.estimatedCredits(model("TEXT_GENERATION", 2), {}), 20);
  assert.equal(await service.estimatedCredits(model("VIDEO_UNDERSTANDING", 0.5), {}), 5);
  assert.equal(await service.estimatedCredits(model("IMAGE_GENERATION", 1.5), { resolution: "2K", credit_multiplier: 0 }), 6);
  assert.equal(await service.estimatedCredits(model("VIDEO_GENERATION", 3), { resolution: "1080p", duration: 10 }), 120);
  assert.equal(await service.estimatedCredits(model("VIDEO_GENERATION"), { resolution: "1080p", duration: 10 }), 40);
});

test("client prices and gateway charges agree for every independently configured model", async () => {
  const rows = [model("TEXT_GENERATION", 2), model("VIDEO_UNDERSTANDING", 0.5), model("IMAGE_GENERATION", 1.5), model("VIDEO_GENERATION", 3)]
    .map((row, index) => ({ ...row, id: `m${index}` }));
  const priceRows = [{ provider_model_id: "m2", resolution: "2K", credit_cost: 4 }, { provider_model_id: "m3", resolution: "1080p", credit_cost: 7 }];
  const db = { query: async (sql) => sql.includes("FROM provider_model_resolution_prices") ? priceRows : rows };
  const result = await new ClientConfigService(db).models();
  assert.deepEqual(result.map((item) => item.credit_cost), [20, 5, 15, 30]);
  assert.equal(result[2].resolution_prices[0].credit_cost, 6);
  assert.equal(result[3].resolution_prices[0].credit_cost, 21);
  assert.equal(result[3].resolution_prices[0].base_credit_cost, 7);
  assert.equal(result[3].credit_multiplier, 3);
  const gateway = new ModelGatewayService({ query: async () => [{ credit_cost: 7 }] }, {});
  assert.equal(await gateway.estimatedCredits(model("VIDEO_GENERATION", 3), { resolution: "1080p", duration: 2.5 }), 53);
  assert.equal(await gateway.estimatedCredits(model("VIDEO_GENERATION", 0.5), { resolution: "1080p", duration: 2.5 }), 10);
  assert.equal(priceRows[0].credit_cost, 4);
});

test("admin catalog keeps editable base costs distinct from per-model final prices", async () => {
  const db = { query: async (sql) => sql.includes("FROM provider_model_resolution_prices")
    ? [{ provider_model_id: "m1", resolution: "2K", credit_cost: 4 }]
    : [model("IMAGE_GENERATION", 1.5)] };
  const result = await new AdminService(db, {}, {}).listProviderModels("p1");
  assert.equal(result[0].credit_cost, 10);
  assert.equal(result[0].credit_multiplier, 1.5);
  assert.equal(result[0].final_credit_cost, 15);
  assert.equal(result[0].resolution_prices[0].credit_cost, 4);
  assert.equal(result[0].resolution_prices[0].final_credit_cost, 6);
});

test("admin display, client catalog and gateway agree on a fractional resolution price", async () => {
  const row = model("IMAGE_GENERATION", 1.1);
  const price = { provider_model_id: "m1", resolution: "2K", credit_cost: 4 };
  const db = { query: async (sql) => sql.includes("FROM provider_model_resolution_prices") ? [price] : [row] };
  const admin = (await new AdminService(db, {}, {}).listProviderModels("p1"))[0];
  const client = (await new ClientConfigService(db).models())[0];
  const gateway = new ModelGatewayService({ query: async () => [price] }, {});
  assert.equal(admin.resolution_prices[0].final_credit_cost, 5);
  assert.equal(client.resolution_prices[0].credit_cost, 5);
  assert.equal(await gateway.estimatedCredits(row, { resolution: "2K" }), 5);
});

test("settlement uses the locked final estimate even if the model factor later changes", async () => {
  const writes = [], commissions = [];
  const connection = { query: async (sql) => {
    if (sql.includes("FROM ai_tasks")) return [[{ id: "task", user_id: "user", estimated_credits: "12.500000", provider_model_id: "m1", logical_model_code: "demo", capability: "IMAGE_GENERATION" }]];
    if (sql.includes("FROM credit_holds")) return [[{ status: "ACTIVE" }]];
    if (sql.includes("FROM ledger_accounts")) return [[{ id: "account" }]];
    throw new Error("Unexpected query");
  }, execute: async (sql, args) => { writes.push({ sql, args }); } };
  const referrals = { settleGenerationConsumption: async (...args) => commissions.push(args) };
  const service = new ModelGatewayService({ transaction: async (fn) => fn(connection) }, {}, undefined, undefined, referrals);
  await service.settle("task", {});
  assert.equal(writes.find(({ sql }) => sql.includes("INSERT INTO ledger_entries")).args[3], -12.5);
  assert.equal(writes.find(({ sql }) => sql.startsWith("UPDATE ai_tasks")).args[0], 12.5);
  const consumption = writes.find(({ sql }) => sql.includes("INSERT INTO credit_consumption_records"));
  assert.match(consumption.sql, /UTC_TIMESTAMP\(3\)/);
  assert.equal(commissions.length, 1);
  assert.deepEqual(commissions[0].slice(1), [consumption.args[0], "task", "user", "IMAGE_GENERATION", 12.5]);
  assert.equal(commissions[0][0], connection);
});

test("insufficient balance for the model-multiplied cost blocks submission", async () => {
  let submitted = false;
  const connection = { query: async (sql) => {
    if (sql.includes("FROM ai_tasks")) return [[]];
    if (sql.includes("FROM ledger_accounts")) return [[{ id: "account" }]];
    if (sql.includes("FROM ledger_entries")) return [[{ balance: 15 }]];
    if (sql.includes("FROM credit_holds")) return [[{ held: 0 }]];
    throw new Error("Unexpected query");
  }, execute: () => { throw new Error("Must not write an unaffordable task"); } };
  const service = new ModelGatewayService({ transaction: async (fn) => fn(connection) }, { decrypt: () => "fake-test-key" });
  service.existing = async () => null;
  service.target = async () => model("TEXT_GENERATION", 2);
  service.request = () => ({ url: "https://example.invalid", method: "POST", headers: {}, body: {} });
  service.call = async () => { submitted = true; };
  await assert.rejects(service.create("user", { idempotencyKey: "request", providerModelId: "m1", payload: { prompt: "test", credit_multiplier: 0 } }), /积分不足/);
  assert.equal(submitted, false);
});
