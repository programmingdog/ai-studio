import { BadRequestException } from "@nestjs/common";

/** API center model 69, verified 2026-11-01. Catalog points_cost is NOT a per-second price. */
export const allaiinWan3Official = {
  remoteId: 69,
  modelCode: "wan3.0-video",
  alias: "Wan 3.0 官",
  durations: Array.from({ length: 27 }, (_, i) => i + 4),
  aspectRatios: ["9:16", "16:9", "3:4", "4:3", "1:1"],
  resolutionPoints: { "480P": 1.5, "720P": 3, "1080P": 6 },
  config: {
    reference_image_mode: "reference_images",
    video_duration_options: Array.from({ length: 27 }, (_, i) => i + 4),
    aspect_ratio_options: ["9:16", "16:9", "3:4", "4:3", "1:1"],
    manual_resolution_pricing: true,
    reference_video_credit_multiplier: 2,
  },
};

export function allaiinWan3OfficialSchema(): Record<string, unknown>[] {
  return [
    { name: "prompt", label: "提示词", type: "textarea", required: true },
    { name: "size", label: "视频比例", type: "select", required: false, options: allaiinWan3Official.aspectRatios },
    { name: "seconds", label: "视频时长", type: "select", required: true, options: allaiinWan3Official.durations },
    { name: "resolution", label: "分辨率", type: "select", required: true, options: Object.keys(allaiinWan3Official.resolutionPoints) },
    { name: "count", label: "生成数量", type: "select", required: false, options: [1, 2, 3, 4] },
    { name: "reference_image", label: "参考图", type: "upload", required: false },
    { name: "reference_images", label: "多张参考图", type: "upload", required: false, description: "最多 30 张公网图片 URL。" },
    { name: "reference_video", label: "参考视频", type: "upload", required: false, description: "最多 5 段；传入参考视频时费用翻倍。" },
    { name: "reference_videos", label: "多个参考视频", type: "upload", required: false },
    { name: "reference_audio", label: "参考音频", type: "upload", required: false, description: "最多 5 段，不能作为唯一参考输入。" },
    { name: "reference_audios", label: "多个参考音频", type: "upload", required: false },
  ];
}

/** Match the flattened REST body, including the compatibility params container. */
export function wan3ReferenceVideoMultiplier(payload: Record<string, unknown>): number {
  const params = payload.params && typeof payload.params === "object" && !Array.isArray(payload.params) ? payload.params as Record<string, unknown> : {};
  const source = { ...params, ...payload };
  const urls = (single: string, multiple: string, label: string): string[] => {
    const values: unknown[] = [];
    if (source[single] !== undefined && source[single] !== null && source[single] !== "") values.push(source[single]);
    if (source[multiple] !== undefined && source[multiple] !== null) {
      if (!Array.isArray(source[multiple])) throw new BadRequestException(`${label}必须为公网 URL 数组`);
      values.push(...source[multiple] as unknown[]);
    }
    if (values.length > 5 || values.some(value => typeof value !== "string" || !/^https?:\/\/[^\s]+$/i.test(value))) {
      throw new BadRequestException(`${label}最多支持 5 个公网 URL`);
    }
    return values as string[];
  };
  const videos = urls("reference_video", "reference_videos", "Wan 3.0 参考视频");
  const audios = urls("reference_audio", "reference_audios", "Wan 3.0 参考音频");
  const hasImages = Boolean(source.reference_image) || (Array.isArray(source.reference_images) && source.reference_images.length > 0);
  if (audios.length && !videos.length && !hasImages) throw new BadRequestException("Wan 3.0 参考音频不能作为唯一参考输入，请同时提供图片或视频");
  return videos.length ? 2 : 1;
}
