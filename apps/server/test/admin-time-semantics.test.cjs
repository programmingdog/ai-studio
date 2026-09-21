const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const admin = fs.readFileSync(path.join(__dirname, '../src/admin/admin.service.ts'), 'utf8');
const credits = fs.readFileSync(path.join(__dirname, '../src/admin/credit-admin.service.ts'), 'utf8');

test('admin reports separate China wall-time columns from genuine UTC instants', () => {
  assert.match(admin, /chinaWallDayStartSql = "DATE_SUB\(DATE\(CURRENT_TIMESTAMP\(\)\), INTERVAL 29 DAY\)"/);
  assert.match(admin, /SELECT DATE_FORMAT\(created_at, '%Y-%m-%d'\) AS date_key/);
  assert.match(admin, /utcDateExpression\("occurred_at"\)/);
  assert.match(admin, /wallDateExpression\("created_at"\)/);
  assert.doesNotMatch(admin, /DATE_FORMAT\(DATE_ADD\(created_at, INTERVAL 8 HOUR\)/);
});

test('admin purchase edits preserve the entered China wall time', () => {
  assert.match(credits, /function chinaWallDateValue/);
  assert.equal((credits.match(/chinaWallDateValue\(input\.purchasedAt/g) || []).length, 2);
  assert.match(credits, /dateValue\(input\.occurredAt/);
});
