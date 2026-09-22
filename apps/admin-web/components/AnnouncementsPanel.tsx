"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";
import { formatDatabaseDateTime } from "@/lib/admin-date-time";

interface Announcement {
  id: string;
  title: string;
  content: string;
  status: "DRAFT" | "PUBLISHED";
  is_pinned: number | boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  created_by_name?: string | null;
}

const emptyForm = { title: "", content: "<p></p>", is_pinned: false };

export function AnnouncementsPanel({ token }: { token: string }) {
  const [items, setItems] = useState<Announcement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async (preferredId?: string | null) => {
    const rows = await apiRequest<Announcement[]>("/admin/announcements", {}, token);
    setItems(rows);
    const nextId = preferredId === undefined ? selectedId : preferredId;
    if (nextId) {
      const selected = rows.find((item) => item.id === nextId);
      if (selected) {
        setSelectedId(selected.id);
        setForm({ title: selected.title, content: selected.content, is_pinned: Boolean(selected.is_pinned) });
      } else {
        setSelectedId(null);
        setForm(emptyForm);
      }
    }
  }, [selectedId, token]);

  useEffect(() => {
    let active = true;
    apiRequest<Announcement[]>("/admin/announcements", {}, token)
      .then((rows) => { if (active) setItems(rows); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "公告列表读取失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  const choose = (item: Announcement) => {
    setSelectedId(item.id);
    setForm({ title: item.title, content: item.content, is_pinned: Boolean(item.is_pinned) });
    setError(""); setMessage("");
  };
  const createNew = () => { setSelectedId(null); setForm(emptyForm); setError(""); setMessage(""); };
  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setSaving(true); setError(""); setMessage("");
    try {
      const saved = await apiRequest<Announcement>(selectedId ? `/admin/announcements/${selectedId}` : "/admin/announcements", {
        method: selectedId ? "PATCH" : "POST", body: JSON.stringify(form),
      }, token);
      setSelectedId(saved.id);
      setMessage(selectedId ? "公告修改已保存" : "公告草稿已创建");
      await load(saved.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "公告保存失败"); }
    finally { setSaving(false); }
  };
  const changeStatus = async (action: "publish" | "unpublish") => {
    if (!selectedId) return;
    setSaving(true); setError(""); setMessage("");
    try {
      if (action === "publish") {
        await apiRequest(`/admin/announcements/${selectedId}`, { method: "PATCH", body: JSON.stringify(form) }, token);
      }
      await apiRequest(`/admin/announcements/${selectedId}/${action}`, { method: "POST", body: "{}" }, token);
      setMessage(action === "publish" ? "公告已发布，客户端现在可以看到" : "公告已撤回为草稿");
      await load(selectedId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "公告状态更新失败"); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!selectedId || !window.confirm("确定删除这条通知公告吗？删除后无法恢复。")) return;
    setSaving(true); setError(""); setMessage("");
    try {
      await apiRequest(`/admin/announcements/${selectedId}`, { method: "DELETE" }, token);
      setSelectedId(null); setForm(emptyForm); setMessage("公告已删除"); await load(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "公告删除失败"); }
    finally { setSaving(false); }
  };

  const selected = items.find((item) => item.id === selectedId);
  return <div className="announcement-workspace">
    <section className="announcement-list-card">
      <header><div><span className="kicker">CLIENT NOTICES</span><h2>通知公告</h2><p>草稿仅后台可见，发布后进入客户端最近 100 条公告。</p></div><button className="secondary" type="button" onClick={createNew}>新建公告</button></header>
      {loading ? <div className="announcement-empty">正在读取公告…</div> : items.length ? <div className="announcement-list">{items.map((item) => <button type="button" key={item.id} className={item.id === selectedId ? "selected" : ""} onClick={() => choose(item)}>
        <span className="announcement-list-title">{Boolean(item.is_pinned) && <i>置顶</i>}<strong>{item.title}</strong></span>
        <span><b className={`status ${item.status === "PUBLISHED" ? "good" : "warn"}`}>{item.status === "PUBLISHED" ? "已发布" : "草稿"}</b><small>{formatDatabaseDateTime(item.published_at || item.updated_at)}</small></span>
      </button>)}</div> : <div className="announcement-empty">还没有公告，点击“新建公告”开始创建。</div>}
    </section>
    <form className="announcement-editor-card" onSubmit={save}>
      <header><div><span className="kicker">{selected ? "EDIT ANNOUNCEMENT" : "NEW ANNOUNCEMENT"}</span><h2>{selected ? "编辑公告" : "创建公告草稿"}</h2><p>{selected ? `最近更新：${formatDatabaseDateTime(selected.updated_at)}` : "填写标题和正文，保存后再发布。"}</p></div>{selected && <span className={`status ${selected.status === "PUBLISHED" ? "good" : "warn"}`}>{selected.status === "PUBLISHED" ? "已发布" : "草稿"}</span>}</header>
      <label>公告标题<input value={form.title} maxLength={200} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="输入简洁清晰的公告标题" required /></label>
      <label className="announcement-pin"><input type="checkbox" checked={form.is_pinned} onChange={(event) => setForm({ ...form, is_pinned: event.target.checked })} /><span><strong>置顶公告</strong><small>客户端列表中优先展示。</small></span></label>
      <div className="rich-editor-field"><span>公告正文</span><RichTextEditor value={form.content} onChange={(content) => setForm((current) => ({ ...current, content }))} /></div>
      {error && <div className="form-error" role="alert">{error}</div>}{message && <div className="form-success" role="status">{message}</div>}
      <footer>{selectedId && <button className="danger" type="button" onClick={remove} disabled={saving}>删除</button>}<span />{selected?.status === "PUBLISHED" && <button className="secondary" type="button" onClick={() => void changeStatus("unpublish")} disabled={saving}>撤回为草稿</button>}<button className="secondary" type="submit" disabled={saving}>{saving ? "正在保存…" : selectedId ? "保存修改" : "保存草稿"}</button>{selectedId && selected?.status !== "PUBLISHED" && <button className="primary" type="button" onClick={() => void changeStatus("publish")} disabled={saving}>发布公告</button>}</footer>
    </form>
  </div>;
}

function RichTextEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const editor = useRef<HTMLDivElement>(null);
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaType, setMediaType] = useState<"image" | "video">("image");
  useEffect(() => { if (editor.current && editor.current.innerHTML !== value) editor.current.innerHTML = value; }, [value]);
  const command = (name: string, commandValue?: string) => {
    editor.current?.focus(); document.execCommand(name, false, commandValue);
    if (editor.current) onChange(editor.current.innerHTML);
  };
  const insertMedia = () => {
    let parsed: URL;
    try { parsed = new URL(mediaUrl); } catch { window.alert("请输入完整的图片或视频 URL"); return; }
    if (!["https:", "http:"].includes(parsed.protocol)) { window.alert("媒体地址仅支持 HTTP 或 HTTPS"); return; }
    const escaped = parsed.toString().replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    command("insertHTML", mediaType === "image" ? `<figure><img src="${escaped}" alt="公告图片" loading="lazy"><figcaption>图片说明</figcaption></figure>` : `<figure><video src="${escaped}" controls preload="metadata"></video><figcaption>视频说明</figcaption></figure>`);
    setMediaUrl("");
  };
  return <div className="rich-editor">
    <div className="rich-editor-toolbar" role="toolbar" aria-label="富文本编辑工具">
      <button type="button" onMouseDown={(event) => { event.preventDefault(); command("bold"); }}><b>B</b><span className="sr-only">加粗</span></button>
      <button type="button" onMouseDown={(event) => { event.preventDefault(); command("italic"); }}><i>I</i><span className="sr-only">斜体</span></button>
      <button type="button" onMouseDown={(event) => { event.preventDefault(); command("formatBlock", "h2"); }}>标题</button>
      <button type="button" onMouseDown={(event) => { event.preventDefault(); command("formatBlock", "p"); }}>正文</button>
      <button type="button" onMouseDown={(event) => { event.preventDefault(); command("insertUnorderedList"); }}>列表</button>
      <button type="button" onMouseDown={(event) => { event.preventDefault(); command("formatBlock", "blockquote"); }}>引用</button>
    </div>
    <div ref={editor} className="rich-editor-content" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="公告正文富文本编辑器" onInput={(event) => onChange(event.currentTarget.innerHTML)} onPaste={(event) => { event.preventDefault(); command("insertText", event.clipboardData.getData("text/plain")); }} />
    <div className="rich-editor-media"><select aria-label="媒体类型" value={mediaType} onChange={(event) => setMediaType(event.target.value as "image" | "video")}><option value="image">图片</option><option value="video">视频</option></select><input aria-label="媒体地址" value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} placeholder="https://…" /><button type="button" className="secondary" onClick={insertMedia} disabled={!mediaUrl.trim()}>插入媒体</button></div>
    <small>粘贴内容按纯文本处理；图片和视频请使用公开可访问的 HTTP(S) 地址，视频不会自动播放。</small>
  </div>;
}
