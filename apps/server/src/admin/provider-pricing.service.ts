import { BadGatewayException, BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { RowDataPacket } from "mysql2/promise";
import { SecretCryptoService } from "../common/secret-crypto.service";
import { DatabaseService } from "../database/database.service";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const amount = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;

export function normalizePricingGroup(input: unknown) {
  const group = record(input);
  return {
    group_name: string(group.group_name),
    is_active: flag(group.is_active),
    in_key_whitelist: flag(group.in_key_whitelist),
    billing_method: string(group.billing_method),
    currency: string(group.currency),
    price_unit: string(group.price_unit),
    base_price: amount(group.base_price),
    min_price: amount(group.min_price),
    input_token_price: amount(group.input_token_price),
    output_token_price: amount(group.output_token_price),
    current_time_discount: amount(group.current_time_discount),
    option_prices: (Array.isArray(group.option_prices) ? group.option_prices : []).map((value) => {
      const option = record(value);
      return {
        param_name: string(option.param_name), option_label: string(option.option_label),
        option_value: String(option.option_value ?? ""), final_price: amount(option.final_price),
        price_multiplier: amount(option.price_multiplier),
        // Additions may be negative (a discount), unlike absolute prices.
        price_addition: typeof option.price_addition === "number" && Number.isFinite(option.price_addition) ? option.price_addition : null,
        price_impact: string(option.price_impact),
      };
    }),
  };
}

interface ProviderRow extends RowDataPacket { id: string; code: string; display_name: string; base_url: string }
interface CredentialRow extends RowDataPacket { name: string; api_key_ciphertext: string }
interface ModelRow extends RowDataPacket { model_code: string; model_alias: string; display_name: string }
type CatalogModel = { name: string; display_name: string; type: string; available_for_this_key: boolean | null };
type ModelPrice = CatalogModel & {
  local_aliases: string[]; queried_at: string; error: string | null; pricing_note: string;
  currency: string; price_unit: string; channel_groups: ReturnType<typeof normalizePricingGroup>[];
};
export type ProviderPricing = {
  provider_id: string; provider_name: string; credential_name: string; queried_at: string;
  catalog_total: number; success_count: number; failed_count: number; models: ModelPrice[];
};

@Injectable()
export class ProviderPricingService {
  private readonly pending = new Map<string, Promise<ProviderPricing>>();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SecretCryptoService) private readonly crypto: SecretCryptoService,
  ) {}

  // Only coalesce concurrent reads. Every subsequent click gets new upstream prices.
  query(providerId: string): Promise<ProviderPricing> {
    const existing = this.pending.get(providerId);
    if (existing) return existing;
    const pending = this.fetchPricing(providerId).finally(() => this.pending.delete(providerId));
    this.pending.set(providerId, pending);
    return pending;
  }

  private async fetchPricing(providerId: string): Promise<ProviderPricing> {
    const [provider] = await this.database.query<ProviderRow[]>("SELECT id, code, display_name, base_url FROM providers WHERE id = ?", [providerId]);
    if (!provider) throw new NotFoundException("供应商不存在");
    if (provider.code.toLowerCase() !== "wagaai") throw new BadRequestException("该供应商暂未接入实时价格接口，目前支持 WagaAI");
    const [credential] = await this.database.query<CredentialRow[]>(
      "SELECT name, api_key_ciphertext FROM provider_credentials WHERE provider_id = ? AND status = 'ACTIVE' ORDER BY created_at, id LIMIT 1", [providerId],
    );
    if (!credential) throw new BadRequestException("请先为该供应商配置并启用至少一个 API Key");
    let url: URL;
    try { url = new URL(provider.base_url); } catch { throw new BadRequestException("供应商网关地址无效"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new BadRequestException("实时价格查询需要不含认证信息、查询参数的 HTTPS 网关地址");
    }
    const baseUrl = url.toString().replace(/\/+$/, "");
    const key = this.crypto.decrypt(credential.api_key_ciphertext);
    const deadline = AbortSignal.timeout(120_000);
    const get = async (path: string): Promise<JsonRecord> => {
      try {
        deadline.throwIfAborted();
        const response = await fetch(`${baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          redirect: "error", cache: "no-store",
          signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new BadGatewayException(`供应商价格接口返回 HTTP ${response.status}`);
        }
        // Bound the upstream response, and never forward raw errors or credentials.
        const reader = response.body?.getReader();
        if (!reader) throw new Error("empty response");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 8 * 1024 * 1024) throw new Error("response too large");
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
        return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        if (error instanceof BadGatewayException) throw error;
        throw new BadGatewayException(deadline.aborted ? "价格查询超时，请重试" : "供应商价格接口连接失败、超时或返回格式无效，请重试");
      }
    };

    // No type/status filter: include every model exposed by the catalog and paused channels.
    const catalog = await get("/v1/skills/models");
    if (!Array.isArray(catalog.models) || catalog.models.length > 2000) throw new BadGatewayException("供应商模型目录格式无效或超过查询上限");
    const localModels = await this.database.query<ModelRow[]>(
      "SELECT model_code, model_alias, display_name FROM provider_models WHERE provider_id = ?", [providerId],
    );
    const entries = new Map<string, CatalogModel>();
    for (const value of catalog.models) {
      const model = record(value);
      const name = string(model.name);
      if (!name || name.length > 255) throw new BadGatewayException("供应商模型目录包含无效模型名称");
      entries.set(name, { name, display_name: string(model.display_name) || name, type: string(model.type), available_for_this_key: flag(model.available_for_this_key) });
    }
    // The skills catalog can omit special chat models; also look up all locally configured codes.
    for (const model of localModels) {
      if (!entries.has(model.model_code)) entries.set(model.model_code, { name: model.model_code, display_name: model.display_name, type: "", available_for_this_key: null });
    }
    const queue = [...entries.values()];
    const results: ModelPrice[] = new Array(queue.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (cursor < queue.length) {
        const index = cursor++;
        const model = queue[index]!;
        const result: ModelPrice = {
          ...model, local_aliases: localModels.filter((local) => local.model_code === model.name).map((local) => local.model_alias || local.display_name),
          queried_at: "", error: null, pricing_note: "", currency: "", price_unit: "", channel_groups: [],
        };
        try {
          const pricing = await get(`/v1/skills/models/${encodeURIComponent(model.name)}/pricing`);
          if (!Array.isArray(pricing.channel_groups)) throw new BadGatewayException("供应商未返回有效的渠道价格数据");
          result.channel_groups = pricing.channel_groups.map(normalizePricingGroup);
          result.pricing_note = string(pricing.pricing_note);
          result.currency = string(pricing.currency);
          result.price_unit = string(pricing.price_unit);
          result.available_for_this_key = flag(pricing.available_for_this_key) ?? model.available_for_this_key;
        } catch (error) {
          result.error = error instanceof BadGatewayException ? error.message : "该模型价格读取失败";
        }
        result.queried_at = new Date().toISOString();
        results[index] = result;
      }
    }));
    const failed = results.filter((model) => model.error).length;
    return {
      provider_id: providerId, provider_name: provider.display_name, credential_name: credential.name,
      queried_at: new Date().toISOString(), catalog_total: catalog.models.length,
      success_count: results.length - failed, failed_count: failed, models: results,
    };
  }
}
