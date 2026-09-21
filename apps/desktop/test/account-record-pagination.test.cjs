const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const component = fs.readFileSync(path.join(__dirname, '../src/components/AccountCenterModal.tsx'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const service = fs.readFileSync(path.join(__dirname, '../src/services/platform.ts'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../../server/src/credits/credits.service.ts'), 'utf8');

test('purchase and consumption histories use separate account tabs', () => {
  assert.match(component, /setSection\("purchases"\).*购买记录/);
  assert.match(component, /setSection\("consumptions"\).*消耗记录/);
  assert.match(component, /section === "purchases" \? <PurchaseRecordsPanel \/>/);
  assert.match(component, /section === "consumptions" \? <ConsumptionRecordsPanel \/>/);
});

test('record pages share synchronized top and bottom pagination controls', () => {
  assert.match(component, /position="top"/);
  assert.match(component, /position="bottom"/);
  assert.match(component, /const \[page, setPage\] = useState\(1\)/);
  assert.match(component, /onPageChange=\{setPage\}/);
});

test('credit history requests and server queries are paginated at ten records', () => {
  assert.match(service, /`\/credits\/purchases\?page=\$\{page\}`/);
  assert.match(service, /`\/credits\/consumptions\?page=\$\{page\}`/);
  assert.match(server, /const CREDIT_RECORD_PAGE_SIZE = 10;/);
  assert.match(server, /total_pages: Math\.ceil\(total \/ CREDIT_RECORD_PAGE_SIZE\)/);
  assert.equal((server.match(/LIMIT \$\{CREDIT_RECORD_PAGE_SIZE\} OFFSET \$\{offset\}/g) || []).length, 2);
});

test('credit center exposes occupied-credit details and safe manual release', () => {
  assert.match(service, /authenticatedRequest<PlatformCreditHolds>\("\/credits\/holds"\)/);
  assert.match(service, /credits\/holds\/workflows\/.*\/release/);
  assert.match(component, /正在使用的积分明细/);
  assert.match(component, /任务进行中，不可释放/);
  assert.match(component, /releaseHold\.mutate\(item\)/);
});

test('client defensively clamps available credits at zero', () => {
  assert.match(component, /Math\.max\(0, Number\(balance\.data\.available\)\)/);
});

test('account email is read-only and excluded from profile updates', () => {
  const profile = component.slice(component.indexOf('function ProfilePanel'), component.indexOf('function CreditsPanel'));
  assert.match(profile, /<label>邮箱<input type="email" readOnly aria-describedby="account-email-readonly-hint"/);
  assert.match(profile, /登录邮箱不可在此修改/);
  assert.doesNotMatch(profile, /email: form\.email/);
  assert.doesNotMatch(profile, /setForm\(\{ \.\.\.form, email:/);
});

test('home account identity never exposes the login email', () => {
  const identity = app.slice(app.indexOf('function AccountIdentity'), app.indexOf('function AccountEntry'));
  assert.doesNotMatch(identity, /user\.data\?\.email/);
  assert.match(identity, /const detail = "账户与积分中心";/);
});
