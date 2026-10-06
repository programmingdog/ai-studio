"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiRequest, apiUpload } from "@/lib/api";
import { formatDatabaseDateTime } from "@/lib/admin-date-time";
import { tutorialMediaUrl, validateTutorialFile } from "@/lib/tutorial-media";
import { emptyViralTemplate, validateViralTemplate, viralTemplateForm, viralManagedMediaUrl, type ViralCategory, type ViralCategoryForm, type ViralMedia, type ViralRemakeType, type ViralReplacementElement, type ViralTemplate, type ViralTemplateForm, type ViralTemplateList } from "@/lib/viral-remakes";

const route = "/admin/viral-remakes";
const errorText = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
const newCategory = (): ViralCategoryForm => ({ code: "", name: "", description: "", sort_order: 0, status: "ACTIVE" });
const categoryForm = (item: ViralCategory): ViralCategoryForm => ({ code: item.code, name: item.name, description: item.description || "", sort_order: item.sort_order, status: item.status });
const typeLabels: Record<ViralRemakeType, string> = { FANS: "爆粉爆款视频", COMMERCE: "带货爆款视频" };

export function ViralRemakesPanel({ token }: { token: string }) {
  const [type, setType] = useState<ViralRemakeType>("FANS");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const switchType = (next: ViralRemakeType) => {
    if (next === type || busy || (dirty && !window.confirm("有尚未保存的修改，确定切换类型并放弃这些修改吗？"))) return;
    setDirty(false); setType(next);
  };
  return <div className="viral-remakes-admin">
    <section className="workspace-tabs-header"><div><span className="kicker">VIRAL REMAKES</span><h2>爆款复刻</h2><p>按题材或商品分类维护爆款视频、完整剧本与可替换元素，启用后客户端可选用。</p></div><div className="workspace-tab-list" role="tablist" aria-label="爆款视频类型">{(["FANS", "COMMERCE"] as const).map((value) => <button id={`viral-tab-${value}`} aria-controls="viral-management-content" key={value} type="button" role="tab" aria-selected={type === value} tabIndex={type === value ? 0 : -1} className={type === value ? "active" : ""} disabled={busy} onClick={() => switchType(value)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "FANS" : event.key === "End" ? "COMMERCE" : type === "FANS" ? "COMMERCE" : "FANS"; switchType(next); document.getElementById(`viral-tab-${next}`)?.focus(); } }}>{typeLabels[value]}</button>)}</div></section>
    <div id="viral-management-content" role="tabpanel" aria-labelledby={`viral-tab-${type}`}><ViralTypeWorkspace key={type} token={token} type={type} onBusyChange={setBusy} onDirtyChange={setDirty} /></div>
  </div>;
}

function ViralTypeWorkspace({ token, type, onBusyChange, onDirtyChange }: { token: string; type: ViralRemakeType; onBusyChange: (value: boolean) => void; onDirtyChange: (value: boolean) => void }) {
  const [categories, setCategories] = useState<ViralCategory[]>([]);
  const [categoryLoading, setCategoryLoading] = useState(true);
  const [categoryError, setCategoryError] = useState("");
  const [categoryRevision, setCategoryRevision] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [categoryEditor, setCategoryEditor] = useState<{ item: ViralCategory | null; form: ViralCategoryForm } | null>(null);
  const [categoryDirty, setCategoryDirty] = useState(false);
  const [list, setList] = useState<ViralTemplateList>({ items: [], page: 1, page_size: 10, total: 0, total_pages: 0 });
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState<ViralTemplate | null>(null);
  const [form, setForm] = useState<ViralTemplateForm>(() => emptyViralTemplate());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [upload, setUpload] = useState<{ name: string; percent: number; kind: "IMAGE" | "VIDEO" } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(false);
  const alive = useRef(true);
  const mutation = useRef(false);
  const detailRequest = useRef(0);
  const uploadController = useRef<AbortController | null>(null);
  const busy = saving || detailLoading || Boolean(upload);

  useEffect(() => { alive.current = true; return () => { alive.current = false; detailRequest.current += 1; uploadController.current?.abort(); }; }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange(dirty || categoryDirty); }, [dirty, categoryDirty, onDirtyChange]);
  useEffect(() => {
    const controller = new AbortController(); setCategoryLoading(true); setCategoryError("");
    apiRequest<ViralCategory[]>(`${route}/categories?type=${type}`, { signal: controller.signal }, token)
      .then((items) => { if (!controller.signal.aborted) { setCategories(items); setCategoryFilter((value) => items.some((item) => item.id === value) ? value : ""); } })
      .catch((reason) => { if (!controller.signal.aborted) setCategoryError(errorText(reason, "分类读取失败")); })
      .finally(() => { if (!controller.signal.aborted) setCategoryLoading(false); });
    return () => controller.abort();
  }, [type, token, categoryRevision]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setListError("");
    const params = new URLSearchParams({ type, page: String(page), page_size: "10", q: query });
    if (categoryFilter) params.set("category", categoryFilter); if (status) params.set("status", status);
    apiRequest<ViralTemplateList>(`${route}/templates?${params}`, { signal: controller.signal }, token)
      .then((result) => { if (!controller.signal.aborted) { setList(result); const next = Math.min(page, Math.max(1, result.total_pages)); if (next !== page) setPage(next); } })
      .catch((reason) => { if (!controller.signal.aborted) setListError(errorText(reason, "爆款视频列表读取失败")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [type, token, categoryFilter, query, page, revision, status]);

  const changeForm = (values: Partial<ViralTemplateForm>) => { setForm((current) => ({ ...current, ...values })); setDirty(true); setMessage(""); };
  const changeElement = (id: string, values: Partial<ViralReplacementElement>) => { setForm((current) => ({ ...current, replacement_elements: current.replacement_elements.map((element) => element.id === id ? { ...element, ...values } : element) })); setDirty(true); setMessage(""); };
  const discard = () => !dirty || window.confirm("当前爆款视频有尚未保存的修改，确定放弃这些修改吗？");
  const createTemplate = () => {
    if (busy || mutation.current || !discard()) return;
    detailRequest.current += 1; setSelected(null); setForm(emptyViralTemplate(categoryFilter || categories.find((item) => item.status === "ACTIVE")?.id)); setDirty(false); setError(""); setMessage(""); setPreview(false);
  };
  const choose = async (id: string) => {
    if (busy || mutation.current || !discard()) return;
    const request = ++detailRequest.current; setDetailLoading(true); setError(""); setMessage("");
    try {
      const item = await apiRequest<ViralTemplate>(`${route}/templates/${encodeURIComponent(id)}`, {}, token);
      if (alive.current && request === detailRequest.current) { setSelected(item); setForm(viralTemplateForm(item)); setDirty(false); setPreview(false); }
    } catch (reason) { if (alive.current && request === detailRequest.current) setError(errorText(reason, "爆款视频详情读取失败")); }
    finally { if (alive.current && request === detailRequest.current) setDetailLoading(false); }
  };
  const uploadMedia = useCallback(async (file: File, kind: "IMAGE" | "VIDEO", elementId?: string) => {
    if (mutation.current || uploadController.current) return;
    setError(""); setMessage("");
    try { validateTutorialFile(file, kind); if (kind === "IMAGE" && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("可替换元素原图仅支持 JPG、PNG 或 WebP 图片"); } catch (reason) { setError(errorText(reason, "文件无效")); return; }
    const controller = new AbortController(); uploadController.current = controller; setUpload({ name: file.name, kind, percent: 0 });
    try {
      const result = await apiUpload<ViralMedia>(`${route}/media`, file, token, (percent) => { if (alive.current) setUpload({ name: file.name, kind, percent }); }, controller.signal);
      if (!viralManagedMediaUrl(result.url) || result.media_type !== kind) throw new Error("上传返回了无效媒体地址或类型");
      if (!alive.current) return;
      setForm((current) => kind === "VIDEO" ? { ...current, video_url: result.url } : { ...current, replacement_elements: current.replacement_elements.map((element) => element.id === elementId ? { ...element, image_url: result.url } : element) });
      setDirty(true); setMessage(`${kind === "VIDEO" ? "视频" : "元素原图"}已上传，请保存爆款视频以生效。`);
    } catch (reason) { if (alive.current && !(reason instanceof DOMException && reason.name === "AbortError")) setError(errorText(reason, "媒体上传失败")); }
    finally { uploadController.current = null; if (alive.current) setUpload(null); }
  }, [token]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (busy || mutation.current) return; setError(""); setMessage("");
    let body: ViralTemplateForm;
    try { body = validateViralTemplate(form, categories); } catch (reason) { setError(errorText(reason, "请检查爆款视频内容")); return; }
    mutation.current = true; setSaving(true);
    try {
      const item = await apiRequest<ViralTemplate>(selected ? `${route}/templates/${encodeURIComponent(selected.id)}` : `${route}/templates`, { method: selected ? "PATCH" : "POST", body: JSON.stringify(body) }, token);
      if (!alive.current) return; setSelected(item); setForm(viralTemplateForm(item)); setDirty(false); setRevision((value) => value + 1); setCategoryRevision((value) => value + 1); setMessage(item.status === "ACTIVE" ? "爆款视频已保存并启用，客户端可以查看。" : "爆款视频已保存并停用。");
    } catch (reason) { if (alive.current) setError(errorText(reason, "保存失败，请重试")); }
    finally { mutation.current = false; if (alive.current) setSaving(false); }
  };
  const remove = async () => {
    if (!selected || busy || mutation.current || !window.confirm(`确定删除爆款视频“${selected.title}”吗？删除后无法恢复。`)) return;
    mutation.current = true; setSaving(true); setError(""); setMessage("");
    try {
      await apiRequest(`${route}/templates/${encodeURIComponent(selected.id)}`, { method: "DELETE" }, token);
      if (!alive.current) return; setSelected(null); setForm(emptyViralTemplate(categoryFilter)); setDirty(false); setPreview(false); setMessage("爆款视频已删除"); setRevision((value) => value + 1); setCategoryRevision((value) => value + 1);
    } catch (reason) { if (alive.current) setError(errorText(reason, "删除失败")); }
    finally { mutation.current = false; if (alive.current) setSaving(false); }
  };
  const editCategory = (item: ViralCategory | null) => {
    if (busy || mutation.current || (categoryDirty && !window.confirm("分类有尚未保存的修改，确定放弃这些修改吗？"))) return;
    setCategoryEditor({ item, form: item ? categoryForm(item) : newCategory() }); setCategoryDirty(false); setError(""); setMessage("");
  };
  const saveCategory = async (event: FormEvent) => {
    event.preventDefault(); if (!categoryEditor || busy || mutation.current) return; setError(""); setMessage("");
    const body = { ...categoryEditor.form, type, code: categoryEditor.form.code.trim(), name: categoryEditor.form.name.trim(), description: categoryEditor.form.description.trim() };
    if (!body.name || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(body.code) || !Number.isInteger(body.sort_order) || body.sort_order < 0 || body.sort_order > 100_000) { setError("请填写分类名称、有效的英文标识和 0 至 100000 的整数排序值"); return; }
    mutation.current = true; setSaving(true);
    try {
      const item = await apiRequest<ViralCategory>(categoryEditor.item ? `${route}/categories/${encodeURIComponent(categoryEditor.item.id)}` : `${route}/categories`, { method: categoryEditor.item ? "PATCH" : "POST", body: JSON.stringify(body) }, token);
      if (!alive.current) return; setCategoryEditor({ item, form: categoryForm(item) }); setCategoryDirty(false); setCategoryRevision((value) => value + 1); setRevision((value) => value + 1); setMessage("分类已保存");
    } catch (reason) { if (alive.current) setError(errorText(reason, "分类保存失败")); }
    finally { mutation.current = false; if (alive.current) setSaving(false); }
  };
  const removeCategory = async (item: ViralCategory) => {
    if (busy || mutation.current || !window.confirm(`确定删除分类“${item.name}”吗？分类下已有视频时需先移动或删除这些视频。`)) return;
    mutation.current = true; setSaving(true); setError(""); setMessage("");
    try {
      await apiRequest(`${route}/categories/${encodeURIComponent(item.id)}`, { method: "DELETE" }, token);
      if (!alive.current) return; if (categoryEditor?.item?.id === item.id) { setCategoryEditor(null); setCategoryDirty(false); } setCategoryRevision((value) => value + 1); setRevision((value) => value + 1); setMessage("分类已删除");
    } catch (reason) { if (alive.current) setError(errorText(reason, "分类删除失败")); }
    finally { mutation.current = false; if (alive.current) setSaving(false); }
  };

  return <div className="viral-workspace">
    <section className="viral-category-card"><header><div><span className="kicker">{type === "FANS" ? "POPULAR THEMES" : "PRODUCT CATEGORIES"}</span><h3>{type === "FANS" ? "题材与场景分类" : "商品与场景分类"}</h3><p>停用分类后，该分类的视频不会出现在客户端。</p></div><button type="button" className="secondary" disabled={busy} onClick={() => editCategory(null)}>新增分类</button></header>
      {categoryError ? <div role="alert" className="form-error">{categoryError}<button type="button" className="secondary" onClick={() => setCategoryRevision((value) => value + 1)}>重新读取分类</button></div> : categoryLoading ? <p role="status">正在读取分类…</p> : categories.length ? <div className="viral-category-list">{categories.map((item) => <div key={item.id} className={categoryFilter === item.id ? "selected" : ""}><button type="button" className="viral-category-name" disabled={busy} aria-pressed={categoryFilter === item.id} onClick={() => { setCategoryFilter(categoryFilter === item.id ? "" : item.id); setPage(1); }}><strong>{item.name}</strong><span>{item.template_count} 个视频 · {item.status === "ACTIVE" ? "启用" : "停用"}</span></button><button type="button" className="secondary" disabled={busy} aria-label={`编辑分类 ${item.name}`} onClick={() => editCategory(item)}>编辑</button><button type="button" className="danger" disabled={busy} aria-label={`删除分类 ${item.name}`} onClick={() => void removeCategory(item)}>删除</button></div>)}</div> : <p className="viral-empty">暂无分类，请先新增一个分类。</p>}
      {categoryEditor && <form className="viral-category-editor" onSubmit={saveCategory}><h4>{categoryEditor.item ? `编辑分类 · ${categoryEditor.item.name}` : "新增分类"}</h4><fieldset disabled={busy}><div className="viral-form-row"><label>分类名称<input value={categoryEditor.form.name} maxLength={100} required onChange={(event) => { setCategoryEditor({ ...categoryEditor, form: { ...categoryEditor.form, name: event.target.value } }); setCategoryDirty(true); }} /></label><label>英文标识<input value={categoryEditor.form.code} maxLength={64} pattern="[a-z0-9]+([-_][a-z0-9]+)*" required placeholder="例如 life-drama" onChange={(event) => { setCategoryEditor({ ...categoryEditor, form: { ...categoryEditor.form, code: event.target.value } }); setCategoryDirty(true); }} /><small>小写字母、数字、连字符或下划线，同一类型中不可重复。</small></label></div><label>分类说明<textarea value={categoryEditor.form.description} rows={2} maxLength={1000} onChange={(event) => { setCategoryEditor({ ...categoryEditor, form: { ...categoryEditor.form, description: event.target.value } }); setCategoryDirty(true); }} /></label><div className="viral-form-row"><label>分类状态<select value={categoryEditor.form.status} onChange={(event) => { setCategoryEditor({ ...categoryEditor, form: { ...categoryEditor.form, status: event.target.value as ViralCategoryForm["status"] } }); setCategoryDirty(true); }}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label><label>分类排序<input type="number" min={0} max={100000} step={1} value={categoryEditor.form.sort_order} onChange={(event) => { setCategoryEditor({ ...categoryEditor, form: { ...categoryEditor.form, sort_order: Number(event.target.value) } }); setCategoryDirty(true); }} /></label></div></fieldset><footer><button type="button" className="secondary" disabled={busy} onClick={() => { if (!categoryDirty || window.confirm("确定放弃尚未保存的分类修改吗？")) { setCategoryEditor(null); setCategoryDirty(false); } }}>关闭分类编辑</button><button type="submit" className="primary" disabled={busy}>{saving ? "正在保存…" : "保存分类"}</button></footer></form>}
    </section>
    {error && <div className="form-error" role="alert">{error}</div>}{message && <div className="form-success" role="status">{message}</div>}
    {upload && <div className="viral-upload-progress" role="status"><div><strong>正在上传{upload.kind === "VIDEO" ? "视频" : "原图"} · {upload.percent}%</strong><button type="button" className="secondary" onClick={() => uploadController.current?.abort()}>取消上传</button></div><progress value={upload.percent} max={100} aria-label="爆款媒体上传进度" /><small>{upload.name}{upload.percent === 100 ? " · 正在处理，请稍候…" : ""}</small></div>}
    <div className="viral-template-columns"><section className="viral-template-list-card"><header><div><span className="kicker">VIDEO LIBRARY</span><h3>{typeLabels[type]}</h3></div><button className="secondary" type="button" onClick={createTemplate} disabled={busy || categoryLoading || !categories.length}>新增爆款视频</button></header><form className="viral-filters" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); setPage(1); setRevision((value) => value + 1); }}><label>所属分类<select value={categoryFilter} disabled={busy || categoryLoading} onChange={(event) => { setCategoryFilter(event.target.value); setPage(1); }}><option value="">全部分类</option>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}{category.status === "DISABLED" ? "（停用）" : ""}</option>)}</select></label><label>视频状态<select value={status} disabled={busy} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">全部状态</option><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label><label className="viral-search">搜索标题<input value={search} disabled={busy} maxLength={200} placeholder="输入爆款视频标题" onChange={(event) => setSearch(event.target.value)} /></label><button type="submit" className="secondary" disabled={busy || loading}>搜索</button></form>
      {listError ? <div className="form-error" role="alert">{listError}<button type="button" className="secondary" onClick={() => setRevision((value) => value + 1)}>重新读取视频</button></div> : loading ? <p className="viral-empty" role="status">正在读取爆款视频…</p> : list.items.length ? <div className="viral-template-list">{list.items.map((item) => <button key={item.id} type="button" className={selected?.id === item.id ? "selected" : ""} disabled={busy} aria-pressed={selected?.id === item.id} onClick={() => void choose(item.id)}><strong>{item.title}</strong><span><b className={`status ${item.status === "ACTIVE" ? "good" : "warn"}`}>{item.status === "ACTIVE" ? "启用" : "停用"}</b><small>{item.category_name} · {item.replacement_elements.length} 个可替换元素</small></span><small>排序 {item.sort_order} · {formatDatabaseDateTime(item.updated_at)}</small></button>)}</div> : <p className="viral-empty">{query || categoryFilter || status ? "当前筛选下没有爆款视频。" : "暂无爆款视频，点击“新增爆款视频”开始创建。"}</p>}
      <nav className="viral-pagination" aria-label="爆款视频分页"><span>共 {list.total} 条 · 每页 10 条</span><div><button type="button" className="secondary" disabled={busy || loading || page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span aria-live="polite">{page} / {Math.max(1, list.total_pages)}</span><button type="button" className="secondary" disabled={busy || loading || page >= list.total_pages} onClick={() => setPage(page + 1)}>下一页</button></div></nav>
    </section>
    <form className="viral-template-editor" onSubmit={save}><header><div><span className="kicker">{selected ? "EDIT VIDEO" : "NEW VIDEO"}</span><h3>{detailLoading ? "正在读取详情…" : selected ? "编辑爆款视频" : "创建爆款视频"}</h3><p>{selected ? `最近更新：${formatDatabaseDateTime(selected.updated_at)}` : "先上传原视频，再填写剧本与需要替换的角色或道具。"}</p></div><button type="button" className="secondary" disabled={busy} aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? "继续编辑" : "预览内容"}</button></header><fieldset disabled={busy || categoryLoading} aria-busy={busy}>
      <label>视频标题<input value={form.title} maxLength={200} required placeholder="例如：反转职场小剧场" onChange={(event) => changeForm({ title: event.target.value })} /></label><div className="viral-form-row"><label>所属分类<select value={form.category_id} required onChange={(event) => changeForm({ category_id: event.target.value })}><option value="">请选择分类</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}{item.status === "DISABLED" ? "（停用）" : ""}</option>)}</select></label><label>视频状态<select value={form.status} onChange={(event) => changeForm({ status: event.target.value as ViralTemplateForm["status"] })}><option value="ACTIVE">启用 · 客户端可见</option><option value="DISABLED">停用 · 仅后台可见</option></select></label></div><label>内容简介<textarea rows={2} value={form.summary} maxLength={1000} placeholder="介绍适用的场景、创作亮点或商品卖点" onChange={(event) => changeForm({ summary: event.target.value })} /></label>
      <div className="viral-video-field"><label>上传爆款视频<input type="file" accept="video/mp4,video/webm" aria-label="上传爆款视频" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadMedia(file, "VIDEO"); }} /><small>支持 MP4、WebM，单个视频不超过 500MB。{form.video_url ? "已上传，重新选择将替换视频。" : "保存前必须上传视频。"}</small></label>{form.video_url && <video src={tutorialMediaUrl(form.video_url)} controls playsInline preload="metadata" aria-label="原爆款视频预览">当前浏览器不支持视频播放。</video>}</div><label>原视频分享链接（选填）<input type="url" value={form.original_share_url || ""} maxLength={2000} placeholder="https://…" onChange={(event) => changeForm({ original_share_url: event.target.value || null })} /><small>用于记录原视频来源，客户端可以打开该分享链接。</small></label>
      {preview ? <article className="viral-content-preview"><h4>{form.title || "未填写标题"}</h4><p>{form.summary}</p><h5>视频剧本</h5><pre>{form.script_content || "尚未填写剧本"}</pre></article> : <label>视频剧本<textarea className="viral-script" rows={12} value={form.script_content} maxLength={100000} required placeholder="完整记录每个镜头的画面、动作、台词、运镜及节奏。可用角色或道具名称说明需要替换的位置。" onChange={(event) => changeForm({ script_content: event.target.value })} /></label>}
      <section className="viral-elements"><header><div><h4>可替换元素</h4><p>客户端会提示用户按名称上传替换图片；原图可以不上传。</p></div><button type="button" className="secondary" disabled={form.replacement_elements.length >= 20} onClick={() => changeForm({ replacement_elements: [...form.replacement_elements, { id: crypto.randomUUID(), type: "CHARACTER", name: "", description: "", image_url: null }] })}>添加元素</button></header>{!form.replacement_elements.length && <p className="viral-empty">暂无可替换元素，可添加角色或道具。</p>}{form.replacement_elements.map((element, index) => <div key={element.id} className="viral-element-card"><header><strong>元素 {index + 1}</strong><button type="button" className="danger" aria-label={`移除元素 ${index + 1}`} onClick={() => changeForm({ replacement_elements: form.replacement_elements.filter((item) => item.id !== element.id) })}>移除元素</button></header><div className="viral-form-row"><label>元素类型<select value={element.type} onChange={(event) => changeElement(element.id, { type: event.target.value as ViralReplacementElement["type"] })}><option value="CHARACTER">角色图</option><option value="PROP">道具图</option></select></label><label>元素名称<input value={element.name} required maxLength={100} placeholder="例如：女主角 / 主推商品" onChange={(event) => changeElement(element.id, { name: event.target.value })} /></label></div><label>替换说明<textarea rows={2} value={element.description} maxLength={2000} placeholder="说明对应哪个角色或道具，以及需要保留的特征" onChange={(event) => changeElement(element.id, { description: event.target.value })} /></label><div className="viral-element-media">{element.image_url && <img src={tutorialMediaUrl(element.image_url)} alt={`${element.name || `元素 ${index + 1}`}原图`} />}<label>上传元素 {index + 1} 原图（选填）<input type="file" accept="image/jpeg,image/png,image/webp" aria-label={`上传元素 ${index + 1} 原图`} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadMedia(file, "IMAGE", element.id); }} /><small>JPG、PNG、WebP，不超过 10MB。</small></label>{element.image_url && <button type="button" className="secondary" onClick={() => changeElement(element.id, { image_url: null })}>移除原图</button>}</div></div>)}</section>
      <label>视频排序<input type="number" value={form.sort_order} min={0} max={100000} step={1} onChange={(event) => changeForm({ sort_order: Number(event.target.value) })} /><small>排序值越小，越靠前显示。</small></label>
    </fieldset><footer>{selected && <button className="danger" type="button" disabled={busy} onClick={() => void remove()}>删除爆款视频</button>}<span>{dirty ? "有尚未保存的修改" : selected ? "修改已保存" : ""}</span><button type="submit" className="primary" disabled={busy || categoryLoading || !categories.length}>{saving ? "正在保存…" : "保存爆款视频"}</button></footer></form></div>
  </div>;
}
