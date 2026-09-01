import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";

type ObjectValue = Record<string, unknown>;
type ResolutionField = "resolution" | "imageSize" | "image_size" | "size";
interface Option { value: string; label: string; unavailable: boolean }
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const key = (value: string): string => value.trim().toLowerCase();

function fieldDefinition(schema: unknown, field: string): ObjectValue | undefined {
  if (Array.isArray(schema)) {
    const found = schema.find((item) => object(item).name === field);
    return found ? object(found) : undefined;
  }
  const source = object(schema);
  const properties = object(source.properties);
  if (properties[field]) return object(properties[field]);
  if (source[field]) return object(source[field]);
  for (const container of ["params", "parameters", "generationConfig", "imageConfig"]) {
    const nested = properties[container] ?? source[container];
    if (nested) { const found = fieldDefinition(nested, field); if (found) return found; }
  }
  return undefined;
}

function options(definition?: ObjectValue): Option[] {
  const values = definition?.enum ?? definition?.options;
  if (!Array.isArray(values)) return [];
  return values.flatMap((item) => {
    const source = object(item);
    const value = typeof item === "string" ? item : source.value;
    return typeof value === "string" ? [{ value: value.trim(), label: String(source.label ?? value), unavailable: source.currently_unavailable === true }] : [];
  });
}

/** Match the provider's actual enum values, never its display labels or a global case rule. */
export function resolveMediaResolution(input: {
  resolution: string; aspectRatio: string; schema: unknown; config: ObjectValue; protocol: string; capability: string; modelCode: string;
}): { field: ResolutionField; value: string } | undefined {
  const requested = input.resolution.trim();
  if (!requested) throw new BadRequestException("图片或视频生成任务必须选择分辨率");
  // This existing fixed-output model has no upstream resolution parameter.
  if (input.modelCode === "omni_flash-10s" && key(requested) === "default") return undefined;
  const fields: ResolutionField[] = ["resolution", "imageSize", "image_size", ...(input.capability === "IMAGE_GENERATION" ? ["size" as const] : [])];
  const configuredField = input.config.resolution_parameter;
  if (configuredField !== undefined && !fields.includes(configuredField as ResolutionField)) throw new ServiceUnavailableException("模型 resolution_parameter 配置无效");
  const field = (configuredField as ResolutionField | undefined) ?? fields.find((name) => fieldDefinition(input.schema, name)) ?? (input.protocol === "gemini" && input.capability === "IMAGE_GENERATION" ? "imageSize" : "resolution");
  const mapping = object(input.config.resolution_mapping);
  const mapped = Object.entries(mapping).find(([name]) => key(name) === key(requested));
  if (mapped) {
    const value = typeof mapped[1] === "string" ? mapped[1] : object(mapped[1])[input.aspectRatio];
    if (typeof value !== "string" || !value.trim()) throw new ServiceUnavailableException("模型分辨率映射缺少当前画面比例的接口值");
    return { field, value: value.trim() };
  }
  const choices = options(fieldDefinition(input.schema, field));
  const match = choices.find((option) => key(option.value) === key(requested));
  if (match) {
    if (match.unavailable) throw new BadRequestException("供应商当前未开放所选分辨率");
    return { field, value: match.value };
  }
  // Some image APIs express 1K/2K/4K as concrete pixel sizes in their catalog.
  if (field === "size" && /^[124]k$/i.test(requested)) {
    const tierMatch = choices.find((option) => {
      const tier = /\b([124]k)\b/i.exec(option.label)?.[1] ?? "1K";
      const ratio = /\b(\d+:\d+)\b/.exec(option.label)?.[1];
      return key(tier) === key(requested) && ratio === input.aspectRatio && !option.unavailable;
    });
    if (tierMatch) return { field, value: tierMatch.value };
  }
  if (choices.length) throw new BadRequestException(`供应商参数 ${field} 不支持分辨率 ${requested}，请检查模型参数定义或分辨率映射`);
  // Without an enum there is no reliable case conversion to infer; administrators
  // can supply resolution_mapping, otherwise preserve the configured/input value.
  return { field, value: requested };
}

/** Catalog/quote checks without a selected aspect ratio: retain a priced tier
 * if it can be used at any supported ratio. Actual submission still validates
 * the exact ratio and uses the provider's enum casing. */
export function supportsMediaResolution(input: Omit<Parameters<typeof resolveMediaResolution>[0], "aspectRatio">): boolean {
  const mapped = Object.entries(object(input.config.resolution_mapping)).find(([name]) => key(name) === key(input.resolution))?.[1];
  const ratios = new Set(["9:16", "16:9", "1:1", "4:3", "3:4", "21:9", ...Object.keys(object(mapped))]);
  for (const option of options(fieldDefinition(input.schema, "size"))) {
    const ratio = /\b(\d+:\d+)\b/.exec(option.label)?.[1];
    if (ratio) ratios.add(ratio);
  }
  return [...ratios].some(aspectRatio => {
    try { resolveMediaResolution({ ...input, aspectRatio }); return true; }
    catch { return false; }
  });
}
