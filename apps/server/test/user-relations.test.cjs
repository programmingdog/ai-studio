const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { AdminService } = require('../dist/admin/admin.service');
const { AdminController } = require('../dist/admin/admin.controller');
const { AdminAuthGuard } = require('../dist/auth/admin-auth.guard');
const { PermissionsGuard } = require('../dist/auth/permissions.guard');
const { REQUIRED_PERMISSIONS } = require('../dist/auth/permissions.decorator');
const id = '11111111-1111-4111-8111-111111111111';
test('relationship queries reject invalid UUID, third level, invalid pagination before SQL', async () => {
  const service = new AdminService({ transaction() { throw Error('unexpected SQL'); } }, {}, {}, {});
  for (const level of ['0', '3', '1.5', 'NaN', '1;DROP TABLE users']) await assert.rejects(service.userRelations(id, level), error => error.getStatus() === 400);
  for (const page of ['0', '-1', '1.5', '100001', 'Infinity']) await assert.rejects(service.userRelations(id, '1', page), error => error.getStatus() === 400);
  await assert.rejects(service.userRelations('invalid-user-id'), error => error.getStatus() === 400);
});
test('relations endpoint uses admin authentication and users.read, with no-store response', async () => {
  const guards = Reflect.getMetadata('__guards__', AdminController);
  assert.ok(guards.includes(AdminAuthGuard)); assert.ok(guards.includes(PermissionsGuard));
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, AdminController.prototype.userRelations), ['users.read']);
  assert.ok(Reflect.getMetadata('__headers__', AdminController.prototype.userRelations).some(x => x.name === 'Cache-Control' && x.value === 'no-store'));
  const calls = [], controller = new AdminController({ userRelations: (...args) => calls.push(args) });
  controller.userRelations(id, '2', '3'); assert.deepEqual(calls, [[id, '2', '3']]);
});
test('balance remains read-only in user editing controller; caller cannot change parent or cash', () => {
  const calls = [], controller = new AdminController({ updateUser: (...args) => calls.push(args) });
  controller.updateUser({ admin: { sub: 'admin' } }, id, { display_name: 'name', status: 'ACTIVE', balance_fen: 999999, pid: id });
  assert.equal(calls[0][2].balance_fen, undefined); assert.equal(calls[0][2].pid, undefined);
});
