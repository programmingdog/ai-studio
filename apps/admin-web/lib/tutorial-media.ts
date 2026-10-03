import { API_BASE } from "./api";

export const TUTORIAL_IMAGE_LIMIT = 10 * 1024 * 1024;
export const TUTORIAL_VIDEO_LIMIT = 500 * 1024 * 1024;

export function validateTutorialFile(file: Pick<File, "name" | "type" | "size">, kind: "IMAGE" | "VIDEO") {
  const limit = kind === "IMAGE" ? TUTORIAL_IMAGE_LIMIT : TUTORIAL_VIDEO_LIMIT;
  const types = kind === "IMAGE" ? ["image/jpeg", "image/png", "image/gif", "image/webp"] : ["video/mp4", "video/webm"];
  if (!types.includes(file.type)) throw new Error(kind === "IMAGE" ? "请选择 JPG、PNG、GIF 或 WebP 图片" : "请选择 MP4 或 WebM 视频");
  if (file.size <= 0 || file.size > limit) throw new Error(kind === "IMAGE" ? "图片大小须在 0 至 10MB 之间" : "视频大小须在 0 至 500MB 之间");
}

export function tutorialMediaUrl(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const api = new URL(API_BASE, typeof window === "undefined" ? "http://localhost:3101" : window.location.origin);
    const url = new URL(value, `${api.toString().replace(/\/$/, "")}/`);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : "";
  } catch { return ""; }
}

export function tutorialStoredMediaUrl(value: string): string {
  const resolved = tutorialMediaUrl(value);
  if (!resolved) return "";
  const url = new URL(resolved);
  const api = new URL(API_BASE, typeof window === "undefined" ? "http://localhost:3101" : window.location.origin);
  return url.origin === api.origin && !url.search && !url.hash && /^\/api\/v1\/tutorials\/media\/[a-f0-9-]{36}$/i.test(url.pathname) ? url.pathname : resolved;
}

const tutorialColor = /^(?:#[a-f0-9]{3,8}|(?:rgb|rgba)\([\d\s.,%]+\)|[a-z]{1,20})$/i;
const tutorialStyleValues: Record<string, RegExp> = {
  "text-align": /^(?:left|center|right|justify)$/,
  "color": tutorialColor, "background-color": tutorialColor,
  "font-size": /^(?:[1-9]|[1-6]\d|72)(?:px|pt)$/,
  "font-weight": /^(?:normal|bold|[1-9]00)$/,
  "text-decoration": /^(?:none|underline|line-through)$/,
};

export function tutorialSafeStyle(value: string): string {
  return value.split(";").flatMap((declaration) => {
    const colon = declaration.indexOf(":");
    if (colon < 0) return [];
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const content = declaration.slice(colon + 1).trim();
    return tutorialStyleValues[property]?.test(content) ? [`${property}: ${content}`] : [];
  }).join("; ");
}

export function tutorialBilibiliInput(input: string): string {
  const shortLink = input.match(/https?:\/\/b23\.tv\/[A-Za-z0-9]+(?:[?][^\s<>"']*)?/i)?.[0];
  if (shortLink) {
    const url = new URL(shortLink);
    if (!url.username && !url.password && !url.port && url.hostname === "b23.tv" && /^\/[A-Za-z0-9]+$/.test(url.pathname)) return `https://b23.tv${url.pathname}`;
  }
  return tutorialBilibiliUrl(input);
}

/** Only keep a Bilibili player address; never render pasted iframe markup. */
export function tutorialBilibiliUrl(input: string): string {
  const text = input.trim();
  const iframe = text.match(/<iframe\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/i);
  const source = (iframe?.[2] || text.match(/(?:https?:)?\/\/(?:player\.bilibili\.com|(?:www\.)?bilibili\.com)\/[^\s<>"']+/i)?.[0] || text).replaceAll("&amp;", "&");
  let url: URL;
  try { url = new URL(source.startsWith("//") ? `https:${source}` : source); } catch { throw new Error("请粘贴 B站视频分享链接或播放器 iframe 嵌入代码"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) throw new Error("B站链接格式无效");
  const player = url.hostname === "player.bilibili.com" && url.pathname === "/player.html";
  const video = ["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(url.hostname) && /^\/video\//.test(url.pathname);
  if (!player && !video) throw new Error("仅支持 bilibili.com 视频分享链接或 player.bilibili.com 嵌入代码");
  const pathId = video ? url.pathname.split("/")[2] : undefined;
  const bvid = url.searchParams.get("bvid") || (pathId?.startsWith("BV") ? pathId : "");
  const aid = url.searchParams.get("aid") || (pathId?.startsWith("av") ? pathId.slice(2) : "");
  if (!(bvid && /^BV[0-9A-Za-z]{10}$/.test(bvid)) && !(aid && /^\d{1,20}$/.test(aid))) throw new Error("B站链接中缺少有效视频编号");
  const result = new URL("https://player.bilibili.com/player.html");
  result.searchParams.set("isOutside", "true");
  if (/^BV[0-9A-Za-z]{10}$/.test(bvid)) result.searchParams.set("bvid", bvid);
  if (/^\d{1,20}$/.test(aid)) result.searchParams.set("aid", aid);
  const cid = url.searchParams.get("cid");
  if (cid && /^\d{1,20}$/.test(cid)) result.searchParams.set("cid", cid);
  const page = url.searchParams.get("p") || "1";
  result.searchParams.set("p", /^\d{1,5}$/.test(page) && Number(page) > 0 ? page : "1");
  result.searchParams.set("autoplay", "0");
  return result.toString();
}

/** Client-side defense for preview and pasted rich text; the API also sanitizes at persistence. */
export function sanitizeTutorialHtml(value: string, forPersistence = false): string {
  if (typeof DOMParser === "undefined") return "";
  const document = new DOMParser().parseFromString(value, "text/html");
  const allowed = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "STRONG", "B", "EM", "I", "U", "S", "UL", "OL", "LI", "BLOCKQUOTE", "BR", "HR", "FIGURE", "FIGCAPTION", "A", "IMG", "SPAN", "DIV", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "PRE", "CODE"]);
  const blocked = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "FORM", "INPUT", "BUTTON", "TEXTAREA", "VIDEO", "AUDIO", "LINK", "META"]);
  const clean = (parent: Element) => {
    for (const element of Array.from(parent.children)) {
      if (blocked.has(element.tagName)) { element.remove(); continue; }
      clean(element);
      if (!allowed.has(element.tagName)) { element.replaceWith(...Array.from(element.childNodes)); continue; }
      const src = element.tagName === "IMG" ? tutorialMediaUrl(element.getAttribute("src")) : "";
      let href = element.tagName === "A" ? tutorialMediaUrl(element.getAttribute("href")) : "";
      if (element.tagName === "A" && /^mailto:/i.test(element.getAttribute("href") || "")) href = element.getAttribute("href") || "";
      const alt = element.getAttribute("alt") || "教程图片";
      const style = tutorialSafeStyle(element.getAttribute("style") || "");
      const title = element.getAttribute("title");
      const attributes = new Map(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value]));
      for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name);
      if (style) element.setAttribute("style", style);
      if (element.tagName === "OL" && /^-?\d{1,9}$/.test(attributes.get("start") || "")) element.setAttribute("start", attributes.get("start")!);
      if (["TH", "TD"].includes(element.tagName)) for (const name of ["colspan", "rowspan"]) {
        const value = attributes.get(name) || "";
        if (/^[1-9]\d{0,3}$/.test(value)) element.setAttribute(name, value);
      }
      if (element.tagName === "IMG") {
        if (!src) { element.remove(); continue; }
        element.setAttribute("src", forPersistence ? tutorialStoredMediaUrl(src) : src); element.setAttribute("alt", alt.slice(0, 300)); element.setAttribute("loading", "lazy");
        if (title) element.setAttribute("title", title.slice(0, 300));
        for (const name of ["width", "height"]) if (/^[1-9]\d{0,4}$/.test(attributes.get(name) || "")) element.setAttribute(name, attributes.get(name)!);
      }
      if (element.tagName === "A" && href) { element.setAttribute("href", href); element.setAttribute("target", "_blank"); element.setAttribute("rel", "noopener noreferrer"); if (title) element.setAttribute("title", title.slice(0, 300)); }
    }
  };
  clean(document.body);
  return document.body.innerHTML;
}

