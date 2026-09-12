const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const component = fs.readFileSync(path.join(__dirname, '../src/components/AccountCenterModal.tsx'), 'utf8');
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
