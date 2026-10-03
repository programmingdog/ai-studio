const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function loadMedia(apiBase = "http://localhost:3101/api/v1", origin = "http://localhost:3200") {
  const source = fs.readFileSync(path.join(__dirname, "../lib/tutorial-media.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (name) => { assert.equal(name, "./api"); return { API_BASE: apiBase }; }, URL, window: { location: { origin } } });
  return exports;
}

test("Bilibili iframe becomes a trusted HTTPS player URL with fullscreen-ready identity", () => {
  const media = loadMedia();
  const source = '<iframe src="//player.bilibili.com/player.html?isOutside=true&aid=117268612713689&bvid=BV1P1Yk6EEX9&cid=41885697238&p=2" scrolling="no" onload="alert(1)"></iframe>';
  const parsed = new URL(media.tutorialBilibiliUrl(source));
  assert.equal(parsed.origin, "https://player.bilibili.com");
  assert.equal(parsed.pathname, "/player.html");
  assert.equal(parsed.searchParams.get("aid"), "117268612713689");
  assert.equal(parsed.searchParams.get("bvid"), "BV1P1Yk6EEX9");
  assert.equal(parsed.searchParams.get("cid"), "41885697238");
  assert.equal(parsed.searchParams.get("p"), "2");
  assert.equal(parsed.searchParams.get("autoplay"), "0");
  assert.equal(parsed.searchParams.has("onload"), false);
});

test("Bilibili full share text, escaped iframe parameters and av links retain only supported parameters", () => {
  const media = loadMedia();
  const shared = new URL(media.tutorialBilibiliInput("【教程标题】 https://www.bilibili.com/video/BV1P1Yk6EEX9/?p=3&share_source=copy_web"));
  assert.equal(shared.searchParams.get("p"), "3");
  assert.equal(shared.searchParams.get("bvid"), "BV1P1Yk6EEX9");
  assert.equal(shared.searchParams.has("share_source"), false);
  assert.equal(new URL(media.tutorialBilibiliUrl('<iframe src="//player.bilibili.com/player.html?bvid=BV1P1Yk6EEX9&amp;p=2"></iframe>')).searchParams.get("p"), "2");
  assert.equal(new URL(media.tutorialBilibiliUrl("https://www.bilibili.com/video/av12345")).searchParams.get("aid"), "12345");
});

test("official short shares are extracted for server resolution and arbitrary embed origins are rejected", () => {
  const media = loadMedia();
  assert.equal(media.tutorialBilibiliInput("教程标题 https://b23.tv/AbC123?share_source=copy"), "https://b23.tv/AbC123");
  for (const input of ["javascript:alert(1)", "https://player.bilibili.com.evil.test/player.html?bvid=BV1P1Yk6EEX9", "https://bilibili.com@evil.test/video/BV1P1Yk6EEX9", "https://player.bilibili.com:123/player.html?bvid=BV1P1Yk6EEX9", '<iframe src="https://evil.test/embed"></iframe>', "https://player.bilibili.com/player.html?bvid=no"]) assert.throws(() => media.tutorialBilibiliUrl(input));
});

test("media resolves against the API server instead of the admin origin, including relative production API bases", () => {
  assert.equal(loadMedia().tutorialMediaUrl("/api/v1/tutorials/media/image-id"), "http://localhost:3101/api/v1/tutorials/media/image-id");
  assert.equal(loadMedia("/api/v1", "https://studio.example").tutorialMediaUrl("/api/v1/tutorials/media/image-id"), "https://studio.example/api/v1/tutorials/media/image-id");
  assert.equal(loadMedia().tutorialMediaUrl("https://cdn.example/image.png"), "https://cdn.example/image.png");
  assert.equal(loadMedia().tutorialMediaUrl("javascript:alert(1)"), "");
  assert.equal(loadMedia().tutorialMediaUrl("https://user:secret@cdn.example/image.png"), "");
});

test("upload file validation matches server image and video formats and size limits", () => {
  const media = loadMedia();
  assert.doesNotThrow(() => media.validateTutorialFile({ name: "video.mp4", type: "video/mp4", size: 500 * 1024 * 1024 }, "VIDEO"));
  assert.doesNotThrow(() => media.validateTutorialFile({ name: "image.webp", type: "image/webp", size: 10 * 1024 * 1024 }, "IMAGE"));
  assert.throws(() => media.validateTutorialFile({ name: "video.mp4", type: "video/mp4", size: 500 * 1024 * 1024 + 1 }, "VIDEO"), /500MB/);
  assert.throws(() => media.validateTutorialFile({ name: "image.png", type: "image/png", size: 10 * 1024 * 1024 + 1 }, "IMAGE"), /10MB/);
  assert.throws(() => media.validateTutorialFile({ name: "image.svg", type: "image/svg+xml", size: 100 }, "IMAGE"));
  assert.throws(() => media.validateTutorialFile({ name: "video.ogg", type: "video/ogg", size: 100 }, "VIDEO"));
  assert.throws(() => media.validateTutorialFile({ name: "image.png", type: "image/png", size: 0 }, "IMAGE"));
});

test("managed image persistence remains portable while external media URLs stay unchanged", () => {
  const media = loadMedia();
  const relative = "/api/v1/tutorials/media/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.equal(media.tutorialStoredMediaUrl(`http://localhost:3101${relative}`), relative);
  assert.equal(media.tutorialStoredMediaUrl(`https://other.example${relative}`), `https://other.example${relative}`);
  assert.equal(loadMedia("/api/v1", "https://studio.example").tutorialStoredMediaUrl(`https://studio.example${relative}`), relative);
  assert.equal(media.tutorialStoredMediaUrl("javascript:alert(1)"), "");
});

test("safe rich text styles survive round trips and executable or layout-changing CSS is removed", () => {
  const media = loadMedia();
  assert.equal(media.tutorialSafeStyle("text-align: center; color: #ffccaa; background-color: rgba(0, 0, 0, .2); font-size: 24px; font-weight: 700; text-decoration: underline"), "text-align: center; color: #ffccaa; background-color: rgba(0, 0, 0, .2); font-size: 24px; font-weight: 700; text-decoration: underline");
  assert.equal(media.tutorialSafeStyle("position: fixed; background-image: url(javascript:alert(1)); color: expression(alert(1)); width: 100%; text-align: right"), "text-align: right");
});

function loadUpload() {
  const source = fs.readFileSync(path.join(__dirname, "../lib/api.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const requests = [];
  class Xhr {
    constructor() { this.upload = {}; this.headers = {}; requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(data) { this.data = data; }
    abort() { this.onabort(); }
    respond(status, body) { this.status = status; this.responseText = JSON.stringify(body); this.onload(); }
  }
  class Form { constructor() { this.items = []; } append(name, file) { this.items.push([name, file]); } }
  const exports = {};
  vm.runInNewContext(compiled, { exports, XMLHttpRequest: Xhr, FormData: Form, DOMException, process: { env: { NEXT_PUBLIC_API_BASE_URL: "https://api.example/api/v1" } } });
  return { ...exports, requests };
}

test("upload sends multipart file with auth and reports network upload progress without setting a boundary", async () => {
  const { apiUpload, requests } = loadUpload();
  const file = { name: "tutorial.mp4", size: 1024 };
  const progress = [];
  const result = apiUpload("/admin/tutorials/media", file, "admin-token", (percent) => progress.push(percent));
  const request = requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api.example/api/v1/admin/tutorials/media");
  assert.equal(request.headers.Authorization, "Bearer admin-token");
  assert.equal(request.headers["Content-Type"], undefined);
  assert.equal(request.data.items[0][0], "file");
  assert.equal(request.data.items[0][1], file);
  request.upload.onprogress({ lengthComputable: true, loaded: 512, total: 1024 });
  assert.deepEqual(progress, [50]);
  request.respond(201, { id: "media-id", url: "/api/v1/tutorials/media/media-id", media_type: "VIDEO" });
  assert.equal((await result).id, "media-id");
});

test("failed and cancelled uploads surface an actionable error and cannot resolve as successful", async () => {
  let loaded = loadUpload();
  const failed = loaded.apiUpload("/admin/tutorials/media", {}, "token", () => {});
  loaded.requests[0].respond(413, { message: "文件过大" });
  await assert.rejects(failed, /文件过大/);
  loaded = loadUpload();
  const controller = new AbortController();
  const cancelled = loaded.apiUpload("/admin/tutorials/media", {}, "token", () => {}, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
});
