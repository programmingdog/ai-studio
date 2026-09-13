const { test } = require("node:test");
const assert = require("node:assert/strict");
require("reflect-metadata");
const { AdminService } = require("../dist/admin/admin.service");
const { modelBillingUnit, validVideoSeconds, videoDurationOptions } = require("../dist/common/video-billing");

const input = (overrides = {}) => ({
  modelCode: "video-test", displayName: "Video Test", modelAlias: "测试视频", capability: "VIDEO_GENERATION",
  apiProtocol: "allaiin_rest", generationEndpoint: "/video/generations", queryEndpoint: null,
  creditCost: 80, billingUnit: "PER_REQUEST", creditMultiplier: 1.2, maxReferenceImages: 0,
  supportsReferenceVideo: false, supportsRealPerson: false, supportsAsyncTasks: false,
  sortOrder: 10, status: "ACTIVE", parameterSchema: [], config: { remote_numeric_id: 65 },
  resolutionPrices: [{ resolution: "720p", creditCost: 80 }], videoDurationOptions: [5, 10, 15],
  ...overrides,
});

test("admin video model settings validate billing and persist exact duration choices", () => {
  const valid = AdminService.prototype.validateProviderModel(input());
  assert.equal(valid.billingUnit, "PER_REQUEST");
  assert.deepEqual(valid.config.video_duration_options, [5, 10, 15]);
  assert.equal(valid.config.remote_numeric_id, 65);
  for (const options of [[5, 5], [0], [3601], [5.5], ["5"]]) {
    assert.throws(() => AdminService.prototype.validateProviderModel(input({ videoDurationOptions: options })), /时长选项/);
  }
  assert.throws(() => AdminService.prototype.validateProviderModel(input({ billingUnit: "PER_MINUTE" })), /计费方式/);
});

test("runtime accepts listed durations and keeps unrestricted models compatible", () => {
  const config = { video_duration_options: [5, 10, 15] };
  assert.deepEqual(videoDurationOptions(config), [5, 10, 15]);
  assert.equal(validVideoSeconds(10, config), true);
  assert.equal(validVideoSeconds(12, config), false);
  assert.equal(validVideoSeconds(12, {}), true);
  assert.equal(modelBillingUnit("VIDEO_GENERATION", "PER_REQUEST"), "PER_REQUEST");
  assert.equal(modelBillingUnit("VIDEO_GENERATION", undefined), "PER_SECOND");
});
