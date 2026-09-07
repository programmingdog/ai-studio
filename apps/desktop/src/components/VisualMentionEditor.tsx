import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Image as ImageIcon, X } from "lucide-react";
import { readProjectAsset } from "../services/backend";

export interface VisualMentionItem {
  id: string;
  label: string;
  detail: string;
  insertText: string;
  relativePath?: string;
  group?: "scene" | "character" | "prop" | "shot";
}

function editorText(element: HTMLElement): string {
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    if (node.dataset.mention) return node.dataset.mention;
    if (node.tagName === "BR") return "\n";
    let content = "";
    for (const child of Array.from(node.childNodes)) {
      if (child instanceof HTMLElement && ["DIV", "P", "LI"].includes(child.tagName) && content && !content.endsWith("\n")) content += "\n";
      content += read(child);
    }
    return content;
  };
  return read(element).replace(/\r\n/g, "\n").replace(/\n{2}$/, "\n");
}

function caretOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return editorText(element).length;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.endContainer)) return editorText(element).length;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(range.endContainer, range.endOffset);
  const container = document.createElement("div");
  container.append(prefix.cloneContents());
  return editorText(container).length;
}

function restoreCaret(element: HTMLElement, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  let remaining = Math.max(0, offset);
  for (const node of Array.from(element.childNodes)) {
    const token = node instanceof HTMLElement ? node.dataset.mention : undefined;
    const length = token?.length ?? node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      if (token) {
        if (remaining === 0) range.setStartBefore(node);
        else range.setStartAfter(node);
      } else {
        range.setStart(node, remaining);
      }
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function decorateEditor(element: HTMLElement, text: string, items: VisualMentionItem[], offset?: number, rich = false, assetSources = new Map<string, string>()) {
  const tokens = [...new Set(items.map((item) => item.insertText))].sort((a, b) => b.length - a.length);
  const fragment = document.createDocumentFragment();
  let position = 0;
  while (position < text.length) {
    let nextIndex = text.length;
    let nextToken = "";
    for (const token of tokens) {
      const index = text.indexOf(token, position);
      if (index >= 0 && index < nextIndex) {
        nextIndex = index;
        nextToken = token;
      }
    }
    if (!nextToken) {
      fragment.append(document.createTextNode(text.slice(position)));
      break;
    }
    if (nextIndex > position) fragment.append(document.createTextNode(text.slice(position, nextIndex)));
    const mention = document.createElement("span");
    mention.className = rich ? "visual-mention-token rich" : "visual-mention-token";
    mention.dataset.mention = nextToken;
    if (rich) {
      mention.contentEditable = "false";
      const item = items.find((candidate) => candidate.insertText === nextToken);
      const source = item?.relativePath ? assetSources.get(item.relativePath) : undefined;
      const avatar = source ? document.createElement("img") : document.createElement("i");
      if (source && avatar instanceof HTMLImageElement) {
        avatar.src = source;
        avatar.alt = "";
      } else {
        avatar.textContent = "图";
      }
      const label = document.createElement("span");
      label.textContent = item?.label ?? nextToken.slice(1);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.mentionRemove = "true";
      remove.tabIndex = -1;
      remove.setAttribute("aria-label", `删除${item?.label ?? nextToken}`);
      remove.textContent = "×";
      mention.append(avatar, label, remove);
    } else {
      mention.textContent = nextToken;
    }
    fragment.append(mention);
    position = nextIndex + nextToken.length;
  }
  element.replaceChildren(fragment);
  if (offset != null) restoreCaret(element, offset);
}

function MentionImage({ projectPath, item, large = false }: { projectPath: string; item: VisualMentionItem; large?: boolean }) {
  const asset = useQuery({
    queryKey: ["project-asset", projectPath, item.relativePath],
    queryFn: () => readProjectAsset(projectPath, item.relativePath!),
    enabled: Boolean(item.relativePath),
    staleTime: Infinity,
  });
  if (!asset.data) return <span className={large ? "visual-mention-image large loading" : "visual-mention-image loading"}><ImageIcon size={large ? 34 : 18} />{large && <small>图片尚未生成</small>}</span>;
  return <img className={large ? "visual-mention-image large" : "visual-mention-image"} src={asset.data} alt={item.label} />;
}

export function VisualMentionEditor({ value, onChange, items, projectPath, rich = false, fill = false, placeholder = "描述画面；输入 @ 引用关联图片", ariaLabel = "画面" }: { value: string; onChange: (value: string) => void; items: VisualMentionItem[]; projectPath: string; rich?: boolean; fill?: boolean; placeholder?: string; ariaLabel?: string }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const triggerRef = useRef(-1);
  const decoratedTokenKeyRef = useRef("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState({ left: 12, top: 42 });
  const [hovered, setHovered] = useState<{ item: VisualMentionItem; left: number; top: number }>();
  const assetQueries = useQueries({ queries: items.map((item) => ({
    queryKey: ["project-asset", projectPath, item.relativePath],
    queryFn: () => readProjectAsset(projectPath, item.relativePath!),
    enabled: rich && Boolean(item.relativePath),
    staleTime: Infinity,
  })) });
  const assetSources = new Map(items.flatMap((item, index) => item.relativePath && assetQueries[index]?.data ? [[item.relativePath, assetQueries[index].data] as const] : []));
  const filtered = items.filter((item) => !query || `${item.label}${item.detail}${item.insertText}`.toLowerCase().includes(query.toLowerCase()));
  const tokenKey = items.map((item) => `${item.insertText}:${item.relativePath ?? "pending"}`).join("|");
  const decorationKey = `${tokenKey}|${assetQueries.map((query) => query.data ? "ready" : "pending").join(",")}`;

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return;
    const textChanged = editorText(editor) !== value;
    if (textChanged || decoratedTokenKeyRef.current !== decorationKey) {
      const offset = !textChanged && document.activeElement === editor ? caretOffset(editor) : undefined;
      decorateEditor(editor, value, items, offset, rich, assetSources);
      decoratedTokenKeyRef.current = decorationKey;
    }
  }, [value, items, tokenKey, rich, ...assetQueries.map((query) => query.data)]);

  const updateMenu = (text: string, offset: number) => {
    const prefix = text.slice(0, offset);
    const at = prefix.lastIndexOf("@");
    const candidate = at >= 0 ? prefix.slice(at + 1) : "";
    if (at < 0 || /[\s，。！？；：,!?;:\n]/.test(candidate) || candidate.length > 30) {
      setMenuOpen(false);
      triggerRef.current = -1;
      return;
    }
    triggerRef.current = at;
    setQuery(candidate);
    const nextItems = items.filter((item) => !candidate || `${item.label}${item.detail}${item.insertText}`.toLowerCase().includes(candidate.toLowerCase()));
    const firstEnabled = nextItems.findIndex((item) => Boolean(item.relativePath));
    setSelectedIndex(firstEnabled >= 0 ? firstEnabled : 0);
    setMenuOpen(true);
    const editor = editorRef.current;
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : undefined;
    if (editor && range) {
      const caret = range.getBoundingClientRect();
      const bounds = editor.getBoundingClientRect();
      setMenuPosition({ left: Math.max(8, Math.min(caret.left - bounds.left, bounds.width - 350)), top: Math.max(38, caret.bottom - bounds.top + 7) });
    }
  };

  const handleInput = (event: FormEvent<HTMLDivElement>) => {
    const editor = event.currentTarget;
    const text = editorText(editor);
    const offset = caretOffset(editor);
    onChange(text);
    if (!composingRef.current) {
      decorateEditor(editor, text, items, offset, rich, assetSources);
      decoratedTokenKeyRef.current = decorationKey;
      updateMenu(text, offset);
    }
  };

  const insertMention = (item: VisualMentionItem) => {
    if (!item.relativePath) return;
    const editor = editorRef.current;
    if (!editor) return;
    const text = editorText(editor);
    const end = caretOffset(editor);
    const start = triggerRef.current >= 0 ? triggerRef.current : end;
    const suffixSpace = text[end] && !/\s/.test(text[end]!) ? " " : "";
    const next = `${text.slice(0, start)}${item.insertText}${suffixSpace}${text.slice(end)}`;
    const nextOffset = start + item.insertText.length + suffixSpace.length;
    onChange(next);
    decorateEditor(editor, next, items, nextOffset, rich, assetSources);
    decoratedTokenKeyRef.current = decorationKey;
    setMenuOpen(false);
    setQuery("");
    triggerRef.current = -1;
    editor.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (menuOpen && event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => {
        for (let step = 1; step <= filtered.length; step += 1) { const next = (index + step) % filtered.length; if (filtered[next]?.relativePath) return next; }
        return index;
      });
    } else if (menuOpen && event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => {
        for (let step = 1; step <= filtered.length; step += 1) { const next = (index - step + filtered.length) % filtered.length; if (filtered[next]?.relativePath) return next; }
        return index;
      });
    } else if (menuOpen && event.key === "Enter" && filtered[selectedIndex]?.relativePath) {
      event.preventDefault();
      insertMention(filtered[selectedIndex]!);
    } else if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false);
    } else if (rich && (event.key === "Backspace" || event.key === "Delete")) {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
      if (!range?.collapsed) return;
      const container = range.startContainer;
      const offset = range.startOffset;
      const adjacent = container.nodeType === Node.TEXT_NODE
        ? (event.key === "Backspace" && offset === 0 ? container.previousSibling : event.key === "Delete" && offset === (container.textContent?.length ?? 0) ? container.nextSibling : undefined)
        : container instanceof HTMLElement
          ? container.childNodes[offset - (event.key === "Backspace" ? 1 : 0)]
          : undefined;
      const token = adjacent instanceof HTMLElement && adjacent.dataset.mention ? adjacent : undefined;
      if (!token?.dataset.mention) return;
      event.preventDefault();
      setHovered(undefined);
      const text = editorText(event.currentTarget);
      const end = caretOffset(event.currentTarget);
      const start = event.key === "Backspace" ? end - token.dataset.mention.length : end;
      const next = `${text.slice(0, start)}${text.slice(start + token.dataset.mention.length)}`;
      onChange(next);
      decorateEditor(event.currentTarget, next, items, start, rich, assetSources);
    }
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const remove = (event.target as HTMLElement).closest<HTMLElement>("[data-mention-remove]");
    const token = remove?.closest<HTMLElement>("[data-mention]");
    if (!remove || !token?.dataset.mention) return;
    event.preventDefault();
    setHovered(undefined);
    const editor = editorRef.current;
    if (!editor) return;
    const prefix = document.createRange();
    prefix.selectNodeContents(editor);
    prefix.setEndBefore(token);
    const container = document.createElement("div");
    container.append(prefix.cloneContents());
    const start = editorText(container).length;
    const text = editorText(editor);
    const next = `${text.slice(0, start)}${text.slice(start + token.dataset.mention.length)}`;
    onChange(next);
    decorateEditor(editor, next, items, start, rich, assetSources);
    editor.focus();
  };

  const handleMouseOver = (event: MouseEvent<HTMLDivElement>) => {
    const token = (event.target as HTMLElement).closest<HTMLElement>("[data-mention]");
    if (!token) return;
    const item = items.find((candidate) => candidate.insertText === token.dataset.mention);
    const editor = editorRef.current;
    if (!item || !editor) return;
    const rect = token.getBoundingClientRect();
    const bounds = editor.getBoundingClientRect();
    setHovered({ item, left: Math.max(8, Math.min(rect.left - bounds.left, bounds.width - 300)), top: rect.bottom - bounds.top + 8 });
  };

  return <div className={`visual-mention-editor-shell${fill ? " fill" : ""}`} onMouseLeave={() => setHovered(undefined)}>
    <div
      ref={editorRef}
      className={`visual-mention-editor${rich ? " rich" : ""}`}
      contentEditable
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      data-placeholder={placeholder}
      suppressContentEditableWarning
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onMouseOver={handleMouseOver}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={(event) => { composingRef.current = false; handleInput(event); }}
      onBlur={() => window.setTimeout(() => setMenuOpen(false), 120)}
    />
    {menuOpen && <div className="visual-mention-menu" style={menuPosition} role="listbox" aria-label="可引用图片">
      <header><strong>引用关联图片</strong><small>↑↓ 选择 · Enter 插入</small></header>
      <div className="visual-mention-options">
        {filtered.length ? filtered.map((item, index) => <button
          key={item.id}
          className={index === selectedIndex ? "active" : ""}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          disabled={!item.relativePath}
          onMouseEnter={() => { if (item.relativePath) setSelectedIndex(index); }}
          onMouseDown={(event) => { event.preventDefault(); if (item.relativePath) insertMention(item); }}
        ><MentionImage projectPath={projectPath} item={item} /><span><strong>{item.label}</strong><small>{item.detail}</small><em>{item.relativePath ? item.insertText : "图片生成后可引用"}</em></span></button>) : <div className="visual-mention-empty">该分镜暂无可引用图片</div>}
      </div>
    </div>}
    {hovered && <div className="visual-mention-hover" style={{ left: hovered.left, top: hovered.top }}><MentionImage projectPath={projectPath} item={hovered.item} large /><strong>{hovered.item.label}</strong><small>{hovered.item.detail}</small></div>}
  </div>;
}

const groupLabels: Record<NonNullable<VisualMentionItem["group"]>, string> = { scene: "场景图", character: "角色图", prop: "道具图", shot: "分镜图" };

export function VideoPromptFullscreenEditor({ shotId, value, onChange, items, projectPath, onClose }: { shotId: string; value: string; onChange: (value: string) => void; items: VisualMentionItem[]; projectPath: string; onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onClose(); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  return createPortal(<div className="modal-backdrop video-prompt-editor-backdrop">
    <section className="video-prompt-editor-modal" role="dialog" aria-modal="true" aria-labelledby="video-prompt-editor-title">
      <header><div><span className="eyebrow">VIDEO PROMPT EDITOR</span><h2 id="video-prompt-editor-title">全屏编辑视频生成提示词</h2><p>{shotId} · 输入 @ 可在光标旁选择参考图，提示词与其他分镜修改会自动保存。</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={19} /></button></header>
      <div className="video-prompt-editor-body">
        <aside className="video-prompt-reference-list"><div><strong>参考图片</strong><small>提交顺序：场景图 → 角色图 → 道具图 → 分镜图</small></div>{(["scene", "character", "prop", "shot"] as const).map((group) => <section key={group}><h3>{groupLabels[group]}</h3>{items.filter((item) => item.group === group).map((item) => <article className={!item.relativePath ? "unavailable" : ""} key={item.id}><MentionImage projectPath={projectPath} item={item} /><span><strong>{item.label}</strong><small>{item.detail}</small><em>{item.relativePath ? item.insertText : "图片尚未生成"}</em></span></article>)}</section>)}</aside>
        <main className="video-prompt-editor-main"><div className="video-prompt-editor-guide"><strong>视频生成提示词</strong><span>选择后的图片在编辑区中显示为标签；点击标签右侧 ×，或在标签旁按 Backspace / Delete 即可删除。</span></div><VisualMentionEditor value={value} onChange={onChange} items={items} projectPath={projectPath} rich fill placeholder="输入视频生成提示词；输入 @ 引用左侧图片" ariaLabel="视频生成提示词" /></main>
      </div>
      <footer><span>引用在提交时会按图片实际顺序自动替换为“参考图N”。</span><button className="primary-button" type="button" onClick={onClose}>完成</button></footer>
    </section>
  </div>, document.body);
}
