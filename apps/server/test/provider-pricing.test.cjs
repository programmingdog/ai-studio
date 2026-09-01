const assert = require("node:assert/strict");
const { test } = require("node:test");
require("reflect-metadata");
const { ProviderPricingService, normalizePricingGroup } = require("../dist/admin/provider-pricing.service");

function service(options = {}) {
  const queries = [];
  const database = { async query(sql, args) {
    queries.push({ sql, args });
    if (sql.includes("FROM providers WHERE")) return options.missing ? [] : [{ id: "p1", code: options.code || "wagaai", display_name: "WagaAI", base_url: options.url || "https://provider.example/api" }];
    if (sql.includes("FROM provider_credentials")) return options.noKey ? [] : [{ name: "测试密钥", api_key_ciphertext: "encrypted" }];
    if (sql.includes("FROM provider_models")) return options.models || [{ model_code: "image-2", model_alias: "图片别名", display_name: "Image 2" }, { model_code: "special/chat", model_alias: "特殊文本", display_name: "Special" }];
    throw new Error("Unexpected database query");
  } };
  return { instance: new ProviderPricingService(database, { decrypt: () => "fake-secret" }), queries };
}
function upstream(t, handler) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}
const catalog = { models: [{ name: "image-2", display_name: "Image 2", type: "image", available_for_this_key: true }, { name: "remote-only", display_name: "Remote", type: "video" }] };
const channel = { group_name: "运行渠道", is_active: true, billing_method: "按次", base_price: 0.02, min_price: 0, in_key_whitelist: true, option_prices: [{ param_name: "resolution", option_label: "2K", option_value: "2k", final_price: 0.05, price_multiplier: 2.5, price_addition: -0.01 }] };

test("normalization preserves zero, paused state, token prices and option casing without exposing unknown fields", () => {
  const result = normalizePricingGroup({ ...channel, is_active: false, input_token_price: "0", output_token_price: "1.2", secret: "do-not-forward" });
  assert.equal(result.base_price, 0.02);
  assert.equal(result.min_price, 0);
  assert.equal(result.input_token_price, 0);
  assert.equal(result.output_token_price, 1.2);
  assert.equal(result.is_active, false);
  assert.equal(result.option_prices[0].option_value, "2k");
  assert.equal(result.option_prices[0].price_addition, -0.01);
  assert.equal(result.secret, undefined);
  assert.equal(normalizePricingGroup({ base_price: false, min_price: -1 }).base_price, null);
  assert.equal(normalizePricingGroup({}).is_active, null);
});

test("queries full catalog plus local models, retains all channels and maps local aliases", async (t) => {
  const calls = upstream(t, (url) => Response.json(url.endsWith("/models") ? catalog : { channel_groups: [channel, { ...channel, is_active: false }], available_for_this_key: false }));
  const { instance, queries } = service();
  const result = await instance.query("p1");
  assert.equal(result.models.length, 3);
  assert.equal(result.success_count, 3);
  assert.equal(result.failed_count, 0);
  assert.deepEqual(result.models[0].local_aliases, ["图片别名"]);
  assert.equal(result.models[0].available_for_this_key, false);
  assert.equal(result.models[0].channel_groups.length, 2);
  assert(calls.some(({ url }) => url.endsWith("special%2Fchat/pricing")));
  assert(calls.every(({ url, init }) => !url.includes("status=") && init.redirect === "error" && init.headers.Authorization === "Bearer fake-secret"));
  assert(queries.some(({ sql }) => sql.includes("status = 'ACTIVE'")));
  assert(!JSON.stringify(result).includes("fake-secret"));
  assert(queries.every(({ sql }) => sql.startsWith("SELECT")));
});

test("per-model failure is isolated and upstream error body is not forwarded", async (t) => {
  upstream(t, (url) => url.endsWith("/models") ? Response.json(catalog) : url.includes("remote-only") ? new Response("fake-secret", { status: 429 }) : Response.json({ channel_groups: [] }));
  const result = await service().instance.query("p1");
  assert.equal(result.failed_count, 1);
  assert.equal(result.success_count, 2);
  assert.match(result.models[1].error, /429/);
  assert(!JSON.stringify(result).includes("fake-secret"));
});

test("rejects unsupported provider, missing provider, disabled keys and invalid gateway without fetching", async (t) => {
  const calls = upstream(t, () => { throw new Error("must not fetch"); });
  for (const [options, expected] of [[{ code: "other" }, /暂未接入/], [{ missing: true }, /不存在/], [{ noKey: true }, /API Key/], [{ url: "http://provider.example" }, /HTTPS/], [{ url: "https://secret@provider.example" }, /HTTPS/]]) {
    await assert.rejects(service(options).instance.query("p1"), expected);
  }
  assert.equal(calls.length, 0);
});

test("malformed catalog fails explicitly and network errors do not expose secrets", async (t) => {
  upstream(t, () => Response.json({ error: "fake-secret" }));
  await assert.rejects(service().instance.query("p1"), /目录格式无效/);
  t.mock.restoreAll();
  upstream(t, () => { throw new Error("fake-secret"); });
  await assert.rejects(service().instance.query("p1"), (error) => !error.message.includes("fake-secret") && /连接失败/.test(error.message));
});

test("coalesces simultaneous queries but refresh fetches again", async (t) => {
  const calls = upstream(t, (url) => Response.json(url.endsWith("/models") ? catalog : { channel_groups: [] }));
  const { instance } = service();
  const first = instance.query("p1"), second = instance.query("p1");
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(calls.length, 4);
  await instance.query("p1");
  assert.equal(calls.length, 8);
});

test("limits upstream concurrency and retains catalog order", async (t) => {
  const models = Array.from({ length: 19 }, (_, index) => ({ name: `model-${index}` }));
  let active = 0, peak = 0;
  upstream(t, async (url) => {
    if (url.endsWith("/models")) return Response.json({ models });
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return Response.json({ channel_groups: [channel] });
  });
  const result = await service({ models: [] }).instance.query("p1");
  assert.equal(peak, 6);
  assert.deepEqual(result.models.map((model) => model.name), models.map((model) => model.name));
});
