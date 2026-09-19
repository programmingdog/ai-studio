const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { channel } = require('node:diagnostics_channel');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { getGlobalDispatcher } = require('undici');
const { ModelGatewayService } = require('../dist/gateway/model-gateway.service');
const { createProviderDispatcher, textProviderTimeoutMs } = require('../dist/gateway/provider-http');

async function localProvider(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('native fetch dispatch overrides inherited timeouts without changing the global dispatcher', async t => {
  const url = await localProvider(t, (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"ok":');
      setTimeout(() => res.end('true}'), 80);
    }, 80);
  });
  const globalDispatcher = getGlobalDispatcher();
  const dispatcher = createProviderDispatcher(2000).compose(dispatch => (options, handler) =>
    dispatch({ ...options, headersTimeout: 1, bodyTimeout: 1 }, handler));
  t.after(() => dispatcher.destroy());
  const observed = [];
  const diagnostic = channel('undici:request:create');
  const listener = ({ request }) => {
    if (request.origin === url) observed.push([request.headersTimeout, request.bodyTimeout]);
  };
  diagnostic.subscribe(listener);
  t.after(() => diagnostic.unsubscribe(listener));
  const response = await fetch(url, { method: 'POST', body: '{}', dispatcher });
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(observed, [[2000, 2000]]);
  assert.equal(getGlobalDispatcher(), globalDispatcher);
});

test('gateway uses the actual text budget for both socket deadlines and preserves JSON responses', async t => {
  const url = await localProvider(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"story":{}}' } }] }));
  });
  const observed = [];
  const diagnostic = channel('undici:request:create');
  const listener = ({ request }) => {
    if (request.origin === url) observed.push([request.headersTimeout, request.bodyTimeout]);
  };
  diagnostic.subscribe(listener);
  t.after(() => diagnostic.unsubscribe(listener));
  const gateway = new ModelGatewayService({}, {});
  const result = await gateway.call({ url, method: 'POST', headers: {}, body: { stream: false } }, textProviderTimeoutMs);
  assert.equal(result.value.choices[0].message.content, '{"story":{}}');
  assert.deepEqual(observed, [[720_000, 720_000]]);
});

test('gateway still aggregates upstream SSE into one JSON result', async t => {
  const url = await localProvider(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    setTimeout(() => res.end('data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), 80);
  });
  const gateway = new ModelGatewayService({}, {});
  const result = await gateway.call({ url, method: 'POST', headers: {}, body: { stream: true } }, 2000);
  assert.equal(result.value.choices[0].message.content, 'hello world');
});

for (const stage of ['headers', 'body', 'dripping body']) {
  test(`overall deadline aborts ${stage} without resubmitting the POST`, async t => {
    let calls = 0;
    let closed;
    const url = await localProvider(t, (_req, res) => {
      calls++;
      closed = once(res, 'close');
      if (stage !== 'headers') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"ok":');
      }
      if (stage === 'dripping body') {
        const timer = setInterval(() => res.write(' '), 40);
        res.once('close', () => clearInterval(timer));
      }
    });
    const gateway = new ModelGatewayService({}, {});
    await assert.rejects(gateway.call({ url, method: 'POST', headers: {}, body: {} }, 300), /等待供应商响应超时/);
    await closed;
    assert.equal(calls, 1);
  });
}

test('deployed API proxy and desktop deadlines leave room for text generation', () => {
  const nginx = readFileSync(path.join(__dirname, '../../../deploy/nginx.conf.example'), 'utf8');
  const api = nginx.match(/location \^~ \/api\/v1\/ \{([\s\S]*?)\n\}/)[1];
  assert.match(api, /proxy_read_timeout 900s;/);
  assert.match(api, /proxy_send_timeout 900s;/);
  assert.ok(textProviderTimeoutMs < 900_000);
});
