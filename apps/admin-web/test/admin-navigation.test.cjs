const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const app = readFileSync(join(__dirname, '../components/AdminApp.tsx'), 'utf8');
const providers = readFileSync(join(__dirname, '../components/ProvidersPanel.tsx'), 'utf8');

test('admin navigation is grouped by stable business domains', () => {
  for (const label of ['产品与客户端', 'AI 与创作', '用户与增长', '交易与积分', '系统与运维']) {
    assert.match(app, new RegExp(label));
  }
  assert.doesNotMatch(app, /label: "配置中心"|<div>设定<|<div>记录</);
});

test('overloaded pages are separated or combined by lifecycle', () => {
  assert.match(app, /id: "model-routing", label: "模型路由"/);
  assert.match(app, /id: "script-analysis", label: "剧本提取"/);
  assert.match(app, /id: "client-distribution", label: "下载与版本"/);
  assert.match(app, /id: "commission-settlement", label: "佣金结算"/);
  assert.match(app, /id: "orders", label: "交易订单"/);
  assert.match(app, /id: "integrations", label: "渠道集成"/);
  assert.doesNotMatch(providers, /<DefaultModelConfigPanel/);
});

test('versioned configuration is presented as AI prompts and workflows', () => {
  assert.match(app, /title="提示词与工作流"/);
  assert.match(app, /客户端下发只是生效范围/);
  assert.doesNotMatch(app, /<h2>客户端默认配置<\/h2>/);
});
