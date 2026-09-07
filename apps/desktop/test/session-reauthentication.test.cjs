const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const main = read('src/main.tsx');
const app = read('src/App.tsx');
const host = read('src/components/SessionReauthenticationHost.tsx');
const account = read('src/components/AccountCenterModal.tsx');
const auth = read('src/components/UnifiedAuthPanel.tsx');
const media = read('src-tauri/src/platform_media.rs');
const ai = read('src-tauri/src/ai.rs');
const records = read('src-tauri/src/database/generation_records.rs');

test('expired platform sessions open a global password reauthentication dialog', () => {
  assert.match(main, /queryCache: new QueryCache\(\{ onError: requestSessionReauthentication \}\)/);
  assert.match(main, /mutationCache: new MutationCache\(\{ onError: requestSessionReauthentication \}\)/);
  assert.match(main, /<SessionReauthenticationHost \/>/);
  assert.match(host, /<AccountCenterModal required forceReauthentication/);
  assert.match(account, /登录已过期，请重新登录/);
  assert.match(account, /<UnifiedAuthPanel[^>]*forcePasswordEntry=\{forceReauthentication\}/);
});

test('forced reauthentication requires a manually entered password', () => {
  assert.match(auth, /if \(forcePasswordEntry\) \{ setRememberedCredentials\(\[\]\); setPassword\(""\); return; \}/);
  assert.match(auth, /!forcePasswordEntry && rememberedCredentials\.length > 0/);
  assert.match(auth, /autoComplete=\{forcePasswordEntry \? "off"/);
  assert.match(auth, /不能使用已保存密码自动填充/);
  assert.match(auth, /!forcePasswordEntry && authMethods\?\.wechat_enabled/);
});

test('submitted storyboard video resumes the same remote task after login', () => {
  assert.match(media, /"remote_task_id": task_id/);
  assert.match(ai, /platform_login_required_error\(&message\)[\s\S]*mark_auth_required/);
  assert.match(ai, /if let Some\(remote_task_id\) = record\.remote_task_id\.as_deref\(\)[\s\S]*platform_media::resume/);
  assert.match(records, /status = 'FAILED'[\s\S]*PLATFORM_LOGIN_REQUIRED/);
  assert.match(app, /expiredVideoRecord[\s\S]*requestSessionReauthentication/);
  assert.match(host, /activatePlatformUserContext\(\)[\s\S]*invalidateQueries/);
});
