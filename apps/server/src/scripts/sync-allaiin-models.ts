import "dotenv/config";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { createConnection, type Connection, type RowDataPacket } from "mysql2/promise";
import { loadDatabaseConfig } from "../config/environment";
import { allaiinPointsToCredits, ALLAIIN_POINT_CNY, previousAllaiinSyncedCredits } from "./allaiin-credit-pricing";

const BASE_URL = "https://ailingg.store/api/v1";
const DOCS_URL = "https://ailingg.store/api-docs";

type Capability = "TEXT_GENERATION" | "VIDEO_UNDERSTANDING" | "IMAGE_GENERATION" | "VIDEO_GENERATION";

interface CatalogModel {
  modelCode: string;
  remoteId?: number;
  alias: string;
  capability: Capability;
  maxReferenceImages: number;
  supportsReferenceVideo: boolean;
  supportsRealPerson: boolean;
  sortOrder: number;
}

interface ProviderRow extends RowDataPacket { id: string; config_json: unknown }
interface CredentialRow extends RowDataPacket { id: string; api_key_ciphertext: string }
interface PricingRow extends RowDataPacket { id: string; model_code: string; model_alias: string; capability: string; billing_unit: string; credit_cost: number | string; config_json: unknown }
interface PricingConfigRow extends RowDataPacket { cny_per_credit: number | string; auto_sync: number }
interface PricingPlan {
  id: string; modelCode: string; alias: string; previousCredits: number; nextCredits: number | null;
  previousSourceCredits: number | null; providerPoints: number | null;
  status: "UPDATED" | "UNCHANGED" | "MANUAL" | "SKIPPED";
  config: Record<string, unknown> | null;
}
interface RemoteModel {
  id: number;
  model_id: string;
  model?: string;
  name: string;
  type: number;
  type_name: string;
  points_cost: number;
  line_selection?: unknown;
}
interface ApiResponse<T> { code: number; message?: string; data: T }
interface AccountData {
  name?: string;
  points_balance?: number;
  key_name?: string;
  daily_limit?: number;
  daily_used?: number;
}

const curatedCatalog: CatalogModel[] = [
  { modelCode: "gpt-5.5", alias: "GPT-5.5", capability: "TEXT_GENERATION", maxReferenceImages: 0, supportsReferenceVideo: false, supportsRealPerson: false, sortOrder: 10 },
  { modelCode: "gemini-3.5-flash", alias: "Gemini 3.5 Flash 视频理解", capability: "VIDEO_UNDERSTANDING", maxReferenceImages: 1, supportsReferenceVideo: true, supportsRealPerson: false, sortOrder: 10 },
  { modelCode: "image2-2k", alias: "GPT-Image-2", capability: "IMAGE_GENERATION", maxReferenceImages: 10, supportsReferenceVideo: false, supportsRealPerson: false, sortOrder: 10 },
  { modelCode: "nano_banana_pro", alias: "Banana Pro", capability: "IMAGE_GENERATION", maxReferenceImages: 14, supportsReferenceVideo: false, supportsRealPerson: false, sortOrder: 20 },
];

const videoAliasOverrides = new Map<number, string>([
  [11, "Veo4-omni"],
  [33, "Seedance 2.0"],
  [53, "Grok 1.5"],
  [55, "Seedance 2.5"],
  [65, "Seedance 2.0 冲量版"],
  [69, "Wan3"],
  [76, "MiniMax H3 官"],
]);

const videoCodeOverrides = new Map<number, string>([
  // AllAIIn id 65 uses "Seedance 2.0 Fast" as model_id. Use a stable,
  // unambiguous local code while routing requests by remote_numeric_id.
  [65, "seedance-2-0-chongliang"],
  [76, "minimax-h3-official"],
]);

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

function isHappyHorse11(model: RemoteModel): boolean {
  const identity = `${model.name} ${model.model_id}`.toLowerCase().replace(/[\s_-]+/g, "");
  return identity.includes("happyhorse1.1") || identity.includes("happyhorse11");
}

function videoReferenceSupport(model: RemoteModel): { maxReferenceImages: number; supportsReferenceVideo: boolean } {
  if (model.id === 76) return { maxReferenceImages: 9, supportsReferenceVideo: true };
  const code = model.model_id.toLowerCase();
  if (/seedance[-\s_]*2[-.\s_]*0/.test(code)) {
    return { maxReferenceImages: 2, supportsReferenceVideo: true };
  }
  if (code.includes("omni_flash")) return { maxReferenceImages: 3, supportsReferenceVideo: false };
  if (code.includes("grok-imagine")) return { maxReferenceImages: 1, supportsReferenceVideo: false };
  return { maxReferenceImages: 0, supportsReferenceVideo: false };
}

function buildVideoCatalog(remoteModels: RemoteModel[]): CatalogModel[] {
  const seenCodes = new Set<string>();
  return remoteModels
    .filter((model) => model.type === 3 && !isHappyHorse11(model))
    .sort((left, right) => left.id - right.id)
    .map((remote, index) => {
      const duplicate = seenCodes.has(remote.model_id);
      seenCodes.add(remote.model_id);
      const reference = videoReferenceSupport(remote);
      return {
        modelCode: videoCodeOverrides.get(remote.id) || (duplicate ? `${remote.model_id}:${remote.id}` : remote.model_id),
        remoteId: remote.id,
        alias: videoAliasOverrides.get(remote.id) || remote.name,
        capability: "VIDEO_GENERATION",
        maxReferenceImages: reference.maxReferenceImages,
        supportsReferenceVideo: reference.supportsReferenceVideo,
        supportsRealPerson: false,
        sortOrder: (index + 1) * 10,
      };
    });
}

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

async function request<T>(path: string, apiKey: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`AllAIIn ${path} returned HTTP ${response.status}`);
  const payload = await response.json() as ApiResponse<T>;
  if (payload.code !== 200) throw new Error(payload.message || `AllAIIn ${path} failed with code ${payload.code}`);
  return payload.data;
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

async function planCreditPrices(db: Connection, providerId: string, remoteById: Map<number, RemoteModel>, cnyPerCredit: number, syncedAt: string): Promise<PricingPlan[]> {
  const [rows] = await db.query<PricingRow[]>(
    "SELECT id, model_code, model_alias, capability, billing_unit, credit_cost, config_json FROM provider_models WHERE provider_id = ? ORDER BY model_code",
    [providerId],
  );
  return rows.map((row) => {
    const config = parseJsonObject(row.config_json);
    const remote = remoteById.get(Number(config.remote_numeric_id));
    const previousCredits = Number(row.credit_cost);
    const previousSourceCredits = previousAllaiinSyncedCredits(config);
    if (row.capability === "VIDEO_GENERATION" && row.billing_unit === "PER_REQUEST") {
      return { id: row.id, modelCode: row.model_code, alias: row.model_alias, previousCredits,
        nextCredits: null, previousSourceCredits, providerPoints: remote ? Number(remote.points_cost) : null, status: "MANUAL", config: null };
    }
    if (!remote || previousSourceCredits === null) {
      return { id: row.id, modelCode: row.model_code, alias: row.model_alias, previousCredits,
        nextCredits: null, previousSourceCredits, providerPoints: null, status: "SKIPPED", config: null };
    }
    const nextCredits = allaiinPointsToCredits(Number(remote.points_cost), cnyPerCredit);
    const automatic = previousCredits === previousSourceCredits;
    return {
      id: row.id, modelCode: row.model_code, alias: row.model_alias, previousCredits, nextCredits,
      previousSourceCredits, providerPoints: Number(remote.points_cost),
      status: !automatic ? "MANUAL" : previousCredits === nextCredits ? "UNCHANGED" : "UPDATED",
      config: {
        ...config, source_points_cost: Number(remote.points_cost), source_point_cny: ALLAIIN_POINT_CNY,
        source_credit_cost: nextCredits, source_cny_per_credit: cnyPerCredit,
        request_model_name: remote.name, remote_model_id: remote.model_id, pricing_synced_at: syncedAt,
      },
    };
  });
}

async function applyCreditPrices(db: Connection, plans: PricingPlan[]): Promise<void> {
  for (const plan of plans) {
    if (!plan.config) continue;
    if (plan.status === "UPDATED") {
      const [result] = await db.execute(
        "UPDATE provider_models SET credit_cost = ? WHERE id = ? AND credit_cost = ?",
        [plan.nextCredits, plan.id, plan.previousCredits],
      );
      if (!result || !("affectedRows" in result) || result.affectedRows !== 1) {
        throw new Error(`AllAIIn model price changed during sync: ${plan.modelCode}`);
      }
      await db.execute(
        "UPDATE provider_model_resolution_prices SET credit_cost = ? WHERE provider_model_id = ? AND credit_cost = ?",
        [plan.nextCredits, plan.id, plan.previousCredits],
      );
    }
    await db.execute("UPDATE provider_models SET config_json = ? WHERE id = ?", [JSON.stringify(plan.config), plan.id]);
  }
}

function commonPromptParameter(): Record<string, unknown> {
  return { name: "prompt", label: "提示词", type: "textarea", required: true, description: "生成内容描述；也可使用 OpenAI messages 格式。" };
}

function parameterSchema(model: CatalogModel): Record<string, unknown>[] {
  if (model.capability === "TEXT_GENERATION") {
    return [
      commonPromptParameter(),
      { name: "messages", label: "消息列表", type: "array", required: false, description: "OpenAI 格式消息数组，与 prompt 二选一。" },
    ];
  }
  if (model.capability === "VIDEO_UNDERSTANDING") {
    return [
      commonPromptParameter(),
      { name: "messages", label: "消息列表", type: "array", required: false, description: "OpenAI 格式消息数组。" },
      { name: "reference_video", label: "待理解视频", type: "upload", required: true, description: "公开可访问的视频 URL。" },
      { name: "reference_image", label: "参考图", type: "upload", required: false, description: "可选参考图片 URL。" },
    ];
  }
  if (model.capability === "IMAGE_GENERATION") {
    return [
      commonPromptParameter(),
      { name: "size", label: "图片尺寸", type: "input", required: false, description: "图片尺寸或比例。" },
      { name: "n", label: "生成数量", type: "number", required: false, description: "生成图片数量。" },
      { name: "reference_image", label: "参考图", type: "upload", required: false, description: "单张参考图 URL。" },
      { name: "reference_images", label: "多张参考图", type: "upload", required: false, description: "多个参考图 URL 数组。" },
    ];
  }
  if (model.modelCode === "minimax-h3-official") {
    return [
      commonPromptParameter(),
      { name: "size", label: "视频比例", type: "select", required: false, options: ["16:9", "9:16", "1:1", "3:4", "4:3"], description: "输出视频比例。" },
      { name: "seconds", label: "视频时长", type: "select", required: false, options: range(4, 15), description: "支持 4～15 秒整数。" },
      { name: "resolution", label: "分辨率", type: "select", required: false, options: ["768P"], description: "当前官方通道默认支持 768P。" },
      { name: "count", label: "生成数量", type: "number", required: false, options: [1, 2, 3, 4], description: "客户端单次生成固定提交 1 个。" },
      { name: "reference_image", label: "参考图", type: "upload", required: false, description: "单张参考图公网 URL。" },
      { name: "reference_images", label: "多张参考图", type: "upload", required: false, description: "多个参考图公网 URL 数组。" },
      { name: "reference_audio", label: "参考音频", type: "upload", required: false, description: "参考音频不能作为唯一参考输入。" },
      { name: "reference_audios", label: "多个参考音频", type: "upload", required: false, description: "多个参考音频公网 URL 数组。" },
      { name: "reference_video", label: "参考视频", type: "upload", required: false, description: "单个参考视频公网 URL。" },
      { name: "reference_videos", label: "多个参考视频", type: "upload", required: false, description: "多个参考视频公网 URL 数组。" },
    ];
  }
  return [
    commonPromptParameter(),
    { name: "size", label: "视频比例", type: "select", required: false, options: ["3:4", "4:3", "16:9", "9:16", "21:9"], description: "输出视频比例。" },
    { name: "seconds", label: "视频时长", type: "number", required: false, description: "视频时长（秒），具体范围以模型为准。" },
    { name: "duration", label: "视频时长文本", type: "input", required: false, description: "例如 5s，会自动映射为 seconds。" },
    { name: "resolution", label: "分辨率", type: "select", required: false, options: ["480P", "720P"], description: "模型支持的输出分辨率。" },
    { name: "reference_image", label: "参考图", type: "upload", required: false, description: "单张参考图 URL。" },
    { name: "reference_images", label: "多张参考图", type: "upload", required: false, description: "多个参考图 URL 数组。" },
    { name: "frame_start", label: "首帧", type: "upload", required: false, description: "首帧图片 URL。" },
    { name: "frame_end", label: "尾帧", type: "upload", required: false, description: "尾帧图片 URL。" },
    { name: "reference_video", label: "参考视频", type: "upload", required: false, description: "参考视频 URL。" },
    { name: "reference_videos", label: "多个参考视频", type: "upload", required: false, description: "多个参考视频 URL 数组。" },
    { name: "reference_audio", label: "参考音频", type: "upload", required: false, description: "参考音频 URL，不能作为唯一参考输入。" },
  ];
}

function endpointFor(capability: Capability): { generation: string; query: string | null; protocol: string; async: boolean } {
  if (capability === "TEXT_GENERATION" || capability === "VIDEO_UNDERSTANDING") {
    return { generation: "/openai/chat/completions", query: null, protocol: "allaiin_openai", async: false };
  }
  if (capability === "IMAGE_GENERATION") {
    return { generation: "/images/generations", query: "/tasks/{task_id}", protocol: "allaiin_rest", async: true };
  }
  return { generation: "/video/generations", query: "/tasks/{task_id}", protocol: "allaiin_rest", async: true };
}

async function main(): Promise<void> {
  const pricesOnly = process.argv.includes("--prices-only");
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun && !pricesOnly) throw new Error("--dry-run requires --prices-only");
  const db = await createConnection({ ...loadDatabaseConfig(), charset: "utf8mb4", timezone: "Z" });
  try {
    const [providers] = await db.query<ProviderRow[]>("SELECT id, config_json FROM providers WHERE code = 'allaiin' LIMIT 1");
    const provider = providers[0];
    if (!provider) throw new Error("AllAIIn provider does not exist");
    const [credentials] = await db.query<CredentialRow[]>(
      `SELECT id, api_key_ciphertext FROM provider_credentials
       WHERE provider_id = ? AND status = 'ACTIVE' AND api_key_ciphertext IS NOT NULL ORDER BY created_at LIMIT 1`,
      [provider.id],
    );
    const credential = credentials[0];
    if (!credential) throw new Error("AllAIIn has no active database API Key");
    const apiKey = decryptSecret(credential.api_key_ciphertext);
    const remoteModels = await request<RemoteModel[]>("/models", apiKey);
    const remoteByCode = new Map(remoteModels.map((model) => [model.model_id, model]));
    const remoteById = new Map(remoteModels.map((model) => [model.id, model]));
    const [pricingRows] = await db.query<PricingConfigRow[]>(
      "SELECT cny_per_credit, auto_sync FROM model_credit_pricing_config WHERE id = 1 LIMIT 1",
    );
    const pricing = pricingRows[0];
    if (!pricing) throw new Error("Missing system CNY per credit configuration");
    const cnyPerCredit = Number(pricing.cny_per_credit);
    const syncedAt = new Date().toISOString();
    const pricePlans = await planCreditPrices(db, provider.id, remoteById, cnyPerCredit, syncedAt);
    if (pricesOnly) {
      const summary = pricePlans.map(({ modelCode, alias, previousCredits, nextCredits, providerPoints, status }) =>
        ({ modelCode, alias, providerPoints, previousCredits, nextCredits, status }));
      process.stdout.write(`AllAIIn price preview: 1 provider point = ¥${ALLAIIN_POINT_CNY}, 1 system credit = ¥${cnyPerCredit}\n${JSON.stringify(summary, null, 2)}\n`);
      if (dryRun) return;
      await db.beginTransaction();
      try { await applyCreditPrices(db, pricePlans); await db.commit(); }
      catch (error) { await db.rollback(); throw error; }
      process.stdout.write(`AllAIIn price sync complete: ${pricePlans.filter((plan) => plan.status === "UPDATED").length} updated, ${pricePlans.filter((plan) => plan.status === "MANUAL").length} manual prices preserved\n`);
      return;
    }
    const account = await request<AccountData>("/account", apiKey);
    const missing = curatedCatalog.filter((model) => !remoteByCode.has(model.modelCode));
    if (missing.length) throw new Error(`AllAIIn models missing: ${missing.map((model) => model.modelCode).join(", ")}`);
    const videoCatalog = buildVideoCatalog(remoteModels);
    if (!videoCatalog.length) throw new Error("AllAIIn returned no eligible video models");
    const catalog = [...curatedCatalog, ...videoCatalog];
    const providerConfig = {
      ...parseJsonObject(provider.config_json),
      credentials_configured: true,
      docs_url: DOCS_URL,
      models_endpoint: "/models",
      account_endpoint: "/account",
      unified_endpoint: "/openai/chat/completions",
      image_endpoint: "/images/generations",
      video_endpoint: "/video/generations",
      task_query_endpoint: "/tasks/{task_id}",
      last_model_sync_at: syncedAt,
    };

    await db.beginTransaction();
    try {
      const [existingModels] = await db.query<RowDataPacket[]>(
        "SELECT model_code, billing_unit, config_json FROM provider_models WHERE provider_id = ?", [provider.id],
      );
      const existingConfig = new Map(existingModels.map((row) => [String(row.model_code), parseJsonObject(row.config_json)]));
      const existingBilling = new Map(existingModels.map((row) => [String(row.model_code), String(row.billing_unit)]));
      if (Number(pricing.auto_sync) === 1) await applyCreditPrices(db, pricePlans);
      await db.execute(
        `UPDATE providers SET display_name = 'AllAIIn', adapter_type = 'allaiin', base_url = ?, status = 'ACTIVE', config_json = ? WHERE id = ?`,
        [BASE_URL, JSON.stringify(providerConfig), provider.id],
      );
      const balance = Number(account.points_balance);
      await db.execute(
        `UPDATE provider_credentials SET balance = ?, balance_currency = '积分', last_balance_synced_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [Number.isFinite(balance) ? balance : null, credential.id],
      );

      for (const selected of catalog) {
        const remote = selected.remoteId ? remoteById.get(selected.remoteId)! : remoteByCode.get(selected.modelCode)!;
        const existingPlan = pricePlans.find((plan) => plan.modelCode === selected.modelCode);
        const convertedCredits = allaiinPointsToCredits(Number(remote.points_cost), cnyPerCredit);
        const endpoint = endpointFor(selected.capability);
        const config = {
          ...existingConfig.get(selected.modelCode),
          source: "allaiin_models_api",
          docs_url: DOCS_URL,
          remote_numeric_id: remote.id,
          request_model_name: remote.name,
          remote_model_id: remote.model_id,
          remote_type: remote.type,
          remote_type_name: remote.type_name,
          source_points_cost: Number(remote.points_cost),
          source_point_cny: ALLAIIN_POINT_CNY,
          source_credit_cost: Number(pricing.auto_sync) === 1 ? convertedCredits : existingPlan?.previousSourceCredits ?? convertedCredits,
          source_cny_per_credit: cnyPerCredit,
          line_selection: remote.line_selection || null,
          pricing_synced_at: syncedAt,
          ...(selected.modelCode === "minimax-h3-official" ? {
            reference_image_mode: "reference_images",
            video_duration_options: range(4, 15),
            aspect_ratio_options: ["16:9", "9:16", "1:1", "3:4", "4:3"],
            resolution_mapping: { "768P": "720P" },
          } : {}),
          real_person_support_source: selected.capability === "VIDEO_GENERATION"
            ? "AllAIIn 当前公开模型文档未明确承诺真人支持，按平台默认值关闭。"
            : undefined,
          credit_cost_note: selected.capability === "VIDEO_GENERATION" && existingBilling.get(selected.modelCode) === "PER_REQUEST"
            ? "每次成本由后台人工配置，不随时长变化；实时价格同步保留该价格。"
            : selected.capability === "VIDEO_GENERATION"
            ? "每秒成本按 AllAIIn 积分 × ¥0.10 ÷ 系统每积分人民币金额换算并向上取整；人工修改的积分定价保留。"
            : "每次成本按 AllAIIn 积分 × ¥0.10 ÷ 系统每积分人民币金额换算并向上取整；人工修改的积分定价保留。",
        };
        await db.execute(
          `INSERT INTO provider_models
            (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
             generation_endpoint, query_endpoint, credit_cost, max_reference_images,
             supports_reference_video, supports_real_person, supports_async_tasks, sort_order,
             description, status, parameter_schema_json, config_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
           ON DUPLICATE KEY UPDATE
             display_name = VALUES(display_name), model_alias = VALUES(model_alias), capability = VALUES(capability),
             api_protocol = VALUES(api_protocol), generation_endpoint = VALUES(generation_endpoint),
             query_endpoint = VALUES(query_endpoint), max_reference_images = VALUES(max_reference_images),
             supports_reference_video = VALUES(supports_reference_video), supports_real_person = VALUES(supports_real_person),
             supports_async_tasks = VALUES(supports_async_tasks), sort_order = VALUES(sort_order),
             description = VALUES(description), parameter_schema_json = VALUES(parameter_schema_json),
             config_json = VALUES(config_json)`,
          [randomUUID(), provider.id, selected.modelCode, remote.name, selected.alias, selected.capability,
           endpoint.protocol, endpoint.generation, endpoint.query, convertedCredits,
           selected.maxReferenceImages, selected.supportsReferenceVideo ? 1 : 0, selected.supportsRealPerson ? 1 : 0,
           endpoint.async ? 1 : 0, selected.sortOrder,
           `${remote.name}，由 AllAIIn API 提供，上游基础价 ${remote.points_cost} 积分（¥${(Number(remote.points_cost) * ALLAIIN_POINT_CNY).toFixed(2)}）。`,
           JSON.stringify(parameterSchema(selected)), JSON.stringify(config)],
        );
        if (selected.modelCode === "minimax-h3-official") {
          await db.execute(
            "UPDATE provider_models SET billing_unit = 'PER_REQUEST' WHERE provider_id = ? AND model_code = ? AND capability = 'VIDEO_GENERATION'",
            [provider.id, selected.modelCode],
          );
        }
        if (["IMAGE_GENERATION", "VIDEO_GENERATION"].includes(selected.capability)) {
          await db.execute(
            `INSERT IGNORE INTO provider_model_resolution_prices (provider_model_id, resolution, credit_cost, sort_order)
             SELECT id, ?, credit_cost, 0 FROM provider_models
             WHERE provider_id = ? AND model_code = ? AND capability = ?`,
            [selected.modelCode === "minimax-h3-official" ? "768P" : selected.capability === "VIDEO_GENERATION" ? "720p" : "1K", provider.id, selected.modelCode, selected.capability],
          );
        }
      }
      await db.commit();
    } catch (error) {
      await db.rollback();
      throw error;
    }
    process.stdout.write(`AllAIIn sync complete: ${catalog.length} models (${videoCatalog.length} video, Happy Horse 1.1 excluded), balance ${String(account.points_balance ?? "unknown")}\n`);
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`AllAIIn sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
