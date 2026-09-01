const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { RegistrationMailService } = require('../dist/user-auth/registration-mail.service');
const { MailDeliveryUnconfirmedException } = require('../dist/user-auth/mail-delivery-unconfirmed.exception');
const { normalizedEmail } = require('../dist/user-auth/registration-validation');
const nodemailer = require('nodemailer');
const net = require('node:net');
const { once } = require('node:events');

const config = { method: 'HTTP', apiUrl: 'https://yuntianxing.net/mail_sys/send_mail_http.json', from: 'no-reply@yuntianxing.net', password: 'test-only & secret=值', timeoutMs: 25 };
const service = (mail = config) => new RegistrationMailService({ values: { mailApiTimeoutMs: mail.timeoutMs } }, { deliveryConfig: async () => mail });
const smtpConfig = { method: 'SMTP', host: 'mail.yuntianxing.net', port: 25, security: 'STARTTLS', from: config.from, password: config.password, timeoutMs: 1000 };

test('SMTP enforces TLS, authenticates with full mailbox and sends one explicit recipient', async t => {
  for (const [security, port] of [['STARTTLS', 25], ['TLS', 465]]) {
    t.mock.restoreAll();
    t.mock.method(global, 'fetch', () => assert.fail('SMTP must not use HTTP'));
    let calls = 0, closed = 0;
    t.mock.method(nodemailer, 'createTransport', options => {
      assert.equal(options.host, smtpConfig.host); assert.equal(options.port, port);
      assert.equal(options.secure, security === 'TLS'); assert.equal(options.requireTLS, security === 'STARTTLS');
      assert.equal(options.opportunisticTLS, false);
      assert.deepEqual(options.tls, { servername: smtpConfig.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      assert.deepEqual(options.auth, { user: config.from, pass: config.password });
      for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout', 'dnsTimeout']) assert.equal(options[key], 1000);
      assert.equal(options.logger, false); assert.equal(options.debug, false);
      assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true);
      return { async sendMail(mail) {
        calls++;
        assert.equal(mail.from.address, config.from); assert.equal(mail.to, 'user@example.com');
        assert.deepEqual(mail.envelope, { from: config.from, to: ['user@example.com'] });
        assert.match(mail.subject, /注册邮箱验证码/); assert.match(mail.text, /012345/);
        assert.equal(mail.html, undefined); assert.equal(mail.attachments, undefined);
        return { accepted: ['user@example.com'], rejected: [] };
      }, close() { closed++; } };
    });
    await service({ ...smtpConfig, security, port }).sendCode(' USER@Example.com ', '012345');
    assert.equal(calls, 1); assert.equal(closed, 1);
  }
});

test('SMTP errors have safe actionable codes, close transport and never retry or fall back to HTTP', async t => {
  for (const [code, expected] of [['EAUTH', 'AUTH_FAILED'], ['ETLS', 'TLS_FAILED'], ['ESOCKET', 'CONNECTION_FAILED'], ['ETIMEDOUT', 'CONNECTION_FAILED'], ['EDNS', 'CONNECTION_FAILED'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS_FAILED'], ['EENVELOPE', 'REJECTED'], ['EMESSAGE', 'FAILED']]) {
    t.mock.restoreAll();
    t.mock.method(global, 'fetch', () => assert.fail('must not fall back to HTTP'));
    let calls = 0, closed = 0;
    t.mock.method(nodemailer, 'createTransport', () => ({ async sendMail() { calls++; throw Object.assign(new Error(config.password), { code }); }, close() { closed++; } }));
    await assert.rejects(service(smtpConfig).sendCode('user@example.com', '123456'), error => {
      assert.equal(error.getStatus(), 503); assert.equal(error.getResponse().code, `MAIL_SMTP_${expected}`);
      assert.match(error.message, /重新进行图形验证/);
      assert.ok(!JSON.stringify(error).includes(config.password)); return true;
    });
    assert.equal(calls, 1); assert.equal(closed, 1);
  }
});

test('SMTP rejects missing acceptance or rejected recipients instead of activating a code', async t => {
  for (const info of [{ accepted: [], rejected: [] }, { accepted: ['other@example.com'], rejected: [] }, { accepted: ['user@example.com'], rejected: ['user@example.com'] }]) {
    t.mock.restoreAll();
    t.mock.method(nodemailer, 'createTransport', () => ({ async sendMail() { return info; }, close() {} }));
    await assert.rejects(service(smtpConfig).sendCode('user@example.com', '123456'), error => error.getResponse().code === 'MAIL_SMTP_REJECTED');
  }
});

test('invalid SMTP configuration and recipient injection fail before creating a transport', async t => {
  t.mock.method(nodemailer, 'createTransport', () => assert.fail('invalid config must not connect'));
  for (const override of [{ host: 'smtp://mail.yuntianxing.net' }, { port: 0 }, { port: '25' }, { port: 465 }, { security: 'NONE' }, { method: 'unknown' }]) {
    await assert.rejects(service({ ...smtpConfig, ...override }).sendCode('user@example.com', '123456'), /尚未配置/);
  }
  await assert.rejects(service(smtpConfig).sendCode('user@example.com\r\nBcc: victim@example.com', '123456'), /邮箱格式/);
});

async function localSmtp(t, onConnection) {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); onConnection(socket); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const createTransport = nodemailer.createTransport.bind(nodemailer);
  // Route only the test transport to loopback. Production hostname/TLS validation remains enabled.
  t.mock.method(nodemailer, 'createTransport', options => createTransport({ ...options, host: '127.0.0.1', port: server.address().port }));
}

test('real SMTP handshake refuses plaintext AUTH when STARTTLS is unavailable', async t => {
  const commands = [];
  await localSmtp(t, socket => {
    socket.write('220 localhost ESMTP test\r\n');
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2); commands.push(line);
        if (line.startsWith('EHLO')) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (line === 'STARTTLS') socket.write('502 STARTTLS unavailable\r\n');
        else socket.write('500 unexpected command\r\n');
      }
    });
  });
  await assert.rejects(service(smtpConfig).sendCode('user@example.com', '123456'), error => error.getResponse().code === 'MAIL_SMTP_TLS_FAILED');
  assert.ok(commands.some(line => line === 'STARTTLS'));
  assert.ok(commands.every(line => !/^(AUTH|MAIL|RCPT|DATA)/.test(line)));
});

test('real SMTP greeting timeout terminates without sending credentials', async t => {
  const received = [];
  await localSmtp(t, socket => socket.on('data', data => received.push(data.toString())));
  await assert.rejects(service({ ...smtpConfig, timeoutMs: 100 }).sendCode('user@example.com', '123456'), error => error.getResponse().code === 'MAIL_SMTP_CONNECTION_FAILED');
  assert.deepEqual(received, []);
});

test('mail adapter sends the documented form fields with TLS, no redirects and timeout', async t => {
  let calls = 0;
  t.mock.method(global, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, config.apiUrl);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.ok(init.signal instanceof AbortSignal);
    const body = new URLSearchParams(init.body.toString());
    assert.deepEqual([...body.keys()].sort(), ['mail_from', 'password', 'mail_to', 'subject', 'content', 'subtype'].sort());
    assert.equal(body.get('password'), config.password);
    assert.equal(body.get('mail_from'), config.from);
    assert.equal(body.get('mail_to'), 'user@example.com');
    assert.equal(body.get('subtype'), 'plain');
    assert.match(body.get('content'), /012345/);
    assert.match(body.get('content'), /10 分钟/);
    return new Response(JSON.stringify({ status: true, msg: '发送邮件成功' }));
  });
  await service().sendCode(' USER@Example.com ', '012345');
  assert.equal(calls, 1);
});

test('configured HTTP URL is sent unchanged with form encoding and redirects disabled', async t => {
  const apiUrl = 'http://211.154.25.178:15686/mail_sys/send_mail_http.json';
  let calls = 0;
  t.mock.method(global, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, apiUrl); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('mail_from'), config.from); assert.equal(body.get('password'), config.password);
    assert.equal(body.get('mail_to'), 'user@example.com'); assert.equal(body.get('subtype'), 'plain');
    assert.match(body.get('content'), /012345/);
    return new Response('{"status":true}');
  });
  await service({ ...config, apiUrl }).sendCode(' USER@Example.com ', '012345');
  assert.equal(calls, 1);
});

test('real local HTTP adapter sends forms but never follows redirects or accepts failed delivery', async t => {
  const http = require('node:http');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    requests.push({ path: req.url, method: req.method, type: req.headers['content-type'], body });
    if (req.url === '/redirect') { res.writeHead(307, { Location: '/leaked' }); res.end(); }
    else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: req.url === '/send' })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  // Fake credentials and code stay on loopback; no production mail service is called.
  await service({ ...config, apiUrl: `${url}/send`, timeoutMs: 2000 }).sendCode('user@example.com', '012345');
  assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].type, 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(requests[0].body).get('password'), config.password);
  for (const [path, expected] of [['/redirect', 'MAIL_HTTP_DELIVERY_UNCONFIRMED'], ['/failed', 'MAIL_HTTP_REJECTED']]) {
    await assert.rejects(service({ ...config, apiUrl: url + path, timeoutMs: 2000 }).sendCode('user@example.com', '012345'), error => error.getResponse().code === expected);
  }
  assert.deepEqual(requests.map(req => req.path), ['/send', '/redirect', '/failed']);
});

test('all upstream failures are sanitized and never retried', async t => {
  for (const response of [
    () => new Response(JSON.stringify({ status: false, msg: config.password })),
    () => new Response(JSON.stringify({ status: 'true' })),
    () => new Response('bad JSON ' + config.password),
    () => new Response(JSON.stringify({ status: true }), { status: 500 }),
    () => new Response('null'),
    () => { throw new Error(config.password); },
    () => { throw new DOMException('aborted', 'TimeoutError'); },
  ]) {
    let calls = 0;
    t.mock.method(global, 'fetch', async () => { calls++; return response(); });
    await assert.rejects(service().sendCode('user@example.com', '123456'), error => {
      assert.equal(error.getStatus(), 503);
      assert.ok(!JSON.stringify(error).includes(config.password));
      return true;
    });
    assert.equal(calls, 1);
    t.mock.restoreAll();
  }
});

test('missing credentials or invalid configuration never call upstream', async t => {
  t.mock.method(global, 'fetch', () => assert.fail('must not send'));
  for (const mail of [{ ...config, from: '' }, { ...config, password: '' }, { ...config, apiUrl: 'ftp://yuntianxing.net/mail_sys/send_mail_http.json' }, { ...config, apiUrl: 'https://user:pass@yuntianxing.net/' }, { ...config, timeoutMs: 60001 }]) {
    await assert.rejects(service(mail).sendCode('user@example.com', '123456'), /尚未配置/);
  }
});

test('recipient lists, header injection and malformed mailboxes are rejected', async t => {
  t.mock.method(global, 'fetch', () => assert.fail('must not send'));
  for (const email of ['a@example.com,b@example.com', 'a,b@example.com', 'a;b@example.com', 'x <a@example.com>', 'a@example.com\r\nBcc: b@example.com', '.a@example.com', 'a..b@example.com', 'a@-example.com', 'a@example..com']) {
    assert.throws(() => normalizedEmail(email), /邮箱格式/);
    await assert.rejects(service().sendCode(email, '123456'), /邮箱格式/);
  }
  assert.equal(normalizedEmail(' Test+tag@Example.com '), 'test+tag@example.com');
});

test('legacy and observed wrapped mail successes are accepted, inner failures never count as success', async t => {
  const cases = [
    [{ status: true, msg: '发送邮件成功' }, 'SENT'],
    [{ code: 0, status: true, msg: '请求成功', data: { status: true, msg: '发送邮件成功' }, timestamp: 123 }, 'SENT'],
    [{ code: 0, status: true, data: { status: false, msg: config.password } }, 'REJECTED'],
    [{ status: false, msg: config.password }, 'REJECTED'],
    [{ code: 1, status: true, data: { status: true } }, 'REJECTED'],
    [{ status: 'true' }, 'UNCERTAIN'],
    [{ code: 0, status: true, data: {} }, 'UNCERTAIN'],
    [{ status: true, data: { status: true } }, 'UNCERTAIN'],
    [{ code: '0', status: true, data: { status: true } }, 'UNCERTAIN'],
    [null, 'UNCERTAIN'],
  ];
  for (const [body, outcome] of cases) {
    t.mock.restoreAll(); let calls = 0; const mail = service(), logs = [];
    t.mock.method(mail.logger, 'log', value => logs.push(value)); t.mock.method(mail.logger, 'warn', value => logs.push(value));
    t.mock.method(global, 'fetch', async () => { calls++; return new Response(JSON.stringify(body)); });
    if (outcome === 'SENT') await mail.sendCode('user@example.com', '012345');
    else await assert.rejects(mail.sendCode('user@example.com', '012345'), error => {
      assert.equal(error instanceof MailDeliveryUnconfirmedException, outcome === 'UNCERTAIN');
      assert.equal(error.getResponse().diagnostic_id, logs[0].diagnostic_id); return true;
    });
    assert.equal(calls, 1); assert.equal(logs[0].outcome, outcome);
    assert.deepEqual(Object.keys(logs[0]).sort(), ['diagnostic_id', 'elapsed_ms', 'event', 'http_status', 'inner_status', 'outcome', 'outer_status', 'reason', 'response_shape', 'timeout_ms'].sort());
    for (const secret of [config.password, config.from, 'user@example.com', '012345']) assert.ok(!JSON.stringify(logs).includes(secret));
  }
});

test('HTTP rejection is distinct from unknown timeout, invalid JSON, server error and reset', async t => {
  const cases = [
    [() => new Response('', { status: 403 }), 'REJECTED', 'HTTP_REJECTED'],
    [() => new Response('', { status: 408 }), 'UNCERTAIN', 'HTTP_SERVER_ERROR'],
    [() => new Response(config.password, { status: 500 }), 'UNCERTAIN', 'HTTP_SERVER_ERROR'],
    [() => new Response(config.password), 'UNCERTAIN', 'INVALID_JSON'],
    [() => { throw new DOMException(config.password, 'TimeoutError'); }, 'UNCERTAIN', 'TIMEOUT'],
    [() => { throw Object.assign(new Error(config.password), { cause: { code: 'ECONNRESET' } }); }, 'UNCERTAIN', 'TRANSPORT_ERROR'],
    [() => { throw Object.assign(new Error(config.password), { cause: { code: 'ECONNREFUSED' } }); }, 'REJECTED', 'CONNECTION_FAILED'],
  ];
  for (const [response, outcome, reason] of cases) {
    t.mock.restoreAll(); const mail = service(), logs = []; let calls = 0;
    t.mock.method(mail.logger, 'warn', value => logs.push(value));
    t.mock.method(global, 'fetch', async () => { calls++; return response(); });
    await assert.rejects(mail.sendCode('user@example.com', '012345'), error => {
      assert.equal(error instanceof MailDeliveryUnconfirmedException, outcome === 'UNCERTAIN');
      assert.ok(!JSON.stringify(error).includes(config.password)); return true;
    });
    assert.equal(calls, 1); assert.equal(logs[0].reason, reason); assert.equal(logs[0].outcome, outcome);
    assert.ok(!JSON.stringify(logs).includes(config.password));
  }
});

test('local HTTP server accepts mail but delays acknowledgment: outcome is uncertain, never retried', async t => {
  const http = require('node:http'); let calls = 0, delayed;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {} calls++;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders();
    delayed = setTimeout(() => res.end('{"status":true}'), 400);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { clearTimeout(delayed); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const mail = service({ ...config, apiUrl: `http://127.0.0.1:${server.address().port}/send`, timeoutMs: 150 });
  await assert.rejects(mail.sendCode('user@example.com', '012345'), error => error instanceof MailDeliveryUnconfirmedException);
  assert.equal(calls, 1);
});
