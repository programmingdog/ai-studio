const assert = require("node:assert/strict");
const { test } = require("node:test");
require("reflect-metadata");
const { CreditPricingService } = require("../dist/admin/credit-pricing.service");
const { normalizePricingGroup } = require("../dist/admin/provider-pricing.service");

function fixture(options = {}) {
  const state = { config: { cny_per_credit: options.allaiin ? 0.01 : 0.1, auto_sync: options.disabled ? 0 : 1, revision: 1, last_sync_at: null, last_sync_report: null }, cost: options.allaiin ? options.manual ? 12 : 8 : 9, tier: options.allaiin ? options.manualTier ? 12 : 8 : 9, writes: [], transactions: 0 };
  const route = { code: options.allaiin ? "allaiin" : "wagaai", base_url: "https://example.com", status: options.providerDisabled ? "DISABLED" : "ACTIVE", credential_id: "key-id", api_key_ciphertext: "cipher" };
  async function query(sql) {
    if (sql.includes("FROM model_credit_pricing_config")) return [{ ...state.config }];
    if (sql.includes("SELECT id, model_code")) return [{ id: "m1", model_code: options.model || "image", model_alias: "测试图", capability: options.requestVideo ? "VIDEO_GENERATION" : "IMAGE_GENERATION", billing_unit: options.requestVideo ? "PER_REQUEST" : "PER_SECOND", api_protocol: "lingkeai_media", credit_cost: state.cost, parameter_schema_json: [{ name: "resolution", options: ["2k"] }], config_json: options.allaiin ? { remote_numeric_id: 65, source_points_cost: 8 } : { existing_setting: true } }];
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
    if (options.allaiin) return { provider_id: "p1", provider_name: "AllAIIn", queried_at: new Date().toISOString(), models: [{ name: options.model || "image", remote_numeric_id: 65, source_points: 8 }] };
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

test("AllAIIn live refresh converts eight upstream points to 80 credits and preserves manual prices", async () => {
  const automatic = fixture({ allaiin: true });
  const result = await automatic.instance.refreshProvider("admin", "p1");
  assert.equal(result.credit_sync.updated_count, 1);
  assert.equal(result.credit_sync.items[0].price_cny, 0.8);
  assert.equal(automatic.state.cost, 80); assert.equal(automatic.state.tier, 80);
  assert.equal(JSON.parse(automatic.state.writes.find((write) => write.sql.startsWith("UPDATE provider_models SET config_json")).params[0]).source_credit_cost, 80);

  const manual = fixture({ allaiin: true, manual: true });
  const preserved = await manual.instance.refreshProvider("admin", "p1");
  assert.equal(preserved.credit_sync.skipped_count, 1);
  assert.equal(manual.state.cost, 12); assert.equal(manual.state.tier, 8);

  const manualTier = fixture({ allaiin: true, manualTier: true });
  const tierResult = await manualTier.instance.refreshProvider("admin", "p1");
  assert.equal(tierResult.credit_sync.skipped_count, 1);
  assert.equal(manualTier.state.cost, 80); assert.equal(manualTier.state.tier, 12);

  const perRequest = fixture({ allaiin: true, requestVideo: true });
  const fixed = await perRequest.instance.refreshProvider("admin", "p1");
  assert.equal(fixed.credit_sync.skipped_count, 1);
  assert.equal(perRequest.state.cost, 8); assert.equal(perRequest.state.tier, 8);
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
