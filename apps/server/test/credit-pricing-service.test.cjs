const assert = require("node:assert/strict");
const { test } = require("node:test");
require("reflect-metadata");
const { CreditPricingService } = require("../dist/admin/credit-pricing.service");
const { normalizePricingGroup } = require("../dist/admin/provider-pricing.service");

function fixture(options = {}) {
  const state = { config: { cny_per_credit: 0.1, auto_sync: options.disabled ? 0 : 1, revision: 1, last_sync_at: null, last_sync_report: null }, cost: 9, tier: 9, writes: [], transactions: 0 };
  const route = { code: "wagaai", base_url: "https://example.com", status: options.providerDisabled ? "DISABLED" : "ACTIVE", credential_id: "key-id", api_key_ciphertext: "cipher" };
  async function query(sql) {
    if (sql.includes("FROM model_credit_pricing_config")) return [{ ...state.config }];
    if (sql.includes("SELECT id, model_code")) return [{ id: "m1", model_code: options.model || "image", model_alias: "测试图", capability: "IMAGE_GENERATION", api_protocol: "lingkeai_media", credit_cost: state.cost, parameter_schema_json: [{ name: "resolution", options: ["2k"] }], config_json: { existing_setting: true } }];
    if (sql.includes("FROM provider_model_resolution_prices")) return [{ provider_model_id: "m1", resolution: "2K", credit_cost: state.tier }];
    if (sql.includes("LEFT JOIN provider_credentials")) return [route];
    if (sql.includes("SELECT id, display_name, code, status FROM providers")) return [{ id: "p1", display_name: "WagaAI", code: "wagaai", status: "ACTIVE" }];
    throw new Error(`unexpected query: ${sql}`);
  }
  async function execute(sql, params) {
    state.writes.push({ sql, params });
    if (sql.startsWith("UPDATE provider_models SET credit_cost")) state.cost = params[0];
    if (sql.startsWith("UPDATE provider_model_resolution_prices")) state.tier = params[0];
    if (sql.includes("SET cny_per_credit")) { state.config.cny_per_credit = params[0]; state.config.auto_sync = params[1]; state.config.revision++; }
    if (sql.includes("SET last_sync_at")) state.config.last_sync_report = params[0];
    return { affectedRows: 1 };
  }
  const db = { query, execute, async transaction(operation) {
    state.transactions++;
    return operation({ query: async (sql, args) => [await query(sql, args)], execute });
  } };
  const pricing = { async query() {
    if (options.changed) state.tier = 77;
    if (options.ratioChanged) state.config.revision++;
    if (options.keyChanged) route.credential_id = "new-key";
    if (options.failed) throw new Error("upstream unavailable");
    return { provider_id: "p1", provider_name: "WagaAI", models: [{ name: options.model || "image", available_for_this_key: true,
      channel_groups: [normalizePricingGroup({ is_active: true, in_key_whitelist: true, billing_method: options.token ? "按token" : "按次", base_price: 0.21, min_price: 0.21, option_prices: [] })] }] };
  } };
  return { instance: new CreditPricingService(db, pricing), state };
}

test("updates persisted resolution and fallback costs atomically with an audit trail", async () => {
  const { instance, state } = fixture();
  const result = await instance.refreshProvider("admin", "p1");
  assert.equal(result.credit_sync.updated_count, 1);
  assert.equal(state.tier, 3); assert.equal(state.cost, 3);
  assert(state.writes.some(({ sql }) => sql.startsWith("INSERT INTO audit_logs")));
  assert(state.writes.every(({ sql }) => !/ledger_|credit_holds|ai_tasks|credit_packages/.test(sql)));
});

test('Waga sync persists generation parameters atomically even when rounded credits are unchanged', async () => {
  const { instance, state } = fixture({ model: 'tt-image-2' });
  state.cost = 3; state.tier = 3;
  const result = await instance.refreshProvider('admin','p1');
  assert.equal(result.credit_sync.unchanged_count, 1);
  const write = state.writes.find(w => w.sql.startsWith('UPDATE provider_models SET config_json'));
  assert(write);
  const config = JSON.parse(write.params[0]);
  assert.equal(config.existing_setting, true);
  assert.deepEqual(config.generation_parameters_by_resolution['2K'], result.credit_sync.items[0].parameters);
  assert.equal(state.transactions, 1);
});

test("disabled automatic pricing and disabled providers are read-only", async () => {
  for (const options of [{ disabled: true }, { providerDisabled: true }]) {
    const { instance, state } = fixture(options);
    const result = await instance.refreshProvider("admin", "p1");
    assert.equal(result.credit_sync.enabled, false); assert.equal(state.writes.length, 0);
  }
});

test("unconvertible token pricing keeps both resolution and fallback prices intact", async () => {
  const { instance, state } = fixture({ token: true });
  const result = await instance.refreshProvider("admin", "p1");
  assert.equal(result.credit_sync.skipped_count, 1);
  assert.equal(state.cost, 9); assert.equal(state.tier, 9);
});

test("concurrent model, ratio or key edits reject stale writes", async () => {
  for (const options of [{ changed: true }, { ratioChanged: true }, { keyChanged: true }]) {
    const { instance, state } = fixture(options);
    await assert.rejects(instance.refreshProvider("admin", "p1"), /改变/);
    assert.equal(state.writes.length, 0);
  }
});

test("configuration save validates value and optimistic revision before writing", async () => {
  const { instance, state } = fixture();
  await assert.rejects(instance.save("admin", { cny_per_credit: 0, auto_sync: true, revision: 1 }), /每积分/);
  await assert.rejects(instance.save("admin", { cny_per_credit: 0.2, auto_sync: false, revision: 0 }), /已被修改/);
  assert.equal(state.writes.length, 0);
  const result = await instance.save("admin", { cny_per_credit: 0.2, auto_sync: false, revision: 1 });
  assert.equal(result.config.cny_per_credit, 0.2); assert.equal(result.config.auto_sync, false); assert.equal(state.tier, 9);
});

test("saving an enabled ratio recalculates models; upstream failure remains explicit", async () => {
  const { instance, state } = fixture();
  const result = await instance.save("admin", { cny_per_credit: 0.01, auto_sync: true, revision: 1 });
  assert.equal(result.report.updated_count, 1); assert.equal(state.tier, 21);
  const failed = fixture({ failed: true });
  const report = await failed.instance.syncAll("admin");
  assert.match(report.errors[0], /upstream unavailable/); assert.equal(failed.state.tier, 9);
});
