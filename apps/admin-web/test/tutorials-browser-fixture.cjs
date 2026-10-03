// Isolated, in-memory browser fixture. It never connects to the application database.
// Run: node apps/admin-web/test/tutorials-browser-fixture.cjs [port]
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");

async function start() {
  const port = Number(process.argv[2] || 4318);
  const workspace = path.resolve(__dirname, "../../..");
  const adminDirectory = path.join(workspace, "apps/admin-web");
  const directory = path.resolve(workspace, ".codex-tmp/tutorials-admin-fixture");
  fs.mkdirSync(directory, { recursive: true });
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const videoPath = path.join(directory, "sample.mp4");
  try {
    if (!fs.existsSync(videoPath)) execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x155f4b:s=320x180:r=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", videoPath]);
  } catch (reason) { console.warn("Sample video unavailable:", reason.message); }
  const apiBase = `http://localhost:${port}/api/v1`;
  await esbuild.build({
    stdin: { resolveDir: adminDirectory, sourcefile: "tutorials-browser-entry.tsx", loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { TutorialsPanel } from "@/components/TutorialsPanel";
      const originalConfirm = window.confirm;
      window.confirm = (message) => {
        document.getElementById("confirmation").textContent = message;
        return (document.getElementById("allow-delete") as HTMLInputElement).checked;
      };
      async function file(kind: "IMAGE" | "VIDEO") {
        const response = await fetch(kind === "IMAGE" ? "/sample.png" : "/sample.mp4");
        const data = await response.blob();
        const selector = kind === "IMAGE" ? '[aria-label="上传教程图片"]' : '[aria-label="上传教程视频"]';
        const input = document.querySelector(selector) as HTMLInputElement;
        const transfer = new DataTransfer();
        transfer.items.add(new File([data], kind === "IMAGE" ? "example.png" : "example.mp4", {type: kind === "IMAGE" ? "image/png" : "video/mp4"}));
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      createRoot(document.getElementById("root")!).render(<main style={{padding: "20px"}}>
        <aside style={{padding: "12px", marginBottom: "14px", border: "1px dashed #8ca598", display: "flex", flexWrap: "wrap", gap: "10px"}} aria-label="隔离验收工具">
          <strong>教程管理 · 本地隔离验收</strong>
          <button type="button" onClick={() => void file("IMAGE")}>上传图片样例</button>
          <button type="button" onClick={() => void file("VIDEO")}>上传视频样例</button>
          <label><input id="allow-delete" type="checkbox" defaultChecked />允许确认删除样例</label>
          <output id="confirmation" aria-label="最近删除确认" />
        </aside>
        <TutorialsPanel token="isolated-fixture-token" />
      </main>);
    ` },
    bundle: true, outfile: path.join(directory, "bundle.js"), platform: "browser", format: "iife", jsx: "automatic", sourcemap: false,
    tsconfig: path.join(adminDirectory, "tsconfig.json"),
    define: { "process.env.NEXT_PUBLIC_API_BASE_URL": '"/api/v1"' },
  });
  if (process.argv.includes("--build-only")) return;
  const now = "2026-10-02T06:30:00.000Z";
  let items = Array.from({ length: 12 }, (_, index) => ({
    id: `tutorial-${index + 1}`, title: `教程 ${index + 1}：项目制作流程`, content: `<h2>步骤 ${index + 1}</h2><p>这是隔离测试的图文教程。</p>`,
    video_type: "NONE", video_url: null, status: index === 2 ? "DRAFT" : "PUBLISHED", sort_order: index,
    created_at: now, updated_at: now, published_at: now,
  }));
  items[0].content = '<h2 style="text-align: center; color: #155f4b">项目制作步骤</h2><ol start="3"><li>创建项目</li></ol><table><tbody><tr><td colspan="2" rowspan="2">流程说明</td></tr></tbody></table><p>图片会插入当前光标位置。</p>';
  const log = [];
  const mediaTypes = new Map();
  let mediaCount = 0;
  let createCount = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, apiBase);
    const send = (status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>教程管理隔离验收</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return;
    }
    if (url.pathname === "/bundle.js") { response.writeHead(200, { "Content-Type": "application/javascript" }); response.end(fs.readFileSync(path.join(directory, "bundle.js"))); return; }
    if (url.pathname === "/styles.css") { response.writeHead(200, { "Content-Type": "text/css" }); response.end(fs.readFileSync(path.join(adminDirectory, "app/globals.css"))); return; }
    if (url.pathname === "/sample.png" || mediaTypes.get(url.pathname) === "IMAGE") { response.writeHead(200, { "Content-Type": "image/png" }); response.end(image); return; }
    if (url.pathname === "/sample.mp4" || mediaTypes.get(url.pathname) === "VIDEO") {
      if (!fs.existsSync(videoPath)) { response.writeHead(404); response.end(); return; }
      const data = fs.readFileSync(videoPath); const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
      if (range) {
        const start = Number(range[1]); const end = range[2] ? Number(range[2]) : data.length - 1;
        response.writeHead(206, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${data.length}`, "Content-Length": end - start + 1 }); response.end(data.subarray(start, end + 1));
      } else { response.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": data.length }); response.end(data); } return;
    }
    if (url.pathname === "/fixture-log") { send(200, { log, items }); return; }
    if (!url.pathname.startsWith("/api/v1/admin/tutorials")) { send(404, { message: "Unknown isolated fixture route" }); return; }
    if (request.headers.authorization !== "Bearer isolated-fixture-token") { send(401, { message: "Fixture token missing" }); return; }
    if (request.method === "GET" && url.pathname === "/api/v1/admin/tutorials") {
      const query = url.searchParams.get("query") || ""; const rows = items.filter((item) => item.title.includes(query)).sort((a, b) => a.sort_order - b.sort_order);
      const pageCount = Math.ceil(rows.length / 10); const page = Math.min(Math.max(1, Number(url.searchParams.get("page") || 1)), Math.max(1, pageCount));
      log.push({ method: "GET", path: url.pathname, page, query });
      send(200, { items: rows.slice((page - 1) * 10, page * 10), page, page_size: 10, total: rows.length, page_count: pageCount }); return;
    }
    const id = decodeURIComponent(url.pathname.split("/").pop());
    if (request.method === "GET") { log.push({ method: "GET", id }); const item = items.find((item) => item.id === id); send(item ? 200 : 404, item || { message: "教程不存在" }); return; }
    if (request.method === "DELETE") { log.push({ method: "DELETE", id }); items = items.filter((item) => item.id !== id); send(200, { deleted: true }); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = Buffer.concat(chunks);
    if (url.pathname.endsWith("/media")) {
      const type = request.headers["content-type"] || ""; const header = body.toString("latin1", 0, Math.min(body.length, 500));
      if (!type.startsWith("multipart/form-data; boundary=") || !header.includes('name="file"')) { send(400, { message: "必须通过 multipart file 上传" }); return; }
      const video = header.includes("video/mp4"); const mediaId = `00000000-0000-4000-8000-${String(++mediaCount).padStart(12, "0")}`;
      mediaTypes.set(`/api/v1/tutorials/media/${mediaId}`, video ? "VIDEO" : "IMAGE");
      log.push({ method: "POST", path: url.pathname, multipart: true, fileSize: body.length, video });
      setTimeout(() => send(201, { id: mediaId, url: `/api/v1/tutorials/media/${mediaId}`, mime_type: video ? "video/mp4" : "image/png", media_type: video ? "VIDEO" : "IMAGE", original_name: video ? "example.mp4" : "example.png", size: body.length }), 600); return;
    }
    let input; try { input = JSON.parse(body.toString()); } catch { send(400, { message: "Invalid JSON" }); return; }
    log.push({ method: request.method, id, input });
    const existing = items.find((item) => item.id === id);
    if (request.method === "PATCH" && !existing) { send(404, { message: "教程不存在" }); return; }
    if (input.video_type === "BILIBILI" && input.video_url.startsWith("https://b23.tv/")) input.video_url = "https://player.bilibili.com/player.html?isOutside=true&bvid=BV1P1Yk6EEX9&p=1&autoplay=0";
    const item = { ...existing, ...input, id: existing?.id || `created-${++createCount}`, created_at: existing?.created_at || now, updated_at: now, published_at: input.status === "PUBLISHED" ? now : null };
    if (existing) items = items.map((row) => row.id === item.id ? item : row); else items.push(item);
    send(request.method === "POST" ? 201 : 200, item);
  });
  server.listen(port, "127.0.0.1", () => console.log(`Tutorial fixture: http://localhost:${port}; in-memory data only`));
}
start().catch((reason) => { console.error(reason); process.exitCode = 1; });
