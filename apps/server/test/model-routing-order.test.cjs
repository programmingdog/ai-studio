const assert = require('node:assert/strict');
const { test } = require('node:test');
require('reflect-metadata');
const { AdminService } = require('../dist/admin/admin.service');
const { ClientConfigService } = require('../dist/client-config/client-config.service');

test('model routing persists client order and one recommendation per capability', async () => {
  const writes = [];
  const candidates = [
    { id: 'image-a', capability: 'IMAGE_GENERATION' },
    { id: 'image-b', capability: 'IMAGE_GENERATION' },
    { id: 'video-a', capability: 'VIDEO_GENERATION' },
    { id: 'text-a', capability: 'TEXT_GENERATION', provider_code: 'wagaai', model_code: 'gem-3.7-flash' },
    { id: 'understanding-a', capability: 'VIDEO_UNDERSTANDING' },
  ];
  const connection = {
    query: async sql => sql.includes('FROM provider_models pm') ? [candidates] : [[]],
    execute: async (sql, args) => { writes.push({ sql, args }); },
  };
  const database = { transaction: async operation => operation(connection) };
  const service = new AdminService(database, { record: async () => {} }, {});
  await service.updateDefaultModelConfig('admin', {
    textModelId: 'text-a', videoUnderstandingModelId: 'understanding-a',
    imageModelIds: ['image-b', 'image-a'], videoModelIds: ['video-a'],
    recommendedImageModelId: 'image-a', recommendedVideoModelId: 'video-a',
  });
  const routingWrites = writes.filter(item => item.sql.includes('INSERT INTO ai_default_media_models'));
  assert.deepEqual(routingWrites.map(item => item.args), [
    ['IMAGE_GENERATION', 'image-b', 0, 0],
    ['IMAGE_GENERATION', 'image-a', 1, 1],
    ['VIDEO_GENERATION', 'video-a', 0, 1],
  ]);
});

test('client catalog query and payload use routing order and recommendation', async () => {
  let catalogSql = '';
  const model = { id: 'video-a', provider_id: 'provider', provider_code: 'demo', provider_name: 'Demo', model_code: 'video',
    display_name: 'Video', model_alias: 'Video', capability: 'VIDEO_GENERATION', credit_cost: 1, billing_unit: 'PER_SECOND',
    credit_multiplier: 1, max_reference_images: 1, supports_reference_video: 0, supports_real_person: 0, supports_async_tasks: 1,
    sort_order: 2, recommended: 1, description: '', parameter_schema_json: [], config_json: { aspect_ratio_options: ['9:16', '3:4', '1:1'] }, api_protocol: 'media' };
  const database = { query: async sql => {
    if (sql.includes('FROM provider_model_resolution_prices')) return [{ provider_model_id: 'video-a', resolution: '720p', credit_cost: 1 }];
    catalogSql = sql;
    return [model];
  } };
  const result = await new ClientConfigService(database).models();
  assert.match(catalogSql, /COALESCE\(dm\.sort_order, pm\.sort_order\) AS sort_order/);
  assert.match(catalogSql, /ORDER BY pm\.capability, COALESCE\(dm\.sort_order, pm\.sort_order\)/);
  assert.equal(result[0].sort_order, 2);
  assert.equal(result[0].recommended, true);
  assert.deepEqual(result[0].aspect_ratio_options, ['9:16', '3:4', '1:1']);
});
