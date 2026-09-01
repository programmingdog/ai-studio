const assert = require('node:assert/strict');
const { test } = require('node:test');
require('reflect-metadata');
const { ModelGatewayService } = require('../dist/gateway/model-gateway.service');
const { wanVideoParameters } = require('../dist/gateway/wan-video-parameters');
const model = {
  model_id: 'wan-test', model_code: 'wan3.0-video-quannengcankao',
  base_url: 'https://provider.example', generation_endpoint: '/v1/media/generate',
  api_protocol: 'lingkeai_media', capability: 'VIDEO_GENERATION',
  model_config_json: {}, provider_config_json: {},
  parameter_schema_json: [{ name: 'resolution', options: ['480P', '720P', '1080P'] },
    { name: 'version', options: ['standard', 'prime'] },
    { name: 'ratio', label: '画面比例', options: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'] },
    { name: 'audio' }, { name: 'prompt_extend' }, { name: 'video_url' }, { name: 'audio_url' }],
};
const multipliers = { get: async () => ({ multipliers: { VIDEO_GENERATION: 1 } }) };
const service = new ModelGatewayService({}, {});
const request = (payload, target = model) => service.request(target, payload, 'fake-test-key');

test('Wan maps the exact desktop workflow payload to documented parameters', () => {
  const reference_images = [{ data_url: 'data:image/png;base64,dGVzdA==', label: '角色' }, { url: 'https://example.com/scene.png', label: '场景' }];
  const fields = { aspect_ratio: '9:16', seconds: 10, duration: 10, resolution: '720p', version: null, reference_images };
  const payload = { prompt: 'test video', ...fields, params: { ...fields } };
  const original = JSON.stringify(payload);
  const result = request(payload);
  assert.equal(result.url, 'https://provider.example/v1/media/generate');
  assert.equal(result.body.model, model.model_code);
  assert.deepEqual(result.body.params, {
    version: 'standard', duration: '10', resolution: '720P', ratio: '9:16',
    image_url: reference_images.map(r => r.data_url || r.url),
  });
  assert.match(result.body.prompt, /第1张：角色/);
  assert.match(result.body.prompt, /第2张：场景/);
  assert.equal(JSON.stringify(payload), original);
});

test('Wan accepts text-only video and every documented duration boundary', () => {
  for (const duration of [2, '2', 30, '30']) {
    const body = request({ prompt: 'test', resolution: '1080p', duration }).body;
    assert.equal(body.params.duration, String(duration));
    assert.equal(body.params.resolution, '1080P');
    assert.equal(body.params.version, 'standard');
    assert.equal(body.params.image_url, undefined);
    assert.equal(body.params.images, undefined);
  }
});

test('Wan preserves explicit documented fields and false switches', () => {
  const result = request({ resolution: '480p', seconds: 5, params: {
    version: 'prime', ratio: 'adaptive', image_url: 'https://example.com/image.png',
    video_url: ['https://example.com/video.mp4'], audio_url: ['https://example.com/audio.mp3'],
    audio: false, prompt_extend: false,
  } }).body.params;
  assert.equal(result.version, 'prime');
  assert.equal(result.audio, false);
  assert.equal(result.prompt_extend, false);
  assert.deepEqual(result.image_url, ['https://example.com/image.png']);
  assert.deepEqual(result.video_url, ['https://example.com/video.mp4']);
});

test('Wan rejects invalid duration or mismatched billed duration without rounding or Auto', () => {
  for (const duration of [undefined, null, true, '', 1, 31, 2.5, 'auto', 'not-a-number']) {
    assert.throws(() => wanVideoParameters({ duration }), /2～30/);
  }
  assert.throws(() => wanVideoParameters({ seconds: 5, duration: 10 }), /预估时长/);
  assert.throws(() => wanVideoParameters({ seconds: 5, params: { duration: 10 } }), /预估时长/);
});

test('Wan rejects invalid version, aspect ratio and excessive reference images', () => {
  assert.throws(() => request({ duration: 5, resolution: '720p', version: '标准' }), /version.*暂不可用/);
  assert.throws(() => request({ duration: 5, resolution: '720p', aspect_ratio: '21:9' }), /画面比例/);
  assert.throws(() => request({ duration: 5, resolution: '720p', reference_images: Array(11).fill('https://example.com/image.png') }), /10 张/);
});

test('Wan invalid duration is rejected during quote, before reserving credits or generation', async () => {
  const gateway = new ModelGatewayService({ query: () => assert.fail('invalid quote must not query prices') }, {}, multipliers);
  gateway.target = async () => model;
  gateway.call = () => assert.fail('must not generate');
  await assert.rejects(gateway.quote({ providerModelId: model.model_id, payload: { seconds: 31, resolution: '720p' } }), /2～30/);
});

test('Wan parameter errors in create are explicitly non-chargeable, non-retryable', async () => {
  const gateway = new ModelGatewayService({
    query: async sql => sql.includes('provider_model_resolution_prices') ? [{ credit_cost: 2 }] : [],
    transaction: () => assert.fail('must not reserve credits'),
  }, { decrypt: () => 'fake-test-key' }, multipliers);
  gateway.target = async () => model;
  gateway.call = () => assert.fail('must not generate');
  await assert.rejects(gateway.create('test-user', { idempotencyKey: 'test', providerModelId: model.model_id,
    payload: { seconds: 5, resolution: '720p', reference_images: Array(11).fill('https://example.com/image.png') } }), error => {
    assert.equal(error.getResponse().code, 'TASK_NOT_SUBMITTED');
    assert.equal(error.getResponse().retryable, false);
    assert.match(error.message, /没有扣分/);
    return true;
  });
});

test('Wan quote uses the same explicit duration as the provider request', async () => {
  const gateway = new ModelGatewayService({ query: async () => [{ credit_cost: 2 }] }, {}, multipliers);
  gateway.target = async () => model;
  const payload = { duration: 10, seconds: 10, resolution: '720p' };
  const quote = await gateway.quote({ providerModelId: model.model_id, payload });
  assert.equal(quote.credits, 20);
  assert.equal(Number(request(payload).body.params.duration), quote.seconds);
});

test('other media video models keep their existing request format', () => {
  const body = request({ duration: 10, resolution: '720p', aspect_ratio: '9:16', reference_images: ['https://example.com/image.png'] },
    { ...model, model_code: 'another-video-model' }).body;
  assert.deepEqual(body.params.images, ['https://example.com/image.png']);
  assert.equal(body.params.aspect_ratio, '9:16');
  assert.equal(body.params.duration, 10);
  assert.equal(body.params.version, undefined);
  assert.equal(body.params.image_url, undefined);
});
