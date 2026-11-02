import { BadRequestException } from "@nestjs/common";
import { allaiinMuseVideo as profile } from "../common/allaiin-muse-video";
import { orderedVideoReferenceImages, withVideoReferenceRelationships } from "./video-reference-prompt";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const present = (value: unknown): boolean => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);

/** Shared by quote, client submission and admin tests; validate before any charge. */
export function museVideoInput(payload: Record<string, unknown>, allowBatch = false) {
  const source = { ...object(payload.params), ...payload };
  const seconds = Number(source.seconds ?? source.duration);
  if (!profile.durations.includes(seconds)) throw new BadRequestException("Muse-video 时长只支持 5/10/15/20/25/30 秒");
  if (String(source.resolution || "").toUpperCase() !== "720P") throw new BadRequestException("Muse-video 仅支持 720P 分辨率");
  const size = String(source.size || source.aspect_ratio || "9:16");
  if (!profile.aspectRatios.includes(size)) throw new BadRequestException("Muse-video 仅支持 9:16 或 16:9 比例");
  const count = Number(source.count ?? source.n ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > (allowBatch ? 4 : 1)) throw new BadRequestException("Muse-video 客户端每次仅生成 1 段视频，后台测试支持 1～4 段");
  for (const key of ["frame_start", "frame_end", "reference_audio", "reference_audios"]) {
    if (present(source[key])) throw new BadRequestException("Muse-video 不支持独立首尾帧或参考音频；请将分镜图作为参考图提交");
  }
  const resources = (single: string, multiple: string, max: number, label: string) => {
    const values: unknown[] = present(source[single]) ? [source[single]] : [];
    if (source[multiple] !== undefined && source[multiple] !== null) {
      if (!Array.isArray(source[multiple])) throw new BadRequestException(`Muse-video ${label}必须是数组`);
      values.push(...source[multiple] as unknown[]);
    }
    if (values.length > max) throw new BadRequestException(`Muse-video 最多支持 ${max} ${label === "参考图" ? "张参考图" : "段参考视频"}`);
    return values.map(value => {
      const item = object(value);
      const url = typeof value === "string" ? value : String(item.url || item.data_url || "");
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new BadRequestException(`Muse-video ${label}需要公网 URL`);
      return { url, type: String(item.type || "reference"), label: String(item.label || label) };
    });
  };
  return { source, seconds, size, count, images: resources("reference_image", "reference_images", 7, "参考图"), videos: resources("reference_video", "reference_videos", 1, "参考视频") };
}

export function museVideoRequest(payload: Record<string, unknown>, allowBatch = false): Record<string, unknown> {
  const input = museVideoInput(payload, allowBatch);
  const images = orderedVideoReferenceImages(input.images);
  return {
    model_id: profile.remoteId,
    prompt: withVideoReferenceRelationships(String(input.source.prompt || ""), images, input.images),
    size: input.size, seconds: input.seconds, resolution: "720P", count: input.count,
    ...(images.length ? { reference_images: images.map(image => image.url) } : {}),
    ...(input.videos.length ? { reference_video: input.videos[0]!.url } : {}),
  };
}
