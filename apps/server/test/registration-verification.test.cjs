const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { RegistrationVerificationService } = require('../dist/user-auth/registration-verification.service');
const { UserAuthService } = require('../dist/user-auth/user-auth.service');
const { UserAuthController } = require('../dist/user-auth/user-auth.controller');
const { MailDeliveryUnconfirmedException } = require('../dist/user-auth/mail-delivery-unconfirmed.exception');

// Transactional SQL double: serializes concurrent transactions and restores rows on rollback.
// No runtime database credentials or live mail services are used by this suite.
function harness() {
  let state = { captchas: new Map(), codes: new Map(), limits: new Map(), users: new Map(), ledger: [] };
  let queue = Promise.resolve();
  const sqlCalls = [], sent = [];
  const execute = async (sql, p = []) => {
    sqlCalls.push(sql);
    let row;
    if (sql.startsWith('DELETE ')) return { affectedRows: 0 };
    if (sql.startsWith('INSERT INTO registration_rate_limits')) {
      if (!state.limits.has(p[0])) state.limits.set(p[0], { hits: 0, window_ends_at: p[1] });
    } else if (sql.startsWith('UPDATE registration_rate_limits')) Object.assign(state.limits.get(p[2]), { hits: p[0], window_ends_at: p[1] });
    else if (sql.startsWith('INSERT INTO registration_captchas')) state.captchas.set(p[0], { id: p[0], email: p[1], ip_hash: p[2], answer_hash: p[3], expires_at: p[4], attempts: 0, token_hash: null, consumed_at: null });
    else if (sql.startsWith('UPDATE registration_captchas SET attempts')) state.captchas.get(p[0]).attempts++;
    else if (sql.startsWith('UPDATE registration_captchas SET answer_hash')) Object.assign(state.captchas.get(p[2]), { answer_hash: null, token_hash: p[0], expires_at: p[1] });
    else if (sql.startsWith('UPDATE registration_captchas SET consumed_at')) Object.assign(state.captchas.get(p[1]), { consumed_at: p[0], token_hash: null });
    else if (sql.startsWith('INSERT INTO registration_email_codes')) {
      if (!state.codes.has(p[0])) state.codes.set(p[0], { email: p[0], next_send_at: p[1], status: 'PENDING', attempts: 0 });
    } else if (sql.startsWith('UPDATE registration_email_codes SET send_id')) Object.assign(state.codes.get(p[2]), { send_id: p[0], code_hash: null, status: 'PENDING', attempts: 0, expires_at: null, next_send_at: p[1] });
    else if (sql.startsWith("UPDATE registration_email_codes SET status = 'FAILED'")) {
      row = state.codes.get(p[0]);
      if (row?.send_id !== p[1] || row.status !== 'PENDING') return { affectedRows: 0 };
      Object.assign(row, { status: 'FAILED', code_hash: null });
    } else if (sql.startsWith("UPDATE registration_email_codes SET status = 'SENT'" ) || sql.startsWith("UPDATE registration_email_codes SET status = 'UNCERTAIN'")) {
      row = state.codes.get(p[2]);
      if (row?.send_id !== p[3] || row.status !== 'PENDING') return { affectedRows: 0 };
      Object.assign(row, { status: sql.includes("status = 'UNCERTAIN'") ? 'UNCERTAIN' : 'SENT', code_hash: p[0], expires_at: p[1] });
    } else if (sql.startsWith('UPDATE registration_email_codes SET attempts')) state.codes.get(p[0]).attempts++;
    else if (sql.startsWith("UPDATE registration_email_codes SET status = 'CONSUMED'")) Object.assign(state.codes.get(p[0]), { status: 'CONSUMED', code_hash: null });
    else if (sql.startsWith('INSERT INTO users')) {
      if (state.users.has(p[1])) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      state.users.set(p[1], { id: p[0], email: p[1], password_hash: p[3] });
    } else if (sql.startsWith('INSERT INTO ledger_accounts')) state.ledger.push(p);
    else throw new Error('Unexpected execute: ' + sql);
    return { affectedRows: 1 };
  };
  const query = async (sql, p) => {
    sqlCalls.push(sql);
    let rows;
    if (sql.includes('FROM registration_rate_limits')) rows = [state.limits.get(p[0])];
    else if (sql.includes('FROM registration_captchas WHERE id')) rows = [state.captchas.get(p[0])];
    else if (sql.includes('FROM registration_captchas WHERE token_hash')) rows = [...state.captchas.values()].filter(x => x.token_hash === p[0]);
    else if (sql.includes('FROM registration_email_codes')) rows = [state.codes.get(p[0])];
    else if (sql.includes('FROM users')) rows = [state.users.get(p[0])];
    else throw new Error('Unexpected query: ' + sql);
    return [rows.filter(Boolean).map(x => ({ ...x }))];
  };
  const connection = { execute, query };
  const database = {
    execute,
    query: async (sql, parameters) => (await query(sql, parameters))[0],
    transaction: operation => {
      const run = queue.then(async () => {
        const snapshot = structuredClone(state);
        try { return await operation(connection); } catch (error) { state = snapshot; throw error; }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
  const environment = { values: { credentialEncryptionKey: 'test-only-key-with-at-least-32-characters', jwtSecret: 'test-only-jwt-secret-with-32-characters' } };
  const mail = { assertConfigured() {}, async sendCode(email, code) { sent.push({ email, code }); } };
  const service = new RegistrationVerificationService(database, environment, mail);
  const email = 'person@example.com', ip = '203.0.113.10';
  const challenge = async (address = email, addressIp = ip) => {
    const result = await service.createCaptcha(address, addressIp);
    // Known test answer without exposing a production answer channel.
    state.captchas.get(result.captcha_id).answer_hash = service.digest(`captcha:${result.captcha_id}`, 'ABCDE');
    return result;
  };
  const proof = async (address = email, addressIp = ip) => {
    const cap = await challenge(address, addressIp);
    return service.verifyCaptcha(address, cap.captcha_id, 'abcde', addressIp);
  };
  const send = async () => service.sendEmailCode(email, (await proof()).captcha_token, ip);
  const verify = (code = sent.at(-1)?.code, operation = async () => 'created') => service.withVerifiedEmail(email, code, ip, operation);
  return { service, database, environment, mail, get state() { return state; }, sent, sqlCalls, email, ip, challenge, proof, send, verify };
}

test('email status normalizes input, exposes existence only, and is rate limited without mail', async () => {
  const h = harness();
  assert.deepEqual(await h.service.emailStatus(' PERSON@Example.COM ', h.ip), { email: h.email, registered: false });
  h.state.users.set(h.email, { id: 'existing-user', email: h.email, display_name: 'private', status: 'DISABLED' });
  assert.deepEqual(await h.service.emailStatus(h.email, h.ip), { email: h.email, registered: true });
  for (let i = 2; i < 30; i++) await h.service.emailStatus(h.email, h.ip);
  await assert.rejects(h.service.emailStatus(h.email, h.ip), error => error.getStatus() === 429);
  assert.equal(h.sent.length, 0);
  assert.equal(h.state.captchas.size, 0);
  await assert.rejects(h.service.emailStatus('not-an-email', 'other-ip'), /邮箱/);
});

test('challenge is an image only, normalized and bound to email/IP', async () => {
  const h = harness();
  const cap = await h.challenge(' PERSON@Example.COM ');
  assert.deepEqual(Object.keys(cap).sort(), ['captcha_id', 'expires_in', 'image_data_url']);
  assert.equal(cap.expires_in, 300);
  const svg = Buffer.from(cap.image_data_url.split(',')[1], 'base64').toString();
  assert.match(svg, /<svg/); assert.match(svg, /<path/); assert.doesNotMatch(svg, /<text|ABCDE|<script/);
  assert.equal(h.state.captchas.get(cap.captcha_id).email, h.email);
  await assert.rejects(h.service.verifyCaptcha('other@example.com', cap.captcha_id, 'ABCDE', h.ip), /图形验证码/);
  await assert.rejects(h.service.verifyCaptcha(h.email, cap.captcha_id, 'ABCDE', 'other-ip'), /图形验证码/);
  const proof = await h.service.verifyCaptcha(h.email, cap.captcha_id, 'abcde', h.ip);
  assert.equal(proof.expires_in, 120);
  assert.notEqual(h.state.captchas.get(cap.captcha_id).token_hash, proof.captcha_token);
  assert.equal(h.state.captchas.get(cap.captcha_id).answer_hash, null);
  await assert.rejects(h.service.verifyCaptcha(h.email, cap.captcha_id, 'ABCDE', h.ip), /图形验证码/);
});

test('async configuration failures stop challenge creation and sending before any writes', async () => {
  const h = harness();
  h.mail.assertConfigured = async () => { throw Error('mail disabled'); };
  await assert.rejects(h.challenge(), /mail disabled/);
  await assert.rejects(h.service.sendEmailCode(h.email, 'token', h.ip), /mail disabled/);
  assert.equal(h.sqlCalls.length, 0); assert.equal(h.sent.length, 0);
});

test('five wrong image answers commit their attempt count and block the right answer', async () => {
  const h = harness(), cap = await h.challenge();
  for (let i = 0; i < 5; i++) await assert.rejects(h.service.verifyCaptcha(h.email, cap.captcha_id, 'WRONG', h.ip));
  assert.equal(h.state.captchas.get(cap.captcha_id).attempts, 5);
  await assert.rejects(h.service.verifyCaptcha(h.email, cap.captcha_id, 'ABCDE', h.ip));
  assert.equal(h.sent.length, 0);
});

test('expired images and expired verified proofs cannot send mail', async () => {
  const h = harness(), cap = await h.challenge();
  h.state.captchas.get(cap.captcha_id).expires_at = new Date(Date.now() - 1);
  await assert.rejects(h.service.verifyCaptcha(h.email, cap.captcha_id, 'ABCDE', h.ip));
  const proof = await h.proof();
  for (const row of h.state.captchas.values()) row.expires_at = new Date(Date.now() - 1);
  await assert.rejects(h.service.sendEmailCode(h.email, proof.captcha_token, h.ip));
  assert.equal(h.sent.length, 0);
});

test('mail requires a valid, single-use proof bound to the recipient and IP', async () => {
  const h = harness();
  await assert.rejects(h.service.sendEmailCode(h.email, 'made-up-token', h.ip), /图形验证码/);
  const proof = await h.proof();
  await assert.rejects(h.service.sendEmailCode('other@example.com', proof.captcha_token, h.ip));
  await assert.rejects(h.service.sendEmailCode(h.email, proof.captcha_token, 'other-ip'));
  const result = await h.service.sendEmailCode(h.email, proof.captcha_token, h.ip);
  assert.deepEqual(result, { sent: true, expires_in: 600, retry_after_seconds: 60 });
  assert.match(h.sent[0].code, /^\d{6}$/);
  assert.notEqual(h.state.codes.get(h.email).code_hash, h.sent[0].code);
  await assert.rejects(h.service.sendEmailCode(h.email, proof.captcha_token, h.ip));
  assert.equal(h.sent.length, 1);
});

test('parallel sends with one proof and different proofs only dispatch one email', async () => {
  for (const sameProof of [true, false]) {
    const h = harness();
    const first = await h.proof(), second = sameProof ? first : await h.proof();
    const outcomes = await Promise.allSettled([h.service.sendEmailCode(h.email, first.captcha_token, h.ip), h.service.sendEmailCode(h.email, second.captcha_token, h.ip)]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(h.sent.length, 1);
  }
});

test('confirmed codes expire, have five tries and cannot be replayed', async () => {
  const h = harness();
  await assert.rejects(h.verify('123456'));
  await h.send();
  const correct = h.sent[0].code, wrong = correct === '000000' ? '999999' : '000000';
  for (let i = 0; i < 5; i++) await assert.rejects(h.verify(wrong));
  assert.equal(h.state.codes.get(h.email).attempts, 5);
  await assert.rejects(h.verify(correct));
  h.state.codes.get(h.email).attempts = 0;
  h.state.codes.get(h.email).expires_at = new Date(Date.now() - 1);
  await assert.rejects(h.verify(correct));
  h.state.codes.get(h.email).expires_at = new Date(Date.now() + 60000);
  assert.equal(await h.verify(correct), 'created');
  assert.equal(h.state.codes.get(h.email).code_hash, null);
  await assert.rejects(h.verify(correct));
});

test('malformed or wrong-mailbox codes cannot execute account creation', async () => {
  const h = harness(); await h.send();
  for (const code of ['', '1', '12345x', '1234567']) await assert.rejects(h.verify(code, () => assert.fail('must not register')));
  await assert.rejects(h.service.withVerifiedEmail('other@example.com', h.sent[0].code, h.ip, () => assert.fail('must not register')));
});

test('parallel registrations consume the code exactly once; creation failure rolls back consumption', async () => {
  const h = harness(); await h.send();
  await assert.rejects(h.verify(undefined, async () => { h.state.ledger.push('rolled-back'); throw new Error('insert failed'); }), /insert failed/);
  assert.equal(h.state.ledger.length, 0);
  assert.equal(h.state.codes.get(h.email).status, 'SENT');
  let created = 0;
  const outcomes = await Promise.allSettled([h.verify(undefined, async () => ++created), h.verify(undefined, async () => ++created)]);
  assert.equal(created, 1);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
});

test('resend is blocked for 60 seconds and invalidates the old code', async () => {
  const h = harness(); await h.send();
  const oldHash = h.state.codes.get(h.email).code_hash;
  const proof = await h.proof();
  await assert.rejects(h.service.sendEmailCode(h.email, proof.captcha_token, h.ip), error => error.getStatus() === 429 && error.getResponse().retry_after_seconds > 0);
  h.state.codes.get(h.email).next_send_at = new Date(Date.now() - 1);
  await h.service.sendEmailCode(h.email, proof.captcha_token, h.ip);
  assert.notEqual(h.state.codes.get(h.email).code_hash, oldHash);
  if (h.sent[0].code !== h.sent[1].code) await assert.rejects(h.verify(h.sent[0].code));
  assert.equal(await h.verify(h.sent[1].code), 'created');
});

test('pending and failed sends cannot register, and a failed send consumes its proof', async () => {
  const h = harness();
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  h.mail.sendCode = async () => { entered(); await new Promise(resolve => { release = resolve; }); throw new Error('mail unavailable'); };
  const proof = await h.proof();
  const sending = h.service.sendEmailCode(h.email, proof.captcha_token, h.ip);
  await waiting;
  assert.equal(h.state.codes.get(h.email).status, 'PENDING');
  await assert.rejects(h.verify('123456'));
  release();
  await assert.rejects(sending, /mail unavailable/);
  assert.equal(h.state.codes.get(h.email).status, 'FAILED');
  assert.equal(h.state.codes.get(h.email).code_hash, null);
  await assert.rejects(h.verify('123456'));
  await assert.rejects(h.service.sendEmailCode(h.email, proof.captcha_token, h.ip));
});

test('registered addresses do not receive registration mail', async () => {
  const h = harness(); h.state.users.set(h.email, { id: 'existing' });
  await assert.rejects(h.send(), error => error.getStatus() === 409);
  assert.equal(h.sent.length, 0);
});

test('unconfirmed delivery keeps only the code hash, consumes proof, rate limits resend and allows one registration', async () => {
  const h = harness(), proof = await h.proof();
  h.mail.sendCode = async (email, code) => { h.sent.push({ email, code }); throw new MailDeliveryUnconfirmedException('test-diagnostic-id'); };
  await assert.rejects(h.service.sendEmailCode(h.email, proof.captcha_token, h.ip), error => {
    const response = error.getResponse();
    assert.equal(response.code, 'MAIL_HTTP_DELIVERY_UNCONFIRMED'); assert.equal(response.delivery_status, 'UNCERTAIN');
    assert.equal(response.expires_in, 600); assert.equal(response.retry_after_seconds, 60);
    assert.ok(!JSON.stringify(response).includes(h.sent[0].code)); return true;
  });
  const row = h.state.codes.get(h.email);
  assert.equal(row.status, 'UNCERTAIN'); assert.match(row.code_hash, /^[a-f0-9]{64}$/); assert.notEqual(row.code_hash, h.sent[0].code);
  await assert.rejects(h.service.sendEmailCode(h.email, proof.captcha_token, h.ip), /图形验证码/);
  await assert.rejects(h.send(), error => error.getStatus() === 429);
  await assert.rejects(h.verify(undefined, async () => { throw Error('insert failed'); }), /insert failed/);
  assert.equal(row.status, 'UNCERTAIN');
  const results = await Promise.allSettled([h.verify(), h.verify()]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(h.state.codes.get(h.email).status, 'CONSUMED'); assert.equal(h.state.codes.get(h.email).code_hash, null);
});

test('unconfirmed codes retain expiry, wrong-attempt and mailbox restrictions and are replaced by a new send', async () => {
  const h = harness();
  h.mail.sendCode = async (email, code) => { h.sent.push({ email, code }); throw new MailDeliveryUnconfirmedException('test-diagnostic-id'); };
  await assert.rejects(h.send());
  await assert.rejects(h.service.withVerifiedEmail('other@example.com', h.sent[0].code, h.ip, () => assert.fail('wrong mailbox')));
  h.state.codes.get(h.email).expires_at = new Date(0); await assert.rejects(h.verify());
  h.state.codes.get(h.email).expires_at = new Date(Date.now() + 60000);
  const wrong = h.sent[0].code === '000000' ? '999999' : '000000';
  for (let i = 0; i < 5; i++) await assert.rejects(h.verify(wrong));
  await assert.rejects(h.verify()); assert.equal(h.state.codes.get(h.email).attempts, 5);
  const oldHash = h.state.codes.get(h.email).code_hash;
  h.state.codes.get(h.email).next_send_at = new Date(0);
  await assert.rejects(h.send());
  assert.notEqual(h.state.codes.get(h.email).code_hash, oldHash);
  assert.equal(h.state.codes.get(h.email).attempts, 0);
  assert.equal(await h.verify(), 'created');
});

test('late unconfirmed response cannot replace a newer email code', async () => {
  const h = harness(); let rejectFirst, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  h.mail.sendCode = async (email, code) => {
    h.sent.push({ email, code });
    if (h.sent.length === 1) { entered(); await new Promise((_, reject) => { rejectFirst = reject; }); }
  };
  const first = h.send(); await waiting;
  h.state.codes.get(h.email).next_send_at = new Date(0);
  await h.send(); const newHash = h.state.codes.get(h.email).code_hash;
  rejectFirst(new MailDeliveryUnconfirmedException('late-diagnostic-id'));
  await assert.rejects(first, error => error.getStatus() === 409);
  assert.equal(h.state.codes.get(h.email).status, 'SENT'); assert.equal(h.state.codes.get(h.email).code_hash, newHash);
  assert.equal(await h.verify(), 'created');
});

test('image issuance and mail sending enforce shared IP/email/global rate limits', async () => {
  const h = harness();
  for (let i = 0; i < 10; i++) await h.challenge();
  await assert.rejects(h.challenge(), error => error.getStatus() === 429);
  const m = harness();
  for (let i = 0; i < 5; i++) { await m.send(); m.state.codes.get(m.email).next_send_at = new Date(0); }
  await assert.rejects(m.send(), error => error.getStatus() === 429);
  assert.equal(m.sent.length, 5);
  const g = harness();
  g.state.limits.set(g.service.digest('rate:mail-global', 'registration'), { hits: 200, window_ends_at: new Date(Date.now() + 60000) });
  await assert.rejects(g.send(), error => error.getStatus() === 429);
  assert.equal(g.sent.length, 0);
});

test('registration creates both user and wallet only after successful email verification', async () => {
  const h = harness();
  const auth = new UserAuthService(h.database, h.environment, {}, h.service, { async newUser() {} });
  auth.issueTokens = async () => ({ access_token: 'test-token' });
  auth.profile = async id => ({ id });
  await assert.rejects(auth.registerEmail(h.email, 'Password123', '123456', undefined, h.ip));
  assert.equal(h.state.users.size, 0);
  await h.send();
  await assert.rejects(auth.registerEmail(h.email, 'weak', h.sent[0].code, undefined, h.ip));
  assert.equal(h.state.codes.get(h.email).status, 'SENT');
  const result = await auth.registerEmail(' PERSON@EXAMPLE.COM ', 'Password123', h.sent[0].code, 'Person', h.ip);
  assert.equal(result.access_token, 'test-token');
  assert.equal(h.state.users.size, 1); assert.equal(h.state.ledger.length, 1);
  assert.equal(h.state.codes.get(h.email).status, 'CONSUMED');
});

test('controller rejects missing verification fields and uses request IP, not raw forwarded headers', () => {
  const calls = [];
  const controller = new UserAuthController({ registerEmail: (...args) => calls.push(args) }, { createCaptcha: (...args) => calls.push(args) });
  const request = { ip: '127.0.0.1', socket: {}, headers: { 'x-forwarded-for': 'untrusted' } };
  assert.throws(() => controller.registerEmail({ email: 'a@example.com', password: 'Password123' }, request), /email_code/);
  assert.throws(() => controller.verifyEmailCaptcha({ email: 'a@example.com' }, request), /captcha_id/);
  assert.throws(() => controller.sendEmailCode({ email: 'a@example.com' }, request), /captcha_token/);
  controller.createEmailCaptcha({ email: 'a@example.com' }, request);
  assert.deepEqual(calls[0], ['a@example.com', '127.0.0.1']);
});

test('OpenAPI requires the code and documents the complete challenge/send flow', () => {
  const doc = require('../dist/api-docs/api-document').createApiDocument();
  assert.ok(doc.components.schemas.EmailRegisterRequest.required.includes('email_code'));
  for (const route of ['/auth/email/status', '/auth/register/email/captcha', '/auth/register/email/captcha/verify', '/auth/register/email/code']) assert.ok(doc.paths[route].post);
});

test('HTTP routes require code/proof fields, return no-store and wire the three-step flow', async () => {
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { UserAuthGuard } = require('../dist/user-auth/user-auth.guard');
  const calls = [];
  class RegistrationTestModule {}
  Module({
    controllers: [UserAuthController],
    providers: [UserAuthGuard,
      { provide: UserAuthService, useValue: { registerEmail: (...args) => { calls.push(['register', ...args]); return { accepted: true }; } } },
      { provide: RegistrationVerificationService, useValue: {
        emailStatus: (...args) => { calls.push(['email-status', ...args]); return { email: args[0], registered: false }; },
        createCaptcha: (...args) => { calls.push(['captcha', ...args]); return { captcha_id: 'test-id', image_data_url: 'data:image/svg+xml;base64,PHN2Zy8+', expires_in: 300 }; },
        verifyCaptcha: (...args) => { calls.push(['verify', ...args]); return { captcha_token: 'test-token', expires_in: 120 }; },
        sendEmailCode: (...args) => { calls.push(['send', ...args]); return { sent: true, expires_in: 600, retry_after_seconds: 60 }; },
      } },
    ],
  })(RegistrationTestModule);
  const app = await NestFactory.create(RegistrationTestModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  try {
    const base = await app.getUrl();
    const post = (path, body) => fetch(base + '/api/v1/auth/register/email' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'untrusted-client-ip' }, body: JSON.stringify(body) });
    assert.equal((await post('', { email: 'test@example.com', password: 'Password123' })).status, 400);
    assert.equal((await post('/code', { email: 'test@example.com' })).status, 400);
    assert.equal(calls.length, 0);
    const image = await post('/captcha', { email: 'test@example.com' });
    assert.equal(image.status, 200); assert.equal(image.headers.get('cache-control'), 'no-store');
    assert.equal((await image.json()).captcha_id, 'test-id');
    assert.equal(calls[0].at(-1), '127.0.0.1');
    const proof = await post('/captcha/verify', { email: 'test@example.com', captcha_id: 'test-id', answer: 'ABCDE' });
    assert.equal(proof.status, 200); assert.equal((await proof.json()).captcha_token, 'test-token');
    const sent = await post('/code', { email: 'test@example.com', captcha_token: 'test-token' });
    assert.equal(sent.status, 200); assert.equal((await sent.json()).sent, true);
    assert.equal((await post('', { email: 'test@example.com', password: 'Password123', email_code: '012345' })).status, 201);
    assert.deepEqual(calls.map(x => x[0]), ['captcha', 'verify', 'send', 'register']);
    assert.equal(calls[3][3], '012345');
    const status = await fetch(base + '/api/v1/auth/email/status', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'untrusted-client-ip' }, body: JSON.stringify({ email: 'test@example.com' }) });
    assert.equal(status.status, 200); assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await status.json(), { email: 'test@example.com', registered: false });
    assert.deepEqual(calls.at(-1), ['email-status', 'test@example.com', '127.0.0.1']);
  } finally { await app.close(); }
});
