const assert = require("node:assert/strict");
const test = require("node:test");
const { BadRequestException, ConflictException } = require("@nestjs/common");
const { compareDesktopVersions, parseDesktopVersion, DesktopReleaseService } = require("../dist/common/desktop-release.service.js");
require("reflect-metadata");
const { AdminController } = require("../dist/admin/admin.controller.js");
const { AdminAuthGuard } = require("../dist/auth/admin-auth.guard.js");
const { PermissionsGuard } = require("../dist/auth/permissions.guard.js");
const { REQUIRED_PERMISSIONS } = require("../dist/auth/permissions.decorator.js");

test("desktop release versions follow SemVer precedence", () => {
  assert.ok(parseDesktopVersion("1.2.3"));
  assert.ok(parseDesktopVersion("1.2.3-beta.2"));
  assert.equal(parseDesktopVersion("1.2"), null);
  assert.equal(parseDesktopVersion("1.2.3-beta.01"), null);
  assert.equal(compareDesktopVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareDesktopVersions("1.2.3-beta.2", "1.2.3-beta.10"), -1);
  assert.equal(compareDesktopVersions("1.2.3", "1.2.3-rc.1"), 1);
  assert.throws(() => compareDesktopVersions("latest", "1.0.0"), BadRequestException);
});

test("update selection returns the latest compatible signed artifact and mandatory flag", async () => {
  const releases = [
    { id: "r1", version: "1.1.0", channel: "stable", status: "PUBLISHED", notes: "one", min_supported_version: "0.9.0", rollout_percent: 100, published_at: "2026-01-01" },
    { id: "r2", version: "1.2.0", channel: "stable", status: "PUBLISHED", notes: "two", backup_download_url: "https://pan.example.com/s/r2?pwd=code#download", min_supported_version: "1.0.0", rollout_percent: 100, published_at: "2026-02-01" },
  ];
  const database = {
    async query(sql, args) {
      if (sql.includes("FROM desktop_releases")) return releases;
      if (sql.includes("FROM desktop_release_artifacts") && args[0] === "r2") return [{ id: "a2", release_id: "r2", target: "windows", arch: "x86_64", url: "https://cdn.example/r2.zip", signature: "signed-r2" }];
      return [];
    },
  };
  const service = new DesktopReleaseService(database, { record: async () => {} });
  const selected = await service.selectUpdate({ currentVersion: "0.8.0", channel: "stable", target: "windows", arch: "x86_64", cohort: "device-1" });
  assert.deepEqual(selected, {
    version: "1.2.0", notes: "two", pub_date: "2026-02-01", url: "https://cdn.example/r2.zip", signature: "signed-r2",
    backup_download_url: "https://pan.example.com/s/r2?pwd=code#download", mandatory: true, min_supported_version: "1.0.0", rollout_percent: 100,
  });
});

function releaseFixture(status = "DRAFT", backupUrl = "https://pan.example.com/s/old#code") {
  const release = { id: "r1", version: "2.0.0", channel: "stable", status, notes: "notes", backup_download_url: backupUrl, min_supported_version: "0.0.0", rollout_percent: 100, published_at: "2026-01-01" };
  const artifact = { id: "a1", release_id: "r1", target: "windows", arch: "x86_64", url: "https://cdn.example/r1.zip", signature: "signed" };
  const writes = [], audits = [];
  const execute = async (sql, args) => {
    writes.push({ sql, args });
    if (sql.includes("INSERT INTO desktop_releases")) {
      assert.match(sql, /notes, backup_download_url, min_supported_version/);
      Object.assign(release, { id: args[0], version: args[1], channel: args[2], notes: args[3], backup_download_url: args[4], min_supported_version: args[5], rollout_percent: args[6], status: "DRAFT" });
    } else if (sql.includes("SET version =")) {
      assert.match(sql, /notes = \?, backup_download_url = \?, min_supported_version/);
      Object.assign(release, { version: args[0], channel: args[1], notes: args[2], backup_download_url: args[3], min_supported_version: args[4], rollout_percent: args[5] });
    } else if (sql.includes("SET backup_download_url =")) release.backup_download_url = args[0];
    return { affectedRows: 1 };
  };
  const database = {
    query: async sql => sql.includes("FROM desktop_releases") ? [{ ...release }] : [{ ...artifact }],
    execute,
    transaction: async callback => callback({ execute }),
  };
  return { release, artifact, writes, audits, service: new DesktopReleaseService(database, { record: async value => audits.push(value) }) };
}

const draftInput = { version: "2.0.0", channel: "stable", notes: "edited", minSupportedVersion: "0.0.0", rolloutPercent: 100, artifacts: [] };

test("new drafts store optional backup links and legacy requests default to an empty link", async () => {
  const fixture = releaseFixture();
  const created = await fixture.service.create("admin", draftInput);
  assert.equal(created.backup_download_url, "");
  assert.equal(fixture.writes[0].args[4], "");
  const share = "https://pan.example.com/s/new?pwd=a%2Bb#access-code";
  const withLink = await fixture.service.create("admin", { ...draftInput, backupDownloadUrl: ` ${share} ` });
  assert.equal(withLink.backup_download_url, share);
  assert.equal((await fixture.service.list())[0].backup_download_url, share);
});

test("legacy draft editing preserves the backup link while explicit input can replace or clear it", async () => {
  const fixture = releaseFixture();
  const original = fixture.release.backup_download_url;
  assert.equal((await fixture.service.update("admin", "r1", draftInput)).backup_download_url, original);
  const replaced = "http://downloads.example.com/client?source=share#installer";
  assert.equal((await fixture.service.update("admin", "r1", { ...draftInput, backupDownloadUrl: replaced })).backup_download_url, replaced);
  assert.equal((await fixture.service.update("admin", "r1", { ...draftInput, backupDownloadUrl: "" })).backup_download_url, "");
});

test("backup links can be changed and cleared in every release state with before and after audit", async () => {
  for (const status of ["DRAFT", "PUBLISHED", "ARCHIVED"]) {
    const fixture = releaseFixture(status);
    const originalArtifact = { ...fixture.artifact };
    const originalBackup = fixture.release.backup_download_url;
    const share = "https://pan.example.com/s/next?pwd=1234#code";
    const updated = await fixture.service.updateBackupDownloadUrl("admin", "r1", share);
    assert.equal(updated.status, status);
    assert.equal(updated.backup_download_url, share);
    assert.deepEqual(fixture.artifact, originalArtifact);
    assert.deepEqual(fixture.audits[0], { adminUserId: "admin", action: "desktop_release.backup_download_url", entityType: "desktop_release", entityId: "r1", details: { version: "2.0.0", channel: "stable", before: originalBackup, after: share } });
    assert.deepEqual(fixture.writes[0].args, [share, "r1"]);
    assert.equal((await fixture.service.updateBackupDownloadUrl("admin", "r1", "")).backup_download_url, "");
    assert.equal(fixture.audits[1].details.before, share);
    assert.equal(fixture.audits[1].details.after, "");
    if (status === "PUBLISHED") {
      const selected = await fixture.service.selectUpdate({ currentVersion: "1.0.0", channel: "stable", target: "windows", arch: "x86_64", cohort: "device" });
      assert.equal(selected.backup_download_url, "");
      assert.equal(selected.url, originalArtifact.url);
      assert.equal(selected.signature, originalArtifact.signature);
      assert.equal(selected.rollout_percent, 100);
    }
  }
});

test("invalid backup links fail before writes without touching the signed update artifact", async () => {
  const fixture = releaseFixture("PUBLISHED");
  for (const value of [undefined, null, 123, {}, "/client.exe", "//pan.example.com/share", "https:pan.example.com/share", "javascript:alert(1)", "data:text/html,test", "file:///client.exe", "ftp://example.com/client.exe", "https://user:secret@pan.example.com/s/x", "https://pan.example.com/a\\b", "https://pan.example.com/s/\u0000x", "https://pan.example.com/s/\nx", `https://pan.example.com/${"x".repeat(2000)}`]) {
    await assert.rejects(() => fixture.service.updateBackupDownloadUrl("admin", "r1", value), BadRequestException);
  }
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.audits.length, 0);
  assert.equal(fixture.artifact.signature, "signed");
});

test("a backup link alone does not produce an update without a matching signed artifact", async () => {
  const release = { id: "r1", version: "2.0.0", channel: "stable", status: "PUBLISHED", notes: "", backup_download_url: "https://pan.example.com/s/client", min_supported_version: "0.0.0", rollout_percent: 100, published_at: "2026-01-01" };
  const service = new DesktopReleaseService({ query: async sql => sql.includes("FROM desktop_releases") ? [release] : [] }, { record: async () => {} });
  assert.equal(await service.selectUpdate({ currentVersion: "1.0.0", channel: "stable", target: "windows", arch: "x86_64", cohort: "device" }), null);
});

test("admin release endpoints map snake case and preserve omitted backup fields", async () => {
  const fixture = releaseFixture();
  const controller = new AdminController(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, fixture.service);
  const request = { admin: { sub: "admin" } };
  const body = { version: "2.0.0", artifacts: [] };
  const share = "https://pan.example.com/s/created#pwd";
  assert.equal((await controller.createDesktopRelease(request, { ...body, backup_download_url: share })).backup_download_url, share);
  assert.equal((await controller.updateDesktopRelease(request, "r1", body)).backup_download_url, share);
  assert.equal((await controller.updateDesktopRelease(request, "r1", { ...body, backup_download_url: "" })).backup_download_url, "");
  for (const value of [null, 123, {}]) assert.throws(() => controller.createDesktopRelease(request, { ...body, backup_download_url: value }), BadRequestException);
  fixture.release.status = "ARCHIVED";
  const historyLink = "https://pan.example.com/s/history?pwd=code";
  assert.equal((await controller.updateDesktopReleaseBackupDownloadUrl(request, "r1", { backup_download_url: historyLink })).backup_download_url, historyLink);
  await assert.rejects(() => controller.updateDesktopReleaseBackupDownloadUrl(request, "r1", {}), BadRequestException);
  assert.equal((await controller.updateDesktopReleaseBackupDownloadUrl(request, "r1", { backup_download_url: "" })).backup_download_url, "");
  const guards = Reflect.getMetadata("__guards__", AdminController);
  assert.ok(guards.includes(AdminAuthGuard));
  assert.ok(guards.includes(PermissionsGuard));
  for (const name of ["createDesktopRelease", "updateDesktopRelease", "updateDesktopReleaseBackupDownloadUrl"]) {
    assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, AdminController.prototype[name]), ["releases.manage"]);
  }
  assert.equal(Reflect.getMetadata("path", AdminController.prototype.updateDesktopReleaseBackupDownloadUrl), "desktop-releases/:releaseId/backup-download-url");
});

test("partial rollout is deterministic and requires a cohort id", async () => {
  const database = {
    async query(sql) {
      if (sql.includes("FROM desktop_releases")) return [{ id: "r1", version: "2.0.0", channel: "stable", status: "PUBLISHED", notes: "", min_supported_version: "0.0.0", rollout_percent: 10, published_at: "2026-01-01" }];
      return [{ id: "a1", release_id: "r1", target: "windows", arch: "x86_64", url: "https://cdn.example/r1.zip", signature: "sig" }];
    },
  };
  const service = new DesktopReleaseService(database, { record: async () => {} });
  assert.equal(await service.selectUpdate({ currentVersion: "1.0.0", channel: "stable", target: "windows", arch: "x86_64", cohort: "" }), null);
  const first = await service.selectUpdate({ currentVersion: "1.0.0", channel: "stable", target: "windows", arch: "x86_64", cohort: "same-device" });
  const second = await service.selectUpdate({ currentVersion: "1.0.0", channel: "stable", target: "windows", arch: "x86_64", cohort: "same-device" });
  assert.deepEqual(first, second);
});

test("published release notes remain editable and feed the updater manifest", async () => {
  const release = { id: "r1", version: "2.0.0", channel: "stable", status: "PUBLISHED", notes: "old", min_supported_version: "0.0.0", rollout_percent: 100, published_at: "2026-01-01" };
  const writes = [], audits = [];
  const database = {
    async query(sql) {
      if (sql.includes("FROM desktop_releases")) return [release];
      if (sql.includes("FROM desktop_release_artifacts")) return [{ id: "a1", release_id: "r1", target: "windows", arch: "x86_64", url: "https://cdn.example/r1.zip", signature: "sig" }];
      return [];
    },
    async execute(sql, args) { writes.push({ sql, args }); release.notes = args[0]; return { affectedRows: 1 }; },
  };
  const service = new DesktopReleaseService(database, { record: async value => audits.push(value) });
  await service.updateNotes("admin", "r1", "\n后台修改后的更新内容\n");
  const selected = await service.selectUpdate({ currentVersion: "1.0.0", channel: "stable", target: "windows", arch: "x86_64", cohort: "device" });
  assert.equal(selected.notes, "后台修改后的更新内容");
  assert.match(writes[0].sql, /SET notes/);
  assert.equal(audits[0].action, "desktop_release.notes");
});

test("a published version can replace its signed artifact without changing its version", async () => {
  const release = { id: "r1", version: "0.1.0", channel: "stable", status: "PUBLISHED", notes: "", min_supported_version: "0.0.0", rollout_percent: 100, published_at: "2026-01-01" };
  const artifact = { id: "a1", release_id: "r1", target: "windows", arch: "x86_64", url: "https://cdn.example/client/old.exe", signature: "old-signature" };
  const audits = [];
  const database = {
    async query(sql) {
      if (sql.includes("FROM desktop_releases")) return [release];
      if (sql.includes("FROM desktop_release_artifacts")) return [artifact];
      return [];
    },
    async execute(sql, args) {
      assert.match(sql, /UPDATE desktop_release_artifacts/);
      artifact.url = args[0];
      artifact.signature = args[1];
      return { affectedRows: 1 };
    },
  };
  const service = new DesktopReleaseService(database, { record: async value => audits.push(value) });
  const replaced = await service.replacePublishedArtifact("admin", "r1", {
    target: "windows", arch: "x86_64", url: "https://cdn.example/client/new.exe", signature: "new-signature",
  });
  assert.equal(replaced.version, "0.1.0");
  assert.equal(replaced.artifacts[0].url, "https://cdn.example/client/new.exe");
  assert.equal(audits[0].action, "desktop_release.artifact_replace");
  assert.equal(await service.selectUpdate({ currentVersion: "0.1.0", channel: "stable", target: "windows", arch: "x86_64", cohort: "device" }), null);
  release.status = "ARCHIVED";
  await assert.rejects(() => service.replacePublishedArtifact("admin", "r1", {
    target: "windows", arch: "x86_64", url: "https://cdn.example/client/next.exe", signature: "next-signature",
  }), ConflictException);
});
