import { BadRequestException } from "@nestjs/common";

type Obj = Record<string, any>;
const object = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v : {};
export const wagaProfiles: Record<string, { video?: boolean; images: string; max: number; ratio: string; duration?: number[]; fixed?: number; defaults?: Obj; resolution?: false }> = {
  "tt-image-2": { images: "images", max: 10, ratio: "" },
  "banana-pro": { images: "images", max: 14, ratio: "aspectRatio" },
  "doubao-seedream-5-0-pro-260628": { images: "images", max: 10, ratio: "aspect_ratio" },
  "mj_imagine": { images: "images", max: 4, ratio: "aspectRatio", resolution: false, defaults: { botType: "MID_JOURNEY" } },
  "gk-video-3.5": { video: true, images: "images", max: 1, ratio: "aspect_ratio", duration: range(1, 15) },
  "doubao-seedance-2-5-quannengcankao": { video: true, images: "image_url", max: 30, ratio: "aspect_ratio", duration: range(4, 30) },
  "hailuo-h3-quannengcankao": { video: true, images: "image_url", max: 9, ratio: "aspect_ratio", duration: range(4, 15) },
  "kwvideo-v2-quannengcankao": { video: true, images: "image_url", max: 9, ratio: "aspect_ratio", duration: range(4, 15), defaults: { version: "Mini" } },
  "wan3.0-video-quannengcankao": { video: true, images: "image_url", max: 10, ratio: "ratio", duration: range(2, 30), defaults: { version: "standard" } },
  "omni_flash-10s": { video: true, images: "images", max: 7, ratio: "aspect_ratio", fixed: 10, resolution: false },
  "kling-v3-video": { video: true, images: "images", max: 2, ratio: "aspect_ratio", duration: [5, 10, 15], resolution: false, defaults: { mode: "pro" } },
  "viduq3": { video: true, images: "images", max: 2, ratio: "aspect_ratio", duration: [4, 8, 12, 16], defaults: { model_variant: "turbo", off_peak: "false" } },
};
function range(min: number, max: number) { return Array.from({ length: max - min + 1 }, (_, i) => min + i); }
export function wagaFields(schema: unknown): Obj[] { return Array.isArray(schema) ? schema.map(object) : []; }
export function wagaPricePlan(config: unknown, resolution: string): Obj {
  const plans = object(object(config).generation_parameters_by_resolution);
  return object(Object.entries(plans).find(([key]) => key.toLowerCase() === resolution.toLowerCase())?.[1]);
}

/** Same policy for quote and submission. Never round duration or choose Auto. */
export function wagaMediaParams(model: string, schema: unknown, config: unknown, payload: Obj,
  options: { submit?: boolean; references?: { url: string; type?: string }[] } = {}): Obj {
  const profile = wagaProfiles[model];
  if (!profile) return {};
  const fields = wagaFields(schema);
  const source = { ...payload, ...object(payload.params) };
  const resolution = String(payload.resolution ?? source.resolution ?? "");
  const plan = wagaPricePlan(config, resolution);
  const result: Obj = {};
  const fail = (message: string): never => { throw new BadRequestException(`${model}：${message}`); };
  const validate = (name: string, value: any) => {
    const field = fields.find(f => f.name === name);
    const choices = Array.isArray(field?.options) ? field.options.map((v: any) => typeof v === "object" ? v : { value: v }) : [];
    const choice = choices.find((c: Obj) => String(c.value) === String(value));
    if (choices.length && (!choice || choice.currently_unavailable)) fail(`所选${field?.label || name}暂不可用，请更换生成方案。`);
    for (const [dependency, allowed] of Object.entries(object(choice?.requires))) {
      if (Array.isArray(allowed) && !allowed.map(String).includes(String(result[dependency]))) fail("所选清晰度与生成版本不匹配，请更换生成方案。");
    }
    return choice ? choice.value : value;
  };
  const policyFields = ["version", "mode", "model_variant", "off_peak", "botType", "quality", "stylize", "chaos", "style", "audio", "prompt_extend", "web_search"];
  for (const name of policyFields) {
    if (!fields.some(f => f.name === name) && !(name in (profile.defaults || {}))) continue;
    let value = plan[name] ?? source[name] ?? profile.defaults?.[name];
    if (plan[name] != null && source[name] != null && String(plan[name]) !== String(source[name])) fail("生成方案已变化，请重新确认积分后再开始。");
    if (value != null) result[name] = validate(name, value);
  }
  if (profile.video) {
    const durations = [payload.seconds, payload.duration, object(payload.params).seconds, object(payload.params).duration].filter(v => v != null);
    const seconds = Number(durations[0]);
    if (!durations.length || durations.some(v => !["string", "number"].includes(typeof v) || Number(v) !== seconds)
      || !Number.isInteger(seconds) || (profile.fixed ? seconds !== profile.fixed : !profile.duration?.includes(seconds))) {
      fail(profile.fixed ? `该方案固定生成 ${profile.fixed} 秒，请将分镜时长设置为 ${profile.fixed} 秒后再开始。`
        : `不支持当前分镜时长，可用时长为 ${profile.duration && profile.duration.length > 5 ? `${profile.duration[0]}～${profile.duration.at(-1)} 秒的整数` : `${profile.duration?.join("、")} 秒`}；本次未开始生成。`);
    }
    if (plan.billing_duration_seconds != null && Number(plan.billing_duration_seconds) !== seconds) {
      fail(`当前积分方案适用于 ${plan.billing_duration_seconds} 秒视频，请调整分镜时长或更换方案。`);
    }
    if (!profile.fixed) result.duration = validate("duration", String(seconds));
  }
  if (profile.ratio && (source.aspect_ratio ?? source[profile.ratio]) != null) {
    result[profile.ratio] = validate(profile.ratio, source.aspect_ratio ?? source[profile.ratio]);
  }
  // Validate linked resolution constraints even though the gateway maps its wire casing.
  const resField = fields.find(f => ["resolution", "imageSize", "size"].includes(f.name));
  if (resField && resField.name !== "size") {
    const choice = (resField.options || []).find((v: Obj) => String(v.value ?? v).toLowerCase() === resolution.toLowerCase());
    if (choice) validate(resField.name, choice.value ?? choice);
  }
  if (!options.submit) return result;
  const refs = options.references || [];
  // First/last-frame models must receive the actual first frame first.
  const ordered = [...refs.filter(r => r.type === "shot_first_frame"), ...refs.filter(r => r.type !== "shot_first_frame")];
  const imageInput = ordered.length ? ordered.map(r => r.url) : source[profile.images];
  const images = imageInput == null ? [] : Array.isArray(imageInput) ? imageInput : [imageInput];
  if (images.length > profile.max) fail(`最多支持 ${profile.max} 张参考图，当前有 ${images.length} 张，请减少参考图或更换方案。`);
  if (images.some(v => typeof v !== "string" || !/^(https?:\/\/|data:image\/)/.test(v))) fail("参考图格式无效，请重新选择图片。");
  if (images.length) result[profile.images] = images;
  for (const field of ["video_url", "audio_url", "avatar_ids"]) {
    if (source[field] != null && fields.some(f => f.name === field)) result[field] = source[field];
  }
  const has = (v: any) => Array.isArray(v) ? v.length > 0 : Boolean(v);
  if ((model === "gk-video-3.5" && !images.length)
    || (model === "hailuo-h3-quannengcankao" && !images.length && !has(result.video_url))
    || (model === "doubao-seedance-2-5-quannengcankao" && !images.length && !has(result.video_url) && !has(result.audio_url))) {
    fail("该方案需要参考素材，请先提供参考图或更换方案。");
  }
  for (const field of fields.filter(f => f.required && f.name !== "prompt" && !["resolution", "size", "imageSize"].includes(f.name))) {
    if (result[field.name] == null) fail(`缺少必要的生成设置 ${field.label || field.name}，请更换方案。`);
  }
  return result;
}

export function wagaTaskStatus(value: unknown): string {
  const data = object(value);
  // success can be reported before the provider has finished transferring the
  // result. Never settle or download before the documented terminal marker.
  if (data.is_final !== true) return "PROCESSING";
  const state = String(data.state ?? data.status ?? "").toLowerCase();
  if (["success", "succeeded", "completed"].includes(state)) return data.result_url ? "SUCCEEDED" : "PROCESSING";
  if (["failed", "error", "canceled", "cancelled"].includes(state)) return "FAILED";
  return "PROCESSING";
}
