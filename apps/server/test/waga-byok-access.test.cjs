const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { WagaByokAccessService } = require('../dist/common/waga-byok-access.service');
const { UserAuthController } = require('../dist/user-auth/user-auth.controller');
const { AdminController } = require('../dist/admin/admin.controller');

function fixture() {
  const grants = new Map(), audits = [], writes = [];
  const db = {
    async query(sql, [id]) { return grants.has(id) ? [grants.get(id)] : []; },
    async transaction(fn) { return fn({
      async query(sql, [id]) { return [sql.includes('FROM users ') ? (id === 'missing' ? [] : [{ id }]) : grants.has(id) ? [grants.get(id)] : []]; },
      async execute(sql, args) { writes.push({ sql, args }); const [id, enabled] = args; grants.set(id, { enabled, revision: (grants.get(id)?.revision || 0) + 1 }); },
    }); },
  };
  return { service: new WagaByokAccessService(db, { async record(v) { audits.push(v); } }), grants, audits, writes };
}
test('grant and revoke only the selected user; all other users default off', async () => {
  const { service, audits, writes } = fixture();
  assert.equal((await service.get('A')).enabled, false);
  await service.update('admin', 'A', { enabled: true, revision: 0 });
  assert.equal((await service.get('A')).enabled, true);
  assert.equal((await service.get('B')).enabled, false);
  await assert.rejects(service.update('admin', 'A', { enabled: false, revision: 0 }), /授权已更新/);
  assert.equal(writes.length, 1);
  await service.update('admin', 'A', { enabled: false, revision: 1 });
  assert.equal((await service.get('A')).enabled, false);
  assert.equal(audits[0].entityId, 'A');
  assert.deepEqual(audits[0].details, { before: false, after: true });
  assert.ok(writes.every(w => w.sql.includes('user_waga_byok_access')));
});
test('missing migration fails closed, no fake grant or mutation', async () => {
  const service = new WagaByokAccessService({ async query() { throw Object.assign(new Error(), { code: 'ER_NO_SUCH_TABLE' }); } }, {});
  assert.deepEqual(await service.get('A'), { user_id: 'A', enabled: false, revision: 0, migration_required: true });
});
test('strict input and nonexistent target never create a grant', async () => {
  const { service, writes } = fixture();
  for (const enabled of ['true', 1, null]) await assert.rejects(service.update('admin', 'A', { enabled, revision: 0 }));
  await assert.rejects(service.update('admin', 'missing', { enabled: true, revision: 0 }), /用户不存在/);
  assert.equal(writes.length, 0);
});
test('client uses authenticated subject, ignores forged user id; admin changes require users.manage', async () => {
  const seen = [];
  const controller = new UserAuthController(null, null, null, { async get(id) { seen.push(id); return { enabled: id === 'A' }; } });
  assert.deepEqual(await controller.wagaByokAccess({ user: { sub: 'A' }, query: { user_id: 'B' }, body: { user_id: 'B' } }), { user_id: 'A', enabled: true });
  assert.deepEqual(seen, ['A']);
  assert.ok(Reflect.getMetadata('__guards__', UserAuthController.prototype.wagaByokAccess).length);
  assert.deepEqual(Reflect.getMetadata('required_permissions', AdminController.prototype.updateWagaByokConfig), ['users.manage']);
});
