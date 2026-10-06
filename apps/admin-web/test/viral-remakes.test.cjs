const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function loadModel(apiBase = "http://localhost:3101/api/v1", origin = "http://localhost:3200") {
  const compile = (file, dependencies) => {
    const source = fs.readFileSync(path.join(__dirname, `../lib/${file}.ts`), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, URL, Set, window: { location: { origin } }, require: (name) => { assert.ok(name in dependencies); return dependencies[name]; } });
    return exports;
  };
  return compile("viral-remakes", { "./tutorial-media": compile("tutorial-media", { "./api": { API_BASE: apiBase } }) });
}

const media = "/api/v1/tutorials/media/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const category = { id: "fans-category", type: "FANS", name: "职场", status: "ACTIVE" };
const form = () => ({ ...loadModel().emptyViralTemplate(category.id), title: "  职场反转  ", video_url: media, script_content: "  镜头一：主角拿出商品。  ", replacement_elements: [{ id: "lead-actor", type: "CHARACTER", name: "  主角  ", description: "  保留服装  ", image_url: null }] });

test("managed uploads remain portable and arbitrary external media cannot become template artifacts", () => {
  const model = loadModel();
  assert.equal(model.viralManagedMediaUrl(`http://localhost:3101${media}`), media);
  assert.equal(model.viralManagedMediaUrl(media), media);
  for (const invalid of [`https://evil.example${media}`, `http://localhost:3101${media}?token=secret`, "javascript:alert(1)", "/api/v1/tutorials/media/not-a-uuid"]) assert.equal(model.viralManagedMediaUrl(invalid), "");
  assert.equal(loadModel("/api/v1", "https://studio.example").viralManagedMediaUrl(`https://studio.example${media}`), media);
});

test("template save normalizes content while keeping stable slot identities and original form intact", () => {
  const draft = form();
  const result = loadModel().validateViralTemplate(draft, [category]);
  assert.equal(result.title, "职场反转");
  assert.equal(result.replacement_elements[0].id, "lead-actor");
  assert.equal(result.replacement_elements[0].name, "主角");
  assert.equal(result.replacement_elements[0].description, "保留服装");
  assert.equal(result.replacement_elements[0].image_url, null);
  assert.equal(draft.title, "  职场反转  ");
  assert.equal(draft.replacement_elements[0].name, "  主角  ");
});

test("save rejects categories from another tab, missing video/script and unsafe source links", () => {
  const model = loadModel();
  assert.throws(() => model.validateViralTemplate(form(), [{ ...category, id: "commerce-category" }]), /所属分类/);
  assert.throws(() => model.validateViralTemplate({ ...form(), video_url: "" }, [category]), /上传爆款视频/);
  assert.throws(() => model.validateViralTemplate({ ...form(), script_content: " " }, [category]), /视频剧本/);
  for (const link of ["javascript:alert(1)", "https://user:password@example.com/video", "https://example.com/a b", "不是链接"]) assert.throws(() => model.safeViralShareUrl(link), /分享链接/);
  assert.equal(model.safeViralShareUrl(" "), null);
  assert.equal(model.safeViralShareUrl("https://b23.tv/example"), "https://b23.tv/example");
});

test("duplicate or excessive replacement slots and missing names cannot be saved", () => {
  const model = loadModel(); const draft = form(); const slot = draft.replacement_elements[0];
  assert.throws(() => model.validateViralTemplate({ ...draft, replacement_elements: [slot, slot] }, [category]), /重复/);
  assert.throws(() => model.validateViralTemplate({ ...draft, replacement_elements: [{ ...slot, name: " " }] }, [category]), /元素的名称/);
  assert.throws(() => model.validateViralTemplate({ ...draft, replacement_elements: Array.from({ length: 21 }, (_, index) => ({ ...slot, id: String(index) })) }, [category]), /20/);
  assert.throws(() => model.validateViralTemplate({ ...draft, replacement_elements: [{ ...slot, image_url: "https://external.example/original.png" }] }, [category]), /原图地址/);
});

test("readback creates an independent editor draft without changing the saved slot data", () => {
  const saved = { ...form(), id: "video-id", summary: null, original_share_url: "", replacement_elements: [{ id: "item", name: "商品", type: "PROP", description: null, image_url: "" }] };
  const editor = loadModel().viralTemplateForm(saved);
  editor.replacement_elements[0].name = "新的商品";
  assert.equal(saved.replacement_elements[0].name, "商品");
  assert.equal(editor.replacement_elements[0].description, "");
  assert.equal(editor.replacement_elements[0].image_url, null);
  assert.equal(editor.original_share_url, null);
});
