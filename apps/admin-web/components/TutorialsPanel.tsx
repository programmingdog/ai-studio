"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, apiUpload } from "@/lib/api";
import { formatDatabaseDateTime } from "@/lib/admin-date-time";
import { sanitizeTutorialHtml, tutorialBilibiliInput, tutorialBilibiliUrl, tutorialMediaUrl, validateTutorialFile } from "@/lib/tutorial-media";
import { TutorialRichTextEditor } from "@/components/TutorialRichTextEditor";

type VideoType = "NONE" | "UPLOAD" | "BILIBILI";
type TutorialForm = { title: string; content: string; video_type: VideoType; video_url: string | null; status: "DRAFT" | "PUBLISHED"; sort_order: number };
type Tutorial = TutorialForm & { id: string; created_at: string; updated_at: string; published_at: string | null };
type TutorialList = { items: Tutorial[]; page: number; page_size: number; total: number; page_count: number };
type TutorialMedia = { id: string; url: string; mime_type: string; media_type: "IMAGE" | "VIDEO"; original_name: string; size: number };
const emptyForm: TutorialForm = { title: "", content: "<p></p>", video_type: "NONE", video_url: null, status: "PUBLISHED", sort_order: 0 };
const formFromTutorial = (item: Tutorial): TutorialForm => ({ title: item.title, content: item.content, video_type: item.video_type, video_url: item.video_url, status: item.status, sort_order: item.sort_order });
const errorText = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

export function TutorialsPanel({ token }: { token: string }) {
  const [list, setList] = useState<TutorialList>({ items: [], page: 1, page_size: 10, total: 0, page_count: 0 });
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState<Tutorial | null>(null);
  const [form, setForm] = useState<TutorialForm>(emptyForm);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [upload, setUpload] = useState<{ kind: "IMAGE" | "VIDEO"; name: string; percent: number } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(false);
  const [fullWindow, setFullWindow] = useState(false);
  const mutationActive = useRef(false);
  const alive = useRef(true);
  const detailRequest = useRef(0);
  const uploadAbort = useRef<AbortController | null>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLDivElement>(null);
  const closePlayer = useRef<HTMLButtonElement>(null);
  const playerReturnFocus = useRef<HTMLElement | null>(null);
  const busy = saving || detailLoading || Boolean(upload);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; detailRequest.current += 1; uploadAbort.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!fullWindow) return;
    closePlayer.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setFullWindow(false); } };
    const keepFocus = (event: FocusEvent) => { if (event.target instanceof Node && !player.current?.contains(event.target)) closePlayer.current?.focus(); };
    document.addEventListener("keydown", escape);
    document.addEventListener("focusin", keepFocus);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", escape); document.removeEventListener("focusin", keepFocus); document.body.style.overflow = previousOverflow; playerReturnFocus.current?.focus(); };
  }, [fullWindow]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setListError("");
    apiRequest<TutorialList>(`/admin/tutorials?page=${page}&query=${encodeURIComponent(query)}`, { signal: controller.signal }, token)
      .then((result) => { if (!controller.signal.aborted) { setList(result); const nextPage = Math.min(Math.max(1, result.page), Math.max(1, result.page_count)); if (nextPage !== page) setPage(nextPage); } })
      .catch((reason) => { if (!controller.signal.aborted) setListError(errorText(reason, "教程列表读取失败")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, query, revision, token]);

  const choose = async (id: string) => {
    if (busy || mutationActive.current) return;
    const request = ++detailRequest.current;
    setDetailLoading(true); setError(""); setMessage(""); setPreview(false);
    try {
      const result = await apiRequest<Tutorial>(`/admin/tutorials/${encodeURIComponent(id)}`, {}, token);
      if (alive.current && request === detailRequest.current) { setSelected(result); setForm(formFromTutorial(result)); }
    } catch (reason) { if (alive.current && request === detailRequest.current) setError(errorText(reason, "教程详情读取失败")); }
    finally { if (alive.current && request === detailRequest.current) setDetailLoading(false); }
  };
  const createNew = () => {
    if (busy || mutationActive.current) return;
    detailRequest.current += 1; setSelected(null); setForm({ ...emptyForm }); setError(""); setMessage(""); setPreview(false);
  };

  const uploadMedia = useCallback(async (file: File, kind: "IMAGE" | "VIDEO") => {
    if (mutationActive.current || uploadAbort.current) throw new Error("请等待当前操作完成");
    validateTutorialFile(file, kind);
    const controller = new AbortController(); uploadAbort.current = controller;
    setUpload({ kind, name: file.name, percent: 0 }); setError(""); setMessage("");
    try {
      const result = await apiUpload<TutorialMedia>("/admin/tutorials/media", file, token, (percent) => {
        if (alive.current) setUpload({ kind, name: file.name, percent });
      }, controller.signal);
      if (result.media_type !== kind || !tutorialMediaUrl(result.url)) throw new Error("媒体上传返回了无效地址或类型");
      return result.url;
    } finally { uploadAbort.current = null; if (alive.current) setUpload(null); }
  }, [token]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || mutationActive.current) return;
    setError(""); setMessage("");
    let videoUrl = form.video_url;
    try {
      if (!form.title.trim()) throw new Error("请输入教程标题");
      if (!Number.isInteger(form.sort_order) || form.sort_order < 0 || form.sort_order > 100_000) throw new Error("排序值须为 0 至 100000 的整数");
      if (form.video_type === "BILIBILI") videoUrl = tutorialBilibiliInput(videoUrl || "");
      if (form.video_type === "UPLOAD" && !tutorialMediaUrl(videoUrl)) throw new Error("请先上传教程视频");
      if (form.video_type === "NONE") videoUrl = null;
    } catch (reason) { setError(errorText(reason, "请检查教程内容")); return; }
    mutationActive.current = true; setSaving(true);
    try {
      const result = await apiRequest<Tutorial>(selected ? `/admin/tutorials/${encodeURIComponent(selected.id)}` : "/admin/tutorials", {
        method: selected ? "PATCH" : "POST", body: JSON.stringify({ ...form, title: form.title.trim(), content: sanitizeTutorialHtml(form.content, true), video_url: videoUrl }),
      }, token);
      if (!alive.current) return;
      setSelected(result); setForm(formFromTutorial(result));
      setMessage(result.status === "PUBLISHED" ? "教程已保存并发布，客户端可以查看" : "教程草稿已保存");
      setRevision((current) => current + 1);
    } catch (reason) { if (alive.current) setError(errorText(reason, "教程保存失败")); }
    finally { mutationActive.current = false; if (alive.current) setSaving(false); }
  };
  const remove = async () => {
    if (!selected || busy || mutationActive.current || !window.confirm(`确定删除教程“${selected.title}”吗？删除后无法恢复。`)) return;
    mutationActive.current = true; setSaving(true); setError(""); setMessage("");
    try {
      await apiRequest(`/admin/tutorials/${encodeURIComponent(selected.id)}`, { method: "DELETE" }, token);
      if (!alive.current) return;
      setSelected(null); setForm({ ...emptyForm }); setPreview(false); setMessage("教程已删除");
      if (page > 1 && list.items.length === 1) setPage(page - 1);
      else setRevision((current) => current + 1);
    } catch (reason) { if (alive.current) setError(errorText(reason, "教程删除失败")); }
    finally { mutationActive.current = false; if (alive.current) setSaving(false); }
  };
  const previewHtml = useMemo(() => sanitizeTutorialHtml(form.content), [form.content]);
  const videoPreview = useMemo(() => {
    try { return form.video_type === "BILIBILI" ? tutorialBilibiliUrl(form.video_url || "") : form.video_type === "UPLOAD" ? tutorialMediaUrl(form.video_url) : ""; }
    catch { return ""; }
  }, [form.video_type, form.video_url]);
  const playFullscreen = async () => {
    setError("");
    playerReturnFocus.current = document.activeElement as HTMLElement | null;
    const element = player.current as (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null;
    if (!element) return;
    try {
      if (element.requestFullscreen) await element.requestFullscreen();
      else if (element.webkitRequestFullscreen) await element.webkitRequestFullscreen();
      else throw new Error("当前浏览器不支持全屏播放");
    } catch { setFullWindow(true); }
  };

  return <div className="tutorial-workspace">
    <section className="tutorial-list-card">
      <header><div><span className="kicker">CLIENT TUTORIALS</span><h2>教程管理</h2><p>维护图文和视频教程，发布后显示在客户端。</p></div><button type="button" className="secondary" onClick={createNew} disabled={busy}>新建教程</button></header>
      <form className="tutorial-search" onSubmit={(event) => { event.preventDefault(); if (!busy) { setQuery(search.trim()); setPage(1); setRevision((current) => current + 1); } }}>
        <input aria-label="搜索教程标题" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索教程标题" maxLength={200} disabled={busy} /><button className="secondary" type="submit" disabled={busy || loading}>搜索</button>
      </form>
      {listError ? <div className="tutorial-list-error" role="alert"><p>{listError}</p><button type="button" className="secondary" onClick={() => setRevision((current) => current + 1)}>重试</button></div> : loading ? <div className="tutorial-empty" role="status">正在读取教程…</div> : list.items.length ? <div className="tutorial-list">{list.items.map((item) => <button key={item.id} type="button" className={selected?.id === item.id ? "selected" : ""} onClick={() => void choose(item.id)} disabled={busy} aria-pressed={selected?.id === item.id}>
        <strong>{item.title}</strong><span><b className={`status ${item.status === "PUBLISHED" ? "good" : "warn"}`}>{item.status === "PUBLISHED" ? "已发布" : "草稿"}</b><small>{item.video_type === "NONE" ? "图文" : item.video_type === "BILIBILI" ? "B站视频" : "上传视频"} · 排序 {item.sort_order}</small></span><small>{formatDatabaseDateTime(item.updated_at)}</small>
      </button>)}</div> : <div className="tutorial-empty">{query ? "没有找到匹配的教程" : "还没有教程，点击“新建教程”开始创建。"}</div>}
      <nav className="tutorial-pagination" aria-label="教程列表分页"><span>共 {list.total} 条 · 每页 10 条</span><div><button type="button" className="secondary" disabled={page <= 1 || loading || busy} onClick={() => setPage(page - 1)}>上一页</button><span aria-live="polite">{page} / {Math.max(1, list.page_count)}</span><button type="button" className="secondary" disabled={page >= list.page_count || loading || busy} onClick={() => setPage(page + 1)}>下一页</button></div></nav>
    </section>
    <form className="tutorial-editor-card" onSubmit={save}>
      <header><div><span className="kicker">{selected ? "EDIT TUTORIAL" : "NEW TUTORIAL"}</span><h2>{detailLoading ? "正在读取教程详情…" : selected ? "编辑教程" : "创建教程"}</h2><p>{selected ? `最近更新：${formatDatabaseDateTime(selected.updated_at)}` : "图文和视频可同时展示；新教程默认发布。"}</p></div><button className="secondary" type="button" onClick={() => setPreview(!preview)} aria-pressed={preview} disabled={busy}>{preview ? "继续编辑" : "预览教程"}</button></header>
      <fieldset disabled={busy} aria-busy={busy}>
        <label>教程标题<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required maxLength={200} placeholder="输入教程标题" /></label>
        <div className="tutorial-form-row"><label>发布状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as TutorialForm["status"] })}><option value="PUBLISHED">已发布 · 客户端可见</option><option value="DRAFT">草稿 · 仅后台可见</option></select></label><label>排序值<input type="number" min={0} max={100000} step={1} value={form.sort_order} onChange={(event) => setForm({ ...form, sort_order: Number(event.target.value) })} /><small>排序值越小，越靠前显示。</small></label></div>
        {preview ? <article className="tutorial-preview"><span className="kicker">CLIENT PREVIEW</span><h3>{form.title || "未填写标题"}</h3><div className="tutorial-rendered-content" dangerouslySetInnerHTML={{ __html: previewHtml }} /></article> : <div className="tutorial-rich-field"><span>图文正文</span><TutorialRichTextEditor key={selected?.id || "new"} value={form.content} onChange={(content) => setForm((current) => ({ ...current, content }))} disabled={busy} onUploadImage={(file) => uploadMedia(file, "IMAGE")} /></div>}
        <div className="tutorial-video-field"><label>教程视频<select value={form.video_type} onChange={(event) => setForm({ ...form, video_type: event.target.value as VideoType, video_url: null })}><option value="NONE">不添加视频</option><option value="UPLOAD">上传视频</option><option value="BILIBILI">引用 B站视频</option></select></label>
          {form.video_type === "UPLOAD" && <div className="tutorial-video-upload"><button type="button" className="secondary" onClick={() => videoInput.current?.click()}>{form.video_url ? "替换视频" : "选择并上传视频"}</button><small>支持 MP4、WebM，单个视频不超过 500MB。</small><input ref={videoInput} type="file" className="sr-only" aria-label="上传教程视频" accept="video/mp4,video/webm" onChange={async (event) => {
            const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
            try { const url = await uploadMedia(file, "VIDEO"); if (alive.current) setForm((current) => ({ ...current, video_url: url })); }
            catch (reason) { if (alive.current && !(reason instanceof DOMException && reason.name === "AbortError")) setError(errorText(reason, "视频上传失败")); }
          }} />{form.video_url && <p className="tutorial-media-saved">已上传视频，可在下方预览。</p>}</div>}
          {form.video_type === "BILIBILI" && <label>B站分享链接或嵌入代码<textarea rows={3} value={form.video_url || ""} onChange={(event) => setForm({ ...form, video_url: event.target.value })} placeholder={'粘贴 B站分享链接，或 <iframe src="//player.bilibili.com/player.html?…"></iframe>'} /><small>接受 B站视频链接、b23.tv 短链接和 iframe 嵌入代码。短链接保存后可预览播放。</small></label>}
          {videoPreview && <div className="tutorial-player-region"><div ref={player} className={`tutorial-player${fullWindow ? " tutorial-player-full-window" : ""}`} role={fullWindow ? "dialog" : undefined} aria-modal={fullWindow ? true : undefined} aria-label={fullWindow ? "教程视频全窗口播放" : undefined}>{fullWindow && <><span className="tutorial-player-fallback-notice" role="status">浏览器未允许全屏，已切换为窗口内大屏</span><button ref={closePlayer} className="tutorial-player-close" type="button" onClick={() => setFullWindow(false)}>退出全屏</button></>}{form.video_type === "BILIBILI" ? <iframe src={videoPreview} title="B站教程视频预览" allow="fullscreen; picture-in-picture; encrypted-media" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /> : <video src={videoPreview} controls playsInline preload="metadata">当前浏览器不支持视频播放。</video>}</div><button className="secondary" type="button" onClick={() => void playFullscreen()}>全屏播放</button></div>}
        </div>
      </fieldset>
      {upload && <div className="tutorial-upload-progress" role="status"><div><strong>正在上传{upload.kind === "IMAGE" ? "图片" : "视频"} · {upload.percent}%</strong><button type="button" className="secondary" onClick={() => uploadAbort.current?.abort()}>取消上传</button></div><progress value={upload.percent} max={100} aria-label="媒体上传进度" /><small>{upload.name}{upload.percent === 100 ? " · 正在处理，请稍候…" : ""}</small></div>}
      {error && <div className="form-error" role="alert">{error}</div>}{message && <div className="form-success" role="status">{message}</div>}
      <footer>{selected && <button className="danger" type="button" onClick={() => void remove()} disabled={busy}>删除教程</button>}<span /><button className="primary" type="submit" disabled={busy}>{saving ? "正在保存…" : form.status === "PUBLISHED" ? "保存并发布" : "保存草稿"}</button></footer>
    </form>
  </div>;
}

