import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { asRecord } from "../common/input";

export type ViralRemakeType = "FANS" | "COMMERCE";
export type ViralRemakeStatus = "ACTIVE" | "DISABLED";
export interface ViralRemakeCategoryInput {
  type: ViralRemakeType; code: string; name: string; description: string; sort_order: number; status: ViralRemakeStatus;
}
export interface ReplacementElement {
  id: string; type: "CHARACTER" | "PROP"; name: string; description: string; image_url: string;
}
export interface ViralRemakeTemplateInput {
  category_id: string; title: string; summary: string; video_url: string; original_share_url: string;
  script_content: string; replacement_elements: ReplacementElement[]; sort_order: number; status: ViralRemakeStatus;
}
export interface ViralRemakeFilters {
  type?: ViralRemakeType; category?: string; q?: string; status?: ViralRemakeStatus; page: number; page_size: number;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const mediaPath = /^\/api\/v1\/tutorials\/media\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

function text(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string" || value.trim().length > max || /[\u0000]/.test(value)) throw new BadRequestException(`${label}格式不正确或超过 ${max} 字符`);
  const normalized = value.trim();
  if (required && !normalized) throw new BadRequestException(`${label}不能为空`);
  return normalized;
}

export function viralRemakeId(value: unknown, label = "资源编号"): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new BadRequestException(`${label}不正确`);
  return value.toLowerCase();
}

export function viralRemakeType(value: unknown): ViralRemakeType {
  if (value !== "FANS" && value !== "COMMERCE") throw new BadRequestException("爆款类型必须是爆粉或带货");
  return value;
}

function status(value: unknown): ViralRemakeStatus {
  if (value !== "ACTIVE" && value !== "DISABLED") throw new BadRequestException("状态必须是 ACTIVE 或 DISABLED");
  return value;
}

function sortOrder(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100_000) throw new BadRequestException("排序必须是 0 到 100000 的整数");
  return Number(value);
}

export function viralRemakeMediaId(value: unknown, label = "媒体地址", required = true): string | null {
  const normalized = text(value, label, 200, required);
  if (!normalized && !required) return null;
  const match = mediaPath.exec(normalized);
  if (!match) throw new BadRequestException(`${label}必须使用后台上传的图片或视频`);
  return match[1]!.toLowerCase();
}

export function categoryInput(value: unknown, previous?: ViralRemakeCategoryInput): ViralRemakeCategoryInput {
  const merged = { type: "FANS", code: "", name: "", description: "", sort_order: 0, status: "ACTIVE", ...previous, ...asRecord(value) };
  const code = text(merged.code, "分类标识", 64, true);
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(code)) throw new BadRequestException("分类标识只能包含小写字母、数字、短横线或下划线");
  return { type: viralRemakeType(merged.type), code, name: text(merged.name, "分类名称", 100, true),
    description: text(merged.description, "分类说明", 1000), sort_order: sortOrder(merged.sort_order), status: status(merged.status) };
}

function shareUrl(value: unknown): string {
  const normalized = text(value, "原视频分享链接", 2000);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || /[\u0000-\u0020\u007f]/.test(normalized)) throw new Error();
    return url.toString();
  } catch { throw new BadRequestException("原视频分享链接必须是有效的 HTTP 或 HTTPS 地址"); }
}

export function templateInput(value: unknown, previous?: ViralRemakeTemplateInput): ViralRemakeTemplateInput {
  const merged = { category_id: "", title: "", summary: "", video_url: "", original_share_url: "", script_content: "",
    replacement_elements: [], sort_order: 0, status: "ACTIVE", ...previous, ...asRecord(value) };
  const videoId = viralRemakeMediaId(merged.video_url, "爆款视频");
  if (!Array.isArray(merged.replacement_elements) || merged.replacement_elements.length > 20) throw new BadRequestException("可替换元素必须是数组，且不能超过 20 个");
  const ids = new Set<string>();
  const elements = merged.replacement_elements.map((value): ReplacementElement => {
    const item = asRecord(value);
    const id = item.id === undefined ? randomUUID() : text(item.id, "替换元素编号", 64, true);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new BadRequestException("替换元素编号格式不正确或重复");
    ids.add(id);
    if (item.type !== "CHARACTER" && item.type !== "PROP") throw new BadRequestException("替换元素类型必须是角色或道具");
    const imageId = viralRemakeMediaId(item.image_url, "替换元素原图", false);
    return { id, type: item.type, name: text(item.name, "替换元素名称", 100, true), description: text(item.description, "替换说明", 2000),
      image_url: imageId ? `/api/v1/tutorials/media/${imageId}` : "" };
  });
  return { category_id: viralRemakeId(merged.category_id, "所属分类"), title: text(merged.title, "爆款标题", 200, true),
    summary: text(merged.summary, "爆款简介", 1000), video_url: `/api/v1/tutorials/media/${videoId}`, original_share_url: shareUrl(merged.original_share_url),
    script_content: text(merged.script_content, "视频剧本", 100_000, true), replacement_elements: elements, sort_order: sortOrder(merged.sort_order), status: status(merged.status) };
}

export function viralRemakeFilters(query: Record<string, unknown>, admin = false): ViralRemakeFilters {
  const positive = (value: unknown, fallback: number, max: number, label: string) => {
    if (value === undefined || value === "") return fallback;
    if (typeof value !== "string" || !/^[1-9]\d{0,7}$/.test(value) || Number(value) > max) throw new BadRequestException(`${label}不正确`);
    return Number(value);
  };
  const result: ViralRemakeFilters = { page: positive(query.page, 1, 1_000_000, "页码"), page_size: positive(query.page_size, 10, 50, "每页条数") };
  if (query.type !== undefined && query.type !== "") result.type = viralRemakeType(query.type);
  if (query.category !== undefined && query.category !== "") result.category = viralRemakeId(query.category, "所属分类");
  if (query.q !== undefined) result.q = text(query.q, "搜索词", 200);
  if (query.status !== undefined && query.status !== "") {
    if (!admin) throw new BadRequestException("公开列表不支持状态筛选");
    result.status = status(query.status);
  }
  return result;
}
