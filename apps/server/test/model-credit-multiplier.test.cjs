const assert = require("node:assert/strict");
const { test } = require("node:test");
require("reflect-metadata");
const { ModelCreditMultiplierService, validateMultiplier, multiplierFor, multiplyCredits } = require("../dist/common/model-credit-multiplier.service");
const { ModelGatewayService } = require("../dist/gateway/model-gateway.service");
const { ClientConfigService } = require("../dist/client-config/client-config.service");
const { AdminService } = require("../dist/admin/admin.service");
const defaults = { TEXT_GENERATION: 1, VIDEO_UNDERSTANDING: 1, IMAGE_GENERATION: 1, VIDEO_GENERATION: 1 };
const factors = { TEXT_GENERATION: 2, VIDEO_UNDERSTANDING: 0.5, IMAGE_GENERATION: 1.5, VIDEO_GENERATION: 3 };
const config = (values = factors) => ({ get: async () => ({ multipliers: values, revision: 2 }) });
const model = (capability) => ({ model_id: "m1", id: "m1", model_code: "demo", model_alias: "Demo", capability, credit_cost: 10, supports_async_tasks: 0 });

test("all four types default to 1 and invalid/missing factors fail closed", async () => {
  const instance = new ModelCreditMultiplierService({ query: async () => [{ text_generation: "1.000000", video_understanding: 1, image_generation: 1, video_generation: 1, revision: 0 }] });
  assert.deepEqual((await instance.get()).multipliers, defaults);
  for (const invalid of [0, -1, null, true, "", "1e2", "0.0000001", 1001, Infinity, NaN]) assert.throws(() => validateMultiplier(invalid));
  assert.equal(validateMultiplier("0.5"), 0.5);
  assert.throws(() => multiplierFor(defaults, "INVALID"));
  await assert.rejects(new ModelCreditMultiplierService({ query: async () => [] }).get(), /配置缺失/);
});

test("multiplication preserves fractional credits without integer ceiling or floating point artifacts", () => {
  assert.equal(multiplyCredits(3, 1.5), 4.5);
  assert.equal(multiplyCredits(1, 0.5), 0.5);
  assert.equal(multiplyCredits(0.07, 0.1), 0.007);
  assert.equal(multiplyCredits(0.000001, 0.5), 0.000001);
  assert.equal(multiplyCredits(10, 1e-8), 0.000001);
  assert.equal(multiplyCredits(0, 1.5), 0);
  assert.throws(() => multiplyCredits(Infinity, 1));
});

test("gateway charges each capability once; image/video use resolution prices and video seconds", async () => {
  const service = new ModelGatewayService({ query: async () => [{ credit_cost: 4 }] }, {}, config());
  assert.equal(await service.estimatedCredits(model("TEXT_GENERATION"), {}), 20);
  assert.equal(await service.estimatedCredits(model("VIDEO_UNDERSTANDING"), {}), 5);
  assert.equal(await service.estimatedCredits(model("IMAGE_GENERATION"), { resolution: "2K", credit_cost: 0, credit_multiplier: 0 }), 6);
  assert.equal(await service.estimatedCredits(model("VIDEO_GENERATION"), { resolution: "1080p", duration: 10, credit_multiplier: 0 }), 120);
  const identity = new ModelGatewayService({ query: async () => [{ credit_cost: 4 }] }, {}, config(defaults));
  assert.equal(await identity.estimatedCredits(model("VIDEO_GENERATION"), { resolution: "1080p", duration: 10 }), 40);
});

test("client prices and gateway charges agree for every model type and resolution", async () => {
  const rows = Object.keys(defaults).map((type, index) => ({ ...model(type), id: `m${index}` }));
  const priceRows = [{ provider_model_id: "m2", resolution: "2K", credit_cost: 4 }, { provider_model_id: "m3", resolution: "1080p", credit_cost: 7 }];
  const db = { query: async (sql) => sql.includes("FROM provider_model_resolution_prices") ? priceRows : rows };
  const client = new ClientConfigService(db, config());
  const result = await client.models();
  assert.deepEqual(result.map((m) => m.credit_cost), [20, 5, 15, 30]);
  assert.equal(result[2].resolution_prices[0].credit_cost, 6);
  assert.equal(result[3].resolution_prices[0].credit_cost, 21);
  assert.equal(result[3].resolution_prices[0].base_credit_cost, 7);
  assert.equal(result[3].credit_multiplier, 3);
  const gateway = new ModelGatewayService({ query: async () => [{ credit_cost: 7 }] }, {}, config());
  assert.equal(await gateway.estimatedCredits(model("VIDEO_GENERATION"), { resolution: "1080p", duration: 2.5 }), 21 * 2.5);
  assert.equal(priceRows[0].credit_cost, 4);
});

test("admin catalog keeps editable base costs distinct from final prices", async () => {
  const db = { query: async (sql) => sql.includes("FROM provider_model_resolution_prices") ? [{ provider_model_id: "m1", resolution: "2K", credit_cost: 4 }] : [model("IMAGE_GENERATION")] };
  const result = await new AdminService(db, {}, {}, config()).listProviderModels("p1");
  assert.equal(result[0].credit_cost, 10);
  assert.equal(result[0].final_credit_cost, 15);
  assert.equal(result[0].resolution_prices[0].credit_cost, 4);
  assert.equal(result[0].resolution_prices[0].final_credit_cost, 6);
});

test("saving coefficients is audited, revision protected, and never rewrites model bases", async () => {
  const state = { text_generation: 1, video_understanding: 1, image_generation: 1, video_generation: 1, revision: 0 };
  const writes = [];
  const db = { query: async () => [{ ...state }], transaction: async (fn) => fn({ query: async () => [[{ ...state }]], execute: async (sql, args) => {
    writes.push(sql);
    if (sql.startsWith("UPDATE")) { [state.text_generation, state.video_understanding, state.image_generation, state.video_generation] = args; state.revision++; }
  } }) };
  const service = new ModelCreditMultiplierService(db);
  await assert.rejects(service.save("admin", { multipliers: factors, revision: 9 }), /已被修改/);
  assert.equal(writes.length, 0);
  const saved = await service.save("admin", { multipliers: factors, revision: 0 });
  assert.deepEqual(saved.multipliers, factors);
  assert(writes.some((sql) => sql.includes("INSERT INTO audit_logs")));
  assert(writes.every((sql) => !/provider_models|provider_model_resolution_prices|ledger_/.test(sql)));
});

test("settlement uses the locked final estimate even if coefficients later change", async () => {
  const writes = [];
  const connection = { query: async (sql) => {
    if (sql.includes("FROM ai_tasks")) return [[{ id: "task", user_id: "user", estimated_credits: "12.500000", provider_model_id: "m1", logical_model_code: "demo" }]];
    if (sql.includes("FROM credit_holds")) return [[{ status: "ACTIVE" }]];
    if (sql.includes("FROM ledger_accounts")) return [[{ id: "account" }]];
    throw new Error("Unexpected query");
  }, execute: async (sql, args) => { writes.push({ sql, args }); } };
  const service = new ModelGatewayService({ transaction: async (fn) => fn(connection) }, {}, { get: () => { throw new Error("Must not reload/reapply multiplier during settlement"); } });
  await service.settle("task", {});
  assert.equal(writes.find(({ sql }) => sql.includes("INSERT INTO ledger_entries")).args[3], -12.5);
  assert.equal(writes.find(({ sql }) => sql.startsWith("UPDATE ai_tasks")).args[0], 12.5);
});

test("insufficient balance for the multiplied cost blocks submission before any write", async () => {
  let submitted = false;
  const connection = { query: async (sql) => {
    if (sql.includes("FROM ai_tasks")) return [[]];
    if (sql.includes("FROM ledger_accounts")) return [[{ id: "account" }]];
    if (sql.includes("FROM ledger_entries")) return [[{ balance: 15 }]];
    if (sql.includes("FROM credit_holds")) return [[{ held: 0 }]];
    throw new Error("Unexpected query");
  }, execute: () => { throw new Error("Must not write an unaffordable task"); } };
  const service = new ModelGatewayService({ transaction: async (fn) => fn(connection) }, { decrypt: () => "fake-test-key" }, config());
  service.existing = async () => null;
  service.target = async () => model("TEXT_GENERATION");
  service.request = () => ({ url: "https://example.invalid", method: "POST", headers: {}, body: {} });
  service.call = async () => { submitted = true; };
  await assert.rejects(service.create("user", { idempotencyKey: "request", providerModelId: "m1", payload: { prompt: "test", credit_multiplier: 0 } }), /积分不足/);
  assert.equal(submitted, false);
});
