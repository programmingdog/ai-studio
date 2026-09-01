const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { MailConfigService, validateMailApiUrl } = require('../dist/mail/mail-config.service');
const { SecretCryptoService } = require('../dist/common/secret-crypto.service');
const { RegistrationMailService } = require('../dist/user-auth/registration-mail.service');
const { AdminController } = require('../dist/admin/admin.controller');
const { AdminAuthGuard } = require('../dist/auth/admin-auth.guard');
const { PermissionsGuard } = require('../dist/auth/permissions.guard');
const { Reflector } = require('@nestjs/core');
const { GUARDS_METADATA } = require('@nestjs/common/constants');

function harness() {
  let row = { api_url: 'https://yuntianxing.net/mail_sys/send_mail_http.json', delivery_method: 'HTTP', smtp_host: 'mail.yuntianxing.net', smtp_port: 25, smtp_security: 'STARTTLS', mail_from: '', password_ciphertext: null, status: 'DISABLED', revision: 0, updated_at: new Date() };
  let audits = [], queue = Promise.resolve();
  const environment = { values: { credentialEncryptionKey: 'test-only-independent-32-character-key', mailApiTimeoutMs: 10000 } };
  const crypto = new SecretCryptoService(environment);
  const connection = {
    query: async () => [[row ? { ...row } : undefined].filter(Boolean)],
    execute: async (sql, args) => {
      if (sql.startsWith('UPDATE mail_service_configs')) row = { ...row, api_url: args[0], mail_from: args[1], password_ciphertext: args[2], status: args[3], revision: row.revision + 1, updated_by: args[4], delivery_method: args[5], smtp_host: args[6], smtp_port: args[7], smtp_security: args[8], updated_at: new Date() };
      else if (sql.startsWith('INSERT INTO audit_logs')) audits.push(args);
      else throw Error(sql);
      return [{ affectedRows: 1 }];
    },
  };
  const database = {
    query: async () => row ? [{ ...row }] : [],
    transaction: fn => {
      const run = queue.then(async () => {
        const before = structuredClone({ row, audits });
        try { return await fn(connection); } catch (error) { row = before.row; audits = before.audits; throw error; }
      });
      queue = run.catch(() => {}); return run;
    },
  };
  const service = new MailConfigService(database, crypto);
  const input = (overrides = {}) => ({ api_url: row.api_url, mail_from: 'sender@yuntianxing.net', password: ' test & secret=密码 ', status: 'ACTIVE', revision: row.revision, ...overrides });
  return { service, input, connection, environment, crypto, get row() { return row; }, get audits() { return audits; }, clear() { row = null; } };
}

test('mail API accepts HTTP and HTTPS with explicit ports but rejects other protocols and embedded credentials', () => {
  for (const url of ['http://211.154.25.178:15686/mail_sys/send_mail_http.json', 'https://example.com:15686/mail_sys/send_mail_http.json']) {
    assert.equal(validateMailApiUrl(` ${url} `), url);
  }
  for (const url of ['ftp://example.com/send', 'file:///send', 'javascript:alert(1)', '//example.com/send', 'http://user:password@example.com/send', 'http://example.com/send?password=secret', 'http://example.com/send#fragment']) {
    assert.throws(() => validateMailApiUrl(url), error => error.getStatus() === 400);
  }
});

test('HTTP endpoint saves and becomes available for delivery; scheme changes require password re-entry', async () => {
  const h = harness();
  const apiUrl = 'http://211.154.25.178:15686/mail_sys/send_mail_http.json';
  const result = await h.service.save('admin-id', h.input({ api_url: apiUrl }));
  assert.equal(result.api_url, apiUrl);
  assert.equal((await h.service.deliveryConfig()).apiUrl, apiUrl);
  await h.service.save('admin-id', h.input({ api_url: apiUrl.replace('http:', 'https:') }));
  await assert.rejects(h.service.save('admin-id', h.input({ api_url: apiUrl, password: '' })), /重新填写/);
  await h.service.save('admin-id', h.input({ api_url: apiUrl }));
  assert.equal((await h.service.deliveryConfig()).apiUrl, apiUrl);
});

test('initial configuration is disabled and administrator reads never decrypt secrets', async () => {
  const h = harness();
  h.crypto.decrypt = () => assert.fail('admin GET must never decrypt');
  const result = await h.service.get();
  assert.equal(result.status, 'DISABLED'); assert.equal(result.password_configured, false);
  assert.equal(result.delivery_method, 'HTTP');
  assert.deepEqual(Object.keys(result).sort(), ['api_url', 'delivery_method', 'mail_from', 'password_configured', 'revision', 'smtp_host', 'smtp_port', 'smtp_security', 'status', 'updated_at']);
  await assert.rejects(h.service.deliveryConfig(), /尚未配置或已停用/);
});

test('save encrypts the exact password and returns no password, ciphertext or hint in response/audit', async () => {
  const h = harness(), input = h.input();
  const result = await h.service.save('admin-id', input);
  assert.equal(h.crypto.decrypt(h.row.password_ciphertext), input.password);
  assert.notEqual(h.row.password_ciphertext, input.password);
  assert.equal(result.password_configured, true); assert.equal(result.revision, 1);
  assert.equal(result.mail_from, input.mail_from);
  for (const value of [result, h.audits]) {
    assert.ok(!JSON.stringify(value).includes(input.password));
    assert.ok(!JSON.stringify(value).includes(h.row.password_ciphertext));
  }
  assert.deepEqual(JSON.parse(h.audits[0][2]), { api_url: input.api_url, delivery_method: 'HTTP', smtp_host: 'mail.yuntianxing.net', smtp_port: 25, smtp_security: 'STARTTLS', mail_from: input.mail_from, status: 'ACTIVE', password_changed: true, revision: 1 });
});

test('blank or omitted passwords preserve the encrypted secret; explicit replacement rotates it', async () => {
  const h = harness(); await h.service.save('admin-id', h.input());
  const original = h.row.password_ciphertext;
  await h.service.save('admin-id', h.input({ password: '', status: 'DISABLED' }));
  assert.equal(h.row.password_ciphertext, original);
  await assert.rejects(h.service.deliveryConfig(), /停用/);
  await h.service.save('admin-id', h.input({ password: undefined }));
  assert.equal(h.row.password_ciphertext, original);
  await h.service.save('admin-id', h.input({ password: 'replacement-test-only' }));
  assert.notEqual(h.row.password_ciphertext, original);
  assert.equal((await h.service.deliveryConfig()).password, 'replacement-test-only');
});

test('changing destination or mailbox requires password re-entry', async () => {
  const h = harness(); await h.service.save('admin-id', h.input());
  for (const override of [{ api_url: 'https://other.example.com/send' }, { mail_from: 'other@yuntianxing.net' }]) {
    await assert.rejects(h.service.save('admin-id', h.input({ ...override, password: '' })), /重新填写/);
  }
  await h.service.save('admin-id', h.input({ api_url: 'https://other.example.com/send', password: 'new-destination-secret' }));
  assert.equal((await h.service.deliveryConfig()).apiUrl, 'https://other.example.com/send');
});

test('SMTP save retains the inactive HTTP endpoint and switching back requires password re-entry', async () => {
  const h = harness(); await h.service.save('admin-id', h.input());
  await assert.rejects(h.service.save('admin-id', h.input({ delivery_method: 'SMTP', password: '' })), /重新填写/);
  await h.service.save('admin-id', h.input({ delivery_method: 'SMTP', api_url: 'ignored-inactive-url', smtp_host: ' MAIL.YUNTIANXING.NET ' }));
  assert.equal(h.row.api_url, 'https://yuntianxing.net/mail_sys/send_mail_http.json');
  assert.deepEqual(await h.service.deliveryConfig(), { method: 'SMTP', host: 'mail.yuntianxing.net', port: 25, security: 'STARTTLS', from: h.row.mail_from, password: h.input().password });
  // A legacy admin request omitting the method must not silently switch SMTP back to HTTP.
  const ciphertext = h.row.password_ciphertext;
  await h.service.save('admin-id', h.input({ password: '', api_url: 'ignored' }));
  assert.equal(h.row.delivery_method, 'SMTP'); assert.equal(h.row.password_ciphertext, ciphertext);
  for (const override of [{ smtp_host: 'other.example.com' }, { smtp_port: 587 }, { smtp_security: 'TLS' }, { delivery_method: 'HTTP' }]) {
    await assert.rejects(h.service.save('admin-id', h.input({ ...override, password: '' })), /重新填写/);
  }
  await h.service.save('admin-id', h.input({ smtp_port: 465, smtp_security: 'TLS' }));
  assert.equal((await h.service.deliveryConfig()).security, 'TLS');
  await h.service.save('admin-id', h.input({ delivery_method: 'HTTP', smtp_host: 'ignored-invalid-host' }));
  assert.equal((await h.service.deliveryConfig()).method, 'HTTP');
  assert.equal(h.row.smtp_host, 'mail.yuntianxing.net'); assert.equal(h.row.smtp_port, 465);
});

test('invalid SMTP hosts, ports, transport and insecure options are rejected atomically', async () => {
  const h = harness();
  for (const override of [
    { smtp_host: '' }, { smtp_host: 'smtp://mail.yuntianxing.net' }, { smtp_host: 'mail.yuntianxing.net:25' }, { smtp_host: 'mail.yuntianxing.net/send' },
    { smtp_host: '127.0.0.1' }, { smtp_host: 'mail..example.com' }, { smtp_host: 'a'.repeat(64) + '.example.com' },
    { smtp_port: 0 }, { smtp_port: 65536 }, { smtp_port: 25.5 }, { smtp_port: '25' }, { smtp_port: null },
    { smtp_security: 'NONE' }, { smtp_security: null }, { smtp_port: 465, smtp_security: 'STARTTLS' }, { delivery_method: 'POP' },
  ]) await assert.rejects(h.service.save('admin-id', h.input({ delivery_method: 'SMTP', ...override })), error => error.getStatus() === 400);
  assert.equal(h.row.revision, 0); assert.equal(h.audits.length, 0);
});

test('bad URLs, recipient lists, invalid secrets, missing credentials and invalid revision are rejected', async () => {
  const h = harness();
  for (const override of [
    { api_url: 'ftp://example.com/send' }, { api_url: 'https://u:secret@example.com/send' }, { api_url: 'https://example.com/send?password=secret' }, { api_url: 'not-a-url' },
    { mail_from: 'a@example.com,b@example.com' }, { mail_from: 123 }, { password: null }, { password: '   ' }, { password: 'a'.repeat(501) },
    { password: '' }, { mail_from: '' }, { status: 'UNKNOWN' }, { revision: -1 }, { revision: '0' },
  ]) await assert.rejects(h.service.save('admin-id', h.input(override)), error => error.getStatus() === 400);
  assert.equal(h.row.revision, 0); assert.equal(h.audits.length, 0);
});

test('revision rejects stale and simultaneous edits; audit failure rolls back config', async () => {
  const h = harness(), first = h.input();
  const results = await Promise.allSettled([h.service.save('admin-id', first), h.service.save('other-admin', first)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.getStatus(), 409);
  assert.equal(h.row.revision, 1); assert.equal(h.audits.length, 1);
  const before = h.row.password_ciphertext;
  const execute = h.connection.execute;
  h.connection.execute = (sql, args) => { if (sql.startsWith('INSERT INTO audit_logs')) throw Error('audit failed'); return execute(sql, args); };
  await assert.rejects(h.service.save('admin-id', h.input({ password: 'must-rollback' })), /audit failed/);
  assert.equal(h.row.password_ciphertext, before); assert.equal(h.row.revision, 1);
});

test('configuration changes affect the next mail request and disabled state fails closed', async t => {
  const h = harness(); await h.service.save('admin-id', h.input());
  const mail = new RegistrationMailService(h.environment, h.service), sent = [];
  t.mock.method(global, 'fetch', async (url, init) => { sent.push({ url, body: new URLSearchParams(init.body) }); return new Response('{"status":true}'); });
  await mail.sendCode('user@example.com', '123456');
  await h.service.save('admin-id', h.input({ api_url: 'https://other.example.com/send', mail_from: 'other@example.com', password: 'second-password' }));
  await mail.sendCode('user@example.com', '123456');
  assert.equal(sent[1].url, 'https://other.example.com/send');
  assert.equal(sent[1].body.get('password'), 'second-password');
  assert.equal(sent[1].body.get('mail_from'), 'other@example.com');
  await h.service.save('admin-id', h.input({ api_url: h.row.api_url, mail_from: h.row.mail_from, password: '', status: 'DISABLED' }));
  await assert.rejects(mail.assertConfigured(), /停用/);
  await assert.rejects(mail.sendCode('user@example.com', '123456'), /停用/);
  assert.equal(sent.length, 2);
});

test('decryption failures and missing rows fail closed without leaking ciphertext', async () => {
  const h = harness(); await h.service.save('admin-id', h.input());
  const ciphertext = h.row.password_ciphertext;
  h.crypto.decrypt = () => { throw Error(ciphertext); };
  await assert.rejects(h.service.deliveryConfig(), error => error.getStatus() === 503 && !JSON.stringify(error).includes(ciphertext));
  h.clear(); await assert.rejects(h.service.get(), /数据库迁移/);
});

test('mail admin routes enforce authentication and configs.manage permission', () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminController), [AdminAuthGuard, PermissionsGuard]);
  const guard = new PermissionsGuard(new Reflector());
  for (const method of ['getMailConfig', 'saveMailConfig']) {
    const context = permissions => ({ getHandler: () => AdminController.prototype[method], getClass: () => AdminController, switchToHttp: () => ({ getRequest: () => ({ admin: { permissions, roles: [], mustChangePassword: false } }) }) });
    assert.throws(() => guard.canActivate(context([])), error => error.getStatus() === 403);
    assert.equal(guard.canActivate(context(['configs.manage'])), true);
  }
});

test('OpenAPI marks the password write-only and has no password fields in the read schema', () => {
  const doc = require('../dist/api-docs/api-document').createApiDocument();
  assert.equal(doc.components.schemas.MailConfigRequest.properties.password.writeOnly, true);
  assert.equal(doc.components.schemas.MailConfig.properties.password, undefined);
  assert.equal(doc.components.schemas.MailConfig.properties.password_ciphertext, undefined);
  assert.ok(doc.paths['/admin/configs/mail'].patch.security);
});
