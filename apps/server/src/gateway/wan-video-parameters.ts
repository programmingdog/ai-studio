import { BadRequestException } from "@nestjs/common";

// WagaAI /v1/skills/models/wan3.0-video-quannengcankao (2026-08-31).
// This adapter is deliberately model-specific: other media models use images
// and aspect_ratio, whereas Wan requires image_url, ratio and an edition.
export function wanVideoParameters(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.params;
  const params = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown> : {};
  const source = { ...payload, ...params };
  const durations = [payload.seconds, payload.duration, params.seconds, params.duration]
    .filter(value => value !== undefined && value !== null);
  const seconds = Number(durations[0]);
  if (!durations.length || durations.some(value => !["string", "number"].includes(typeof value)
    || Number(value) !== seconds) || !Number.isInteger(seconds) || seconds < 2 || seconds > 30) {
    throw new BadRequestException("Wan3.0 视频时长需要是 2～30 秒的整数，且预估时长与生成时长一致，请调整分镜时长。");
  }
  // Never choose Auto (30 seconds reserved upstream) or upgrade to Prime.
  const version = source.version == null || source.version === "" ? "standard" : source.version;
  if (version !== "standard" && version !== "prime") {
    throw new BadRequestException("Wan3.0 生成版本不可用，请选择标准版或 Prime 版。");
  }
  const ratio = source.ratio ?? source.aspect_ratio;
  if (ratio != null && !["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4"].includes(String(ratio))) {
    throw new BadRequestException("Wan3.0 不支持当前画面比例，请调整项目画面比例。");
  }
  // Send only documented parameters; omit null optional values from the desktop.
  const result: Record<string, unknown> = { version, duration: String(seconds) };
  for (const field of ["resolution", "image_url", "video_url", "audio_url", "audio", "prompt_extend"]) {
    if (source[field] != null) result[field] = source[field];
  }
  if (ratio != null) result.ratio = ratio;
  return result;
}
