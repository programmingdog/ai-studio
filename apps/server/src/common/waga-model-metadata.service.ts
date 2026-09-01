import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";
import { SecretCryptoService } from "./secret-crypto.service";
import { calculateModelCredits, CreditPriceModel } from "../admin/credit-price-calculator";
import { normalizePricingGroup, ProviderPricing } from "../admin/provider-pricing.service";

/** Read-only metadata, scoped to the configured provider/key. Never starts a task. */
@Injectable()
export class WagaModelMetadataService {
  private readonly cache = new Map<string, { until: number; value: Promise<Record<string, any>> }>();
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SecretCryptoService) private readonly secrets: SecretCryptoService) {}

  async schema(providerId: string, model: string): Promise<unknown[]> {
    const data = await this.read(providerId, model);
    if (!Array.isArray(data.params)) throw new ServiceUnavailableException("供应商模型定义无效，请稍后重试。");
    return data.params;
  }

  async plans(providerId: string, model: CreditPriceModel): Promise<Record<string, unknown>> {
    const data = await this.read(providerId, model.model_code, "/pricing?status=active");
    const price = { ...data, name: model.model_code, channel_groups: (Array.isArray(data.channel_groups) ? data.channel_groups : []).map(normalizePricingGroup) } as ProviderPricing["models"][number];
    // Only derive the cheapest parameter tuple. This read never changes the
    // administrator's prices, user balance or rounding/multiplier policy.
    return Object.fromEntries(calculateModelCredits(model, price, 1).filter(item => item.status !== "SKIPPED").map(item => [item.resolution, item.parameters]));
  }

  private async read(providerId: string, model: string, suffix = ""): Promise<Record<string, any>> {
    const [route] = await this.database.query<RowDataPacket[]>(`SELECT p.base_url, pc.api_key_ciphertext
      FROM providers p JOIN provider_credentials pc ON pc.provider_id=p.id
      WHERE p.id=? AND p.code='wagaai' AND p.status='ACTIVE' AND pc.status='ACTIVE'
      AND LENGTH(pc.api_key_ciphertext)>0 ORDER BY pc.created_at,pc.id LIMIT 1`, [providerId]);
    if (!route) throw new ServiceUnavailableException("供应商未启用或没有可用密钥，请稍后重试。");
    const url = new URL(`${String(route.base_url).replace(/\/+$/, "")}/v1/skills/models/${encodeURIComponent(model)}${suffix}`);
    if (url.protocol !== "https:") throw new ServiceUnavailableException("供应商文档接口必须使用 HTTPS。");
    const cacheKey = createHash("sha256").update(`${url}|${route.api_key_ciphertext}`).digest("hex");
    const cached = this.cache.get(cacheKey);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = (async () => {
      try {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${this.secrets.decrypt(route.api_key_ciphertext)}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("metadata unavailable");
        const text = await response.text();
        if (text.length > 8 * 1024 * 1024) throw new Error("metadata too large");
        const data = JSON.parse(text);
        if (!data || typeof data !== "object" || data.error) throw new Error("invalid metadata");
        return data;
      } catch {
        this.cache.delete(cacheKey);
        throw new ServiceUnavailableException("暂时无法确认供应商可用方案，请稍后重试。本次没有扣分。");
      }
    })();
    this.cache.set(cacheKey, { until: Date.now() + 60_000, value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}
