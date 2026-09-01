const assert = require("node:assert/strict");
const { test } = require("node:test");
const { calculateModelCredits, cnyToCredits, validateCnyPerCredit } = require("../dist/admin/credit-price-calculator");
const { normalizePricingGroup } = require("../dist/admin/provider-pricing.service");

const field = (name, values) => ({ name, options: values.map((value) => typeof value === "string" ? { value, label: value } : value) });
const option = (param, value, final, multiplier = 1, addition = 0) => ({ param_name: param, option_value: value, option_label: value, final_price: final, price_multiplier: multiplier, price_addition: addition });
const group = (overrides = {}) => normalizePricingGroup({ group_name: "default", is_active: true, in_key_whitelist: true, billing_method: "按次", base_price: 0.1, min_price: 0.1, option_prices: [], ...overrides });
const model = (overrides = {}) => ({ id: "m1", model_code: "test-image", model_alias: "测试图", capability: "IMAGE_GENERATION", api_protocol: "lingkeai_media", credit_cost: 10,
  parameter_schema_json: [field("resolution", ["1k", "2k", "4k"])], config_json: {},
  resolution_prices: ["1K", "2K", "4K"].map((resolution) => ({ resolution, credit_cost: 10 })), ...overrides });
function calculate(overrides = {}, groups = [group()], ratio = 0.1, priceOverrides = {}) {
  return calculateModelCredits(model(overrides), { name: "test-image", available_for_this_key: true, channel_groups: groups, ...priceOverrides }, ratio);
}

test("validates the ratio and uses decimal ceiling with a minimum of one credit", () => {
  assert.equal(validateCnyPerCredit("0.1"), 0.1);
  for (const invalid of [0, -1, Infinity, NaN, null, true, "", "1e3", "0.0000001", 1000001]) assert.throws(() => validateCnyPerCredit(invalid));
  assert.equal(cnyToCredits(0.07, 0.01), 7);
  assert.equal(cnyToCredits(0.21, 0.1), 3);
  assert.equal(cnyToCredits(0, 0.1), 1);
  assert.throws(() => cnyToCredits(1000000, 0.1), /上限/);
});

test("selects the cheapest eligible channel separately for each resolution, matching case", () => {
  const results = calculate({}, [group({ group_name: "first-expensive", base_price: 2, min_price: 2 }), group({ group_name: "cheap", option_prices: [option("resolution", "2k", 0.25, 2.5), option("resolution", "4k", 0.45, 4.5)] }), group({ group_name: "paused", is_active: false, base_price: 0.001 }), group({ group_name: "forbidden", in_key_whitelist: false, base_price: 0.001 })]);
  assert.deepEqual(results.map((item) => item.credits), [1, 3, 5]);
  assert(results.every((item) => item.channel === "cheap"));
  assert.equal(results[1].parameters.resolution, "2k");
});

test("combines price factors and additions instead of adding final prices or using a bare base", () => {
  const results = calculate({ parameter_schema_json: [field("resolution", ["2k"]), field("quality", ["high"])], resolution_prices: [{ resolution: "2K", credit_cost: 99 }] }, [group({ base_price: 0.1, min_price: 0.1, option_prices: [option("resolution", "2k", 0.4, 4), option("quality", "high", 0.25, 2, 0.05)] })]);
  assert.equal(results[0].price_cny, 0.85);
  assert.equal(results[0].credits, 9);
});

test("respects actual min_price floor and exact option final_price", () => {
  assert.equal(calculate({}, [group({ base_price: 0.1, min_price: 0.4 })])[0].price_cny, 0.4);
  assert.equal(calculate({}, [group({ base_price: 0.216, min_price: 0.216, option_prices: [option("resolution", "4k", 0.3857, 1.7857)] })])[2].price_cny, 0.3857);
});

test("omitted price options use base, but unavailable or unsupported schema tiers are skipped", () => {
  const results = calculate({ parameter_schema_json: [field("resolution", [{ value: "1k", currently_unavailable: true }, "2k"])] });
  assert.equal(results[0].status, "SKIPPED");
  assert.equal(results[1].credits, 1);
  assert.equal(results[2].status, "SKIPPED");
});

test("pixel size variants match their resolution tier and cheapest aspect ratio", () => {
  const result = calculate({ parameter_schema_json: [{ name: "size", options: [{ value: "2560x1440", label: "2K (16:9)" }, { value: "1440x2560", label: "2K (9:16)" }, { value: "5120x2880", label: "4K (16:9)" }] }] }, [group({ option_prices: [option("size", "2560x1440", 0.3, 3), option("size", "1440x2560", 0.2, 2), option("size", "5120x2880", 0.6, 6)] })]);
  assert.equal(result[1].price_cny, 0.2);
  assert.equal(result[2].price_cny, 0.6);
});

test("per-second video uses the requested resolution price without dividing by duration", () => {
  const results = calculate({ capability: "VIDEO_GENERATION", resolution_prices: [{ resolution: "720p", credit_cost: 8 }], parameter_schema_json: [field("resolution", ["720P"])] }, [group({ billing_method: "按秒", base_price: 0.144, min_price: 0.144, option_prices: [option("resolution", "720P", 0.288, 2)] })]);
  assert.equal(results[0].credits, 3);
  assert.equal(results[0].parameters.billing_duration_seconds, undefined, 'equal per-second prices must not lock one arbitrary duration');
  assert.equal(results[0].billing_unit, "PER_SECOND");
});

test("per-request video is converted using supported durations and combined parameter prices", () => {
  const overrides = { capability: "VIDEO_GENERATION", resolution_prices: [{ resolution: "720p", credit_cost: 8 }], parameter_schema_json: [field("resolution", ["720p"]), field("duration", ["5", "10"]), field("quality", ["high"])] };
  const results = calculate(overrides, [group({ base_price: 1, min_price: 1, option_prices: [option("duration", "10", 2, 2), option("quality", "high", 1.5, 1.5)] })]);
  assert.equal(results[0].price_cny, 0.3);
  assert.equal(results[0].credits, 3);
  assert.equal(calculate({ ...overrides, parameter_schema_json: [field("resolution", ["720p"])] })[0].status, "SKIPPED");
});

test("known fixed-duration video retains default resolution and divides by its actual fixed duration", () => {
  const result = calculate({ model_code: "omni_flash-10s", capability: "VIDEO_GENERATION", resolution_prices: [{ resolution: "default", credit_cost: 8 }], parameter_schema_json: [] }, [group({ base_price: 2, min_price: 2 })]);
  assert.equal(result[0].price_cny, 0.2);
});

test("token-only, bad currency, absent price or unusable Key never overwrite old costs", () => {
  for (const [groups, priceOverrides] of [[[group({ billing_method: "按token", base_price: 0, min_price: null, output_token_price: 70 })], {}], [[group({ currency: "USD" })], {}], [[group()], { available_for_this_key: false }], [[group()], { error: "HTTP 404" }], [[group({ is_active: false })], {}]]) {
    const result = calculate({}, groups, 0.1, priceOverrides)[0];
    assert.equal(result.status, "SKIPPED"); assert.equal(result.credits, null); assert.equal(result.previous_credits, 10);
  }
});

test("mixed token channels are not misinterpreted as free per-request quotes", () => {
  const result = calculate({}, [group({ billing_method: "按token", base_price: 0, min_price: null }), group({ base_price: 0.2, min_price: 0.2 })])[0];
  assert.equal(result.credits, 2);
  assert.match(result.reason, /Token/);
});

test("channel 1K-only suffix cannot supply a cheaper 4K quote", () => {
  const result = calculate({}, [group({ group_name: "cheap-1K" }), group({ group_name: "all", base_price: 0.3, min_price: 0.3 })]);
  assert.equal(result[0].channel, "cheap-1K"); assert.equal(result[2].channel, "all");
});

test("nonmedia per-request prices update, token prices stay on manual billing", () => {
  const overrides = { capability: "TEXT_GENERATION", resolution_prices: [], parameter_schema_json: [] };
  assert.equal(calculate(overrides)[0].credits, 1);
  assert.equal(calculate(overrides, [group({ billing_method: "按token", base_price: 0, min_price: null })])[0].status, "SKIPPED");
});
