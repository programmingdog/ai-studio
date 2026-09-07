const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  WAGAAI_TEXT_MODELS,
  RETIRED_WAGAAI_TEXT_MODEL_CODES,
  isAdminVisibleProviderModel,
  isDefaultModelCandidate,
} = require("../dist/common/wagaai-text-models.js");

test("WagaAI exposes only the three approved text models in admin lists", () => {
  assert.deepEqual(WAGAAI_TEXT_MODELS.map((model) => model.modelCode), [
    "gem-3.7-flash",
    "kimi-k2.6",
    "glm-5.3-flash",
  ]);
  for (const model of WAGAAI_TEXT_MODELS) {
    assert.equal(isAdminVisibleProviderModel({
      provider_code: "wagaai",
      capability: "TEXT_GENERATION",
      model_code: model.modelCode,
    }), true);
  }
  for (const modelCode of RETIRED_WAGAAI_TEXT_MODEL_CODES) {
    assert.equal(isAdminVisibleProviderModel({
      provider_code: "wagaai",
      capability: "TEXT_GENERATION",
      model_code: modelCode,
    }), false);
  }
  assert.equal(isAdminVisibleProviderModel({
    provider_code: "other-provider",
    capability: "TEXT_GENERATION",
    model_code: "custom-text-model",
  }), true);
  assert.equal(isDefaultModelCandidate({
    provider_code: "other-provider",
    capability: "TEXT_GENERATION",
    model_code: "custom-text-model",
  }), false);
  assert.equal(isDefaultModelCandidate({
    provider_code: "wagaai",
    capability: "IMAGE_GENERATION",
    model_code: "image-model",
  }), true);
  for (const model of WAGAAI_TEXT_MODELS) {
    assert.equal(isDefaultModelCandidate({
      provider_code: "wagaai",
      capability: "TEXT_GENERATION",
      model_code: model.modelCode,
    }), true);
  }
});

test("the migration retires both TT models and seeds all approved replacements", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../src/database/migrations/033_wagaai_text_model_catalog.sql"), "utf8");
  for (const modelCode of ["tt-5.6-luna", "tt-5.6-sol"]) {
    assert.match(migration, new RegExp(modelCode.replaceAll(".", "\\.")));
  }
  assert.match(migration, /SET pm\.status = 'DISABLED'/);
  for (const modelCode of WAGAAI_TEXT_MODELS.map((model) => model.modelCode)) {
    assert.match(migration, new RegExp(modelCode.replaceAll(".", "\\.")));
  }
});

test("provider models can reuse one model code across capabilities", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../src/database/migrations/034_provider_model_multi_capability.sql"), "utf8");
  const sync = fs.readFileSync(path.join(__dirname, "../src/scripts/sync-wagaai-models.ts"), "utf8");
  assert.match(migration, /DROP INDEX uq_provider_models_code/);
  assert.match(migration, /UNIQUE KEY uq_provider_models_code_capability \(provider_id, model_code, capability\)/);
  assert.match(migration, /'GEM 3\.7 Flash 视频理解', 'VIDEO_UNDERSTANDING'/);
  assert.match(migration, /SET dc\.video_understanding_model_id = pm\.id/);
  assert.match(sync, /name: "gem-3\.7-flash", alias: "GEM 3\.7 Flash 视频理解", capability: "VIDEO_UNDERSTANDING"/);
});
