const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuthMethodConfigService } = require('../dist/common/auth-method-config.service.js');

function fixture(row = { registration_enabled: 1, email_enabled: 1, phone_otp_enabled: 0, wechat_enabled: 1, revision: 2, updated_at: '2026-09-03T00:00:00.000Z' }) {
  const executions = [], audits = [];
  const database = {
    async query() { return [row]; },
    async execute(sql, parameters) { executions.push({ sql, parameters }); },
  };
  const audit = { async record(input) { audits.push(input); } };
  return { service: new AuthMethodConfigService(database, audit), executions, audits };
}

test('public config exposes only available login methods and forces phone OTP off', async () => {
  const { service } = fixture({ registration_enabled: 0, email_enabled: 0, phone_otp_enabled: 1, wechat_enabled: 1, revision: 4, updated_at: 'now' });
  assert.deepEqual(await service.publicConfig(), {
    registration_enabled: false,
    email_enabled: false,
    phone_otp_enabled: false,
    phone_otp_available: false,
    wechat_enabled: true,
  });
});

test('phone OTP cannot be enabled before an SMS service is integrated', async () => {
  const { service, executions } = fixture();
  await assert.rejects(() => service.update('admin-1', { registrationEnabled: true, emailEnabled: true, phoneOtpEnabled: true, wechatEnabled: true }), /尚未接入短信服务/);
  assert.equal(executions.length, 0);
});

test('at least one currently available login method remains enabled', async () => {
  const { service, executions } = fixture();
  await assert.rejects(() => service.update('admin-1', { registrationEnabled: true, emailEnabled: false, phoneOtpEnabled: false, wechatEnabled: false }), /至少需要启用一种/);
  assert.equal(executions.length, 0);
});

test('updating methods persists values and writes an audit record', async () => {
  const { service, executions, audits } = fixture({ registration_enabled: 0, email_enabled: 1, phone_otp_enabled: 0, wechat_enabled: 0, revision: 3, updated_at: 'now' });
  const result = await service.update('admin-1', { registrationEnabled: false, emailEnabled: true, phoneOtpEnabled: false, wechatEnabled: false });
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0].parameters, [0, 1, 0, 'admin-1']);
  assert.equal(audits[0].action, 'client_auth_methods.update');
  assert.equal(result.wechat_enabled, false);
});

test('disabled registration is enforced by the server', async () => {
  const { service } = fixture({ registration_enabled: 0, email_enabled: 1, phone_otp_enabled: 0, wechat_enabled: 1, revision: 1, updated_at: 'now' });
  await assert.rejects(() => service.assertRegistrationEnabled(), /暂未开放新用户注册/);
});
