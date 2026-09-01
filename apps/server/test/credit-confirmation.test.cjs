const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { ModelGatewayService } = require('../dist/gateway/model-gateway.service');
const factors = { get: async () => ({ multipliers: { TEXT_GENERATION: 1.5, VIDEO_UNDERSTANDING: 2, IMAGE_GENERATION: 3, VIDEO_GENERATION: 1.25 } }) };
const target = (capability, extra = {}) => ({ model_id: 'model-1', model_code: 'demo', model_alias: '模型别名', capability, credit_cost: 2, supports_async_tasks: 0, ...extra });
function service() {
  const gateway = new ModelGatewayService({ query: async () => [{ credit_cost: 4 }] }, { decrypt: () => 'test-only' }, factors);
  gateway.defaultTextTarget = async () => target('TEXT_GENERATION');
  gateway.defaultVideoUnderstandingTarget = async () => target('VIDEO_UNDERSTANDING');
  return gateway;
}

test('read-only text and understanding quotes include their type multiplier', async () => {
  const gateway = service();
  gateway.call = () => assert.fail('A quote must not call a provider');
  const text = await gateway.quote({ capability: 'TEXT_GENERATION', payload: {} });
  assert.equal(text.credits, 3);
  assert.equal(text.provider_model_id, 'model-1');
  assert.equal(text.model_alias, '模型别名');
  assert.equal(text.includes_multiplier, true);
  assert.equal((await gateway.quote({ capability: 'VIDEO_UNDERSTANDING', payload: {} })).credits, 4);
});

test('media quote includes resolution price, seconds and type multiplier', async () => {
  const gateway = service();
  gateway.target = async () => target('IMAGE_GENERATION');
  assert.equal((await gateway.quote({ providerModelId: 'image', payload: { resolution: '2K' } })).credits, 12);
  gateway.target = async () => target('VIDEO_GENERATION');
  const quote = await gateway.quote({ providerModelId: 'video', payload: { resolution: '1080P', seconds: 7.5 } });
  assert.equal(quote.credits, 37.5);
  assert.equal(quote.seconds, 7.5);
  assert.equal(quote.resolution, '1080P');
  await assert.rejects(gateway.quote({ providerModelId: 'video', payload: { resolution: '1080P' } }), /seconds|duration/);
});

test('any changed or invalid price blocks provider calls and ledger writes', async () => {
  const gateway = service();
  gateway.existing = async () => null;
  gateway.target = async () => target('TEXT_GENERATION');
  gateway.database.transaction = () => assert.fail('must not write');
  gateway.call = () => assert.fail('must not call provider');
  for (const expectedCredits of [0, 2, 4, -1, NaN, Infinity]) {
    await assert.rejects(gateway.create('user', { idempotencyKey: 'quote-test', providerModelId: 'model-1', payload: { prompt: 'hello' }, expectedCredits }), /重新确认/);
  }
});

function taskHarness(failure = false) {
  const gateway = service();
  let stored;
  const writes = [], calls = [], released = [], settled = [];
  gateway.database.query = async () => [stored];
  gateway.database.transaction = async fn => fn({
    query: async sql => {
      if (sql.includes('FROM ai_tasks')) return [[]];
      if (sql.includes('FROM ledger_accounts')) return [[{ id: 'account' }]];
      if (sql.includes('FROM ledger_entries')) return [[{ balance: 100 }]];
      if (sql.includes('FROM credit_holds')) return [[{ held: 0 }]];
      throw Error(sql);
    },
    execute: async (sql, args) => {
      writes.push({ sql, args });
      if (sql.includes('INSERT INTO ai_tasks')) stored = { id: args[0], user_id: 'user', provider_model_id: args[8], estimated_credits: args[9], status: 'SUCCEEDED' };
    },
  });
  gateway.existing = async () => null;
  gateway.target = async () => target('TEXT_GENERATION');
  gateway.request = () => ({ url: 'https://example.invalid', method: 'POST', headers: {}, body: {} });
  gateway.call = async request => { calls.push(request); return { ok: !failure, status: failure ? 502 : 200, value: { choices: [{ message: { content: '{}' } }] } }; };
  gateway.settle = async id => settled.push(id);
  gateway.release = async (...args) => released.push(args);
  return { gateway, writes, calls, released, settled };
}

test('confirmed text calls reserve and settle the final quoted credits', async () => {
  const state = taskHarness();
  await state.gateway.create('user', { idempotencyKey: 'text-paid', providerModelId: 'model-1', payload: { messages: [{ role: 'user', content: '二创' }] }, expectedCredits: 3 });
  assert.equal(state.calls.length, 1);
  assert.equal(state.writes.find(x => x.sql.includes('INSERT INTO credit_holds')).args[3], 3);
  assert.equal(state.settled.length, 1);
  assert.equal(state.released.length, 0);
});

test('parallel media reservations lock the wallet before inspecting task keys', async () => {
  const state = taskHarness();
  const queries = [];
  const transaction = state.gateway.database.transaction;
  state.gateway.database.transaction = fn => transaction(connection => fn({ ...connection, query: async (sql, args) => {
    queries.push(sql); return connection.query(sql, args);
  } }));
  await state.gateway.create('user', { idempotencyKey: 'lock-order', providerModelId: 'model-1', payload: { prompt: 'test' }, expectedCredits: 3 });
  assert.match(queries[0], /FROM ledger_accounts.*FOR UPDATE/);
  assert.match(queries[1], /FROM ai_tasks/);
  assert.doesNotMatch(queries[1], /FOR UPDATE/);
  assert.equal(state.calls.length, 1);
});

test('rolled-back reservation deadlocks retry before the only provider call', async () => {
  const state = taskHarness();
  const transaction = state.gateway.database.transaction;
  let attempts = 0;
  state.gateway.database.transaction = async fn => {
    if (++attempts <= 2) { assert.equal(state.calls.length, 0); throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }); }
    return transaction(fn);
  };
  await state.gateway.create('user', { idempotencyKey: 'lock-retry', providerModelId: 'model-1', payload: { prompt: 'test' }, expectedCredits: 3 });
  assert.equal(state.calls.length, 1);
  assert.equal(state.settled.length, 1);
  assert.equal(state.writes.filter(x => x.sql.includes('INSERT INTO credit_holds')).length, 1);
});

test('exhausted known rollbacks explicitly confirm no submission or deduction', async () => {
  const state = taskHarness();
  let attempts = 0;
  state.gateway.database.transaction = async () => { attempts++; throw Object.assign(new Error('busy'), { code: 'ER_LOCK_WAIT_TIMEOUT' }); };
  await assert.rejects(state.gateway.create('user', { idempotencyKey: 'lock-exhausted', providerModelId: 'model-1', payload: { prompt: 'test' }, expectedCredits: 3 }), error => {
    assert.equal(error.getResponse().code, 'TASK_NOT_SUBMITTED');
    assert.equal(error.getResponse().retryable, true);
    return true;
  });
  assert.equal(attempts, 3);
  assert.equal(state.calls.length, 0);
  assert.equal(state.settled.length, 0);
});

test('uncertain commit/network errors never claim safe resubmission', async () => {
  const state = taskHarness();
  let attempts = 0;
  state.gateway.database.transaction = async () => { attempts++; throw Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' }); };
  await assert.rejects(state.gateway.create('user', { idempotencyKey: 'unknown', providerModelId: 'model-1', payload: { prompt: 'test' }, expectedCredits: 3 }), /connection lost/);
  assert.equal(attempts, 1);
  assert.equal(state.calls.length, 0);
});

test('provider failure releases the hold and never settles', async () => {
  const state = taskHarness(true);
  await assert.rejects(state.gateway.create('user', { idempotencyKey: 'text-failed', providerModelId: 'model-1', payload: { prompt: '二创' }, expectedCredits: 3 }), /HTTP 502/);
  assert.equal(state.released.length, 1);
  assert.equal(state.settled.length, 0);
});

test('idempotent replay cannot create a second paid call', async () => {
  const gateway = service();
  gateway.existing = async () => ({ task: { id: 'existing' }, idempotent_replay: true });
  gateway.target = () => assert.fail('replay must not create a new task');
  assert.equal((await gateway.create('user', { idempotencyKey: 'same', providerModelId: 'model-1', payload: { prompt: '二创' }, expectedCredits: 3 })).idempotent_replay, true);
});

test('URL and upload calls preserve confirmed model and price', async () => {
  const gateway = service();
  gateway.target = async () => target('VIDEO_UNDERSTANDING');
  gateway.create = async (_, input) => input;
  const url = await gateway.createVideoUnderstanding('user', { idempotencyKey: 'url', prompt: '分析', videoUrl: 'https://example.invalid/video.mp4', providerModelId: 'model-1', expectedCredits: 4 });
  assert.equal(url.providerModelId, 'model-1');
  assert.equal(url.expectedCredits, 4);
  const upload = await gateway.createVideoUnderstandingUpload('user', { idempotencyKey: 'upload', prompt: '分析', providerModelId: 'model-1', expectedCredits: 4, file: { buffer: Buffer.from('test'), mimetype: 'video/mp4', originalname: 'test.mp4', size: 4 } });
  assert.equal(upload.expectedCredits, 4);
});

test('default text model must be configured, enabled through target lookup, and synchronous', async () => {
  const gateway = new ModelGatewayService({ query: async () => [] }, {}, factors);
  await assert.rejects(gateway.defaultTextTarget(), /尚未配置/);
  gateway.database.query = async () => [{ text_model_id: 'configured-text' }];
  gateway.target = async id => { assert.equal(id, 'configured-text'); return target('TEXT_GENERATION'); };
  assert.equal((await gateway.defaultTextTarget()).capability, 'TEXT_GENERATION');
  gateway.target = async () => target('IMAGE_GENERATION');
  await assert.rejects(gateway.defaultTextTarget(), /类型不正确/);
  gateway.target = async () => target('TEXT_GENERATION', { supports_async_tasks: 1 });
  await assert.rejects(gateway.defaultTextTarget(), /同步调用/);
});

test('text messages use the server-selected OpenAI or Gemini model without client credentials', () => {
  const gateway = service();
  const model = target('TEXT_GENERATION', { base_url: 'https://example.invalid', api_protocol: 'openai', generation_endpoint: '/v1/chat/completions' });
  const payload = { model: 'untrusted-client-model', stream: false, temperature: 0.35, messages: [{ role: 'system', content: '只输出JSON' }, { role: 'user', content: '二创剧情' }] };
  const openai = gateway.request(model, payload, 'test-only-key');
  assert.equal(openai.body.model, 'demo');
  assert.deepEqual(openai.body.messages, payload.messages);
  const gemini = { ...model, api_protocol: 'gemini', generation_endpoint: '/v1beta/models/{model}:generateContent' };
  const request = gateway.request(gemini, payload, 'test-only-key');
  assert.equal(request.body.contents[0].parts[0].text, '二创剧情');
  assert.equal(request.body.systemInstruction.parts[0].text, '只输出JSON');
  assert.equal(request.body.generationConfig.temperature, 0.35);
  assert.equal(request.body.model, undefined);
  assert.throws(() => gateway.request(gemini, { ...payload, tools: [{}] }, 'test-only-key'), /本次未扣分/);
});

test('workflow refund recovery requires a released hold and is scoped to the user', async () => {
  const gateway=service();
  gateway.database.query=async(sql,args)=>{
    assert.match(sql,/user_id = \?/);
    assert.deepEqual(args,['local-id','user-a']);
    assert.match(sql,/h.status='RELEASED'/);
    return [{id:'task',status:'FAILED',credits_released:0}];
  };
  assert.equal((await gateway.getByLocal('user-a','local-id')).credits_released,false);
  gateway.database.query=async()=>[{id:'task',status:'FAILED',credits_released:1}];
  assert.equal((await gateway.getByLocal('user-a','local-id')).credits_released,true);
  gateway.database.query=async()=>[];
  await assert.rejects(gateway.getByLocal('other-user','local-id'),/任务不存在/);
});
