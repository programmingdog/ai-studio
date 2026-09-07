export const WAGAAI_TEXT_MODELS = [
  { modelCode: "gem-3.7-flash", modelAlias: "GEM 3.7 Flash", initialCreditCost: 1, sortOrder: 10 },
  { modelCode: "kimi-k2.6", modelAlias: "Kimi 2.6", initialCreditCost: 1, sortOrder: 20 },
  { modelCode: "glm-5.3-flash", modelAlias: "GLM-5.3 Flash", initialCreditCost: 1, sortOrder: 30 },
] as const;

export const RETIRED_WAGAAI_TEXT_MODEL_CODES = ["tt-5.6-luna", "tt-5.6-sol"] as const;

const visibleTextModelCodes = new Set<string>(WAGAAI_TEXT_MODELS.map((model) => model.modelCode));

export function isAdminVisibleProviderModel(model: {
  provider_code?: string;
  capability: string;
  model_code: string;
}): boolean {
  return model.provider_code?.toLowerCase() !== "wagaai"
    || model.capability !== "TEXT_GENERATION"
    || visibleTextModelCodes.has(model.model_code);
}

export function isDefaultModelCandidate(model: {
  provider_code?: string;
  capability: string;
  model_code: string;
}): boolean {
  return model.capability !== "TEXT_GENERATION"
    || (model.provider_code?.toLowerCase() === "wagaai" && visibleTextModelCodes.has(model.model_code));
}
