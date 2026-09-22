const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
require("reflect-metadata");

const { AnnouncementsService } = require("../dist/announcements/announcements.service");

test("announcement creation sanitizes rich content and starts as draft", async () => {
  let insert;
  const database = {
    execute: async (sql, parameters) => { insert = { sql, parameters }; return { affectedRows: 1 }; },
    query: async () => [{ id: "A1", title: "公告", content: "safe", status: "DRAFT", is_pinned: 1 }],
  };
  const audit = { record: async () => undefined };
  const service = new AnnouncementsService(database, audit);
  const result = await service.create("ADMIN", {
    title: "公告",
    content: '<p onclick="alert(1)">正文</p><script>alert(1)</script><img src="javascript:alert(1)"><video src="https://cdn.example.com/a.mp4" autoplay></video>',
    isPinned: true,
  });
  assert.equal(result.status, "DRAFT");
  assert.match(insert.sql, /'DRAFT'/);
  assert.doesNotMatch(insert.parameters[2], /script|onclick|javascript:|autoplay/i);
  assert.match(insert.parameters[2], /video[^>]+controls/);
});

test("public announcement feed is published-only, pinned-first and capped at 100", async () => {
  let query;
  const database = { query: async (sql) => { query = sql; return []; } };
  const service = new AnnouncementsService(database, { record: async () => undefined });
  await service.publicList();
  assert.match(query, /status='PUBLISHED'/);
  assert.match(query, /ORDER BY is_pinned DESC,published_at DESC/);
  assert.match(query, /LIMIT 100/);
});

test("announcement migration and routes cover pinning, publishing and admin permission", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../src/database/migrations/062_announcements_management.sql"), "utf8");
  const controller = fs.readFileSync(path.join(__dirname, "../src/announcements/announcements.controller.ts"), "utf8");
  assert.match(migration, /is_pinned/);
  assert.match(migration, /announcements\.manage/);
  assert.match(controller, /@Controller\("announcements"\)/);
  assert.match(controller, /:announcementId\/publish/);
  assert.match(controller, /:announcementId\/unpublish/);
  assert.match(controller, /@Delete\(":announcementId"\)/);
});
