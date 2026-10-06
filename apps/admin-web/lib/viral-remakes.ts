import { tutorialStoredMediaUrl } from "./tutorial-media";

export type ViralRemakeType = "FANS" | "COMMERCE";
export type ViralRemakeStatus = "ACTIVE" | "DISABLED";
export type ViralReplacementElement = { id: string; type: "CHARACTER" | "PROP"; name: string; description: string; image_url: string | null };
export type ViralCategoryForm = { code: string; name: string; description: string; sort_order: number; status: ViralRemakeStatus };
export type ViralCategory = ViralCategoryForm & { id: string; type: ViralRemakeType; template_count: number; created_at: string; updated_at: string };
export type ViralTemplateForm = { category_id: string; title: string; summary: string; video_url: string; original_share_url: string | null; script_content: string; replacement_elements: ViralReplacementElement[]; sort_order: number; status: ViralRemakeStatus };
export type ViralTemplate = ViralTemplateForm & { id: string; type: ViralRemakeType; category_name: string; created_at: string; updated_at: string };
export type ViralTemplateList = { items: ViralTemplate[]; total: number; page: number; page_size: number; total_pages: number };
export type ViralMedia = { id: string; url: string; media_type: "IMAGE" | "VIDEO"; mime_type: string; original_name: string; size: number };

export function emptyViralTemplate(categoryId = ""): ViralTemplateForm {
  return { category_id: categoryId, title: "", summary: "", video_url: "", original_share_url: null, script_content: "", replacement_elements: [], sort_order: 0, status: "ACTIVE" };
}

export function viralTemplateForm(item: ViralTemplate): ViralTemplateForm {
  return { category_id: item.category_id, title: item.title, summary: item.summary || "", video_url: item.video_url, original_share_url: item.original_share_url || null, script_content: item.script_content, replacement_elements: item.replacement_elements.map((element) => ({ ...element, description: element.description || "", image_url: element.image_url || null })), sort_order: item.sort_order, status: item.status };
}

export function safeViralShareUrl(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /[\u0000-\u0020\u007f]/.test(value.trim())) throw new Error();
    return url.toString();
  } catch { throw new Error("原视频分享链接须为有效的 HTTP 或 HTTPS 地址"); }
}

export function viralManagedMediaUrl(value: string): string {
  const stored = tutorialStoredMediaUrl(value);
  return /^\/api\/v1\/tutorials\/media\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(stored) ? stored : "";
}

export function validateViralTemplate(form: ViralTemplateForm, categories: ViralCategory[]): ViralTemplateForm {
  if (!categories.some((category) => category.id === form.category_id)) throw new Error("请选择当前类型下的所属分类");
  if (!form.title.trim()) throw new Error("请输入爆款视频标题");
  const videoUrl = viralManagedMediaUrl(form.video_url);
  if (!videoUrl) throw new Error("请先上传爆款视频");
  if (!form.script_content.trim()) throw new Error("请输入视频剧本");
  if (!Number.isInteger(form.sort_order) || form.sort_order < 0 || form.sort_order > 100_000) throw new Error("排序值须为 0 至 100000 的整数");
  if (form.replacement_elements.length > 20) throw new Error("每个视频最多添加 20 个可替换元素");
  const ids = new Set<string>();
  const elements = form.replacement_elements.map((element, index) => {
    if (!element.name.trim()) throw new Error(`请填写第 ${index + 1} 个可替换元素的名称`);
    if (!element.id || element.id.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(element.id) || ids.has(element.id)) throw new Error("可替换元素标识重复或无效，请重新添加该元素");
    ids.add(element.id);
    if (element.image_url && !viralManagedMediaUrl(element.image_url)) throw new Error(`第 ${index + 1} 个可替换元素的原图地址无效`);
    return { ...element, name: element.name.trim(), description: element.description.trim(), image_url: element.image_url ? viralManagedMediaUrl(element.image_url) : null };
  });
  return { ...form, video_url: videoUrl, title: form.title.trim(), summary: form.summary.trim(), original_share_url: safeViralShareUrl(form.original_share_url), script_content: form.script_content.trim(), replacement_elements: elements };
}
