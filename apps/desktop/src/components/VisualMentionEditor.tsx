import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Image as ImageIcon } from "lucide-react";
import { readProjectAsset } from "../services/backend";

export interface VisualMentionItem {
  id: string;
  label: string;
  detail: string;
  insertText: string;
  relativePath?: string;
}

function editorText(element: HTMLElement): string {
  return element.innerText.replace(/\r\n/g, "\n");
}

function caretOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return editorText(element).length;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.endContainer)) return editorText(element).length;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(range.endContainer, range.endOffset);
  return prefix.toString().length;
}

function restoreCaret(element: HTMLElement, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
    node = walker.nextNode();
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function decorateEditor(element: HTMLElement, text: string, items: VisualMentionItem[], offset?: number) {
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
    mention.className = "visual-mention-token";
    mention.dataset.mention = nextToken;
    mention.textContent = nextToken;
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

export function VisualMentionEditor({ value, onChange, items, projectPath }: { value: string; onChange: (value: string) => void; items: VisualMentionItem[]; projectPath: string }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const triggerRef = useRef(-1);
  const decoratedTokenKeyRef = useRef("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState({ left: 12, top: 42 });
  const [hovered, setHovered] = useState<{ item: VisualMentionItem; left: number; top: number }>();
  const filtered = items.filter((item) => !query || `${item.label}${item.detail}${item.insertText}`.toLowerCase().includes(query.toLowerCase()));
  const tokenKey = items.map((item) => `${item.insertText}:${item.relativePath ?? "pending"}`).join("|");

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return;
    const textChanged = editorText(editor) !== value;
    if (textChanged || decoratedTokenKeyRef.current !== tokenKey) {
      const offset = !textChanged && document.activeElement === editor ? caretOffset(editor) : undefined;
      decorateEditor(editor, value, items, offset);
      decoratedTokenKeyRef.current = tokenKey;
    }
  }, [value, items, tokenKey]);

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
      decorateEditor(editor, text, items, offset);
      decoratedTokenKeyRef.current = tokenKey;
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
    decorateEditor(editor, next, items, nextOffset);
    decoratedTokenKeyRef.current = tokenKey;
    setMenuOpen(false);
    setQuery("");
    triggerRef.current = -1;
    editor.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!menuOpen) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => {
        for (let step = 1; step <= filtered.length; step += 1) { const next = (index + step) % filtered.length; if (filtered[next]?.relativePath) return next; }
        return index;
      });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => {
        for (let step = 1; step <= filtered.length; step += 1) { const next = (index - step + filtered.length) % filtered.length; if (filtered[next]?.relativePath) return next; }
        return index;
      });
    } else if (event.key === "Enter" && filtered[selectedIndex]?.relativePath) {
      event.preventDefault();
      insertMention(filtered[selectedIndex]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false);
    }
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

  return <div className="visual-mention-editor-shell" onMouseLeave={() => setHovered(undefined)}>
    <div
      ref={editorRef}
      className="visual-mention-editor"
      contentEditable
      role="textbox"
      aria-multiline="true"
      aria-label="画面"
      data-placeholder="描述画面；输入 @ 引用关联图片"
      suppressContentEditableWarning
      onInput={handleInput}
      onKeyDown={handleKeyDown}
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
