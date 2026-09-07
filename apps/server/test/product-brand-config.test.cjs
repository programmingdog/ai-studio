const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProductBrandConfigService } = require('../dist/common/product-brand-config.service.js');

function fixture(row = { chinese_name: '影匠', english_name: 'Yingjiang', revision: 0, updated_at: 'now' }) {
  const executions = [], audits = [];
  const database = {
    async query() { return [row]; },
    async execute(sql, parameters) { executions.push({ sql, parameters }); row = { ...row, chinese_name: parameters[0], english_name: parameters[1], revision: row.revision + 1 }; },
  };
  const audit = { async record(input) { audits.push(input); } };
  return { service: new ProductBrandConfigService(database, audit), executions, audits };
}

test('product brand exposes the configured Chinese and English names', async () => {
  const { service } = fixture();
  assert.deepEqual(await service.get(), { chinese_name: '影匠', english_name: 'Yingjiang', revision: 0, updated_at: 'now' });
});

test('product brand update persists both names and records an audit event', async () => {
  const { service, executions, audits } = fixture();
  const result = await service.update('admin-1', { chineseName: '影匠', englishName: 'CineCraft' });
  assert.deepEqual(executions[0].parameters, ['影匠', 'CineCraft', 'admin-1']);
  assert.equal(audits[0].action, 'product_brand.update');
  assert.equal(result.english_name, 'CineCraft');
  assert.equal(result.revision, 1);
});
