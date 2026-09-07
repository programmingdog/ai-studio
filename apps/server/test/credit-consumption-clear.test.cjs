const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const { CreditAdminService } = require('../dist/admin/credit-admin.service');
const { AdminController } = require('../dist/admin/admin.controller');
const { REQUIRED_PERMISSIONS } = require('../dist/auth/permissions.decorator');

test('clearing consumption records deletes only the consumption table and audits the count', async () => {
  const statements = [], audits = [];
  const database = {
    async execute(sql, parameters = []) {
      statements.push([sql, parameters]);
      return { affectedRows: 37 };
    },
  };
  const service = new CreditAdminService(database, { async record(input) { audits.push(input); } });
  const result = await service.clearConsumptions('admin-1');
  assert.deepEqual(result, { deleted: true, deleted_count: 37 });
  assert.deepEqual(statements, [['DELETE FROM credit_consumption_records', []]]);
  assert.deepEqual(audits, [{
    adminUserId: 'admin-1', action: 'credit_consumption.clear_all',
    entityType: 'credit_consumption_record', entityId: 'ALL', details: { deleted_count: 37 },
  }]);
});

test('clear endpoint requires explicit destructive confirmation and credits permission', async () => {
  const calls = [];
  const controller = new AdminController({}, { clearConsumptions: (...args) => { calls.push(args); return { deleted: true, deleted_count: 2 }; } });
  const request = { admin: { sub: 'admin-1' } };
  assert.throws(() => controller.clearCreditConsumptions(request, {}), /明确确认/);
  assert.throws(() => controller.clearCreditConsumptions(request, { confirmed: true, confirmation: 'WRONG' }), /明确确认/);
  assert.equal(calls.length, 0);
  assert.deepEqual(
    controller.clearCreditConsumptions(request, { confirmed: true, confirmation: 'CLEAR_ALL_CREDIT_CONSUMPTIONS' }),
    { deleted: true, deleted_count: 2 },
  );
  assert.deepEqual(calls, [['admin-1']]);
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, AdminController.prototype.clearCreditConsumptions), ['credits.manage']);
});
