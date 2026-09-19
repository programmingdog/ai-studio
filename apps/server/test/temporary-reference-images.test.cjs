const assert = require('node:assert/strict');
const { mkdtemp, readdir, unlink, rmdir, rename, utimes } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { TemporaryReferenceImageService } = require('../dist/common/temporary-reference-image.service');
const { createReferenceTestDatabase } = require('./fixtures/reference-image-database.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=', 'base64');
const hour = 60 * 60 * 1000;

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'aivs-reference-test-'));
  const db = await createReferenceTestDatabase(mode);
  const environment = { values: { referenceImageDirectory: root, credentialEncryptionKey: 'test-key-with-more-than-thirty-two-characters' } };
  let service = new TemporaryReferenceImageService(environment, db);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.after(async () => {
    service.onModuleDestroy(); await db.close();
    for (const name of await readdir(root)) await unlink(join(root, name));
    await rmdir(root);
  });
  await service.onModuleInit();
  return {
    root, db, get service() { return service; }, now: () => now, advance: ms => { now += ms; },
    async restart() { service.onModuleDestroy(); service = new TemporaryReferenceImageService(environment, db); await service.onModuleInit(); },
    async upload() {
      const uploaded = await service.upload('user-one', { buffer: png, size: png.length, mimetype: 'image/png', originalname: 'one.png' }, 'https://api.example.test');
      const token = service.ownedTokens({ reference_images: [{ url: uploaded.url }] }, 'user-one')[0];
      return { ...uploaded, token, nonce: service.verify(token).n };
    },
    async bind(token, status = 'PROCESSING') {
      const id = randomUUID(); await db.setTask(id, status, null);
      await db.transaction(c => service.bindToTask(c, [token], id, 'user-one')); return id;
    },
    async read(token) {
      const result = await service.open(token), chunks = [];
      for await (const chunk of result.stream) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), png); assert.equal(result.mimeType, 'image/png');
    },
  };
}

// Optional SQL run uses ONLY session-local temporary tables; never touches
// actual users, tasks, credits or production reference records.
for (const mode of ['memory', ...(process.env.AIVS_TEST_DB === '1' ? ['mysql'] : [])]) {
  test(`${mode}: queued/running/uncertain tasks retain images and signed URLs beyond one hour`, async t => {
    const f = await fixture(t, mode);
    for (const status of ['CREDIT_RESERVED', 'SUBMITTING', 'PROVIDER_ACCEPTED', 'PROCESSING', 'UNKNOWN_RECOVERABLE']) {
      const image = await f.upload(); await f.bind(image.token, status);
      f.advance(24 * hour); await f.service.cleanup(); await f.read(image.token);
    }
  });
  test(`${mode}: restart preserves active images without client polling`, async t => {
    const f = await fixture(t, mode), image = await f.upload(); await f.bind(image.token);
    f.advance(48 * hour); await f.restart(); await f.read(image.token);
  });
  for (const status of ['SUCCEEDED', 'FAILED', 'CANCELED']) test(`${mode}: ${status} cleanup starts from task completion, not upload time`, async t => {
    const f = await fixture(t, mode), image = await f.upload(), task = await f.bind(image.token);
    f.advance(12 * hour); await f.db.setTask(task, status, new Date(f.now()));
    f.advance(59 * 60 * 1000); await f.service.cleanup(); await f.read(image.token);
    f.advance(2 * 60 * 1000); await assert.rejects(f.service.open(image.token), /过期|结束/);
    await f.service.cleanup(); assert.deepEqual(await readdir(f.root), []);
  });
  test(`${mode}: shared references wait for every task and its terminal grace period`, async t => {
    const f = await fixture(t, mode), image = await f.upload(), first = await f.bind(image.token), second = await f.bind(image.token);
    await f.db.setTask(first, 'FAILED', new Date(f.now())); f.advance(8 * hour);
    await f.service.cleanup(); await f.read(image.token);
    await f.db.setTask(second, 'SUCCEEDED', new Date(f.now()));
    await f.service.cleanup(); await f.read(image.token);
    f.advance(hour + 1); await f.service.cleanup(); assert.deepEqual(await readdir(f.root), []);
  });
  test(`${mode}: unused uploads expire, while failed reservations do not pin them`, async t => {
    const f = await fixture(t, mode), image = await f.upload(), task = randomUUID();
    await f.db.setTask(task, 'SUBMITTING', null);
    await assert.rejects(f.db.transaction(async c => {
      await f.service.bindToTask(c, [image.token], task, 'user-one'); throw new Error('reservation rollback');
    }), /rollback/);
    f.advance(hour + 1); await assert.rejects(f.service.open(image.token), /过期/);
    await f.service.cleanup(); assert.deepEqual(await readdir(f.root), []);
  });
  test(`${mode}: expired admission does not stop existing downloads or idempotent token extraction`, async t => {
    const f = await fixture(t, mode), image = await f.upload(); await f.bind(image.token);
    f.advance(2 * hour);
    assert.deepEqual(f.service.ownedTokens({ frame_start: image.url }, 'user-one'), [image.token]);
    await assert.rejects(f.bind(image.token), /过期/); await f.read(image.token);
  });
  test(`${mode}: signatures and ownership remain enforced; all reference fields bind`, async t => {
    const f = await fixture(t, mode), image = await f.upload();
    for (const field of ['reference_images', 'reference_image', 'frame_start', 'frame_end']) {
      const value = field === 'reference_images' ? [image.url, { url: image.url }] : image.url;
      assert.deepEqual(f.service.ownedTokens({ [field]: value, params: { [field]: value } }, 'user-one'), [image.token]);
      assert.throws(() => f.service.ownedTokens({ [field]: value }, 'user-two'), /不属于/);
    }
    await assert.rejects(f.service.open(image.token + 'x'), /签名/);
    await assert.rejects(f.db.transaction(c => f.service.bindToTask(c, [image.token], randomUUID(), 'user-two')), /不属于/);
    await assert.rejects(f.service.open(image.token.split('.')[0]), /令牌/);
  });
  test(`${mode}: missing file rejects binding; deletion claim blocks rebinding`, async t => {
    const f = await fixture(t, mode), image = await f.upload();
    await f.db.execute("UPDATE temporary_reference_images SET state = 'DELETING' WHERE nonce = ?", [image.nonce]);
    await assert.rejects(f.bind(image.token), /已清理/);
    const missing = await f.upload(); await unlink(join(f.root, `${missing.nonce}.image`));
    await assert.rejects(f.bind(missing.token), /不存在/);
  });
  test(`${mode}: DB failure never falls back to deleting active images by age`, async t => {
    const f = await fixture(t, mode), image = await f.upload(); await f.bind(image.token); f.advance(4 * hour);
    const original = f.db.query; f.db.query = async () => { throw new Error('database unavailable'); };
    await assert.rejects(f.service.cleanup(), /database unavailable/); assert.equal((await readdir(f.root)).length, 1);
    await f.restart(); // Startup must leave non-reference APIs available.
    f.db.query = original; await f.read(image.token);
  });
  test(`${mode}: legacy uploads are adopted without changing their URLs`, async t => {
    const f = await fixture(t, mode), image = await f.upload();
    const payload = f.service.verify(image.token); delete payload.v;
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url'), token = `${encoded}.${f.service.signature(encoded)}`;
    await rename(join(f.root, `${image.nonce}.image`), join(f.root, `${image.nonce}.pending`));
    await f.db.execute("UPDATE temporary_reference_images SET state = 'DELETING' WHERE nonce = ?", [image.nonce]);
    await f.db.execute("DELETE FROM temporary_reference_images WHERE nonce = ? AND state = 'DELETING'", [image.nonce]);
    await f.bind(token); f.advance(5 * hour); await f.restart(); await f.read(token);
  });
  test(`${mode}: orphan files are swept and spoofed image content is rejected`, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(f.service.upload('user', { buffer: Buffer.from('<svg/>'), size: 6, mimetype: 'image/png' }, 'https://api.example.test'), /PNG、JPEG 或 WebP/);
    const image = await f.upload();
    await f.db.execute("UPDATE temporary_reference_images SET state = 'DELETING' WHERE nonce = ?", [image.nonce]);
    await f.db.execute("DELETE FROM temporary_reference_images WHERE nonce = ? AND state = 'DELETING'", [image.nonce]);
    const old = new Date(f.now() - 2 * hour); await utimes(join(f.root, `${image.nonce}.image`), old, old);
    await f.service.cleanup(); assert.deepEqual(await readdir(f.root), []);
  });
  test(`${mode}: public readiness accepts only an externally reachable HTTPS image`, async t => {
    const f = await fixture(t, mode), image = await f.upload();
    const calls = [];
    t.mock.method(globalThis, 'fetch', async url => {
      calls.push(String(url));
      const response = new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      Object.defineProperty(response, 'url', { value: String(url) });
      return response;
    });
    await f.service.assertPubliclyReachable({ reference_images: [{ url: image.url }] }, 'user-one');
    assert.deepEqual(calls, [image.url]);
  });
  test(`${mode}: public readiness rejects localhost before any network request`, async t => {
    const f = await fixture(t, mode);
    const uploaded = await f.service.upload('user-one', { buffer: png, size: png.length, mimetype: 'image/png', originalname: 'one.png' }, 'http://127.0.0.1:3101');
    const network = t.mock.fn(async () => assert.fail('localhost must be rejected before fetch'));
    t.mock.method(globalThis, 'fetch', network);
    await assert.rejects(f.service.assertPubliclyReachable({ reference_images: [{ url: uploaded.url }] }, 'user-one'), /公网 HTTPS|本机或内网/);
    assert.equal(network.mock.callCount(), 0);
  });
}
