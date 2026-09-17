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

test('WagaAI Gemini and text requests use the documented root URL and model protocol', () => {
  const gateway = new ModelGatewayService({}, {});
  for (const model of ['gem-3.7-flash', 'gem-3.8-flash']) {
    const gem = gateway.request(target({
      model_code: model,
      api_protocol: 'gemini',
      generation_endpoint: '/v1beta/models/{model}:generateContent',
    }), { contents: [{ parts: [{ text: 'Hello' }] }] }, 'fixture-key');
    assert.equal(gem.url, `https://api.lk888.ai/v1beta/models/${model}:generateContent`);
    assert.equal(gem.headers.Authorization, 'Bearer fixture-key');
  }

  const video = gateway.request(target({
    model_code: 'gem-3.8-flash',
    model_alias: 'GEM 3.8 Flash 视频理解',
    capability: 'VIDEO_UNDERSTANDING',
    api_protocol: 'gemini',
    generation_endpoint: '/v1beta/models/{model}:generateContent',
  }), { video_uri: 'https://example.com/video.mp4', mime_type: 'video/mp4', prompt: '分析视频' }, 'fixture-key');
  assert.equal(video.url, 'https://api.lk888.ai/v1beta/models/gem-3.8-flash:generateContent');
  assert.deepEqual(video.body.contents[0].parts, [
    { file_data: { file_uri: 'https://example.com/video.mp4', mime_type: 'video/mp4' } },
    { text: '分析视频' },
  ]);

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
  const ttImage25 = fs.readFileSync(path.join(__dirname, '../src/database/migrations/045_wagaai_tt_image_2_5.sql'), 'utf8');
  const newVideoModels = fs.readFileSync(path.join(__dirname, '../src/database/migrations/046_wagaai_gk_video_3_omni_flash.sql'), 'utf8');
  const viduTurbo = fs.readFileSync(path.join(__dirname, '../src/database/migrations/048_wagaai_viduq3_turbo_reference.sql'), 'utf8');
  const gem38 = fs.readFileSync(path.join(__dirname, '../src/database/migrations/054_wagaai_gem_3_8_flash_video_understanding.sql'), 'utf8');
  assert.match(sync, /WAGAAI_BASE_URL = "https:\/\/api\.lk888\.ai"/);
  assert.doesNotMatch(sync, /WAGAAI_BASE_URL = "https:\/\/api\.lk888\.ai\/api"/);
  assert.match(sync, /requestJson<Record<string, unknown>>\("\/v1\/skills\/guide"/);
  assert.match(sync, /name: "tt-image-2\.5"[\s\S]*maxReferenceImages: 16[\s\S]*initialResolutions: \["1K", "2K", "4K"\]/);
  assert.match(migration, /base_url = 'https:\/\/api\.lk888\.ai'/);
  assert.match(migration, /'\/v1\/media\/generate'/);
  assert.match(migration, /'\/v1\/skills\/task-status'/);
  assert.match(migration, /'\/v1beta\/models\/\{model\}:generateContent'/);
  assert.match(migration, /'\/v1\/chat\/completions'/);
  assert.match(ttImage25, /'tt-image-2\.5'/);
  assert.match(ttImage25, /'\/v1\/media\/generate'/);
  assert.match(ttImage25, /'\/v1\/skills\/task-status'/);
  assert.match(ttImage25, /'version', 'flare'/);
  assert.match(ttImage25, /'1K'[\s\S]*'2K'[\s\S]*'4K'/);
  assert.match(sync, /name: "gk-video-3"[\s\S]*initialResolutions: \["720P"\][\s\S]*videoDurationOptions: \[6, 10\]/);
  assert.match(sync, /name: "omni-flash"[\s\S]*videoDurationOptions: \[4, 6, 8, 10\][\s\S]*fixedOutputResolution: true/);
  assert.doesNotMatch(sync, /replacedModelCodes[\s\S]*"omni-flash"/);
  assert.match(newVideoModels, /'gk-video-3'/);
  assert.match(newVideoModels, /'omni-flash'/);
  assert.match(newVideoModels, /'resolution_parameter', 'size'/);
  assert.match(newVideoModels, /'fixed_output_resolution', TRUE/);
  assert.match(sync, /name: "viduq3-turbo-cankaosheng"[\s\S]*maxReferenceImages: 7[\s\S]*initialResolutions: \["540p", "720p", "1080p"\][\s\S]*videoDurationOptions: range\(3, 16\)/);
  assert.match(viduTurbo, /'viduq3-turbo-cankaosheng'/);
  assert.match(viduTurbo, /'PER_SECOND'/);
  assert.match(viduTurbo, /JSON_ARRAY\('9:16', '16:9', '3:4', '4:3', '1:1'\)/);
  assert.match(viduTurbo, /UNION ALL SELECT '720p', 23, 1[\s\S]*UNION ALL SELECT '1080p', 28, 2/);
  assert.match(sync, /name: "gem-3\.8-flash", alias: "GEM 3\.8 Flash 视频理解", capability: "VIDEO_UNDERSTANDING"/);
  assert.match(gem38, /'gem-3\.8-flash'/);
  assert.match(gem38, /'VIDEO_UNDERSTANDING', 'gemini', '\/v1beta\/models\/\{model\}:generateContent'/);
  assert.match(gem38, /'PER_REQUEST'/);
});
