const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

test("admin includes immutable signed desktop release management", () => {
  const app = readFileSync(join(__dirname, "../components/AdminApp.tsx"), "utf8");
  const panel = readFileSync(join(__dirname, "../components/DesktopReleasePanel.tsx"), "utf8");
  assert.match(app, /client-releases/);
  assert.match(app, /label: "下载与版本"/);
  assert.match(app, /label: "版本发布"/);
  assert.match(panel, /\/admin\/desktop-releases/);
  assert.match(panel, /Windows x64/);
  assert.match(panel, /macOS Apple Silicon/);
  assert.match(panel, /最低可运行版本/);
  assert.match(panel, /发布后版本号、更新包与签名将不可修改/);
  assert.match(panel, /编辑更新说明/);
  assert.match(panel, /desktop-releases\/\$\{release\.id\}\/notes/);
});

// Drive the real panel component and its form events without a browser dependency.
function releasePanel(items, handleRequest) {
  const source = readFileSync(join(__dirname, "../components/DesktopReleasePanel.tsx"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2021 } }).outputText;
  const instances = new Map();
  const pendingEffects = [];
  const requests = [];
  let current;
  let tree;
  let rows = JSON.parse(JSON.stringify(items));
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => value === right[index]);
  function hook() { const index = current.index++; return [current.hooks, index]; }
  const react = {
    useState(initial) {
      const [hooks, index] = hook();
      if (!hooks[index]) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, (next) => { hooks[index].value = typeof next === "function" ? next(hooks[index].value) : next; }];
    },
    useCallback(callback, deps) {
      const [hooks, index] = hook();
      if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { value: callback, deps };
      return hooks[index].value;
    },
    useEffect(callback, deps) {
      const [hooks, index] = hook();
      if (!hooks[index] || !same(hooks[index].deps, deps)) { hooks[index] = { deps }; pendingEffects.push(callback); }
    },
  };
  const fragment = Symbol("fragment");
  const jsx = (type, props, key) => ({ type, props, key });
  const exported = {};
  vm.runInNewContext(compiled, { exports: exported, Error, URL, window: { confirm: () => true }, require(name) {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: fragment };
    if (name === "@/lib/admin-date-time") return { formatDatabaseDateTime: (value) => value || "未发布" };
    assert.equal(name, "@/lib/api");
    return { apiRequest: async (path, init = {}, token) => {
      assert.equal(token, "test-admin-token");
      const request = { path, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined };
      requests.push(request);
      if (handleRequest) await handleRequest(request);
      if (request.method === "GET") return JSON.parse(JSON.stringify(rows));
      if (request.method === "POST") { const row = { ...release("new-release", "DRAFT"), ...request.body }; rows.push(row); return row; }
      const id = path.split("/")[3];
      const row = rows.find((item) => item.id === id);
      assert.ok(row, `Unknown fixture release: ${path}`);
      Object.assign(row, request.body);
      return JSON.parse(JSON.stringify(row));
    } };
  } });
  function render() {
    const seen = new Set();
    function visit(node, path) {
      if (node === null || node === undefined || typeof node === "boolean") return null;
      if (Array.isArray(node)) return node.map((child, index) => visit(child, `${path}/${child?.key || index}`)).filter((child) => child !== null);
      if (typeof node !== "object") return node;
      if (typeof node.type === "function") {
        const key = `${path}/${node.type.name}`;
        seen.add(key);
        if (!instances.has(key)) instances.set(key, { hooks: [], index: 0 });
        const previous = current;
        current = instances.get(key); current.index = 0;
        const rendered = node.type(node.props);
        current = previous;
        return visit(rendered, key);
      }
      return { ...node, props: { ...node.props, children: visit(node.props?.children, `${path}/children`) } };
    }
    tree = visit(jsx(exported.DesktopReleasePanel, { token: "test-admin-token" }), "root");
    for (const key of instances.keys()) if (!seen.has(key)) instances.delete(key);
  }
  async function settle() {
    for (let pass = 0; pass < 5; pass++) { render(); while (pendingEffects.length) pendingEffects.shift()(); await new Promise((resolve) => setImmediate(resolve)); }
  }
  function all(predicate) {
    const found = [];
    const visit = (node) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      if (predicate(node)) found.push(node);
      visit(node.props.children);
    };
    visit(tree);
    return found;
  }
  const text = (node) => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props.children) : node == null ? "" : String(node);
  const button = (label) => { const match = all((node) => node.type === "button" && text(node) === label)[0]; assert.ok(match, `Button missing: ${label}`); return match; };
  const input = (label) => {
    const match = all((node) => node.type === "label" && text(node).startsWith(label))[0];
    assert.ok(match, `Label missing: ${label}`);
    return [match.props.children].flat(Infinity).find((node) => node?.type === "input" || node?.type === "textarea");
  };
  return {
    requests, settle, all, text,
    async click(label) { button(label).props.onClick(); await settle(); },
    async fill(label, value) { input(label).props.onChange({ target: { value } }); await settle(); },
    async submit() { const form = all((node) => node.type === "form")[0]; assert.ok(form); await form.props.onSubmit({ preventDefault() {} }); await settle(); },
    value(label) { return input(label).props.value; },
    content() { return text(tree); },
  };
}

function release(id, status, backup_download_url = "") {
  return { id, version: "1.2.3", channel: "stable", status, notes: "原始更新说明", backup_download_url, min_supported_version: "0.0.0", rollout_percent: 100, created_at: "2026-10-03", updated_at: "2026-10-03", published_at: status === "DRAFT" ? null : "2026-10-03", artifacts: [{ target: "windows", arch: "x86_64", url: "https://cdn.example/app.exe", signature: "signed-artifact" }] };
}

test("new release form saves an optional backup URL and defaults to an empty URL", async () => {
  const panel = releasePanel([]);
  await panel.settle();
  await panel.click("新建版本");
  assert.equal(panel.value("备用下载链接"), "");
  await panel.fill("版本号", "1.3.0");
  await panel.fill("备用下载链接", " https://pan.example/share?id=123#code ");
  await panel.submit();
  const request = panel.requests.find((item) => item.method === "POST");
  assert.equal(request.path, "/admin/desktop-releases");
  assert.equal(request.body.backup_download_url, "https://pan.example/share?id=123#code");
  assert.match(panel.content(), /草稿已保存/);
  assert.match(panel.content(), /备用下载：已配置/);
});

test("draft edits preserve signed artifacts when the backup URL is changed", async () => {
  const existing = release("draft", "DRAFT", "https://pan.example/old");
  const panel = releasePanel([existing]);
  await panel.settle(); await panel.click("编辑");
  assert.equal(panel.value("备用下载链接"), existing.backup_download_url);
  await panel.fill("备用下载链接", "http://download.example/new");
  await panel.submit();
  const request = panel.requests.find((item) => item.method === "PATCH");
  assert.equal(request.path, "/admin/desktop-releases/draft");
  assert.equal(request.body.backup_download_url, "http://download.example/new");
  assert.deepEqual(request.body.artifacts, existing.artifacts);
});

test("published and archived releases update or clear only the backup URL", async () => {
  for (const status of ["PUBLISHED", "ARCHIVED"]) {
    const panel = releasePanel([release("history", status, "https://pan.example/old")]);
    await panel.settle(); await panel.click("编辑备用链接");
    assert.equal(panel.value("备用下载链接"), "https://pan.example/old");
    await panel.fill("备用下载链接", "https://pan.example/new?password=abc#share");
    await panel.submit();
    let request = panel.requests.find((item) => item.method === "PATCH");
    assert.equal(request.path, "/admin/desktop-releases/history/backup-download-url");
    assert.deepEqual(request.body, { backup_download_url: "https://pan.example/new?password=abc#share" });
    assert.match(panel.content(), /备用下载链接已更新/);
    await panel.click("编辑备用链接");
    await panel.fill("备用下载链接", ""); await panel.submit();
    request = panel.requests.filter((item) => item.method === "PATCH").at(-1);
    assert.deepEqual(request.body, { backup_download_url: "" });
    assert.match(panel.content(), /备用下载链接已清空/);
    assert.match(panel.content(), /备用下载：未配置/);
  }
});

test("invalid backup URLs stay in the editor and cannot be submitted to the API", async () => {
  for (const value of ["javascript:alert(1)", "https:pan.example/share", String.raw`https://pan.example\share`, "https://user:secret@pan.example/share", "https://pan.example/sh\nare", `https://pan.example/${"x".repeat(2000)}`, `https://pan.example/${"中".repeat(300)}`, "a relative URL"]) {
    const panel = releasePanel([release("published", "PUBLISHED")]);
    await panel.settle(); await panel.click("编辑备用链接");
    await panel.fill("备用下载链接", value); await panel.submit();
    assert.equal(panel.requests.filter((item) => item.method === "PATCH").length, 0);
    assert.equal(panel.all((node) => node.props.role === "alert").length, 1);
    assert.equal(panel.value("备用下载链接"), value);
  }
});

test("failed saves show the API error, retain the URL and allow a retry", async () => {
  let fail = true;
  const panel = releasePanel([release("published", "PUBLISHED")], (request) => { if (fail && request.method === "PATCH") throw new Error("当前账号没有管理客户端版本的权限"); });
  await panel.settle(); await panel.click("编辑备用链接");
  await panel.fill("备用下载链接", "https://pan.example/retry"); await panel.submit();
  assert.match(panel.content(), /当前账号没有管理客户端版本的权限/);
  assert.equal(panel.value("备用下载链接"), "https://pan.example/retry");
  assert.equal(panel.all((node) => node.type === "button" && panel.text(node) === "保存备用链接")[0].props.disabled, false);
  fail = false;
  await panel.submit();
  assert.match(panel.content(), /备用下载链接已更新/);
  assert.equal(panel.all((node) => node.props.role === "dialog").length, 0);
});

test("old API responses without a backup URL remain editable and default to empty", async () => {
  const old = release("old", "PUBLISHED");
  delete old.backup_download_url;
  const panel = releasePanel([old]);
  await panel.settle();
  assert.match(panel.content(), /备用下载：未配置/);
  await panel.click("编辑备用链接");
  assert.equal(panel.value("备用下载链接"), "");
});
