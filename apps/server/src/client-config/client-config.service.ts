import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { RowDataPacket } from "mysql2";
import { parseStoredJson } from "../common/input";
import { DatabaseService } from "../database/database.service";
import { ModelCreditMultiplierService, multiplierFor, multiplyCredits } from "../common/model-credit-multiplier.service";
import { supportsMediaResolution } from "../gateway/media-resolution";
import { WagaModelMetadataService } from "../common/waga-model-metadata.service";
import { wagaMediaParams, wagaProfiles } from "../gateway/waga-media";

interface PublishedConfigRow extends RowDataPacket {
  config_key: string;
  category: string;
  name: string;
  description: string;
  version: number;
  value_json: unknown;
  checksum: string;
  channel: string;
  min_client_version: string;
  rollout_percent: number;
  effective_at: Date;
}

interface ClientModelRow extends RowDataPacket {
  id: string;
  provider_code: string;
  provider_name: string;
  model_code: string;
  display_name: string;
  model_alias: string;
  capability: string;
  credit_cost: number;
  max_reference_images: number;
  supports_reference_video: number;
  supports_real_person: number;
  supports_async_tasks: number;
  sort_order: number;
  description: string;
  parameter_schema_json: unknown;
  config_json: unknown;
  api_protocol: string;
}

interface PromptConfigRow extends RowDataPacket {
  config_key: string;
  version: number;
  value_json: unknown;
}

const promptConfigKeys = {
  "prompt.video_storyboard.default": "video_storyboard_prompt",
  "prompt.video_storyboard.detailed": "video_storyboard_detailed_prompt",
  "prompt.character_image.default": "character_image_prompt",
} as const;

@Injectable()
export class ClientConfigService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ModelCreditMultiplierService) private readonly creditMultipliers: ModelCreditMultiplierService,
    @Inject(WagaModelMetadataService) private readonly wagaMetadata?: WagaModelMetadataService) {}

  async current(channel = "stable"): Promise<Record<string, unknown>> {
    const [rows, models] = await Promise.all([
      this.database.query<PublishedConfigRow[]>(
      `SELECT cs.config_key, cs.category, cs.name, cs.description,
              cv.version, cv.value_json, cv.checksum,
              cr.channel, cr.min_client_version, cr.rollout_percent, cr.effective_at
       FROM config_releases cr
       INNER JOIN config_versions cv ON cv.id = cr.config_version_id
       INNER JOIN config_sets cs ON cs.id = cv.config_set_id
       WHERE cr.status = 'ACTIVE' AND cv.status = 'PUBLISHED'
         AND cs.status = 'ACTIVE' AND cr.channel = ? AND cr.effective_at <= CURRENT_TIMESTAMP(3)
      ORDER BY cs.category, cs.config_key`,
      [channel],
      ),
      this.models(),
    ]);
    return {
      channel,
      generated_at: new Date().toISOString(),
      merge_policy: "LOCAL_OVERRIDE_THEN_SERVER_DEFAULT_THEN_CLIENT_FALLBACK",
      configs: rows.map((row) => ({ ...row, value: parseStoredJson(row.value_json), value_json: undefined })),
      models,
    };
  }

  async models(): Promise<Record<string, unknown>[]> {
    const { multipliers } = await this.creditMultipliers.get();
    const [rows, priceRows] = await Promise.all([this.database.query<ClientModelRow[]>(
      `SELECT pm.id, p.id AS provider_id, p.code AS provider_code, p.display_name AS provider_name,
              pm.model_code, pm.display_name, pm.model_alias, pm.capability, pm.credit_cost,
              pm.max_reference_images, pm.supports_reference_video, pm.supports_real_person,
              pm.supports_async_tasks,
              pm.sort_order, pm.description, pm.parameter_schema_json, pm.config_json, pm.api_protocol
       FROM provider_models pm INNER JOIN providers p ON p.id = pm.provider_id
       WHERE p.status = 'ACTIVE' AND pm.status = 'ACTIVE'
         AND EXISTS (SELECT 1 FROM provider_credentials pc WHERE pc.provider_id = p.id AND pc.status = 'ACTIVE' AND pc.api_key_ciphertext IS NOT NULL AND LENGTH(pc.api_key_ciphertext) > 0)
         AND (pm.capability NOT IN ('IMAGE_GENERATION', 'VIDEO_GENERATION') OR EXISTS
              (SELECT 1 FROM ai_default_media_models dm WHERE dm.provider_model_id = pm.id AND dm.capability = pm.capability))
       ORDER BY pm.capability, pm.sort_order, pm.display_name`,
    ), this.database.query<RowDataPacket[]>(
      `SELECT rp.provider_model_id, rp.resolution, rp.credit_cost, rp.sort_order
       FROM provider_model_resolution_prices rp
       INNER JOIN provider_models pm ON pm.id = rp.provider_model_id
       INNER JOIN providers p ON p.id = pm.provider_id
       WHERE p.status = 'ACTIVE' AND pm.status = 'ACTIVE'
       ORDER BY rp.provider_model_id, rp.sort_order, rp.resolution`,
    )]);
    await Promise.all(rows.map(async row => {
      if (row.provider_code === "wagaai" && this.wagaMetadata && wagaProfiles[row.model_code]) {
        row.parameter_schema_json = await this.wagaMetadata.schema(String(row.provider_id), row.model_code);
      }
    }));
    return rows.map((row) => ({
      ...row,
      base_credit_cost: Number(row.credit_cost),
      credit_multiplier: multiplierFor(multipliers, row.capability),
      credit_cost: multiplyCredits(Number(row.credit_cost), multiplierFor(multipliers, row.capability)),
      billing_unit: row.capability === "VIDEO_GENERATION" ? "PER_SECOND" : "PER_REQUEST",
      max_reference_images: wagaProfiles[row.model_code]?.max ?? Number(row.max_reference_images),
      generation_notice: row.model_code === "viduq3" ? "优惠方案可能采用错峰生成，预计需要 1～5 小时，请耐心等待。"
        : row.model_code === "omni_flash-10s" ? "此方案固定生成 10 秒视频。"
        : wagaProfiles[row.model_code]?.resolution === false ? "此方案由供应商决定输出清晰度，不支持指定分辨率。" : undefined,
      supports_reference_video: Boolean(row.supports_reference_video),
      supports_real_person: Boolean(row.supports_real_person),
      supports_async_tasks: Boolean(row.supports_async_tasks),
      sort_order: Number(row.sort_order),
      parameter_schema: parseStoredJson(row.parameter_schema_json),
      parameter_schema_json: undefined,
      config_json: undefined,
      resolution_prices: priceRows.filter((price) => price.provider_model_id === row.id && (() => {
        if (!wagaProfiles[row.model_code]) return true;
        if (wagaProfiles[row.model_code]?.resolution === false && price !== priceRows.find(p => p.provider_model_id === row.id)) return false;
        try {
          wagaMediaParams(row.model_code, parseStoredJson(row.parameter_schema_json), parseStoredJson(row.config_json),
            { resolution: price.resolution, ...(wagaProfiles[row.model_code]?.video ? { seconds: wagaProfiles[row.model_code]?.fixed ?? wagaProfiles[row.model_code]?.duration?.find(n => n >= 10) } : {}) });
          return true;
        } catch { return false; }
      })() && supportsMediaResolution({
        resolution: String(price.resolution), schema: parseStoredJson(row.parameter_schema_json),
        config: parseStoredJson<Record<string, unknown>>(row.config_json) || {}, protocol: row.api_protocol || "",
        capability: row.capability, modelCode: row.model_code,
      })).map((price) => ({ resolution: String(price.resolution), label: wagaProfiles[row.model_code]?.resolution === false ? "固定输出" : undefined,
        base_credit_cost: Number(price.credit_cost), credit_cost: multiplyCredits(Number(price.credit_cost), multiplierFor(multipliers, row.capability)) })),
    }));
  }

  async promptDefaults(channel = "stable"): Promise<Record<string, unknown>> {
    const rows = await this.database.query<PromptConfigRow[]>(
      `SELECT cs.config_key, cv.version, cv.value_json
       FROM config_releases cr
       INNER JOIN config_versions cv ON cv.id = cr.config_version_id
       INNER JOIN config_sets cs ON cs.id = cv.config_set_id
       WHERE cr.status = 'ACTIVE' AND cv.status = 'PUBLISHED' AND cs.status = 'ACTIVE'
         AND cr.channel = ? AND cr.effective_at <= CURRENT_TIMESTAMP(3)
         AND cs.config_key IN (?, ?, ?)
       ORDER BY cs.config_key`,
      [channel, ...Object.keys(promptConfigKeys)],
    );
    const prompts: Record<string, string> = {};
    const versions: Record<string, number> = {};
    for (const row of rows) {
      const field = promptConfigKeys[row.config_key as keyof typeof promptConfigKeys];
      const value = parseStoredJson<{ template?: unknown }>(row.value_json);
      if (field && typeof value?.template === "string" && value.template.trim().length >= 50) {
        prompts[field] = value.template.trim();
        versions[field] = Number(row.version);
      }
    }
    const requiredFields = Object.values(promptConfigKeys);
    if (requiredFields.some((field) => !prompts[field])) {
      throw new ServiceUnavailableException("服务端提示词默认配置不完整");
    }
    return { source: "SERVER", channel, generated_at: new Date().toISOString(), prompts, versions };
  }
}
