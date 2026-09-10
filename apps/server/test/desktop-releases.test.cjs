const assert = require("node:assert/strict");
const test = require("node:test");
const { BadRequestException } = require("@nestjs/common");
const { compareDesktopVersions, parseDesktopVersion, DesktopReleaseService } = require("../dist/common/desktop-release.service.js");

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
    { id: "r2", version: "1.2.0", channel: "stable", status: "PUBLISHED", notes: "two", min_supported_version: "1.0.0", rollout_percent: 100, published_at: "2026-02-01" },
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
  assert.equal(selected.version, "1.2.0");
  assert.equal(selected.signature, "signed-r2");
  assert.equal(selected.mandatory, true);
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
