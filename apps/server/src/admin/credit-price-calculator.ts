import { resolveMediaResolution } from "../gateway/media-resolution";
import { ProviderPricing } from "./provider-pricing.service";
import { wagaProfiles } from "../gateway/waga-media";

type ObjectValue = Record<string, unknown>;
type Price = ProviderPricing["models"][number];
type Group = Price["channel_groups"][number];
type OptionPrice = Group["option_prices"][number];
type Choice = { value: string; label: string; unavailable: boolean };
type Variant = { multiplier: number; addition: number; parameters: Record<string, string> };
export type CreditPriceModel = {
  id: string; model_code: string; model_alias: string; capability: string; api_protocol: string;
  credit_cost: number; parameter_schema_json: unknown; config_json: unknown;
  resolution_prices: { resolution: string; credit_cost: number }[];
};
export type CreditPriceResult = {
  model_id: string; model_code: string; model_alias: string; resolution: string;
  billing_unit: "PER_REQUEST" | "PER_SECOND"; previous_credits: number; credits: number | null;
  price_cny: number | null; channel: string; parameters: Record<string, string>;
  status: "UPDATED" | "UNCHANGED" | "SKIPPED"; reason: string;
};
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const key = (value: string) => value.trim().toLowerCase();
const durationFields = ["duration", "seconds", "duration_seconds"];
const resolutionFields = ["resolution", "imagesize", "image_size", "size"];

function definition(schema: unknown, name: string): ObjectValue | undefined {
  if (Array.isArray(schema)) return schema.map(object).find((item) => key(String(item.name)) === key(name));
  const source = object(schema);
  const fields = object(source.properties ?? source);
  const field = Object.keys(fields).find((field) => key(field) === key(name));
  if (field) return object(fields[field]);
  for (const container of ["params", "parameters", "generationConfig", "imageConfig"]) {
    if (fields[container]) { const found = definition(fields[container], name); if (found) return found; }
  }
  return undefined;
}
function choices(field?: ObjectValue): Choice[] {
  const values = field?.options ?? field?.enum;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const item = object(value), raw = typeof value === "string" || typeof value === "number" ? value : item.value;
    return typeof raw === "string" || typeof raw === "number" ? [{ value: String(raw), label: String(item.label ?? raw), unavailable: item.currently_unavailable === true }] : [];
  });
}

export function validateCnyPerCredit(value: unknown): number {
  const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  if (!/^\d+(?:\.\d{1,6})?$/.test(text) || Number(text) < 0.000001 || Number(text) > 1000000) {
    throw new Error("每积分人民币金额须为 0.000001～1000000 的数字，最多 6 位小数");
  }
  return Number(text);
}

/** Decimal ceiling avoids e.g. 0.07 / 0.01 becoming 7.000000000000001. */
export function cnyToCredits(cny: number, cnyPerCredit: number): number {
  validateCnyPerCredit(cnyPerCredit);
  if (!Number.isFinite(cny) || cny < 0 || cny > 100000000000) throw new Error("人民币报价无效");
  const numerator = BigInt(cny.toFixed(12).replace(".", ""));
  const denominator = BigInt(cnyPerCredit.toFixed(12).replace(".", ""));
  const credits = Math.max(1, Number((numerator + denominator - 1n) / denominator));
  if (credits > 100000) throw new Error("换算积分超过单价上限 100000，保留原定价");
  return credits;
}

function optionFactor(option?: OptionPrice, base = 0): { multiplier: number; addition: number } {
  if (!option) return { multiplier: 1, addition: 0 }; // Documented: omitted options use base price.
  const addition = option.price_addition ?? 0;
  // Upstream multipliers are rounded; prefer the exact final_price for a single dimension.
  const multiplier = base > 0 && option.final_price !== null ? (option.final_price - addition) / base : option.price_multiplier;
  if (multiplier === null || !Number.isFinite(multiplier) || multiplier < 0) throw new Error("缺少可靠的参数价格系数");
  if (base === 0 && option.final_price !== null && Math.abs(option.final_price - addition) > 1e-8) throw new Error("零基础价的参数加价无法核对");
  return { multiplier, addition };
}

function dimension(group: Group, schema: unknown, name: string, selected?: string): Array<Variant> {
  const priced = group.option_prices.filter((option) => key(option.param_name) === key(name));
  const field = definition(schema, name);
  if (field?.constraints && Object.keys(object(field.constraints)).length) throw new Error("参数含联动约束，需人工核价");
  let available = choices(field).filter((choice) => !choice.unavailable);
  if (selected !== undefined) {
    if (available.length && !available.some((choice) => key(choice.value) === key(selected))) throw new Error(`参数 ${name} 不支持所选档位`);
    available = [{ value: selected, label: selected, unavailable: false }];
  } else if (!available.length) {
    if (choices(field).length) throw new Error(`参数 ${name} 暂无可用选项`);
    available = priced.map((option) => ({ value: option.option_value, label: option.option_label, unavailable: false }));
  }
  if (!available.length) return [{ multiplier: 1, addition: 0, parameters: {} }];
  return available.map((choice) => ({
    ...optionFactor(priced.find((option) => key(option.option_value) === key(choice.value)), group.base_price!),
    parameters: { [name]: choice.value },
  }));
}

function groupMinimum(group: Group, model: CreditPriceModel, resolution: string) {
  const method = group.billing_method.trim();
  if (!["按次", "按秒"].includes(method)) throw new Error("按 Token 计费，缺少用量换算规则；保留原积分");
  if (group.base_price === null) throw new Error("供应商未返回基础报价");
  const video = model.capability === "VIDEO_GENERATION";
  if (!video && method !== "按次") throw new Error("供应商计费单位无法换算为每次积分");
  const currency = group.currency;
  if (currency && !["CNY", "RMB", "人民币", "元", "算力"].includes(currency.toUpperCase())) throw new Error("报价币种不是人民币或算力");
  const config = object(model.config_json);
  // Name suffix is a documented upstream tier restriction, not a price dimension.
  const restricted = /-([124]k)(?:$|[\s（(])/i.exec(group.group_name)?.[1];
  if (restricted && key(restricted) !== key(resolution)) throw new Error("该渠道仅支持其他分辨率");

  const aspectChoices = choices(definition(model.parameter_schema_json, "aspect_ratio") ?? definition(model.parameter_schema_json, "aspectRatio"));
  const ratios = aspectChoices.filter((choice) => !choice.unavailable && /^\d+:\d+$/.test(choice.value)).map((choice) => choice.value);
  const aspects = ratios.length ? ratios : ["9:16", "16:9", "1:1", "4:3", "3:4", "2:3", "3:2", "21:9"];
  const selectedValues = new Map<string, { field: string; value: string } | undefined>();
  for (const aspect of resolution ? aspects : [""]) {
    try {
      const selected = resolution ? resolveMediaResolution({ resolution, aspectRatio: aspect, schema: model.parameter_schema_json, config,
        protocol: model.api_protocol, capability: model.capability, modelCode: model.model_code }) : undefined;
      selectedValues.set(JSON.stringify(selected) || "fixed", selected);
    } catch { /* Other aspect ratios may still map to this resolution. */ }
  }
  if (!selectedValues.size) throw new Error("供应商参数定义不支持或暂未开放该分辨率");
  const candidates: { price_cny: number; parameters: Record<string, string> }[] = [];
  for (const selected of selectedValues.values()) {
    const names = [...new Set(group.option_prices.map((option) => option.param_name))];
    // Include required priced editions even if the provider omits them from
    // option_prices (omitted choices use base_price, not a missing parameter).
    for (const name of Object.keys(wagaProfiles[model.model_code]?.defaults || {})) {
      if (!names.includes(name)) names.push(name);
    }
    if (selected && !names.some((name) => key(name) === key(selected.field))) names.push(selected.field);
    const durationField = durationFields.find((name) => definition(model.parameter_schema_json, name)) ?? names.find((name) => durationFields.includes(key(name)));
    if (video && method === "按次" && durationField && !names.includes(durationField)) names.push(durationField);
    let variants: Variant[] = [{ multiplier: 1, addition: 0, parameters: {} }];
    for (const name of names) {
      // Do not accidentally choose a cheaper resolution in a second resolution field.
      if (selected && resolutionFields.includes(key(name)) && key(name) !== key(selected.field)) throw new Error("渠道与模型的分辨率参数不一致");
      const selectedValue = selected && key(name) === key(selected.field) ? selected.value : undefined;
      const options = dimension(group, model.parameter_schema_json, name, selectedValue);
      if (variants.length * options.length > 4096) throw new Error("价格参数组合过多，需人工核价");
      variants = variants.flatMap((variant) => options.map((option) => ({ multiplier: variant.multiplier * option.multiplier,
        addition: variant.addition + option.addition, parameters: { ...variant.parameters, ...option.parameters } })));
    }
    for (const variant of variants) {
      // Option-level dependencies (e.g. 1080p requires Standard) must hold
      // before selecting a minimum; otherwise the cheapest tuple cannot run.
      const compatible = Object.entries(variant.parameters).every(([name, value]) => {
        const field = definition(model.parameter_schema_json, name);
        const choice = (Array.isArray(field?.options) ? field.options : []).map(object).find(item => key(String(item.value)) === key(value));
        return Object.entries(object(choice?.requires)).every(([dependency, allowed]) =>
          Array.isArray(allowed) && allowed.map(String).includes(variant.parameters[dependency] ?? String(wagaProfiles[model.model_code]?.defaults?.[dependency] ?? "")));
      });
      if (!compatible) continue;
      let value = group.base_price * variant.multiplier + variant.addition;
      // min_price is a real payable floor; base_price alone may not be purchasable.
      if (group.min_price !== null) value = Math.max(value, group.min_price);
      if (video && method === "按次") {
        const seconds = Number(durationField ? variant.parameters[durationField] : config.fixed_duration_seconds ?? (model.model_code === "omni_flash-10s" ? 10 : NaN));
        if (!Number.isFinite(seconds) || seconds <= 0) continue;
        value /= seconds;
        variant.parameters.billing_duration_seconds = String(seconds);
      }
      if (Number.isFinite(value) && value >= 0) candidates.push({ price_cny: Number(value.toFixed(12)), parameters: variant.parameters });
    }
  }
  candidates.sort((a, b) => a.price_cny - b.price_cny);
  if (!candidates.length) throw new Error("缺少可用于换算每秒价格的明确时长或参数");
  const best = candidates[0]!;
  if (video && best.parameters.billing_duration_seconds && !wagaProfiles[model.model_code]?.fixed) {
    const withoutDuration = (parameters: Record<string, string>) => JSON.stringify(Object.entries(parameters)
      .filter(([name]) => !durationFields.includes(name) && name !== "billing_duration_seconds").sort());
    const samePlan = candidates.filter(candidate => withoutDuration(candidate.parameters) === withoutDuration(best.parameters));
    // Linear duration pricing may use any supported duration; do not lock a
    // 4/8/12/16s model to 4s just because that equal-price candidate came first.
    if (samePlan.length > 1 && samePlan.every(candidate => Math.abs(candidate.price_cny - best.price_cny) < 1e-10)) {
      delete best.parameters.billing_duration_seconds;
      for (const name of durationFields) delete best.parameters[name];
    }
  }
  return best;
}

export function calculateModelCredits(model: CreditPriceModel, pricing: Price | undefined, cnyPerCredit: number): CreditPriceResult[] {
  validateCnyPerCredit(cnyPerCredit);
  const media = ["IMAGE_GENERATION", "VIDEO_GENERATION"].includes(model.capability);
  const tiers = media && model.resolution_prices.length ? model.resolution_prices : [{ resolution: "", credit_cost: model.credit_cost }];
  return tiers.map((tier): CreditPriceResult => {
    const result: CreditPriceResult = { model_id: model.id, model_code: model.model_code, model_alias: model.model_alias,
      resolution: tier.resolution, billing_unit: model.capability === "VIDEO_GENERATION" ? "PER_SECOND" : "PER_REQUEST",
      previous_credits: Number(tier.credit_cost), credits: null, price_cny: null, channel: "", parameters: {}, status: "SKIPPED", reason: "" };
    try {
      if (media && !tier.resolution) throw new Error("尚未配置分辨率");
      if (!pricing || pricing.error) throw new Error(pricing?.error || "未查询到该模型价格");
      if (pricing.available_for_this_key === false) throw new Error("当前 API Key 不可用");
      if (pricing.currency && !["CNY", "RMB", "人民币", "元", "算力"].includes(pricing.currency.toUpperCase())) throw new Error("报价币种不支持换算");
      const groups = pricing.channel_groups.filter((group) => group.is_active === true && group.in_key_whitelist !== false);
      if (!groups.length) throw new Error("没有运行中且当前 Key 可用的渠道");
      const errors: string[] = [];
      const offers = groups.flatMap((group) => {
        try { return [{ ...groupMinimum(group, model, tier.resolution), channel: group.group_name }]; }
        catch (error) { errors.push(error instanceof Error ? error.message : "价格无法换算"); return []; }
      }).sort((left, right) => left.price_cny - right.price_cny);
      const best = offers[0];
      if (!best) throw new Error([...new Set(errors)].join("；"));
      result.price_cny = best.price_cny; result.channel = best.channel; result.parameters = best.parameters;
      result.credits = cnyToCredits(best.price_cny, cnyPerCredit);
      result.status = result.credits === result.previous_credits ? "UNCHANGED" : "UPDATED";
      if (errors.some((error) => error.includes("Token"))) result.reason = "仅比较可换算的按次/按秒渠道；Token 渠道未参与比较";
    } catch (error) { result.reason = error instanceof Error ? error.message : "价格换算失败"; }
    return result;
  });
}
