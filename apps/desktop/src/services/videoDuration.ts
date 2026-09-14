import type { PlatformMediaModel } from "./platform";

export type VideoDurationMode = "automatic" | "manual";

export function normalizedVideoDurationOptions(options: readonly number[] | undefined): number[] {
  return [...new Set((options ?? []).filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
}

export function resolveVideoDuration(shotDuration: number, model: Pick<PlatformMediaModel, "video_duration_options">, mode: VideoDurationMode): number {
  if (!Number.isFinite(shotDuration) || shotDuration <= 0) throw new Error("分镜时长无效，请先修改分镜时长。");
  const minimum = mode === "automatic" ? Math.max(10, shotDuration) : shotDuration;
  const options = normalizedVideoDurationOptions(model.video_duration_options);
  if (!options.length) return minimum;
  const duration = options.find((value) => value >= minimum);
  if (duration === undefined) throw new Error(`分镜时长为 ${shotDuration} 秒，该模型最长只能生成 ${options.at(-1)} 秒，请缩短分镜或更换模型。`);
  return duration;
}

export function selectableVideoDurations(shotDuration: number, model: Pick<PlatformMediaModel, "video_duration_options">): Array<{ seconds: number; disabled: boolean }> {
  return normalizedVideoDurationOptions(model.video_duration_options).map((seconds) => ({ seconds, disabled: seconds < shotDuration }));
}
