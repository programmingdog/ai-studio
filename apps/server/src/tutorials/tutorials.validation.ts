import { BadRequestException } from "@nestjs/common";
import sanitizeHtml from "sanitize-html";
import { asRecord } from "../common/input";

export type TutorialVideoType = "NONE" | "UPLOAD" | "BILIBILI";
export type TutorialStatus = "DRAFT" | "PUBLISHED";
export interface TutorialInput {
  title: string;
  content: string;
  video_type: TutorialVideoType;
  video_url: string | null;
  status: TutorialStatus;
  sort_order: number;
}

const mediaPath = /^\/api\/v1\/tutorials\/media\/[a-f0-9-]{36}$/i;
const color = /^(?:#[a-f0-9]{3,8}|(?:rgb|rgba)\([\d\s.,%]+\)|[a-z]{1,20})$/i;

export function sanitizeTutorialContent(content: string): string {
  if (content.length > 2_000_000) throw new BadRequestException("教程正文不能超过 200 万字符");
  return sanitizeHtml(content, {
    allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "s", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "img", "figure", "figcaption", "hr", "span", "div", "table", "thead", "tbody", "tfoot", "tr", "th", "td"],
    allowedAttributes: {
      "*": ["style"],
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      ol: ["start"], th: ["colspan", "rowspan"], td: ["colspan", "rowspan"],
    },
    allowedStyles: {
      "*": {
        "text-align": [/^(?:left|center|right|justify)$/],
        "color": [color], "background-color": [color],
        "font-size": [/^(?:[1-9]|[1-6]\d|72)(?:px|pt)$/],
        "font-weight": [/^(?:normal|bold|[1-9]00)$/],
        "text-decoration": [/^(?:none|underline|line-through)$/],
      },
    },
    allowedSchemes: ["https", "http"],
    allowedSchemesByTag: { a: ["https", "http", "mailto"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attributes) => ({ tagName: "a", attribs: { ...attributes, target: "_blank", rel: "noopener noreferrer" } }),
      img: (_tag, attributes) => ({ tagName: "img", attribs: { ...attributes, loading: "lazy" } }),
    },
    exclusiveFilter: frame => frame.tag === "img" && (!frame.attribs.src || !safeImageSource(frame.attribs.src)),
  }).trim();
}

function safeImageSource(source: string): boolean {
  if (source.startsWith("/") && !source.startsWith("//")) return mediaPath.test(source);
  try {
    const url = new URL(source);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function iframeSource(value: string): string {
  if (!value.trim().startsWith("<")) return value.trim();
  const match = /^<iframe\b([\s\S]*?)>\s*<\/iframe>$/i.exec(value.trim());
  if (!match) throw new BadRequestException("请粘贴 B 站视频链接或完整的 iframe 分享代码");
  let source: string | undefined;
  let remainder = match[1]!;
  const attributes = /\s+([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  remainder = remainder.replace(attributes, (_text, name: string, double: string | undefined, single: string | undefined, plain: string | undefined) => {
    const attribute = name.toLowerCase();
    if (!["src", "scrolling", "border", "frameborder", "framespacing", "allowfullscreen", "width", "height", "allow", "title"].includes(attribute)) {
      throw new BadRequestException("B 站嵌入代码包含不支持的属性");
    }
    if (attribute === "src") {
      if (source !== undefined) throw new BadRequestException("B 站嵌入代码只能包含一个视频地址");
      source = double ?? single ?? plain;
    }
    return "";
  }).replace(/\s+allowfullscreen\b/gi, "");
  if (remainder.trim() || !source) throw new BadRequestException("B 站嵌入代码格式不正确");
  return source.replace(/&amp;/gi, "&");
}

export function normalizeBilibiliVideo(value: string): string {
  const source = iframeSource(value);
  let url: URL;
  try { url = new URL(source.startsWith("//") ? `https:${source}` : source); }
  catch { throw new BadRequestException("B 站视频地址不正确"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new BadRequestException("B 站视频地址不正确");
  }
  let bvid: string | null = null;
  let aid: string | null = null;
  let cid: string | null = null;
  if (url.hostname === "player.bilibili.com" && url.pathname === "/player.html") {
    bvid = url.searchParams.get("bvid");
    aid = url.searchParams.get("aid");
    cid = url.searchParams.get("cid");
  } else if (["www.bilibili.com", "bilibili.com", "m.bilibili.com"].includes(url.hostname)) {
    const video = /^\/video\/(BV[a-zA-Z0-9]{10}|av\d{1,20})\/?$/.exec(url.pathname)?.[1];
    if (video?.startsWith("BV")) bvid = video;
    else if (video?.startsWith("av")) aid = video.slice(2);
    else throw new BadRequestException("请输入 B 站标准视频分享链接");
  } else throw new BadRequestException("仅支持 B 站官方视频链接和播放器嵌入代码");
  if ((bvid && !/^BV[a-zA-Z0-9]{10}$/.test(bvid)) || (aid && !/^[1-9]\d{0,19}$/.test(aid))
    || (cid && !/^[1-9]\d{0,19}$/.test(cid)) || (!bvid && !aid)) {
    throw new BadRequestException("B 站视频编号不正确");
  }
  const page = url.searchParams.get("p") || "1";
  if (!/^[1-9]\d{0,4}$/.test(page)) throw new BadRequestException("B 站视频分集编号不正确");
  const normalized = new URL("https://player.bilibili.com/player.html");
  normalized.searchParams.set("isOutside", "true");
  if (aid) normalized.searchParams.set("aid", aid);
  if (bvid) normalized.searchParams.set("bvid", bvid);
  if (cid) normalized.searchParams.set("cid", cid);
  normalized.searchParams.set("p", page);
  normalized.searchParams.set("autoplay", "0");
  return normalized.toString();
}

export async function resolveBilibiliVideo(value: string, fetcher: typeof fetch = fetch): Promise<string> {
  const source = iframeSource(value);
  let url: URL;
  try { url = new URL(source.startsWith("//") ? `https:${source}` : source); }
  catch { throw new BadRequestException("B 站视频地址不正确"); }
  if (url.hostname !== "b23.tv") return normalizeBilibiliVideo(source);
  const signal = AbortSignal.timeout(10_000);
  for (let redirect = 0; redirect < 3; redirect++) {
    if (url.hostname !== "b23.tv") return normalizeBilibiliVideo(url.toString());
    if (url.protocol !== "https:" || url.username || url.password || url.port || !/^\/[a-zA-Z0-9]{1,128}\/?$/.test(url.pathname)) {
      throw new BadRequestException("B 站短分享链接不正确");
    }
    let response: Response;
    try { response = await fetcher(url, { method: "GET", redirect: "manual", signal, headers: { "User-Agent": "AI-Studio-Tutorial-Link/1.0" } }); }
    catch { throw new BadRequestException("B 站短链接解析失败，请重试或使用完整视频链接、嵌入代码"); }
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (![301,302,303,307,308].includes(response.status) || !location) {
      throw new BadRequestException("B 站短链接未返回有效视频，请使用完整视频链接或嵌入代码");
    }
    try { url = new URL(location, url); } catch { throw new BadRequestException("B 站短链接跳转地址无效"); }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !["b23.tv", "www.bilibili.com", "bilibili.com", "m.bilibili.com", "player.bilibili.com"].includes(url.hostname)) {
      throw new BadRequestException("B 站短链接跳转地址不受支持");
    }
  }
  if (url.hostname !== "b23.tv") return normalizeBilibiliVideo(url.toString());
  throw new BadRequestException("B 站短链接跳转次数过多，请使用完整视频链接或嵌入代码");
}

export function uploadedVideoAssetId(value: string): string {
  // Uploaded videos must reference assets managed by this server, never arbitrary HTML or media URLs.
  let path = value;
  if (!value.startsWith("/")) {
    try { const url = new URL(value); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); path = url.pathname; }
    catch { throw new BadRequestException("请上传教程视频后选择生成的视频地址"); }
  }
  if (!mediaPath.test(path)) throw new BadRequestException("请上传教程视频后选择生成的视频地址");
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

export function tutorialInput(value: unknown, previous?: TutorialInput): TutorialInput {
  const body = asRecord(value);
  const merged: Record<string, unknown> = { title: "", content: "", video_type: "NONE", video_url: null, status: "DRAFT", sort_order: 0, ...previous, ...body };
  if (typeof merged.title !== "string" || !merged.title.trim() || merged.title.trim().length > 200) throw new BadRequestException("教程标题不能为空，且不能超过 200 字符");
  if (typeof merged.content !== "string") throw new BadRequestException("教程正文格式不正确");
  if (!["NONE", "UPLOAD", "BILIBILI"].includes(String(merged.video_type))) throw new BadRequestException("视频类型不正确");
  if (!["DRAFT", "PUBLISHED"].includes(String(merged.status))) throw new BadRequestException("教程状态不正确");
  if (!Number.isInteger(merged.sort_order) || Number(merged.sort_order) < 0 || Number(merged.sort_order) > 100_000) throw new BadRequestException("教程排序必须是 0 到 100000 的整数");
  const videoType = merged.video_type as TutorialVideoType;
  let videoUrl: string | null = null;
  if (videoType !== "NONE") {
    if (typeof merged.video_url !== "string" || !merged.video_url.trim() || merged.video_url.length > 10_000) throw new BadRequestException("请上传视频或填写 B 站视频链接");
    videoUrl = videoType === "BILIBILI" ? normalizeBilibiliVideo(merged.video_url) : `/api/v1/tutorials/media/${uploadedVideoAssetId(merged.video_url)}`;
  }
  const content = sanitizeTutorialContent(merged.content);
  const text = sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} }).replace(/(?:&nbsp;|\u00a0)/g, "").trim();
  if (!text && !/<img\b/i.test(content) && !videoUrl) throw new BadRequestException("教程至少需要正文、图片或视频");
  return { title: merged.title.trim(), content, video_type: videoType, video_url: videoUrl, status: merged.status as TutorialStatus, sort_order: Number(merged.sort_order) };
}

export function tutorialPage(value: unknown): number {
  if (value === undefined || value === "") return 1;
  if (typeof value !== "string" || !/^[1-9]\d{0,8}$/.test(value)) throw new BadRequestException("分页参数不正确");
  return Number(value);
}
