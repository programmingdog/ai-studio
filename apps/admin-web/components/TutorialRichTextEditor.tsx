"use client";

import { useEffect, useRef, useState } from "react";
import { sanitizeTutorialHtml, tutorialMediaUrl } from "@/lib/tutorial-media";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onUploadImage: (file: File) => Promise<string>;
  disabled: boolean;
};

export function TutorialRichTextEditor({ value, onChange, onUploadImage, disabled }: Props) {
  const editor = useRef<HTMLDivElement>(null);
  const selection = useRef<Range | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (editor.current && editor.current.innerHTML !== value) {
      editor.current.innerHTML = sanitizeTutorialHtml(value);
      selection.current = null;
    }
  }, [value]);

  const rememberSelection = () => {
    const current = window.getSelection();
    if (editor.current && current?.rangeCount && editor.current.contains(current.getRangeAt(0).commonAncestorContainer)) selection.current = current.getRangeAt(0).cloneRange();
  };
  const insert = (command: string, content?: string) => {
    if (!editor.current) return;
    editor.current.focus();
    const current = window.getSelection();
    if (selection.current && editor.current.contains(selection.current.commonAncestorContainer)) {
      current?.removeAllRanges(); current?.addRange(selection.current);
    } else {
      const range = document.createRange(); range.selectNodeContents(editor.current); range.collapse(false);
      current?.removeAllRanges(); current?.addRange(range);
    }
    if (command === "insertHTML" && content) {
      const range = current?.rangeCount ? current.getRangeAt(0) : null;
      if (range) {
        range.deleteContents();
        const fragment = range.createContextualFragment(content);
        const last = fragment.lastChild;
        range.insertNode(fragment);
        if (last) { range.setStartAfter(last); range.collapse(true); current?.removeAllRanges(); current?.addRange(range); }
      }
    } else document.execCommand(command, false, content);
    rememberSelection();
    onChange(editor.current.innerHTML);
  };
  const insertImage = (value: string) => {
    const url = tutorialMediaUrl(value);
    if (!url) { setError("请输入完整的 HTTP(S) 图片地址"); return; }
    const escaped = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    insert("insertHTML", `<figure><img src="${escaped}" alt="教程图片" loading="lazy"><figcaption>图片说明</figcaption></figure><p><br></p>`);
    setImageUrl(""); setError("");
  };

  return <div className="tutorial-rich-editor">
    <div className="tutorial-rich-toolbar" role="toolbar" aria-label="教程正文格式工具">
      {[
        ["bold", "加粗", "B"], ["italic", "斜体", "I"], ["underline", "下划线", "U"],
        ["formatBlock", "二级标题", "标题", "h2"], ["formatBlock", "正文段落", "正文", "p"],
        ["insertUnorderedList", "无序列表", "列表"], ["insertOrderedList", "有序列表", "编号"],
        ["formatBlock", "引用段落", "引用", "blockquote"], ["removeFormat", "清除格式", "清除格式"],
      ].map(([command, label, text, value]) => <button key={label} type="button" aria-label={label} title={label} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(command!, value)}>{text}</button>)}
      <button type="button" disabled={disabled} onMouseDown={(event) => { event.preventDefault(); rememberSelection(); }} onClick={() => imageInput.current?.click()}>上传图片</button>
      <input ref={imageInput} className="sr-only" type="file" accept="image/jpeg,image/png,image/gif,image/webp" aria-label="上传教程图片" disabled={disabled} onChange={async (event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        setError("");
        try { insertImage(await onUploadImage(file)); }
        catch (reason) { if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "图片上传失败"); }
      }} />
    </div>
    <div ref={editor} className="tutorial-rich-content" contentEditable={!disabled} suppressContentEditableWarning role="textbox" aria-label="教程正文富文本编辑器" aria-multiline="true" aria-disabled={disabled} onKeyUp={rememberSelection} onMouseUp={rememberSelection} onBlur={rememberSelection} onInput={(event) => { rememberSelection(); onChange(event.currentTarget.innerHTML); }} onPaste={(event) => {
      event.preventDefault();
      const html = event.clipboardData.getData("text/html");
      if (html) insert("insertHTML", sanitizeTutorialHtml(html));
      else insert("insertText", event.clipboardData.getData("text/plain"));
    }} />
    <div className="tutorial-image-url"><input aria-label="教程图片地址" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} placeholder="也可粘贴图片的 https:// 地址" disabled={disabled} /><button type="button" className="secondary" disabled={disabled || !imageUrl.trim()} onClick={() => insertImage(imageUrl)}>插入图片</button></div>
    <small>支持粘贴图文和格式；上传图片支持 JPG、PNG、GIF、WebP，单张不超过 10MB。</small>
    {error && <div className="form-error" role="alert">{error}</div>}
  </div>;
}
