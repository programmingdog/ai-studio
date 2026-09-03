const test = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv, createHash, randomBytes, X509Certificate } = require('node:crypto');
const { rootCertificates } = require('node:tls');
const { certificatePem } = require('../dist/admin/wechat-payment-config.service.js');
const { decryptWechatMessage, verifyWechatMessageSignature, xmlValue } = require('../dist/user-auth/wechat-official-account.js');
const { UserAuthService } = require('../dist/user-auth/user-auth.service.js');

function signature(...values) {
  return createHash('sha1').update(values.sort().join(''), 'utf8').digest('hex');
}

function encryptMessage(xml, encodingAesKey, appId) {
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  const length = Buffer.alloc(4); length.writeUInt32BE(Buffer.byteLength(xml));
  let plain = Buffer.concat([randomBytes(16), length, Buffer.from(xml), Buffer.from(appId)]);
  const padding = 32 - (plain.length % 32 || 32); const pad = padding || 32;
  plain = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

test('公众号明文签名与 subscribe/SCAN XML 字段均可验证和解析', () => {
  const token = 'AivsWechatToken2026', timestamp = '1700000000', nonce = 'nonce-value';
  verifyWechatMessageSignature(token, timestamp, nonce, signature(token, timestamp, nonce));
  assert.throws(() => verifyWechatMessageSignature(token, timestamp, nonce, 'bad'), /签名/);
  const subscribe = '<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event><EventKey><![CDATA[qrscene_login-state]]></EventKey></xml>';
  const scan = '<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[SCAN]]></Event><EventKey><![CDATA[login-state]]></EventKey></xml>';
  assert.equal(xmlValue(subscribe, 'Event'), 'subscribe');
  assert.equal(xmlValue(subscribe, 'EventKey'), 'qrscene_login-state');
  assert.equal(xmlValue(scan, 'EventKey'), 'login-state');
});

test('公众号安全模式消息校验并解密，且拒绝错误 AppID', () => {
  const token = 'AivsWechatToken2026', timestamp = '1700000000', nonce = 'nonce-value';
  const encodingAesKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  const appId = 'wx1234567890abcdef';
  const xml = '<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[SCAN]]></Event></xml>';
  const encrypted = encryptMessage(xml, encodingAesKey, appId);
  verifyWechatMessageSignature(token, timestamp, nonce, signature(token, timestamp, nonce, encrypted), encrypted);
  assert.equal(decryptWechatMessage(encrypted, encodingAesKey, appId), xml);
  assert.throws(() => decryptWechatMessage(encrypted, encodingAesKey, 'wx-different'), /AppID/);
});

test('商户 cert 上传同时接受 PEM 和二进制 DER X.509 证书', () => {
  const pem = rootCertificates[0];
  const certificate = new X509Certificate(pem);
  const fromPem = certificatePem(Buffer.from(pem), '测试证书');
  const fromDer = certificatePem(certificate.raw, '测试证书');
  assert.equal(fromPem.serial, fromDer.serial);
  assert.match(fromDer.pem, /BEGIN CERTIFICATE/);
});

for (const event of [{ name: '未关注用户 subscribe', type: 'subscribe', prefix: 'qrscene_' }, { name: '已关注用户 SCAN', type: 'SCAN', prefix: '' }]) {
  test(`公众号${event.name}事件完成同一个带参二维码登录会话`, async () => {
    const token = 'AivsWechatToken2026', appId = 'wx1234567890abcdef', state = 'login-state-123';
    const executed = [], queried = [];
    const connection = {
      query: async (sql, params) => {
        queried.push([sql, params]);
        if (sql.includes('wechat_auth_sessions')) return [[{ id: 'session-id', status: 'PENDING', inviter_id: null }]];
        return [[]];
      },
      execute: async (sql, params) => { executed.push([sql, params]); return [{ affectedRows: 1 }]; },
    };
    const database = {
      query: async (sql, params) => {
        queried.push([sql, params]);
        if (sql.includes('wechat_payment_configs')) return [{ app_id: appId, app_secret_ciphertext: 'app-secret', official_account_token_ciphertext: token, official_account_encoding_aes_key_ciphertext: null, status: 'ACTIVE' }];
        if (sql.includes('wechat_auth_sessions')) return [{ id: 'session-id', status: 'PENDING' }];
        return [];
      },
      transaction: callback => callback(connection),
    };
    const referrals = { newUser: async () => undefined };
    const service = new UserAuthService(database, { values: { jwtSecret: 'unused' } }, { decrypt: value => value }, {}, referrals);
    service.wechatAccessToken = async () => 'access-token';
    const originalFetch = global.fetch;
    global.fetch = async () => ({ json: async () => ({ subscribe: 1, openid: 'openid-1', unionid: 'union-1', nickname: '微信测试用户', headimgurl: 'https://example.invalid/avatar.png' }) });
    const timestamp = '1700000000', nonce = 'nonce-value';
    const body = `<xml><FromUserName><![CDATA[openid-1]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[${event.type}]]></Event><EventKey><![CDATA[${event.prefix}${state}]]></EventKey></xml>`;
    try {
      assert.equal(await service.handleOfficialAccountEvent({ signature: signature(token, timestamp, nonce), timestamp, nonce, body }), 'success');
    } finally { global.fetch = originalFetch; }
    const expectedHash = createHash('sha256').update(state).digest('hex');
    assert.ok(queried.some(([, params]) => params?.includes(expectedHash)), 'event scene must select the matching login session');
    const sessionQueries = queried.filter(([sql]) => sql.includes('wechat_auth_sessions'));
    assert.ok(sessionQueries.every(([sql]) => !sql.includes('CURRENT_TIMESTAMP')), 'session expiry must not depend on the MySQL server timezone');
    assert.ok(sessionQueries.every(([, params]) => params?.some(value => value instanceof Date)), 'session expiry queries must compare against an explicit UTC-safe Date');
    assert.ok(executed.some(([sql]) => sql.includes("status = 'COMPLETED'")), 'event must complete the login session');
  });
}
