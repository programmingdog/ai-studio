export type VideoBillingUnit = "PER_SECOND" | "PER_REQUEST";

export function modelBillingUnit(capability: string, stored: unknown): VideoBillingUnit {
  return capability === "VIDEO_GENERATION" && stored === "PER_REQUEST" ? "PER_REQUEST" : "PER_SECOND";
}

export function videoDurationOptions(config: unknown): number[] {
  const source = config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : {};
  const values = source.video_duration_options;
  return Array.isArray(values) && values.length <= 60 && values.every((value) => Number.isInteger(value) && value > 0 && value <= 3600)
    ? values as number[] : [];
}

export function validVideoSeconds(seconds: number, config: unknown): boolean {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) return false;
  const options = videoDurationOptions(config);
  return options.length === 0 || options.includes(seconds);
}
