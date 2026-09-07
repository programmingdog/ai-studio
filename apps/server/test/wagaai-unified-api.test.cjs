const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
require('reflect-metadata');

const { ModelGatewayService } = require('../dist/gateway/model-gateway.service');

function target(overrides) {
  return {
    provider_code: 'wagaai',
    base_url: 'https://api.lk888.ai',
    provider_config_json: {},
    model_id: 'model-id',
    model_alias: 'model',
    capability: 'TEXT_GENERATION',
    query_endpoint: null,
    credit_cost: 1,
    supports_async_tasks: 0,
    model_config_json: {},
    parameter_schema_json: [],
    ...overrides,
  };
}

test('WagaAI text requests use the documented root URL and model protocol', () => {
  const gateway = new ModelGatewayService({}, {});
  const gem = gateway.request(target({
    model_code: 'gem-3.7-flash',
    api_protocol: 'gemini',
    generation_endpoint: '/v1beta/models/{model}:generateContent',
  }), { contents: [{ parts: [{ text: 'Hello' }] }] }, 'fixture-key');
  assert.equal(gem.url, 'https://api.lk888.ai/v1beta/models/gem-3.7-flash:generateContent');
  assert.equal(gem.headers.Authorization, 'Bearer fixture-key');

  for (const model of ['kimi-k2.6', 'glm-5.3-flash']) {
    const request = gateway.request(target({
      model_code: model,
      api_protocol: 'openai',
      generation_endpoint: '/v1/chat/completions',
    }), { messages: [{ role: 'user', content: 'Hello' }] }, 'fixture-key');
    assert.equal(request.url, 'https://api.lk888.ai/v1/chat/completions');
    assert.equal(request.body.model, model);
  }
});

test('sync and migration keep the WagaAI universal API contract aligned', () => {
  const sync = fs.readFileSync(path.join(__dirname, '../src/scripts/sync-wagaai-models.ts'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../src/database/migrations/035_wagaai_unified_api.sql'), 'utf8');
  assert.match(sync, /WAGAAI_BASE_URL = "https:\/\/api\.lk888\.ai"/);
  assert.doesNotMatch(sync, /WAGAAI_BASE_URL = "https:\/\/api\.lk888\.ai\/api"/);
  assert.match(sync, /requestJson<Record<string, unknown>>\("\/v1\/skills\/guide"/);
  assert.match(migration, /base_url = 'https:\/\/api\.lk888\.ai'/);
  assert.match(migration, /'\/v1\/media\/generate'/);
  assert.match(migration, /'\/v1\/skills\/task-status'/);
  assert.match(migration, /'\/v1beta\/models\/\{model\}:generateContent'/);
  assert.match(migration, /'\/v1\/chat\/completions'/);
});
