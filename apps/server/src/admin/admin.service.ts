import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { AuditService } from "../common/audit.service";
import { parseStoredJson } from "../common/input";
import { SecretCryptoService } from "../common/secret-crypto.service";
import { DatabaseService } from "../database/database.service";
import { ModelCreditMultiplierService, multiplierFor, multiplyCredits } from "../common/model-credit-multiplier.service";
import { integer } from "../referrals/referral-rules";

// Both directory counts and relationship pages use the same exact two-level scope.
// Disabled accounts remain in the tree; no third-level traversal or rank promotion.
const directUserCount = `(SELECT COUNT(*) FROM users d WHERE d.pid = u.id AND d.id <> u.id)`;
const indirectUserCount = `(SELECT COUNT(*) FROM users i INNER JOIN users d ON d.id = i.pid
  WHERE d.pid = u.id AND d.id <> u.id AND i.id <> u.id AND i.id <> d.id)`;
const relationUserColumns = "u.id, u.pid, u.invite_code, u.display_name, u.email, u.phone, u.status, u.balance_fen, u.created_at";

interface CountRow extends RowDataPacket {
  users: number | string;
  active_tasks: number | string;
  paid_orders: number | string;
  published_configs: number | string;
  enabled_providers: number | string;
  revenue_fen: number | string | null;
}

interface ConfigRow extends RowDataPacket {
  id: string;
  config_key: string;
  category: string;
  name: string;
  description: string;
  status: string;
  version_id: string | null;
  version: number | null;
  version_status: string | null;
  value_json: unknown;
  checksum: string | null;
  change_note: string | null;
  created_at: Date;
  published_at: Date | null;
}

interface ProviderRow extends RowDataPacket {
  id: string;
  code: string;
  display_name: string;
  adapter_type: string;
  base_url: string;
  status: string;
  config_json: unknown;
  model_count: number | string;
  active_model_count: number | string;
  created_at: Date;
  updated_at: Date;
}

interface ProviderModelRow extends RowDataPacket {
  id: string;
  provider_id: string;
  provider_code: string;
  provider_name: string;
  model_code: string;
  display_name: string;
  model_alias: string;
  capability: string;
  api_protocol: string;
  generation_endpoint: string;
  query_endpoint: string | null;
  credit_cost: number;
  max_reference_images: number;
  supports_reference_video: number;
  supports_real_person: number;
  supports_async_tasks: number;
  sort_order: number;
  description: string;
  status: string;
  parameter_schema_json: unknown;
  config_json: unknown;
  created_at: Date;
  updated_at: Date;
}

interface ProviderModelInput {
  modelCode: string;
  displayName: string;
  modelAlias: string;
  capability: string;
  apiProtocol: string;
  generationEndpoint: string;
  queryEndpoint?: string | null;
  creditCost: number;
  maxReferenceImages: number;
  supportsReferenceVideo: boolean;
  supportsRealPerson: boolean;
  supportsAsyncTasks: boolean;
  sortOrder: number;
  description?: string;
  status?: string;
  parameterSchema?: unknown;
  config?: unknown;
  resolutionPrices: Array<{ resolution: string; creditCost: number }>;
}

interface ProviderCredentialRow extends RowDataPacket {
  id: string;
  provider_id: string;
  name: string;
  masked_hint: string;
  status: string;
  balance: string | number | null;
  balance_currency: string;
  notes: string;
  last_balance_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface EligibleDefaultModelRow extends RowDataPacket {
  id: string;
  provider_id: string;
  provider_name: string;
  model_code: string;
  display_name: string;
  model_alias: string;
  capability: string;
  sort_order: number;
}

interface DefaultModelConfigRow extends RowDataPacket {
  text_model_id: string | null;
  video_understanding_model_id: string | null;
}

const configCategories = new Set(["PROMPT", "GENERATION", "PIPELINE"]);
const providerStatuses = new Set(["ACTIVE", "DISABLED", "DEGRADED"]);
const modelStatuses = new Set(["ACTIVE", "DISABLED"]);
const credentialStatuses = new Set(["ACTIVE", "DISABLED"]);
const modelCapabilities = new Set(["TEXT_GENERATION", "VIDEO_UNDERSTANDING", "IMAGE_GENERATION", "VIDEO_GENERATION"]);
const userStatuses = new Set(["ACTIVE", "DISABLED"]);

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pageSize(value?: string): number {
  const parsed = Number(value || 50);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(200, parsed)) : 50;
}

function validatedEndpoint(value: string, field: string, allowEmpty = false): string {
  const normalized = value.trim();
  if (!normalized) {
    if (allowEmpty) return "";
    throw new BadRequestException(`${field} 不能为空`);
  }
  if (normalized.startsWith("/")) return normalized;
  let parsed: URL;
  try { parsed = new URL(normalized); } catch { throw new BadRequestException(`${field} 不是有效 URL 或相对路径`); }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new BadRequestException(`${field} 必须使用 HTTPS`);
  }
  return normalized;
}

function integerInRange(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new BadRequestException(`${field} 必须是 ${minimum}～${maximum} 的整数`);
  }
  return value;
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SecretCryptoService) private readonly secretCrypto: SecretCryptoService,
    @Inject(ModelCreditMultiplierService) private readonly creditMultipliers: ModelCreditMultiplierService,
  ) {}

  async overview(): Promise<Record<string, number>> {
    const rows = await this.database.query<CountRow[]>(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM ai_tasks WHERE status IN ('ACCEPTED','CREDIT_RESERVED','SUBMITTING','PROVIDER_ACCEPTED','PROCESSING','UNKNOWN')) AS active_tasks,
        (SELECT COUNT(*) FROM payment_orders WHERE status = 'PAID') AS paid_orders,
        (SELECT COUNT(*) FROM config_versions WHERE status = 'PUBLISHED') AS published_configs,
        (SELECT COUNT(*) FROM providers WHERE status = 'ACTIVE') AS enabled_providers,
        (SELECT COALESCE(SUM(amount_fen), 0) FROM payment_orders WHERE status = 'PAID') AS revenue_fen
    `);
    const row = rows[0];
    return {
      users: Number(row?.users || 0),
      active_tasks: Number(row?.active_tasks || 0),
      paid_orders: Number(row?.paid_orders || 0),
      published_configs: Number(row?.published_configs || 0),
      enabled_providers: Number(row?.enabled_providers || 0),
      revenue_fen: Number(row?.revenue_fen || 0),
    };
  }

  async listConfigs(category?: string): Promise<Record<string, unknown>[]> {
    const parameters: unknown[] = [];
    let where = "";
    if (category) {
      where = "WHERE cs.category = ?";
      parameters.push(category.toUpperCase());
    }
    const rows = await this.database.query<ConfigRow[]>(
      `SELECT cs.id, cs.config_key, cs.category, cs.name, cs.description, cs.status,
              cv.id AS version_id, cv.version, cv.status AS version_status, cv.value_json,
              cv.checksum, cv.change_note, cv.created_at, cv.published_at
       FROM config_sets cs
       LEFT JOIN config_versions cv ON cv.config_set_id = cs.id
         AND cv.version = (SELECT MAX(cv2.version) FROM config_versions cv2 WHERE cv2.config_set_id = cs.id)
       ${where}
       ORDER BY cs.category, cs.name`,
      parameters,
    );
    return rows.map((row) => ({ ...row, value_json: parseStoredJson(row.value_json) }));
  }

  async createConfig(
    adminUserId: string,
    input: { configKey: string; category: string; name: string; description?: string; value: unknown; changeNote?: string },
  ): Promise<{ id: string; version_id: string; version: number }> {
    if (!/^[a-z0-9][a-z0-9._-]{2,190}$/.test(input.configKey)) {
      throw new BadRequestException("configKey 只能使用小写字母、数字、点、下划线和短横线");
    }
    const category = input.category.toUpperCase();
    if (!configCategories.has(category)) throw new BadRequestException("不支持的配置分类");
    const setId = randomUUID();
    const versionId = randomUUID();
    await this.database.transaction(async (connection) => {
      await connection.execute(
        `INSERT INTO config_sets (id, config_key, category, name, description)
         VALUES (?, ?, ?, ?, ?)`,
        [setId, input.configKey, category, input.name, input.description || ""],
      );
      await connection.execute(
        `INSERT INTO config_versions
          (id, config_set_id, version, value_json, checksum, status, change_note, created_by)
         VALUES (?, ?, 1, ?, ?, 'DRAFT', ?, ?)`,
        [versionId, setId, JSON.stringify(input.value), checksum(input.value), input.changeNote || "初始版本", adminUserId],
      );
    });
    await this.audit.record({ adminUserId, action: "config.create", entityType: "config_set", entityId: setId, details: { configKey: input.configKey, category } });
    return { id: setId, version_id: versionId, version: 1 };
  }

  async createConfigVersion(
    adminUserId: string,
    configSetId: string,
    input: { value: unknown; changeNote?: string },
  ): Promise<{ id: string; version: number }> {
    const versionId = randomUUID();
    const version = await this.database.transaction(async (connection) => {
      const [setRows] = await connection.query<RowDataPacket[]>("SELECT id FROM config_sets WHERE id = ? FOR UPDATE", [configSetId]);
      if (!setRows.length) throw new NotFoundException("配置不存在");
      const [versionRows] = await connection.query<RowDataPacket[]>(
        "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM config_versions WHERE config_set_id = ?",
        [configSetId],
      );
      const nextVersion = Number(versionRows[0]?.next_version || 1);
      await connection.execute(
        `INSERT INTO config_versions
          (id, config_set_id, version, value_json, checksum, status, change_note, created_by)
         VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
        [versionId, configSetId, nextVersion, JSON.stringify(input.value), checksum(input.value), input.changeNote || "", adminUserId],
      );
      return nextVersion;
    });
    await this.audit.record({ adminUserId, action: "config.version.create", entityType: "config_set", entityId: configSetId, details: { version } });
    return { id: versionId, version };
  }

  async publishConfig(
    adminUserId: string,
    configSetId: string,
    versionId: string,
    input: { channel?: string; minClientVersion?: string; rolloutPercent?: number },
  ): Promise<{ published: true }> {
    const rollout = input.rolloutPercent ?? 100;
    if (!Number.isInteger(rollout) || rollout < 1 || rollout > 100) throw new BadRequestException("rolloutPercent 必须是 1～100 的整数");
    await this.database.transaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT id FROM config_versions WHERE id = ? AND config_set_id = ? FOR UPDATE",
        [versionId, configSetId],
      );
      if (!rows.length) throw new NotFoundException("配置版本不存在");
      await connection.execute("UPDATE config_versions SET status = 'ARCHIVED' WHERE config_set_id = ? AND status = 'PUBLISHED'", [configSetId]);
      await connection.execute("UPDATE config_versions SET status = 'PUBLISHED', published_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [versionId]);
      await connection.execute(
        `UPDATE config_releases cr
         INNER JOIN config_versions cv ON cv.id = cr.config_version_id
         SET cr.status = 'RETIRED'
         WHERE cv.config_set_id = ? AND cr.status = 'ACTIVE'`,
        [configSetId],
      );
      await connection.execute(
        `INSERT INTO config_releases
          (id, config_version_id, channel, min_client_version, rollout_percent, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [randomUUID(), versionId, input.channel || "stable", input.minClientVersion || "0.0.0", rollout, adminUserId],
      );
    });
    await this.audit.record({ adminUserId, action: "config.publish", entityType: "config_version", entityId: versionId, details: { configSetId, rollout } });
    return { published: true };
  }

  async listProviders(): Promise<Record<string, unknown>[]> {
    const rows = await this.database.query<ProviderRow[]>(
      `SELECT p.id, p.code, p.display_name, p.adapter_type, p.base_url, p.status, p.config_json,
              p.created_at, p.updated_at, COUNT(pm.id) AS model_count,
              SUM(CASE WHEN pm.status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_model_count
       FROM providers p LEFT JOIN provider_models pm ON pm.provider_id = p.id
       GROUP BY p.id, p.code, p.display_name, p.adapter_type, p.base_url, p.status,
                p.config_json, p.created_at, p.updated_at
       ORDER BY CASE WHEN p.status = 'ACTIVE' THEN 0 ELSE 1 END, p.display_name`,
    );
    return rows.map((row) => ({
      ...row,
      config_json: parseStoredJson(row.config_json),
      model_count: Number(row.model_count || 0),
      active_model_count: Number(row.active_model_count || 0),
    }));
  }

  private eligibleDefaultModels(connection?: PoolConnection): Promise<EligibleDefaultModelRow[]> {
    const sql = `SELECT pm.id, pm.provider_id, p.display_name AS provider_name,
                        pm.model_code, pm.display_name, pm.model_alias, pm.capability, pm.sort_order
                 FROM provider_models pm
                 INNER JOIN providers p ON p.id = pm.provider_id
                 WHERE p.status = 'ACTIVE' AND pm.status = 'ACTIVE'
                   AND EXISTS (
                     SELECT 1 FROM provider_credentials pc
                     WHERE pc.provider_id = p.id AND pc.status = 'ACTIVE'
                       AND pc.api_key_ciphertext IS NOT NULL AND LENGTH(pc.api_key_ciphertext) > 0
                   )
                 ORDER BY pm.capability, p.display_name, pm.sort_order, pm.model_alias, pm.display_name`;
    if (connection) {
      return connection.query<EligibleDefaultModelRow[]>(sql).then(([rows]) => rows);
    }
    return this.database.query<EligibleDefaultModelRow[]>(sql);
  }

  async getDefaultModelConfig(): Promise<Record<string, unknown>> {
    const [candidates, configRows, mediaRows] = await Promise.all([
      this.eligibleDefaultModels(),
      this.database.query<DefaultModelConfigRow[]>(
        "SELECT text_model_id, video_understanding_model_id FROM ai_default_model_config WHERE id = 1",
      ),
      this.database.query<RowDataPacket[]>(
        "SELECT capability, provider_model_id FROM ai_default_media_models ORDER BY capability, sort_order, provider_model_id",
      ),
    ]);
    const eligibleIds = new Set(candidates.map((model) => model.id));
    const config = configRows[0];
    return {
      text_model_id: config?.text_model_id && eligibleIds.has(config.text_model_id) ? config.text_model_id : null,
      video_understanding_model_id: config?.video_understanding_model_id && eligibleIds.has(config.video_understanding_model_id)
        ? config.video_understanding_model_id
        : null,
      image_model_ids: mediaRows
        .filter((row) => row.capability === "IMAGE_GENERATION" && eligibleIds.has(String(row.provider_model_id)))
        .map((row) => String(row.provider_model_id)),
      video_model_ids: mediaRows
        .filter((row) => row.capability === "VIDEO_GENERATION" && eligibleIds.has(String(row.provider_model_id)))
        .map((row) => String(row.provider_model_id)),
      candidates,
    };
  }

  async updateDefaultModelConfig(
    adminUserId: string,
    input: { textModelId: string; videoUnderstandingModelId: string; imageModelIds: string[]; videoModelIds: string[] },
  ): Promise<{ updated: true }> {
    await this.database.transaction(async (connection) => {
      const candidates = await this.eligibleDefaultModels(connection);
      const byId = new Map(candidates.map((model) => [model.id, model]));
      const assertCapability = (modelId: string, capability: string, label: string) => {
        const model = byId.get(modelId);
        if (!model || model.capability !== capability) {
          throw new BadRequestException(`${label}不可用；请选择已启用且配置了启用 API Key 的供应商模型`);
        }
      };
      assertCapability(input.textModelId, "TEXT_GENERATION", "默认文本大模型");
      assertCapability(input.videoUnderstandingModelId, "VIDEO_UNDERSTANDING", "默认视频理解大模型");
      input.imageModelIds.forEach((id) => assertCapability(id, "IMAGE_GENERATION", "图片生成大模型"));
      input.videoModelIds.forEach((id) => assertCapability(id, "VIDEO_GENERATION", "视频生成大模型"));

      await connection.execute(
        `INSERT INTO ai_default_model_config (id, text_model_id, video_understanding_model_id, updated_by)
         VALUES (1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE text_model_id = VALUES(text_model_id),
           video_understanding_model_id = VALUES(video_understanding_model_id), updated_by = VALUES(updated_by)`,
        [input.textModelId, input.videoUnderstandingModelId, adminUserId],
      );
      await connection.execute("DELETE FROM ai_default_media_models");
      for (const [capability, ids] of [
        ["IMAGE_GENERATION", input.imageModelIds],
        ["VIDEO_GENERATION", input.videoModelIds],
      ] as const) {
        for (const [sortOrder, modelId] of ids.entries()) {
          await connection.execute(
            "INSERT INTO ai_default_media_models (capability, provider_model_id, sort_order) VALUES (?, ?, ?)",
            [capability, modelId, sortOrder],
          );
        }
      }
    });
    await this.audit.record({
      adminUserId,
      action: "provider_default_models.update",
      entityType: "ai_default_model_config",
      entityId: "1",
      details: {
        textModelId: input.textModelId,
        videoUnderstandingModelId: input.videoUnderstandingModelId,
        imageModelIds: input.imageModelIds,
        videoModelIds: input.videoModelIds,
      },
    });
    return { updated: true };
  }

  async createProvider(
    adminUserId: string,
    input: { code: string; displayName: string; adapterType: string; baseUrl: string; status?: string; config?: unknown },
  ): Promise<{ id: string }> {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(input.code)) throw new BadRequestException("供应商 code 格式不正确");
    const status = (input.status || "DISABLED").toUpperCase();
    if (!providerStatuses.has(status)) throw new BadRequestException("供应商状态不正确");
    let parsedUrl: URL;
    try { parsedUrl = new URL(input.baseUrl); } catch { throw new BadRequestException("baseUrl 不是有效 URL"); }
    if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") throw new BadRequestException("供应商地址必须使用 HTTPS");
    const id = randomUUID();
    await this.database.execute(
      `INSERT INTO providers (id, code, display_name, adapter_type, base_url, status, config_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.code, input.displayName, input.adapterType, input.baseUrl, status, input.config === undefined ? null : JSON.stringify(input.config)],
    );
    await this.audit.record({ adminUserId, action: "provider.create", entityType: "provider", entityId: id, details: { code: input.code, adapterType: input.adapterType, status } });
    return { id };
  }

  async updateProvider(
    adminUserId: string,
    providerId: string,
    input: { code?: string; displayName?: string; adapterType?: string; baseUrl?: string; status?: string; config?: unknown },
  ): Promise<{ updated: true }> {
    const fields: string[] = [];
    const parameters: unknown[] = [];
    if (input.code !== undefined) {
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(input.code)) throw new BadRequestException("供应商 code 格式不正确");
      fields.push("code = ?"); parameters.push(input.code);
    }
    if (input.displayName !== undefined) { fields.push("display_name = ?"); parameters.push(input.displayName); }
    if (input.adapterType !== undefined) { fields.push("adapter_type = ?"); parameters.push(input.adapterType); }
    if (input.baseUrl !== undefined) {
      let parsedUrl: URL;
      try { parsedUrl = new URL(input.baseUrl); } catch { throw new BadRequestException("baseUrl 不是有效 URL"); }
      if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") throw new BadRequestException("供应商地址必须使用 HTTPS");
      fields.push("base_url = ?"); parameters.push(input.baseUrl);
    }
    if (input.status !== undefined) {
      const status = input.status.toUpperCase();
      if (!providerStatuses.has(status)) throw new BadRequestException("供应商状态不正确");
      fields.push("status = ?"); parameters.push(status);
    }
    if (input.config !== undefined) { fields.push("config_json = ?"); parameters.push(JSON.stringify(input.config)); }
    if (!fields.length) throw new BadRequestException("没有可更新字段");
    parameters.push(providerId);
    const result = await this.database.execute(`UPDATE providers SET ${fields.join(", ")} WHERE id = ?`, parameters);
    if (!result.affectedRows) throw new NotFoundException("供应商不存在");
    await this.audit.record({ adminUserId, action: "provider.update", entityType: "provider", entityId: providerId, details: { fields: fields.map((field) => field.split(" ")[0]) } });
    return { updated: true };
  }

  async listProviderCredentials(providerId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.database.query<ProviderCredentialRow[]>(
      `SELECT id, provider_id, name, masked_hint, status, balance, balance_currency,
              notes, last_balance_synced_at, created_at, updated_at
       FROM provider_credentials WHERE provider_id = ? ORDER BY created_at`,
      [providerId],
    );
    return rows.map((row) => ({ ...row, balance: row.balance === null ? null : Number(row.balance) }));
  }

  async createProviderCredential(
    adminUserId: string,
    providerId: string,
    input: { name: string; apiKey: string; status?: string; balance?: number; balanceCurrency?: string; notes?: string },
  ): Promise<{ id: string }> {
    const providerRows = await this.database.query<RowDataPacket[]>("SELECT id FROM providers WHERE id = ? LIMIT 1", [providerId]);
    if (!providerRows.length) throw new NotFoundException("供应商不存在");
    const status = (input.status || "ACTIVE").toUpperCase();
    if (!credentialStatuses.has(status)) throw new BadRequestException("API Key 状态不正确");
    if (input.apiKey.length < 8 || input.apiKey.length > 500) throw new BadRequestException("API Key 长度不正确");
    if (input.balance !== undefined && (!Number.isFinite(input.balance) || input.balance < 0)) throw new BadRequestException("余额不能为负数");
    const id = randomUUID();
    await this.database.execute(
      `INSERT INTO provider_credentials
        (id, provider_id, name, secret_ref, api_key_ciphertext, masked_hint, status,
         balance, balance_currency, notes)
       VALUES (?, ?, ?, 'database_encrypted', ?, ?, ?, ?, ?, ?)`,
      [id, providerId, input.name, this.secretCrypto.encrypt(input.apiKey), this.secretCrypto.mask(input.apiKey), status,
       input.balance ?? null, input.balanceCurrency || "CREDITS", input.notes || ""],
    );
    await this.audit.record({ adminUserId, action: "provider_credential.create", entityType: "provider_credential", entityId: id, details: { providerId, name: input.name, status } });
    return { id };
  }

  async updateProviderCredential(
    adminUserId: string,
    providerId: string,
    credentialId: string,
    input: { name?: string; apiKey?: string; status?: string; balance?: number; balanceCurrency?: string; notes?: string },
  ): Promise<{ updated: true }> {
    const fields: string[] = [];
    const parameters: unknown[] = [];
    if (input.name !== undefined) { fields.push("name = ?"); parameters.push(input.name); }
    if (input.apiKey !== undefined) {
      if (input.apiKey.length < 8 || input.apiKey.length > 500) throw new BadRequestException("API Key 长度不正确");
      fields.push("api_key_ciphertext = ?", "masked_hint = ?", "secret_ref = 'database_encrypted'");
      parameters.push(this.secretCrypto.encrypt(input.apiKey), this.secretCrypto.mask(input.apiKey));
    }
    if (input.status !== undefined) {
      const status = input.status.toUpperCase();
      if (!credentialStatuses.has(status)) throw new BadRequestException("API Key 状态不正确");
      fields.push("status = ?"); parameters.push(status);
    }
    if (input.balance !== undefined) {
      if (!Number.isFinite(input.balance) || input.balance < 0) throw new BadRequestException("余额不能为负数");
      fields.push("balance = ?"); parameters.push(input.balance);
    }
    if (input.balanceCurrency !== undefined) { fields.push("balance_currency = ?"); parameters.push(input.balanceCurrency); }
    if (input.notes !== undefined) { fields.push("notes = ?"); parameters.push(input.notes); }
    if (!fields.length) throw new BadRequestException("没有可更新字段");
    parameters.push(credentialId, providerId);
    const result = await this.database.execute(
      `UPDATE provider_credentials SET ${fields.join(", ")} WHERE id = ? AND provider_id = ?`,
      parameters,
    );
    if (!result.affectedRows) throw new NotFoundException("API Key 不存在");
    await this.audit.record({ adminUserId, action: "provider_credential.update", entityType: "provider_credential", entityId: credentialId, details: { providerId, fields: fields.map((field) => field.split(" ")[0]) } });
    return { updated: true };
  }

  async listProviderModels(providerId: string): Promise<Record<string, unknown>[]> {
    const { multipliers } = await this.creditMultipliers.get();
    const [rows, priceRows] = await Promise.all([this.database.query<ProviderModelRow[]>(
      `SELECT pm.id, pm.provider_id, p.code AS provider_code, p.display_name AS provider_name,
              pm.model_code, pm.display_name, pm.model_alias, pm.capability, pm.api_protocol,
              pm.generation_endpoint, pm.query_endpoint, pm.credit_cost,
              pm.max_reference_images, pm.supports_reference_video, pm.supports_real_person,
              pm.supports_async_tasks,
              pm.sort_order, pm.description, pm.status, pm.parameter_schema_json, pm.config_json,
              pm.created_at, pm.updated_at
       FROM provider_models pm INNER JOIN providers p ON p.id = pm.provider_id
       WHERE pm.provider_id = ?
       ORDER BY pm.capability, pm.sort_order, pm.display_name`,
      [providerId],
    ), this.database.query<RowDataPacket[]>(
      `SELECT provider_model_id, resolution, credit_cost, sort_order
       FROM provider_model_resolution_prices WHERE provider_model_id IN
         (SELECT id FROM provider_models WHERE provider_id = ?)
       ORDER BY provider_model_id, sort_order, resolution`,
      [providerId],
    )]);
    return rows.map((row) => ({
      ...row,
      credit_cost: Number(row.credit_cost),
      credit_multiplier: multiplierFor(multipliers, row.capability),
      final_credit_cost: multiplyCredits(Number(row.credit_cost), multiplierFor(multipliers, row.capability)),
      billing_unit: row.capability === "VIDEO_GENERATION" ? "PER_SECOND" : "PER_REQUEST",
      max_reference_images: Number(row.max_reference_images),
      supports_reference_video: Boolean(row.supports_reference_video),
      supports_real_person: Boolean(row.supports_real_person),
      supports_async_tasks: Boolean(row.supports_async_tasks),
      sort_order: Number(row.sort_order),
      parameter_schema_json: parseStoredJson(row.parameter_schema_json),
      config_json: parseStoredJson(row.config_json),
      resolution_prices: priceRows.filter((price) => price.provider_model_id === row.id).map((price) => ({ resolution: String(price.resolution), credit_cost: Number(price.credit_cost), final_credit_cost: multiplyCredits(Number(price.credit_cost), multiplierFor(multipliers, row.capability)) })),
    }));
  }

  private validateProviderModel(input: ProviderModelInput): ProviderModelInput {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/.test(input.modelCode)) {
      throw new BadRequestException("模型值只能使用字母、数字、点、冒号、斜杠、下划线和短横线");
    }
    const capability = input.capability.toUpperCase();
    if (!modelCapabilities.has(capability)) throw new BadRequestException("不支持的模型类型");
    const status = (input.status || "DISABLED").toUpperCase();
    if (!modelStatuses.has(status)) throw new BadRequestException("模型状态不正确");
    const generationEndpoint = validatedEndpoint(input.generationEndpoint, "生成接口地址");
    const queryEndpoint = input.queryEndpoint ? validatedEndpoint(input.queryEndpoint, "查询接口地址") : null;
    if (input.supportsAsyncTasks && !queryEndpoint) throw new BadRequestException("异步任务模型必须配置查询接口地址");
    const resolutionPrices = input.resolutionPrices.map((price) => ({ resolution: price.resolution.trim(), creditCost: price.creditCost }));
    if (["IMAGE_GENERATION", "VIDEO_GENERATION"].includes(capability)) {
      if (!resolutionPrices.length) throw new BadRequestException("图片或视频模型至少需要配置一种分辨率价格");
      if (resolutionPrices.length > 30) throw new BadRequestException("每个模型最多配置 30 种分辨率");
      if (new Set(resolutionPrices.map((price) => price.resolution.toLowerCase())).size !== resolutionPrices.length) throw new BadRequestException("分辨率不能重复");
      for (const price of resolutionPrices) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/.test(price.resolution)) throw new BadRequestException("分辨率只能使用字母、数字、点、冒号、下划线和短横线");
        integerInRange(price.creditCost, "分辨率积分消耗", 1, 100000);
      }
    } else if (resolutionPrices.length) {
      throw new BadRequestException("只有图片生成和视频生成模型可以配置分辨率价格");
    }
    return {
      ...input,
      capability,
      status,
      generationEndpoint,
      queryEndpoint,
      creditCost: integerInRange(input.creditCost, capability === "VIDEO_GENERATION" ? "每秒消耗积分数" : "每次消耗积分数", 1, 100000),
      maxReferenceImages: integerInRange(input.maxReferenceImages, "参考图数量", 0, 255),
      supportsRealPerson: capability === "VIDEO_GENERATION" && input.supportsRealPerson,
      sortOrder: integerInRange(input.sortOrder, "排序值", 0, 100000),
      resolutionPrices,
    };
  }

  private async replaceResolutionPrices(connection: PoolConnection, modelId: string, prices: Array<{ resolution: string; creditCost: number }>): Promise<void> {
    await connection.execute("DELETE FROM provider_model_resolution_prices WHERE provider_model_id = ?", [modelId] as never[]);
    for (const [sortOrder, price] of prices.entries()) {
      await connection.execute(
        "INSERT INTO provider_model_resolution_prices (provider_model_id, resolution, credit_cost, sort_order) VALUES (?, ?, ?, ?)",
        [modelId, price.resolution, price.creditCost, sortOrder] as never[],
      );
    }
  }

  async createProviderModel(adminUserId: string, providerId: string, rawInput: ProviderModelInput): Promise<{ id: string }> {
    const providerRows = await this.database.query<RowDataPacket[]>("SELECT id FROM providers WHERE id = ? LIMIT 1", [providerId]);
    if (!providerRows.length) throw new NotFoundException("供应商不存在");
    const input = this.validateProviderModel(rawInput);
    const id = randomUUID();
    await this.database.transaction(async (connection) => {
      await connection.query(`INSERT INTO provider_models
        (id, provider_id, model_code, display_name, model_alias, capability, api_protocol,
         generation_endpoint, query_endpoint, credit_cost, max_reference_images,
         supports_reference_video, supports_real_person, supports_async_tasks, sort_order, description, status,
         parameter_schema_json, config_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, providerId, input.modelCode, input.displayName, input.modelAlias, input.capability,
       input.apiProtocol, input.generationEndpoint, input.queryEndpoint, input.creditCost,
       input.maxReferenceImages, input.supportsReferenceVideo ? 1 : 0, input.supportsRealPerson ? 1 : 0,
       input.supportsAsyncTasks ? 1 : 0,
       input.sortOrder, input.description || "", input.status,
       input.parameterSchema === undefined ? null : JSON.stringify(input.parameterSchema),
       input.config === undefined ? null : JSON.stringify(input.config)]);
      await this.replaceResolutionPrices(connection, id, input.resolutionPrices);
    });
    await this.audit.record({ adminUserId, action: "provider_model.create", entityType: "provider_model", entityId: id, details: { providerId, modelCode: input.modelCode, capability: input.capability, creditCost: input.creditCost, billingUnit: input.capability === "VIDEO_GENERATION" ? "PER_SECOND" : "PER_REQUEST" } });
    return { id };
  }

  async updateProviderModel(adminUserId: string, providerId: string, modelId: string, rawInput: ProviderModelInput): Promise<{ updated: true }> {
    const input = this.validateProviderModel(rawInput);
    await this.database.transaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT id FROM provider_models WHERE id = ? AND provider_id = ? LIMIT 1 FOR UPDATE", [modelId, providerId]);
      if (!rows.length) throw new NotFoundException("模型不存在");
      await connection.query(`UPDATE provider_models SET model_code = ?, display_name = ?, model_alias = ?, capability = ?,
         api_protocol = ?, generation_endpoint = ?, query_endpoint = ?, credit_cost = ?,
         max_reference_images = ?, supports_reference_video = ?, supports_real_person = ?, supports_async_tasks = ?,
         sort_order = ?, description = ?, status = ?, parameter_schema_json = ?, config_json = ?
       WHERE id = ? AND provider_id = ?`,
      [input.modelCode, input.displayName, input.modelAlias, input.capability, input.apiProtocol,
       input.generationEndpoint, input.queryEndpoint, input.creditCost, input.maxReferenceImages,
       input.supportsReferenceVideo ? 1 : 0, input.supportsRealPerson ? 1 : 0,
       input.supportsAsyncTasks ? 1 : 0, input.sortOrder,
       input.description || "", input.status,
       input.parameterSchema === undefined ? null : JSON.stringify(input.parameterSchema),
       input.config === undefined ? null : JSON.stringify(input.config), modelId, providerId]);
      await this.replaceResolutionPrices(connection, modelId, input.resolutionPrices);
    });
    await this.audit.record({ adminUserId, action: "provider_model.update", entityType: "provider_model", entityId: modelId, details: { providerId, modelCode: input.modelCode, capability: input.capability, creditCost: input.creditCost, billingUnit: input.capability === "VIDEO_GENERATION" ? "PER_SECOND" : "PER_REQUEST" } });
    return { updated: true };
  }

  async listUsers(limit?: string): Promise<Record<string, unknown>[]> {
    const rows = await this.database.query<RowDataPacket[]>(
      `SELECT u.id, u.email, u.phone, u.display_name, u.avatar_url, u.bio, u.status, u.pid, u.invite_code, u.balance_fen,
              p.id AS parent_id, p.display_name AS parent_display_name, p.email AS parent_email, p.phone AS parent_phone, p.status AS parent_status,
              ${directUserCount} AS direct_count, ${indirectUserCount} AS indirect_count,
              COALESCE(w.available_fen, 0) AS commission_available_fen, COALESCE(w.frozen_fen, 0) AS commission_frozen_fen,
              u.last_login_at, u.created_at, u.updated_at,
              COALESCE((SELECT SUM(le.amount) FROM ledger_accounts la
                        LEFT JOIN ledger_entries le ON le.account_id = la.id
                        WHERE la.owner_type = 'USER' AND la.owner_id = u.id
                          AND la.account_type = 'AVAILABLE' AND la.currency = 'CREDIT'), 0) AS credit_balance,
              COALESCE((SELECT SUM(ch.amount) FROM credit_holds ch
                        WHERE ch.user_id = u.id AND ch.status = 'ACTIVE'), 0) AS held_credits
       FROM users u LEFT JOIN users p ON p.id = u.pid LEFT JOIN commission_wallets w ON w.user_id = u.id
       ORDER BY u.created_at DESC, u.id DESC LIMIT ${pageSize(limit)}`,
    );
    return rows.map(({ parent_id, parent_display_name, parent_email, parent_phone, parent_status, ...row }) => ({
      ...row,
      parent: parent_id ? { id: parent_id, display_name: parent_display_name, email: parent_email, phone: parent_phone, status: parent_status } : null,
      balance_fen: Number(row.balance_fen || 0),
      commission_available_fen: Number(row.commission_available_fen || 0),
      commission_frozen_fen: Number(row.commission_frozen_fen || 0),
      direct_count: Number(row.direct_count || 0), indirect_count: Number(row.indirect_count || 0),
      credit_balance: Number(row.credit_balance || 0),
      held_credits: Number(row.held_credits || 0),
      available_credits: Number(row.credit_balance || 0) - Number(row.held_credits || 0),
    }));
  }

  async userRelations(userId: string, rawLevel?: string, rawPage?: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw new BadRequestException("用户 ID 格式无效");
    const level = integer(rawLevel === undefined ? 1 : Number(rawLevel), "下级层级", 1, 2);
    const page = integer(rawPage === undefined ? 1 : Number(rawPage), "页码", 1, 100000);
    // Read parent, counts and this page in a consistent transaction snapshot.
    return this.database.transaction(async c => {
      const [users] = await c.query<RowDataPacket[]>(`SELECT ${relationUserColumns}, ${directUserCount} AS direct_count, ${indirectUserCount} AS indirect_count FROM users u WHERE u.id = ?`, [userId]);
      const user = users[0];
      if (!user) throw new NotFoundException("用户不存在");
      const [parents] = user.pid ? await c.query<RowDataPacket[]>(`SELECT ${relationUserColumns} FROM users u WHERE u.id = ?`, [user.pid]) : [[]];
      const scope = level === 1 ? "u.pid = ? AND u.id <> u.pid" : "p.pid = ? AND p.id <> p.pid AND u.id <> p.pid AND u.id <> p.id";
      const [items] = await c.query<RowDataPacket[]>(`SELECT ${relationUserColumns}, p.id AS parent_id, p.display_name AS parent_display_name FROM users u LEFT JOIN users p ON p.id = u.pid WHERE ${scope} ORDER BY u.created_at DESC, u.id DESC LIMIT 51 OFFSET ${(page - 1) * 50}`, [userId]);
      const direct = Number(user.direct_count), indirect = Number(user.indirect_count);
      return {
        user: { ...user, balance_fen: Number(user.balance_fen), direct_count: direct, indirect_count: indirect },
        parent: parents[0] ? { ...parents[0], balance_fen: Number(parents[0].balance_fen) } : null,
        direct_count: direct, indirect_count: indirect, level, page, page_size: 50,
        total: level === 1 ? direct : indirect, has_more: items.length > 50,
        items: items.slice(0, 50).map(row => ({ ...row, balance_fen: Number(row.balance_fen) })),
      };
    });
  }

  async updateUser(
    adminUserId: string,
    userId: string,
    input: { displayName: string; email: string | null; phone: string | null; avatarUrl: string | null; bio: string; status: string },
  ): Promise<{ updated: true }> {
    const email = input.email?.trim().toLowerCase() || null;
    const phone = input.phone?.replace(/[\s-]/g, "") || null;
    const status = input.status.toUpperCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException("邮箱格式无效");
    if (phone && !/^\+?[0-9]{6,20}$/.test(phone)) throw new BadRequestException("手机号格式无效");
    if (!userStatuses.has(status)) throw new BadRequestException("用户状态无效");
    if (input.avatarUrl) {
      let parsed: URL;
      try { parsed = new URL(input.avatarUrl); } catch { throw new BadRequestException("头像地址格式无效"); }
      if (parsed.protocol !== "https:") throw new BadRequestException("头像地址必须使用 HTTPS");
    }
    try {
      await this.database.transaction(async (connection) => {
        const [currentRows] = await connection.query<RowDataPacket[]>("SELECT id, status FROM users WHERE id = ? LIMIT 1 FOR UPDATE", [userId]);
        if (!currentRows.length) throw new NotFoundException("用户不存在");
        const [duplicateRows] = await connection.query<RowDataPacket[]>(
          "SELECT id FROM users WHERE id <> ? AND ((? IS NOT NULL AND email = ?) OR (? IS NOT NULL AND phone = ?)) LIMIT 1",
          [userId, email, email, phone, phone],
        );
        if (duplicateRows.length) throw new ConflictException("邮箱或手机号已被其他用户使用");
        await connection.execute(
          `UPDATE users SET email = ?, phone = ?, display_name = ?, avatar_url = ?, bio = ?, status = ? WHERE id = ?`,
          [email, phone, input.displayName.trim(), input.avatarUrl, input.bio.trim(), status, userId],
        );
        if (status !== "ACTIVE") {
          await connection.execute("UPDATE user_refresh_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(3)) WHERE user_id = ?", [userId]);
        }
        await connection.execute(
          `INSERT INTO audit_logs (id, admin_user_id, action, entity_type, entity_id, details_json)
           VALUES (?, ?, 'user.update', 'user', ?, ?)`,
          [randomUUID(), adminUserId, userId, JSON.stringify({ status, fields: ["display_name", "email", "phone", "avatar_url", "bio", "status"] })],
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw new ConflictException("邮箱或手机号已被其他用户使用");
      throw error;
    }
    return { updated: true };
  }

  async adjustUserCredits(
    adminUserId: string,
    userId: string,
    input: { amount: number; reason: string },
  ): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(input.amount) || input.amount === 0 || Math.abs(input.amount) > 9_000_000_000_000_000) {
      throw new BadRequestException("积分调整值必须是非零整数");
    }
    const adjustmentId = randomUUID();
    return this.database.transaction(async (connection) => {
      const [userRows] = await connection.query<RowDataPacket[]>("SELECT id FROM users WHERE id = ? LIMIT 1 FOR UPDATE", [userId]);
      if (!userRows.length) throw new NotFoundException("用户不存在");
      let [accountRows] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM ledger_accounts WHERE owner_type = 'USER' AND owner_id = ?
         AND account_type = 'AVAILABLE' AND currency = 'CREDIT' LIMIT 1 FOR UPDATE`,
        [userId],
      );
      if (!accountRows.length) {
        const accountId = randomUUID();
        await connection.execute(
          "INSERT INTO ledger_accounts (id, owner_type, owner_id, account_type, currency) VALUES (?, 'USER', ?, 'AVAILABLE', 'CREDIT')",
          [accountId, userId],
        );
        accountRows = [{ id: accountId } as RowDataPacket];
      }
      const accountId = String(accountRows[0]!.id);
      const [balanceRows] = await connection.query<RowDataPacket[]>("SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_entries WHERE account_id = ?", [accountId]);
      const [holdRows] = await connection.query<RowDataPacket[]>("SELECT COALESCE(SUM(amount), 0) AS held FROM credit_holds WHERE user_id = ? AND status = 'ACTIVE'", [userId]);
      const currentBalance = Number(balanceRows[0]?.balance || 0);
      const held = Number(holdRows[0]?.held || 0);
      const nextBalance = currentBalance + input.amount;
      if (nextBalance < held) throw new ConflictException(`调整后积分不能低于当前占用积分 ${held}`);
      const transactionId = randomUUID();
      await connection.execute(
        `INSERT INTO ledger_transactions (id, transaction_type, reference_type, reference_id, metadata_json)
         VALUES (?, 'ADMIN_ADJUSTMENT', 'admin_user_credit_adjustment', ?, ?)`,
        [transactionId, adjustmentId, JSON.stringify({ adminUserId, userId, amount: input.amount, reason: input.reason })],
      );
      await connection.execute(
        "INSERT INTO ledger_entries (id, transaction_id, account_id, amount) VALUES (?, ?, ?, ?)",
        [randomUUID(), transactionId, accountId, input.amount],
      );
      await connection.execute(
        `INSERT INTO audit_logs (id, admin_user_id, action, entity_type, entity_id, details_json)
         VALUES (?, ?, 'user.credit.adjust', 'user', ?, ?)`,
        [randomUUID(), adminUserId, userId, JSON.stringify({ adjustmentId, amount: input.amount, reason: input.reason, previousBalance: currentBalance, nextBalance })],
      );
      return { adjustment_id: adjustmentId, credit_balance: nextBalance, held_credits: held, available_credits: nextBalance - held };
    });
  }

  async listTasks(limit?: string): Promise<RowDataPacket[]> {
    return this.database.query<RowDataPacket[]>(
      `SELECT id, user_id, local_task_id, task_type, logical_model_code, status, progress,
              estimated_credits, settled_credits, error_code, created_at, updated_at
       FROM ai_tasks ORDER BY created_at DESC LIMIT ${pageSize(limit)}`,
    );
  }

  async listPayments(limit?: string): Promise<RowDataPacket[]> {
    return this.database.query<RowDataPacket[]>(
      `SELECT id, user_id, out_trade_no, wechat_transaction_id, description, amount_fen,
              currency, status, expires_at, paid_at, created_at
       FROM payment_orders ORDER BY created_at DESC LIMIT ${pageSize(limit)}`,
    );
  }

  async listAuditLogs(limit?: string): Promise<RowDataPacket[]> {
    return this.database.query<RowDataPacket[]>(
      `SELECT al.id, al.admin_user_id, au.display_name AS admin_name, al.action, al.entity_type,
              al.entity_id, al.details_json, al.created_at
       FROM audit_logs al LEFT JOIN admin_users au ON au.id = al.admin_user_id
       ORDER BY al.created_at DESC LIMIT ${pageSize(limit)}`,
    );
  }
}
