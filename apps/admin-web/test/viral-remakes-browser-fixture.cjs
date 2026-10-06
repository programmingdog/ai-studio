// Local in-memory UI acceptance fixture; no production API, account or database access.
// Run: node apps/admin-web/test/viral-remakes-browser-fixture.cjs [port]
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");

async function start() {
  const port = Number(process.argv[2] || 4327);
  const root = path.resolve(__dirname, "../../..");
  const directory = path.join(root, ".codex-tmp/viral-remakes-admin-fixture");
  const admin = path.join(root, "apps/admin-web");
  fs.mkdirSync(directory, { recursive: true });
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const sampleVideo = path.join(directory, "sample.mp4");
  if (!fs.existsSync(sampleVideo)) {
    const existingSample = path.join(root, ".codex-tmp/tutorials-admin-fixture/sample.mp4");
    if (fs.existsSync(existingSample)) fs.copyFileSync(existingSample, sampleVideo);
    else try { execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x155f4b:s=320x180:r=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", sampleVideo]); } catch { console.warn("No sample video available; install ffmpeg to check playback."); }
  }
  await esbuild.build({ stdin: { resolveDir: admin, sourcefile: "viral-remakes-browser-entry.tsx", loader: "tsx", contents: `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { ViralRemakesPanel } from "@/components/ViralRemakesPanel";
    window.confirm = () => true;
    async function sample(kind: "IMAGE" | "VIDEO") {
      const selector = kind === "VIDEO" ? '[aria-label="上传爆款视频"]' : '[aria-label="上传元素 1 原图"]';
      const input = document.querySelector(selector) as HTMLInputElement;
      if (!input) return;
      const data = await (await fetch(kind === "VIDEO" ? "/sample.mp4" : "/sample.png")).blob();
      const transfer = new DataTransfer();
      transfer.items.add(new File([data], kind === "VIDEO" ? "sample.mp4" : "sample.png", { type: kind === "VIDEO" ? "video/mp4" : "image/png" }));
      input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    createRoot(document.getElementById("root")!).render(<main style={{padding: "20px", maxWidth: "1500px", margin: "auto"}}>
      <aside style={{display: "flex", gap: "12px", padding: "12px", border: "1px dashed #7aa997", marginBottom: "20px"}}>
        <strong>本地隔离验收</strong><button onClick={() => void sample("VIDEO")}>注入视频上传样例</button><button onClick={() => void sample("IMAGE")}>注入元素原图样例</button><button onClick={() => void fetch("/__fail-save", {method:"POST"})}>下一次保存失败</button>
      </aside><ViralRemakesPanel token="isolated-fixture-token" /></main>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: path.join(directory, "bundle.js"), tsconfig: path.join(admin, "tsconfig.json"), define: { "process.env.NEXT_PUBLIC_API_BASE_URL": '"/api/v1"' } });
  if (process.argv.includes("--build-only")) return;
  const now = "2026-10-04T04:30:00.000Z";
  let categories = [
    { id: randomUUID(), type: "FANS", code: "life-drama", name: "生活剧情", description: "生活题材", sort_order: 0, status: "ACTIVE", created_at: now, updated_at: now },
    { id: randomUUID(), type: "FANS", code: "workplace", name: "职场故事", description: "职场题材", sort_order: 1, status: "ACTIVE", created_at: now, updated_at: now },
    { id: randomUUID(), type: "COMMERCE", code: "beauty", name: "美妆护肤", description: "美妆商品", sort_order: 0, status: "ACTIVE", created_at: now, updated_at: now },
  ];
  const videoUrl = `/api/v1/tutorials/media/${randomUUID()}`;
  let templates = Array.from({ length: 12 }, (_, index) => ({ id: randomUUID(), category_id: categories[0].id, title: `生活反转 ${index + 1}`, summary: "保留反转节奏，替换主角形象。", video_url: videoUrl, original_share_url: "https://b23.tv/example", script_content: "镜头一：主角在办公室拿起文件。\n镜头二：镜头推近，展示反转。", replacement_elements: [{ id: "lead", type: "CHARACTER", name: "主角", description: "穿着保持一致", image_url: "" }], sort_order: index, status: index === 2 ? "DISABLED" : "ACTIVE", created_at: now, updated_at: now }));
  templates.push({ ...templates[0], id: randomUUID(), category_id: categories[2].id, title: "护肤商品展示", replacement_elements: [{ id: "product", type: "PROP", name: "护肤品", description: "替换瓶身外观", image_url: "" }] });
  const decorate = (item) => ({ ...item, type: categories.find((c) => c.id === item.category_id)?.type, category_name: categories.find((c) => c.id === item.category_id)?.name || "" });
  const log = [];
  const media = new Map([[videoUrl, "VIDEO"]]);
  let failSave = false;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://localhost:${port}`);
    const send = (status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (url.pathname === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>爆款复刻后台隔离验收</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
    if (url.pathname === "/bundle.js") { response.writeHead(200, { "Content-Type": "application/javascript" }); response.end(fs.readFileSync(path.join(directory, "bundle.js"))); return; }
    if (url.pathname === "/styles.css") { response.writeHead(200, { "Content-Type": "text/css" }); response.end(fs.readFileSync(path.join(admin, "app/globals.css"))); return; }
    if (url.pathname === "/sample.png" || media.get(url.pathname) === "IMAGE") { response.writeHead(200, { "Content-Type": "image/png" }); response.end(image); return; }
    if (url.pathname === "/sample.mp4" || media.get(url.pathname) === "VIDEO") {
      if (!fs.existsSync(sampleVideo)) { response.writeHead(404); response.end(); return; }
      const data = fs.readFileSync(sampleVideo); const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
      if (range) { const first = Number(range[1]); const last = range[2] ? Number(range[2]) : data.length - 1; response.writeHead(206, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Range": `bytes ${first}-${last}/${data.length}`, "Content-Length": last - first + 1 }); response.end(data.subarray(first, last + 1)); }
      else { response.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": data.length }); response.end(data); } return;
    }
    if (url.pathname === "/__state") { send(200, { categories, templates, log }); return; }
    if (url.pathname === "/__fail-save") { failSave = true; send(200, {}); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const raw = Buffer.concat(chunks);
    let body = {}; try { body = raw.length && request.headers["content-type"]?.includes("application/json") ? JSON.parse(raw) : {}; } catch { send(400, { message: "JSON格式错误" }); return; }
    log.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (request.headers.authorization !== "Bearer isolated-fixture-token") { send(401, { message: "fixture token required" }); return; }
    const base = "/api/v1/admin/viral-remakes";
    if (url.pathname === `${base}/media`) { const id = randomUUID(); const kind = raw.includes(Buffer.from('filename="sample.mp4"')) ? "VIDEO" : "IMAGE"; const uploaded = `/api/v1/tutorials/media/${id}`; media.set(uploaded, kind); send(201, { id, url: uploaded, media_type: kind, mime_type: kind === "VIDEO" ? "video/mp4" : "image/png", size: raw.length, original_name: kind === "VIDEO" ? "sample.mp4" : "sample.png" }); return; }
    if (failSave && ["POST", "PATCH"].includes(request.method)) { failSave = false; send(500, { message: "模拟保存失败：请重试，草稿应当保留" }); return; }
    if (url.pathname === `${base}/categories`) {
      if (request.method === "GET") { send(200, categories.filter((item) => item.type === url.searchParams.get("type")).map((item) => ({ ...item, template_count: templates.filter((t) => t.category_id === item.id).length }))); return; }
      if (request.method === "POST") { const item = { ...body, id: randomUUID(), created_at: now, updated_at: now, template_count: 0 }; categories.push(item); send(201, item); return; }
    }
    const categoryId = url.pathname.match(new RegExp(`^${base}/categories/([^/]+)$`))?.[1];
    if (categoryId) { const item = categories.find((c) => c.id === categoryId); if (!item) { send(404, { message: "分类不存在" }); return; } if (request.method === "PATCH") { Object.assign(item, body); send(200, item); return; } if (request.method === "DELETE") { if (templates.some((t) => t.category_id === categoryId)) { send(409, { message: "分类下已有爆款视频，请先移动或删除这些视频" }); return; } categories = categories.filter((c) => c.id !== categoryId); send(200, { deleted: true }); return; } send(200, item); return; }
    if (url.pathname === `${base}/templates`) {
      if (request.method === "GET") { const q = url.searchParams.get("q") || ""; const page = Number(url.searchParams.get("page") || 1); const filtered = templates.map(decorate).filter((item) => item.type === url.searchParams.get("type") && (!url.searchParams.get("category") || item.category_id === url.searchParams.get("category")) && (!url.searchParams.get("status") || item.status === url.searchParams.get("status")) && item.title.includes(q)); send(200, { items: filtered.slice((page - 1) * 10, page * 10), total: filtered.length, page, page_size: 10, total_pages: Math.ceil(filtered.length / 10) }); return; }
      if (request.method === "POST") { const item = { ...body, id: randomUUID(), created_at: now, updated_at: now }; templates.unshift(item); send(201, decorate(item)); return; }
    }
    const templateId = url.pathname.match(new RegExp(`^${base}/templates/([^/]+)$`))?.[1];
    if (templateId) { const item = templates.find((t) => t.id === templateId); if (!item) { send(404, { message: "视频不存在" }); return; } if (request.method === "PATCH") { Object.assign(item, body); send(200, decorate(item)); return; } if (request.method === "DELETE") { templates = templates.filter((t) => t.id !== templateId); send(200, { deleted: true }); return; } send(200, decorate(item)); return; }
    send(404, { message: "fixture route not found" });
  });
  server.listen(port, "127.0.0.1", () => console.log(`Viral remakes admin isolated fixture: http://127.0.0.1:${port}`));
}
start().catch((reason) => { console.error(reason); process.exitCode = 1; });
