const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "../components/AdminApp.tsx"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "../components/AnnouncementsPanel.tsx"), "utf8");

test("admin navigation exposes announcement management", () => {
  assert.match(app, /id: "announcements", label: "通知公告"/);
  assert.match(app, /<AnnouncementsPanel token=\{token\}/);
});

test("announcement editor supports drafts, publish lifecycle, pinning and rich media", () => {
  assert.match(panel, /保存草稿/);
  assert.match(panel, /发布公告/);
  assert.match(panel, /撤回为草稿/);
  assert.match(panel, /is_pinned/);
  assert.match(panel, /mediaType === "image"/);
  assert.match(panel, /<video[^>]+controls/);
  assert.match(panel, /clipboardData\.getData\("text\/plain"\)/);
});
