const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
require("reflect-metadata");
const { Module, UnauthorizedException } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { ViralRemakesService } = require("../dist/viral-remakes/viral-remakes.service");
const { ViralRemakesController, ViralRemakesAdminController } = require("../dist/viral-remakes/viral-remakes.controller");
const { categoryInput, templateInput, viralRemakeFilters, viralRemakeMediaId } = require("../dist/viral-remakes/viral-remakes.validation");
const { TutorialMediaService } = require("../dist/tutorials/tutorial-media.service");
const { TutorialsController, TutorialsService } = { ...require("../dist/tutorials/tutorials.controller"), ...require("../dist/tutorials/tutorials.service") };
const { AdminAuthGuard } = require("../dist/auth/admin-auth.guard");
const { AdminAuthService } = require("../dist/auth/admin-auth.service");
const { PermissionsGuard } = require("../dist/auth/permissions.guard");

const categoryId = "11111111-1111-4111-8111-111111111111";
const commerceCategoryId = "22222222-2222-4222-8222-222222222222";
const videoId = "33333333-3333-4333-8333-333333333333";
const imageId = "44444444-4444-4444-8444-444444444444";
const media = id => `/api/v1/tutorials/media/${id}`;
const category = (id = categoryId, type = "FANS", overrides = {}) => ({ id, type, code: "life-drama", name: "生活剧情", description: "", sort_order: 10, status: "ACTIVE", ...overrides });
const input = overrides => ({ category_id: categoryId, title: " 生活反转 ", video_url: media(videoId), script_content: "角色小明拿起杯子，朋友说出反转台词。",
  original_share_url: "https://www.bilibili.com/video/BV1P1Yk6EEX9", replacement_elements: [{ id: "hero", type: "CHARACTER", name: "小明", image_url: media(imageId) }, { id: "cup", type: "PROP", name: "杯子", description: "手中道具" }], ...overrides });

function databaseFixture() {
  const categories = new Map([[categoryId, category()], [commerceCategoryId, category(commerceCategoryId, "COMMERCE", { code: "home", name: "家居日用" })]]);
  const templates = new Map();
  const assets = new Map([[videoId, { id: videoId, media_type: "VIDEO", mime_type: "video/mp4" }], [imageId, { id: imageId, media_type: "IMAGE", mime_type: "image/png" }]]);
  const queries = [], writes = [], audits = [], locks = [];
  const joined = id => {
    const row = templates.get(id); if (!row) return undefined;
    const cat = categories.get(row.category_id); if (!cat) return undefined;
    return { ...row, type: cat.type, category_name: cat.name };
  };
  const query = async (sql, p = []) => {
    queries.push({ sql, p });
    if (sql.includes("tutorial_media")) return p.map(id => assets.get(id)).filter(Boolean);
    if (sql.includes("viral_remake_categories") && !sql.includes("INNER JOIN") && !sql.includes("template_count")) {
      if (/FOR UPDATE|LOCK IN SHARE MODE/.test(sql)) locks.push(sql);
      return categories.has(p[0]) ? [{ ...categories.get(p[0]) }] : [];
    }
    if (/SELECT COUNT\(\*\) total FROM viral_remake_templates WHERE category_id/.test(sql)) return [{ total: [...templates.values()].filter(row => row.category_id === p[0]).length }];
    if (sql.includes("template_count")) return [...categories.values()].map(row => ({ ...row, template_count: [...templates.values()].filter(t => t.category_id === row.id).length }));
    if (/WHERE t\.id=\?/.test(sql)) {
      const row = joined(p[0]);
      if (!row || (sql.includes("t.status='ACTIVE'") && (row.status !== "ACTIVE" || categories.get(row.category_id).status !== "ACTIVE"))) return [];
      return [row];
    }
    if (/COUNT\(\*\)/.test(sql)) return [{ total: templates.size }];
    return [...templates.keys()].map(joined);
  };
  const execute = async (sql, p = []) => {
    writes.push({ sql, p });
    if (sql.startsWith("INSERT INTO viral_remake_categories")) {
      if ([...categories.values()].some(row => row.type === p[1] && (row.code === p[2] || row.name === p[3]))) throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
      categories.set(p[0], { id: p[0], type: p[1], code: p[2], name: p[3], description: p[4], sort_order: p[5], status: p[6] });
    } else if (sql.startsWith("UPDATE viral_remake_categories")) {
      categories.set(p[7], { ...categories.get(p[7]), type: p[0], code: p[1], name: p[2], description: p[3], sort_order: p[4], status: p[5] });
    } else if (sql.startsWith("DELETE FROM viral_remake_categories")) {
      if ([...templates.values()].some(row => row.category_id === p[0])) throw Object.assign(new Error("referenced"), { code: "ER_ROW_IS_REFERENCED_2" });
      return { affectedRows: categories.delete(p[0]) ? 1 : 0 };
    } else if (sql.startsWith("INSERT INTO viral_remake_templates")) {
      templates.set(p[0], { id: p[0], category_id: p[1], title: p[2], summary: p[3], video_url: p[4], original_share_url: p[5], script_content: p[6], replacement_elements_json: p[7], sort_order: p[8], status: p[9] });
    } else if (sql.startsWith("UPDATE viral_remake_templates")) {
      if (!templates.has(p[10])) return { affectedRows: 0 };
      templates.set(p[10], { ...templates.get(p[10]), category_id: p[0], title: p[1], summary: p[2], video_url: p[3], original_share_url: p[4], script_content: p[5], replacement_elements_json: p[6], sort_order: p[7], status: p[8] });
    } else if (sql.startsWith("DELETE FROM viral_remake_templates")) return { affectedRows: templates.delete(p[0]) ? 1 : 0 };
    return { affectedRows: 1 };
  };
  const database = { query, execute, transaction: async callback => callback({ query: async (...args) => [await query(...args)], execute: async (...args) => [await execute(...args)] }) };
  const service = new ViralRemakesService(database, { record: async row => audits.push(row) });
  return { database, service, categories, templates, assets, queries, writes, audits, locks };
}

test("viral remake validation handles exact types, slot identity, plain scripts, managed media and bounded filters", () => {
  assert.equal(categoryInput({ type: "FANS", code: "life-drama", name: " 生活剧情 " }).name, "生活剧情");
  const normalized = templateInput(input());
  assert.equal(normalized.title, "生活反转");
  assert.equal(normalized.replacement_elements[1].image_url, "");
  assert.equal(normalized.replacement_elements[0].id, "hero");
  assert.equal(templateInput({ title: "改名" }, normalized).script_content, normalized.script_content);
  const withGeneratedId = templateInput(input({ replacement_elements: [{ type: "PROP", name: "手表" }] }));
  assert.match(withGeneratedId.replacement_elements[0].id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(viralRemakeFilters({}), { page: 1, page_size: 10 });
  assert.deepEqual(viralRemakeFilters({ type: "COMMERCE", category: commerceCategoryId, q: " 手机 ", page: "2", page_size: "20", status: "DISABLED" }, true), { type: "COMMERCE", category: commerceCategoryId, q: "手机", status: "DISABLED", page: 2, page_size: 20 });
  for (const bad of [{ type: "BUY", code: "valid", name: "分类" }, { type: "FANS", code: "<script>", name: "分类" }, { type: "FANS", code: "valid", name: "", sort_order: 1 }]) assert.throws(() => categoryInput(bad));
  for (const overrides of [{ title: "" }, { script_content: "" }, { video_url: "https://evil.example/video.mp4" }, { video_url: `https://evil.example${media(videoId)}` }, { video_url: `${media(videoId)}?download=1` }, { category_id: "bad" }, { status: "PUBLISHED" }, { sort_order: -1 }, { original_share_url: "javascript:alert(1)" }, { original_share_url: "https://user:password@example.com/video" }, { replacement_elements: [{ id: "duplicate", type: "PROP", name: "A" }, { id: "duplicate", type: "PROP", name: "B" }] }, { replacement_elements: Array.from({ length: 21 }, (_, n) => ({ id: `slot${n}`, type: "PROP", name: "A" })) }, { replacement_elements: [{ id: "hero", type: "CHARACTER", name: "角色", image_url: "file:///C:/x.png" }] }, { replacement_elements: [{ type: "LOCATION", name: "场景" }] }]) assert.throws(() => templateInput(input(overrides)));
  for (const bad of [{ page: "0" }, { page: ["1"] }, { page_size: "51" }, { type: "FANS' OR 1=1" }, { q: ["a"] }, { status: "DISABLED" }]) assert.throws(() => viralRemakeFilters(bad));
  assert.equal(viralRemakeMediaId("", "图片", false), null);
});

test("public category/template queries enforce active parents and correct counts, numbering and parameterized search", async () => {
  const calls = [];
  const service = new ViralRemakesService({ query: async (sql, p) => {
    calls.push({ sql, p }); return /COUNT\(\*\) total/.test(sql) ? [{ total: "21" }] : sql.includes("template_count") ? [{ ...category(), template_count: "2" }] : [{ id: randomUUID(), replacement_elements_json: '[{"id":"hero","type":"CHARACTER","name":"角色","image_url":""}]' }];
  } }, { record: async () => undefined });
  const cats = await service.categories(viralRemakeFilters({ type: "FANS" }), true);
  assert.equal(cats[0].template_count, 2);
  assert.match(calls[0].sql, /c\.status='ACTIVE'/);
  assert.match(calls[0].sql, /t\.status='ACTIVE'/);
  assert.deepEqual(calls[0].p, ["FANS"]);
  const result = await service.templates(viralRemakeFilters({ type: "FANS", category: categoryId, q: "' OR 1=1", page: "2" }), true);
  assert.equal(result.total_pages, 3);
  assert.equal(result.page_size, 10);
  assert.equal(result.page, 2);
  assert.equal(result.items[0].replacement_elements[0].id, "hero");
  assert.equal(result.items[0].replacement_elements_json, undefined);
  assert.match(calls[1].sql, /t\.status='ACTIVE' AND c\.status='ACTIVE'/);
  assert.doesNotMatch(calls[1].sql, /OR 1=1/);
  assert.deepEqual(calls[2].p, ["FANS", categoryId, "%' OR 1=1%", "%' OR 1=1%", 10, 10]);
  calls.length = 0;
  await service.templates(viralRemakeFilters({ type: "COMMERCE", status: "DISABLED" }, true), false);
  assert.match(calls[0].sql, /t\.status=\?/);
  assert.deepEqual(calls[0].p, ["COMMERCE", "DISABLED"]);
});

test("template creation/update/delete validates assets and types, preserves partial fields and audits each successful change", async () => {
  const f = databaseFixture();
  const created = await f.service.templateCreate("ADMIN", input({ type: "FANS" }));
  assert.equal(created.type, "FANS");
  assert.equal(created.category_name, "生活剧情");
  assert.equal(created.title, "生活反转");
  assert.equal(created.replacement_elements[0].name, "小明");
  assert.match(f.locks[0], /LOCK IN SHARE MODE/);
  const updated = await f.service.templateUpdate("ADMIN", created.id, { title: "二创", status: "DISABLED" });
  assert.equal(updated.script_content, created.script_content);
  assert.equal(updated.video_url, created.video_url);
  assert.equal(updated.replacement_elements[0].id, "hero");
  await assert.rejects(f.service.templateGet(created.id, true), /已下架/);
  await f.service.templateUpdate("ADMIN", created.id, { status: "ACTIVE" });
  f.categories.get(categoryId).status = "DISABLED";
  await assert.rejects(f.service.templateGet(created.id, true), /已下架/);
  assert.equal((await f.service.templateGet(created.id)).title, "二创");
  assert.deepEqual(await f.service.templateDelete("ADMIN", created.id), { deleted: true });
  assert.deepEqual(f.audits.map(row => row.action), ["viral-remake.template.create", "viral-remake.template.update", "viral-remake.template.update", "viral-remake.template.delete"]);
  await assert.rejects(f.service.templateDelete("ADMIN", created.id), /不存在/);
  await assert.rejects(f.service.templateCreate("ADMIN", input({ type: "COMMERCE" })), /类型不一致/);
  await assert.rejects(f.service.templateCreate("ADMIN", input({ category_id: randomUUID() })), /所属分类不存在/);
  await assert.rejects(f.service.templateCreate("ADMIN", input({ video_url: media(imageId) })), /不是视频/);
  await assert.rejects(f.service.templateCreate("ADMIN", input({ replacement_elements: [{ id: "hero", type: "CHARACTER", name: "角色", image_url: media(videoId) }] })), /不是图片/);
  await assert.rejects(f.service.templateCreate("ADMIN", input({ video_url: media(randomUUID()) })), /视频不存在/);
  f.assets.get(imageId).mime_type = "image/gif";
  await assert.rejects(f.service.templateCreate("ADMIN", input()), /仅支持 PNG/);
  assert.equal(f.templates.size, 0);
});

test("categories support CRUD and guarded moves while referenced categories cannot change type or be deleted", async () => {
  const f = databaseFixture();
  const created = await f.service.categoryCreate("ADMIN", { type: "FANS", code: "new-category", name: "新题材" });
  assert.equal(created.type, "FANS");
  const updated = await f.service.categoryUpdate("ADMIN", created.id, { name: "新商品", type: "COMMERCE", status: "DISABLED" });
  assert.equal(updated.code, "new-category");
  assert.equal(updated.type, "COMMERCE");
  assert.match(f.locks[0], /FOR UPDATE/);
  await f.service.categoryDelete("ADMIN", created.id);
  await assert.rejects(f.service.categoryCreate("ADMIN", { type: "FANS", code: "life-drama", name: "重复" }), /已经存在/);
  const item = await f.service.templateCreate("ADMIN", input());
  await assert.rejects(f.service.categoryUpdate("ADMIN", categoryId, { type: "COMMERCE" }), /不能修改分类类型/);
  await assert.rejects(f.service.categoryDelete("ADMIN", categoryId), /先移动或删除/);
  assert.equal(f.categories.get(categoryId).type, "FANS");
  await f.service.templateUpdate("ADMIN", item.id, { category_id: commerceCategoryId, type: "COMMERCE" });
  assert.equal((await f.service.templateGet(item.id)).type, "COMMERCE");
  await f.service.categoryDelete("ADMIN", categoryId);
  assert.deepEqual(f.audits.filter(row => row.entityType === "viral_remake_category").map(row => row.action), ["viral-remake.category.create", "viral-remake.category.update", "viral-remake.category.delete", "viral-remake.category.delete"]);
});

test("HTTP admin routes require dedicated permission and valid types; media uploads remain seekable through public media API", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aivs-remake-http-"));
  const previous = process.env.TUTORIAL_MEDIA_DIRECTORY;
  process.env.TUTORIAL_MEDIA_DIRECTORY = root;
  const f = databaseFixture(), mediaRows = new Map();
  const mediaService = new TutorialMediaService({
    execute: async (_sql, p) => { mediaRows.set(p[0], { id: p[0], storage_name: p[1], mime_type: p[2], media_type: p[3], original_name: p[4], byte_size: p[5] }); return { affectedRows: 1 }; },
    query: async (_sql, p) => mediaRows.has(p[0]) ? [mediaRows.get(p[0])] : [],
  }, { record: async () => undefined });
  class TestModule {}
  Module({ controllers: [ViralRemakesController, ViralRemakesAdminController, TutorialsController], providers: [
    { provide: ViralRemakesService, useValue: f.service }, { provide: TutorialMediaService, useValue: mediaService },
    { provide: TutorialsService, useValue: {} }, AdminAuthGuard, PermissionsGuard,
    { provide: AdminAuthService, useValue: { verify: token => {
      if (!["MANAGE", "NO_PERMISSION", "TUTORIALS_ONLY"].includes(token)) throw new UnauthorizedException();
      return { sub: "ADMIN", roles: [], permissions: token === "MANAGE" ? ["viral-remakes.manage"] : token === "TUTORIALS_ONLY" ? ["tutorials.manage"] : [], mustChangePassword: false };
    } } },
  ] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix("api/v1"); await app.listen(0, "127.0.0.1");
  t.after(async () => { await app.close(); if (previous === undefined) delete process.env.TUTORIAL_MEDIA_DIRECTORY; else process.env.TUTORIAL_MEDIA_DIRECTORY = previous; await fs.rm(root, { recursive: true, force: true }); });
  const base = `${await app.getUrl()}/api/v1`, adminHeaders = { Authorization: "Bearer MANAGE", "Content-Type": "application/json" };
  for (const [method, endpoint] of [["GET", "categories"], ["POST", "categories"], ["PATCH", `categories/${categoryId}`], ["DELETE", `categories/${categoryId}`], ["GET", "templates"], ["POST", "templates"], ["PATCH", `templates/${randomUUID()}`], ["DELETE", `templates/${randomUUID()}`], ["POST", "media"]]) {
    assert.equal((await fetch(`${base}/admin/viral-remakes/${endpoint}`, { method })).status, 401);
    assert.equal((await fetch(`${base}/admin/viral-remakes/${endpoint}`, { method, headers: { Authorization: "Bearer TUTORIALS_ONLY" } })).status, 403);
  }
  assert.equal((await fetch(`${base}/viral-remakes/templates?type=INVALID`)).status, 400);
  assert.equal((await fetch(`${base}/viral-remakes/templates?page_size=51`)).status, 400);
  const createdResponse = await fetch(`${base}/admin/viral-remakes/templates`, { method: "POST", headers: adminHeaders, body: JSON.stringify(input()) });
  assert.equal(createdResponse.status, 201); const created = await createdResponse.json();
  const detail = await fetch(`${base}/viral-remakes/templates/${created.id}`); assert.equal(detail.status, 200); assert.equal(detail.headers.get("cache-control"), "no-store");
  assert.equal((await detail.json()).replacement_elements[0].id, "hero");
  assert.equal((await fetch(`${base}/admin/viral-remakes/templates/${created.id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "DISABLED" }) })).status, 200);
  assert.equal((await fetch(`${base}/viral-remakes/templates/${created.id}`)).status, 404);
  assert.equal((await fetch(`${base}/admin/viral-remakes/templates/${created.id}`, { headers: adminHeaders })).status, 200);
  const video = Buffer.alloc(100); video.writeUInt32BE(24, 0); video.write("ftypisom", 4); video.write("isommp42", 16);
  const form = new FormData(); form.append("file", new Blob([video], { type: "video/mp4" }), "爆款.mp4");
  const upload = await fetch(`${base}/admin/viral-remakes/media`, { method: "POST", headers: { Authorization: "Bearer MANAGE" }, body: form });
  assert.equal(upload.status, 201); const asset = await upload.json(); assert.equal(asset.media_type, "VIDEO");
  const partial = await fetch(`${await app.getUrl()}${asset.url}`, { headers: { Range: "bytes=5-15" } });
  assert.equal(partial.status, 206); assert.equal(partial.headers.get("content-range"), "bytes 5-15/100"); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), video.subarray(5,16));
  const badForm = new FormData(); badForm.append("file", new Blob([Buffer.from("fake-video")], { type: "video/mp4" }), "fake.mp4");
  assert.equal((await fetch(`${base}/admin/viral-remakes/media`, { method: "POST", headers: { Authorization: "Bearer MANAGE" }, body: badForm })).status, 400);
  assert.deepEqual(await fs.readdir(path.join(root, ".incoming")), []);
});

test("067 migration seeds both taxonomies and dedicated permission and restricts referenced category removal", async () => {
  const sql = await fs.readFile(path.join(__dirname, "../src/database/migrations/067_viral_remakes.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS viral_remake_categories/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS viral_remake_templates/);
  assert.match(sql, /FOREIGN KEY \(category_id\).*ON DELETE RESTRICT/);
  assert.match(sql, /UNIQUE KEY uq_viral_category_code \(type,code\)/);
  assert.match(sql, /UNIQUE KEY uq_viral_category_name \(type,name\)/);
  assert.equal((sql.match(/','FANS','/g) || []).length, 8);
  assert.equal((sql.match(/','COMMERCE','/g) || []).length, 8);
  assert.match(sql, /viral-remakes\.manage/);
});
