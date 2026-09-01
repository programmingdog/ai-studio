import "dotenv/config";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { createConnection, RowDataPacket } from "mysql2/promise";
import { loadDatabaseConfig } from "../config/environment";

const WAGAAI_BASE_URL = "https://api.lk888.ai/api";

type Capability = "TEXT_GENERATION" | "VIDEO_UNDERSTANDING" | "IMAGE_GENERATION" | "VIDEO_GENERATION";

interface CatalogModel {
  name: string;
  alias: string;
  capability: Capability;
  initialCreditCost: number;
  maxReferenceImages: number;
  supportsReferenceVideo: boolean;
  supportsRealPerson?: boolean;
  sortOrder: number;
}

interface ProviderRow extends RowDataPacket {
  id: string;
  config_json: unknown;
}

interface CredentialRow extends RowDataPacket {
  id: string;
  api_key_ciphertext: string;
}

interface ModelDetail {
  name: string;
  display_name: string;
  description?: string;
  input_hint?: string;
  type: "chat" | "image" | "video";
  api_format?: string;
  api_endpoint?: string;
  api_endpoints?: unknown[];
  params?: unknown[];
  params_note?: string;
  tags?: string[];
}

interface PricingGroup {
  billing_method?: string;
  base_price?: number;
  min_price?: number;
  input_token_price?: number;
  output_token_price?: number;
}

interface PricingResponse {
  available_for_this_key?: boolean;
  key_channel_strategy?: string;
  channel_groups?: PricingGroup[];
}

const catalog: CatalogModel[] = [
  { name: "tt-5.6-luna", alias: "TT 5.6 Luna", capability: "TEXT_GENERATION", initialCreditCost: 1, maxReferenceImages: 0, supportsReferenceVideo: false, sortOrder: 10 },
  { name: "tt-5.6-sol", alias: "TT 5.6 Sol", capability: "TEXT_GENERATION", initialCreditCost: 4, maxReferenceImages: 0, supportsReferenceVideo: false, sortOrder: 20 },
  { name: "gem-3.7-flash", alias: "GEM 3.7 视频理解", capability: "VIDEO_UNDERSTANDING", initialCreditCost: 1, maxReferenceImages: 0, supportsReferenceVideo: true, sortOrder: 10 },
  { name: "tt-image-2", alias: "TT Image 2", capability: "IMAGE_GENERATION", initialCreditCost: 2, maxReferenceImages: 10, supportsReferenceVideo: false, sortOrder: 10 },
  { name: "banana-pro", alias: "Banana Pro", capability: "IMAGE_GENERATION", initialCreditCost: 3, maxReferenceImages: 14, supportsReferenceVideo: false, sortOrder: 20 },
  { name: "doubao-seedream-5-0-pro-260628", alias: "Seedream 5.0 Pro", capability: "IMAGE_GENERATION", initialCreditCost: 3, maxReferenceImages: 2, supportsReferenceVideo: false, sortOrder: 30 },
  { name: "mj_imagine", alias: "Midjourney", capability: "IMAGE_GENERATION", initialCreditCost: 3, maxReferenceImages: 4, supportsReferenceVideo: false, sortOrder: 40 },
  { name: "gk-video-3.5", alias: "GK Video 3.5", capability: "VIDEO_GENERATION", initialCreditCost: 6, maxReferenceImages: 1, supportsReferenceVideo: false, sortOrder: 10 },
  { name: "doubao-seedance-2-5-quannengcankao", alias: "Seedance 2.5 全能参考", capability: "VIDEO_GENERATION", initialCreditCost: 14, maxReferenceImages: 30, supportsReferenceVideo: true, sortOrder: 20 },
  { name: "hailuo-h3-quannengcankao", alias: "海螺 H3 全能参考", capability: "VIDEO_GENERATION", initialCreditCost: 8, maxReferenceImages: 9, supportsReferenceVideo: true, sortOrder: 30 },
  { name: "kwvideo-v2-quannengcankao", alias: "Seedance 2.0 全能参考", capability: "VIDEO_GENERATION", initialCreditCost: 12, maxReferenceImages: 9, supportsReferenceVideo: true, supportsRealPerson: true, sortOrder: 40 },
  { name: "wan3.0-video-quannengcankao", alias: "Wan3 全能参考", capability: "VIDEO_GENERATION", initialCreditCost: 10, maxReferenceImages: 10, supportsReferenceVideo: true, sortOrder: 50 },
  { name: "omni_flash-10s", alias: "Omni Flash 10s", capability: "VIDEO_GENERATION", initialCreditCost: 10, maxReferenceImages: 7, supportsReferenceVideo: false, sortOrder: 60 },
  { name: "kling-v3-video", alias: "Kling V3", capability: "VIDEO_GENERATION", initialCreditCost: 18, maxReferenceImages: 2, supportsReferenceVideo: false, sortOrder: 70 },
  { name: "viduq3", alias: "Vidu Q3", capability: "VIDEO_GENERATION", initialCreditCost: 8, maxReferenceImages: 2, supportsReferenceVideo: false, sortOrder: 80 },
];

const replacedModelCodes = [
  "doubao-seedance-2-5-260628",
  "hailuo-h3-cankaosheng",
  "kwvideo-v2",
  "omni-flash",
];

function decryptSecret(payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unsupported encrypted API Key format");
  const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!encryptionKey) throw new Error("Missing CREDENTIAL_ENCRYPTION_KEY");
  const key = createHash("sha256").update(encryptionKey).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

async function requestJson<T>(path: string, apiKey: string): Promise<T> {
  const response = await fetch(`${WAGAAI_BASE_URL}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`WagaAI ${path} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function finiteNumbers(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function pricingSummary(pricing: PricingResponse): Record<string, unknown> {
  const groups = pricing.channel_groups || [];
  const billingMethods = [...new Set(groups.map((group) => group.billing_method).filter(Boolean))];
  const minPrices = finiteNumbers(groups.flatMap((group) => [group.min_price, group.base_price]));
  const inputTokenPrices = finiteNumbers(groups.map((group) => group.input_token_price));
  const outputTokenPrices = finiteNumbers(groups.map((group) => group.output_token_price));
  return {
    available_for_this_key: Boolean(pricing.available_for_this_key),
    channel_strategy: pricing.key_channel_strategy || null,
    billing_methods: billingMethods,
    active_channel_count: groups.length,
    lowest_price: minPrices.length ? Math.min(...minPrices) : null,
    lowest_input_token_price: inputTokenPrices.length ? Math.min(...inputTokenPrices) : null,
    lowest_output_token_price: outputTokenPrices.length ? Math.min(...outputTokenPrices) : null,
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const connection = await createConnection({ ...loadDatabaseConfig(), charset: "utf8mb4", timezone: "Z" });
  try {
    const [providers] = await connection.query<ProviderRow[]>("SELECT id, config_json FROM providers WHERE code = 'wagaai' LIMIT 1");
    if (!providers.length) throw new Error("WagaAI provider does not exist; run database migrations first");
    const provider = providers[0]!;
    const [credentials] = await connection.query<CredentialRow[]>(
      `SELECT id, api_key_ciphertext FROM provider_credentials
       WHERE provider_id = ? AND status = 'ACTIVE' AND api_key_ciphertext IS NOT NULL
       ORDER BY created_at LIMIT 1`,
      [provider.id],
    );
    if (!credentials.length) throw new Error("WagaAI has no active database API Key");
    const credential = credentials[0]!;
    const apiKey = decryptSecret(credential.api_key_ciphertext);

    const skills = await requestJson<Record<string, unknown>>("/v1/skills", apiKey);
    const balance = await requestJson<Record<string, unknown>>("/v1/skills/balance", apiKey);
    const syncedAt = new Date().toISOString();
    const providerConfig = {
      ...parseJsonObject(provider.config_json),
      credentials_configured: true,
      docs_version: skills.version || null,
      platform: skills.platform || "LingkeAI",
      model_catalog_source: "/v1/skills/models",
      balance_endpoint: "/v1/skills/balance",
      media_generation_endpoint: "/v1/media/generate",
      task_query_endpoint: "/v1/skills/task-status",
      last_model_sync_at: syncedAt,
    };

    await connection.beginTransaction();
    try {
      await connection.execute(
        `UPDATE providers SET display_name = 'WagaAI', adapter_type = 'lingkeai', base_url = ?,
         status = 'ACTIVE', config_json = ? WHERE id = ?`,
        [WAGAAI_BASE_URL, JSON.stringify(providerConfig), provider.id],
      );

      const balanceValue = Number(balance.balance);
      await connection.execute(
        `UPDATE provider_credentials SET balance = ?, balance_currency = ?, last_balance_synced_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [Number.isFinite(balanceValue) ? balanceValue : null, String(balance.unit || "CREDITS"), credential.id],
      );

      await connection.query(
        `DELETE FROM provider_models WHERE provider_id = ? AND model_code IN (${replacedModelCodes.map(() => "?").join(", ")})`,
        [provider.id, ...replacedModelCodes],
      );

      for (const selected of catalog) {
        const [detail, pricing] = await Promise.all([
          requestJson<ModelDetail>(`/v1/skills/models/${encodeURIComponent(selected.name)}`, apiKey),
          requestJson<PricingResponse>(`/v1/skills/models/${encodeURIComponent(selected.name)}/pricing?status=active`, apiKey),
        ]);
        const isMedia = detail.type === "image" || detail.type === "video";
        const config = {
          source: "wagaai_skills_api",
          source_type: detail.type,
          tags: detail.tags || [],
          input_hint: detail.input_hint || "",
          api_endpoints: detail.api_endpoints || [],
          params_note: detail.params_note || "",
          pricing: pricingSummary(pricing),
          pricing_synced_at: syncedAt,
          real_person_support_source: selected.capability === "VIDEO_GENERATION"
            ? (selected.supportsRealPerson
                ? "WagaAI avatar_ids 参数明确支持真人头像，但要求先完成二维码活体认证。"
                : "当前 WagaAI 模型文档未明确承诺真人支持，按平台默认值关闭。")
            : undefined,
          credit_cost_note: selected.capability === "VIDEO_GENERATION"
            ? "每秒消耗积分数；首次同步使用预设值，后台人工修改后续同步会保留。"
            : "每次消耗积分数；首次同步使用预设值，后台人工修改后续同步会保留。",
        };
        await connection.execute(
          `INSERT INTO provider_models
            (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
             generation_endpoint, query_endpoint, credit_cost, max_reference_images,
             supports_reference_video, supports_real_person, supports_async_tasks, sort_order, description, status,
             parameter_schema_json, config_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
           ON DUPLICATE KEY UPDATE
             display_name = VALUES(display_name), model_alias = VALUES(model_alias), capability = VALUES(capability),
             api_protocol = VALUES(api_protocol), generation_endpoint = VALUES(generation_endpoint),
             query_endpoint = VALUES(query_endpoint), max_reference_images = VALUES(max_reference_images),
             supports_reference_video = VALUES(supports_reference_video),
             supports_real_person = VALUES(supports_real_person),
             supports_async_tasks = VALUES(supports_async_tasks), sort_order = VALUES(sort_order),
             description = VALUES(description), parameter_schema_json = VALUES(parameter_schema_json),
             config_json = VALUES(config_json)`,
          [randomUUID(), provider.id, selected.name, detail.display_name, selected.alias, selected.capability,
           isMedia ? "lingkeai_media" : (detail.api_format || "openai"),
           isMedia ? "/v1/media/generate" : (detail.api_endpoint || "/v1/chat/completions"),
           isMedia ? "/v1/skills/task-status" : null, selected.initialCreditCost,
           selected.maxReferenceImages, selected.supportsReferenceVideo ? 1 : 0,
           selected.supportsRealPerson ? 1 : 0, isMedia ? 1 : 0,
           selected.sortOrder, detail.description || "", JSON.stringify(detail.params || []), JSON.stringify(config)],
        );
        if (isMedia) {
          await connection.execute(
            `INSERT IGNORE INTO provider_model_resolution_prices (provider_model_id, resolution, credit_cost, sort_order)
             SELECT id, ?, credit_cost, 0 FROM provider_models WHERE provider_id = ? AND model_code = ?`,
            [selected.name === "hailuo-h3-cankaosheng" ? "768P" : selected.name === "omni_flash-10s" ? "default" : selected.capability === "VIDEO_GENERATION" ? "720p" : "1K", provider.id, selected.name],
          );
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    process.stdout.write(`WagaAI sync complete: ${catalog.length} models, balance refreshed, docs ${String(skills.version || "unknown")}\n`);
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`WagaAI sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
