const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
require("reflect-metadata");
const { TemporaryReferenceImageService } = require("../dist/common/temporary-reference-image.service");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=", "base64");

test("temporary reference images use signed owner-scoped URLs and remain readable during the consumed grace period", async () => {
  const root = await mkdtemp(join(tmpdir(), "aivs-reference-test-"));
  const service = new TemporaryReferenceImageService({ values: { referenceImageDirectory: root, credentialEncryptionKey: "test-key-with-more-than-thirty-two-characters" } });
  await service.onModuleInit();
  try {
    const uploaded = await service.upload("user-one", { buffer: png, size: png.length, mimetype: "image/png", originalname: "one.png" }, "https://api.example.test");
    assert.match(uploaded.url, /^https:\/\/api\.example\.test\/api\/v1\/temporary-reference-images\//);
    const payload = { reference_images: [{ url: uploaded.url, label: "场景", type: "scene" }] };
    const tokens = service.ownedTokens(payload, "user-one");
    assert.equal(tokens.length, 1);
    assert.throws(() => service.ownedTokens(payload, "user-two"), /不属于/);
    const before = await service.open(tokens[0]);
    assert.equal(before.mimeType, "image/png");
    before.stream.destroy();
    await service.markConsumed(tokens);
    const duringGrace = await service.open(tokens[0]);
    assert.equal(duringGrace.size, png.length);
    duringGrace.stream.destroy();
  } finally {
    service.onModuleDestroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("temporary upload validates image bytes rather than trusting the multipart content type", async () => {
  const root = await mkdtemp(join(tmpdir(), "aivs-reference-test-"));
  const service = new TemporaryReferenceImageService({ values: { referenceImageDirectory: root, credentialEncryptionKey: "test-key-with-more-than-thirty-two-characters" } });
  await service.onModuleInit();
  try {
    await assert.rejects(service.upload("user", { buffer: Buffer.from("<svg/>") , size: 6, mimetype: "image/png", originalname: "fake.png" }, "https://api.example.test"), /PNG、JPEG 或 WebP/);
    await assert.rejects(service.upload("user", { buffer: png, size: png.length, mimetype: "image/png", originalname: "one.png" }, "ftp://api.example.test"), /公网地址无效/);
  } finally {
    service.onModuleDestroy();
    await rm(root, { recursive: true, force: true });
  }
});
