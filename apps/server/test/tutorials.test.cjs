const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
require("reflect-metadata");

const { Module, UnauthorizedException } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { TutorialsService } = require("../dist/tutorials/tutorials.service");
const { TutorialMediaService, parseTutorialRange } = require("../dist/tutorials/tutorial-media.service");
const { TutorialsController, TutorialsAdminController } = require("../dist/tutorials/tutorials.controller");
const { AdminAuthGuard } = require("../dist/auth/admin-auth.guard");
const { AdminAuthService } = require("../dist/auth/admin-auth.service");
const { PermissionsGuard } = require("../dist/auth/permissions.guard");
const { tutorialInput, tutorialPage, normalizeBilibiliVideo, resolveBilibiliVideo } = require("../dist/tutorials/tutorials.validation");

const iframe = '<iframe src="//player.bilibili.com/player.html?isOutside=true&aid=117268612713689&bvid=BV1P1Yk6EEX9&cid=41885697238&p=1" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>';
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5x0AAAAASUVORK5CYII=", "base64");

test("tutorial content preserves rich images/tables and strips executable markup and unsafe styles", () => {
  const input = tutorialInput({ title: " 教程 ", content: '<h2 style="text-align:center;color:#123456;position:fixed;background-image:url(javascript:alert(1))" onclick="alert(1)">正文</h2><table><tbody><tr><td colspan="2">表格</td></tr></tbody></table><img src="/api/v1/tutorials/media/11111111-1111-1111-1111-111111111111"><script>alert(1)</script><iframe src="https://example.com"></iframe><img src="javascript:alert(1)"><a href="javascript:alert(1)">危险链接</a>' });
  assert.equal(input.title, "教程");
  assert.match(input.content, /text-align:center/);
  assert.match(input.content, /table/);
  assert.match(input.content, /img[^>]+loading="lazy"/);
  assert.doesNotMatch(input.content, /script|iframe|onclick|javascript|position|background-image/);
  assert.throws(() => tutorialInput({ title: "空教程", content: "<p>&nbsp;</p><script>foo</script>" }), /至少需要/);
  assert.throws(() => tutorialInput({ title: "", content: "正文" }), /标题/);
  assert.throws(() => tutorialInput({ title: "教程", content: "正文", sort_order: -1 }), /排序/);
});

test("Bilibili share iframe and standard video links become a safe HTTPS player URL", () => {
  const url = new URL(normalizeBilibiliVideo(iframe));
  assert.equal(url.origin, "https://player.bilibili.com");
  assert.equal(url.pathname, "/player.html");
  assert.equal(url.searchParams.get("bvid"), "BV1P1Yk6EEX9");
  assert.equal(url.searchParams.get("cid"), "41885697238");
  assert.equal(url.searchParams.get("autoplay"), "0");
  assert.match(normalizeBilibiliVideo("https://www.bilibili.com/video/BV1P1Yk6EEX9/?p=2&share_source=copy_web"), /p=2/);
  assert.match(normalizeBilibiliVideo("https://www.bilibili.com/video/av123"), /aid=123/);
  for (const unsafe of [
    '<iframe src="https://example.com/video"></iframe>',
    '<iframe src="https://player.bilibili.com/player.html?bvid=BV1P1Yk6EEX9" onload="alert(1)"></iframe>',
    `${iframe}<script>alert(1)</script>`,
    "https://player.bilibili.com.evil.example/player.html?bvid=BV1P1Yk6EEX9",
    "https://evil.example@player.bilibili.com/player.html?bvid=BV1P1Yk6EEX9",
    "https://player.bilibili.com:8443/player.html?bvid=BV1P1Yk6EEX9",
    "javascript:alert(1)",
  ]) assert.throws(() => normalizeBilibiliVideo(unsafe));
  assert.equal(tutorialInput({ title: "纯视频", video_type: "BILIBILI", video_url: iframe }).content, "");
});

test("B23 redirects are anonymous, bounded and checked before any next request", async () => {
  const calls = [];
  const result = await resolveBilibiliVideo("https://b23.tv/abcd", async (url, options) => {
    calls.push({ url: url.toString(), options });
    return new Response(null, { status: 302, headers: { location: "https://www.bilibili.com/video/BV1P1Yk6EEX9?p=2" } });
  });
  assert.match(result, /player\.bilibili\.com/);
  assert.match(result, /p=2/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  let unsafeCalls = 0;
  await assert.rejects(resolveBilibiliVideo("https://b23.tv/abcd", async () => {
    unsafeCalls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  }), /不受支持/);
  assert.equal(unsafeCalls, 1);
  let loops = 0;
  await assert.rejects(resolveBilibiliVideo("https://b23.tv/abcd", async () => {
    loops++; return new Response(null, { status: 302, headers: { location: "https://b23.tv/abcd" } });
  }), /次数过多/);
  assert.equal(loops, 3);
  await assert.rejects(resolveBilibiliVideo("https://b23.tv/abcd", async () => { throw new Error("timeout"); }), /解析失败/);
});

test("tutorial list is published-only, contains summaries, and paginates at ten; admin search is parameterized", async () => {
  const calls = [];
  const service = new TutorialsService({ query: async (sql, parameters) => { calls.push({ sql, parameters }); return /COUNT/.test(sql) ? [{ total: 23 }] : [{ id: "A1", title: "教程" }]; } }, { record: async () => undefined });
  const result = await service.publicList(2);
  assert.equal(result.page_size, 10);
  assert.equal(result.page_count, 3);
  assert.equal(result.page, 2);
  assert.equal(result.total, 23);
  assert.match(calls[0].sql, /status='PUBLISHED'/);
  assert.match(calls[1].sql, /LIMIT 10 OFFSET \?/);
  assert.equal(calls[1].parameters[0], 10);
  assert.doesNotMatch(calls[1].sql.split("FROM")[0], /content|created_by|updated_by/);
  calls.length = 0;
  await service.adminList(1, "' OR 1=1");
  assert.equal(calls[0].parameters[0], "%' OR 1=1%");
  assert.doesNotMatch(calls[0].sql, /OR 1=1/);
  assert.equal(tutorialPage(undefined), 1);
  for (const invalid of ["0", "-1", "1.5", ["1"], "1 OR 1=1"]) assert.throws(() => tutorialPage(invalid));
});

test("create and partial update sanitize, preserve fields, publish/unpublish and audit; unpublished detail is unavailable", async () => {
  const executions = [], audits = [];
  const prior = { id: "A1", title: "旧标题", content: "<p>正文</p>", video_type: "NONE", video_url: null, status: "PUBLISHED", sort_order: 3, published_at: "2026-10-02", created_at: "2026-10-01", updated_at: "2026-10-02" };
  const database = { execute: async (sql, parameters) => { executions.push({ sql, parameters }); return { affectedRows: 1 }; }, query: async sql => sql.includes("AND status='PUBLISHED'") ? [] : [prior] };
  const service = new TutorialsService(database, { record: async input => audits.push(input) });
  await service.create("ADMIN", { title: "新教程", content: '<p onclick="bad()">内容</p>', status: "PUBLISHED" });
  assert.match(executions[0].sql, /UTC_TIMESTAMP/);
  assert.equal(executions[0].parameters[2], "<p>内容</p>");
  await service.update("ADMIN", "A1", { title: "改标题", status: "DRAFT" });
  assert.equal(executions[1].parameters[1], prior.content);
  assert.equal(executions[1].parameters[4], 3);
  assert.equal(executions[1].parameters[6], "DRAFT");
  assert.match(executions[1].sql, /COALESCE\(published_at,UTC_TIMESTAMP/);
  await service.delete("ADMIN", "A1");
  assert.deepEqual(audits.map(a => a.action), ["tutorial.create", "tutorial.update", "tutorial.delete"]);
  await assert.rejects(service.publicGet("A1"), /尚未发布/);
  await assert.rejects(service.create("ADMIN", { title: "坏视频", video_type: "UPLOAD", video_url: `/api/v1/tutorials/media/${randomUUID()}` }), /视频不存在/);
});

test("single byte ranges support seeking, suffix and clamping and reject multiple/out-of-bounds ranges", () => {
  assert.equal(parseTutorialRange(undefined, 100), null);
  assert.deepEqual(parseTutorialRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseTutorialRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseTutorialRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseTutorialRange("bytes=0-999", 100), { start: 0, end: 99 });
  for (const value of ["bytes=100-", "bytes=20-10", "bytes=-0", "bytes=0-1,4-5", "bytes=-", "items=1-2", "bytes=9007199254740993-"]) assert.equal(parseTutorialRange(value, 100), "UNSATISFIABLE");
});

test("disk upload validates actual content/extension/length/limits and removes invalid or failed files", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aivs-tutorial-upload-"));
  const previous = process.env.TUTORIAL_MEDIA_DIRECTORY;
  process.env.TUTORIAL_MEDIA_DIRECTORY = root;
  t.after(async () => { if (previous === undefined) delete process.env.TUTORIAL_MEDIA_DIRECTORY; else process.env.TUTORIAL_MEDIA_DIRECTORY = previous; await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, ".incoming"));
  const makeFile = async (contents, originalname, mimetype, size = contents.length) => {
    const filename = `${randomUUID()}.upload`, target = path.join(root, ".incoming", filename);
    await fs.writeFile(target, contents);
    return { filename, path: target, originalname, mimetype, size };
  };
  let insert;
  const service = new TutorialMediaService({ execute: async (sql, parameters) => { insert = { sql, parameters }; return { affectedRows: 1 }; } }, { record: async () => undefined });
  const good = await makeFile(png, "../教程.png", "image/png");
  const uploaded = await service.upload("ADMIN", good);
  assert.equal(uploaded.media_type, "IMAGE");
  assert.equal(uploaded.original_name, "教程.png");
  assert.equal(uploaded.url, `/api/v1/tutorials/media/${uploaded.id}`);
  assert.equal(insert.parameters[6], "ADMIN");
  assert.equal((await fs.readFile(path.join(root, insert.parameters[1]))).length, png.length);
  for (const file of [
    await makeFile(Buffer.from('<svg onload="evil()"/>'), "test.svg", "image/svg+xml"),
    await makeFile(png, "test.mp4", "video/mp4"),
    await makeFile(png, "test.png", "image/png", png.length + 1),
    await makeFile(png, "test.png", "text/html"),
  ]) { await assert.rejects(service.upload("ADMIN", file)); await assert.rejects(fs.stat(file.path), { code: "ENOENT" }); }
  const large = await makeFile(png, "large.png", "image/png");
  await fs.truncate(large.path, 10 * 1024 * 1024 + 1); large.size = 10 * 1024 * 1024 + 1;
  await assert.rejects(service.upload("ADMIN", large), /不能超过 10MB/);
  await assert.rejects(fs.stat(large.path), { code: "ENOENT" });
  const before = await fs.readdir(root);
  const failingService = new TutorialMediaService({ execute: async () => { throw new Error("database unavailable"); } }, { record: async () => undefined });
  const failed = await makeFile(png, "failed.png", "image/png");
  await assert.rejects(failingService.upload("ADMIN", failed), /database unavailable/);
  assert.deepEqual(await fs.readdir(root), before);
  assert.deepEqual(await fs.readdir(path.join(root, ".incoming")), []);
  await assert.rejects(service.upload("ADMIN", { ...good, path: path.join(root, "..", "other") }), /路径无效/);
});

test("HTTP media upload requires permission and public media supports full, partial, suffix, HEAD and 416 responses", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aivs-tutorial-http-"));
  const previous = process.env.TUTORIAL_MEDIA_DIRECTORY;
  process.env.TUTORIAL_MEDIA_DIRECTORY = root;
  const mediaRows = new Map();
  const database = {
    execute: async (_sql, p) => { mediaRows.set(p[0], { id: p[0], storage_name: p[1], mime_type: p[2], media_type: p[3], original_name: p[4], byte_size: p[5] }); return { affectedRows: 1 }; },
    query: async (_sql, p) => mediaRows.has(p[0]) ? [mediaRows.get(p[0])] : [],
  };
  const media = new TutorialMediaService(database, { record: async () => undefined });
  class TestModule {}
  Module({
    controllers: [TutorialsController, TutorialsAdminController],
    providers: [
      { provide: TutorialsService, useValue: { publicList: async () => ({ items: [], page: 1, page_size: 10, total: 0, page_count: 0 }), publicGet: async () => { throw new Error("media route reached tutorial details"); } } },
      { provide: TutorialMediaService, useValue: media }, AdminAuthGuard, PermissionsGuard,
      { provide: AdminAuthService, useValue: { verify: token => {
        if (!["MANAGE", "NO_PERMISSION"].includes(token)) throw new UnauthorizedException();
        return { sub: "ADMIN", roles: [], permissions: token === "MANAGE" ? ["tutorials.manage"] : [], mustChangePassword: false };
      } } },
    ],
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  t.after(async () => { await app.close(); if (previous === undefined) delete process.env.TUTORIAL_MEDIA_DIRECTORY; else process.env.TUTORIAL_MEDIA_DIRECTORY = previous; await fs.rm(root, { recursive: true, force: true }); });
  const base = await app.getUrl();
  const video = Buffer.alloc(100); video.writeUInt32BE(24, 0); video.write("ftypisom", 4); video.write("isommp42", 16);
  const upload = async token => {
    const form = new FormData(); form.append("file", new Blob([video], { type: "video/mp4" }), "教程.mp4");
    return fetch(`${base}/api/v1/admin/tutorials/media`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
  };
  assert.equal((await upload()).status, 401);
  assert.equal((await upload("NO_PERMISSION")).status, 403);
  const uploadResponse = await upload("MANAGE");
  assert.equal(uploadResponse.status, 201);
  const asset = await uploadResponse.json();
  assert.equal(asset.media_type, "VIDEO");
  assert.equal(asset.size, 100);
  const full = await fetch(`${base}${asset.url}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), video);
  const partial = await fetch(`${base}${asset.url}`, { headers: { Range: "bytes=5-15" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 5-15/100");
  assert.equal(partial.headers.get("content-length"), "11");
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), video.subarray(5, 16));
  const suffix = await fetch(`${base}${asset.url}`, { headers: { Range: "bytes=-10" } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), video.subarray(90));
  const head = await fetch(`${base}${asset.url}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "100");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const invalid = await fetch(`${base}${asset.url}`, { headers: { Range: "bytes=100-" } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */100");
  assert.equal((await invalid.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(`${base}/api/v1/tutorials/media/${randomUUID()}`)).status, 404);
  assert.deepEqual(await fs.readdir(path.join(root, ".incoming")), []);
});
