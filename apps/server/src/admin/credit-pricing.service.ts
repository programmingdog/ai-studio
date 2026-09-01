import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";
import { parseStoredJson } from "../common/input";
import { ProviderPricingService } from "./provider-pricing.service";
import { calculateModelCredits, CreditPriceModel, CreditPriceResult, validateCnyPerCredit } from "./credit-price-calculator";
import { WagaModelMetadataService } from "../common/waga-model-metadata.service";
import { wagaProfiles } from "../gateway/waga-media";

interface ConfigRow extends RowDataPacket {
  cny_per_credit: string | number; auto_sync: number; revision: number;
  last_sync_at: Date | null; last_sync_report: unknown;
}
export type CreditSyncReport = {
  at: string; enabled: boolean; cny_per_credit: number; updated_count: number; unchanged_count: number; skipped_count: number;
  items: Array<CreditPriceResult & { provider_name: string }>; errors: string[];
};
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

@Injectable()
export class CreditPricingService {
  // Serialize price writes in this process. Transactions/revision checks also protect other instances.
  private readonly syncing = new Set<string>();
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProviderPricingService) private readonly pricing: ProviderPricingService,
    @Inject(WagaModelMetadataService) private readonly wagaMetadata?: WagaModelMetadataService,
  ) {}

  async get() {
    const [row] = await this.database.query<ConfigRow[]>("SELECT * FROM model_credit_pricing_config WHERE id = 1");
    if (!row) throw new BadRequestException("请先执行积分定价数据库迁移");
    return { cny_per_credit: Number(row.cny_per_credit), auto_sync: Boolean(row.auto_sync), revision: Number(row.revision),
      last_sync_at: row.last_sync_at, last_sync_report: parseStoredJson<CreditSyncReport>(row.last_sync_report) };
  }

  async save(adminId: string, input: { cny_per_credit: unknown; auto_sync: unknown; revision: unknown }) {
    let ratio: number;
    try { ratio = validateCnyPerCredit(input.cny_per_credit); }
    catch (error) { throw new BadRequestException((error as Error).message); }
    if (typeof input.auto_sync !== "boolean" || !Number.isInteger(input.revision) || Number(input.revision) < 0) throw new BadRequestException("自动更新开关或配置版本无效");
    await this.database.transaction(async (connection) => {
      const [rows] = await connection.query<ConfigRow[]>("SELECT * FROM model_credit_pricing_config WHERE id = 1 FOR UPDATE");
      const previous = rows[0];
      if (!previous || Number(previous.revision) !== input.revision) throw new ConflictException("比例配置已被修改，请刷新后重试");
      await connection.execute("UPDATE model_credit_pricing_config SET cny_per_credit = ?, auto_sync = ?, revision = revision + 1, updated_by = ? WHERE id = 1", [ratio, input.auto_sync ? 1 : 0, adminId]);
      await this.audit(connection, adminId, "credit_pricing.configure", { previous: { cny_per_credit: Number(previous.cny_per_credit), auto_sync: Boolean(previous.auto_sync) }, next: { cny_per_credit: ratio, auto_sync: input.auto_sync } });
    });
    const report = input.auto_sync ? await this.syncAll(adminId) : null;
    return { config: await this.get(), report };
  }

  private async models(providerId: string, connection?: PoolConnection): Promise<CreditPriceModel[]> {
    const query = async (sql: string) => connection ? (await connection.query<RowDataPacket[]>(sql, [providerId]))[0] : this.database.query<RowDataPacket[]>(sql, [providerId]);
    const rows = await query(`SELECT id, model_code, model_alias, capability, api_protocol, credit_cost, parameter_schema_json, config_json
      FROM provider_models WHERE provider_id = ? ORDER BY id${connection ? " FOR UPDATE" : ""}`);
    const prices = await query(`SELECT provider_model_id, resolution, credit_cost FROM provider_model_resolution_prices
      WHERE provider_model_id IN (SELECT id FROM provider_models WHERE provider_id = ?) ORDER BY provider_model_id, resolution${connection ? " FOR UPDATE" : ""}`);
    return rows.map((row) => ({ id: String(row.id), model_code: String(row.model_code), model_alias: String(row.model_alias),
      capability: String(row.capability), api_protocol: String(row.api_protocol), credit_cost: Number(row.credit_cost),
      parameter_schema_json: parseStoredJson(row.parameter_schema_json), config_json: parseStoredJson(row.config_json),
      resolution_prices: prices.filter((price) => price.provider_model_id === row.id).map((price) => ({ resolution: String(price.resolution), credit_cost: Number(price.credit_cost) })),
    }));
  }

  private async routing(providerId: string, connection?: PoolConnection) {
    const sql = `SELECT p.code, p.base_url, p.status, pc.id AS credential_id, pc.api_key_ciphertext
      FROM providers p LEFT JOIN provider_credentials pc ON pc.provider_id = p.id AND pc.status = 'ACTIVE'
      WHERE p.id = ? ORDER BY pc.created_at, pc.id LIMIT 1${connection ? " FOR UPDATE" : ""}`;
    const rows = connection ? (await connection.query<RowDataPacket[]>(sql, [providerId]))[0] : await this.database.query<RowDataPacket[]>(sql, [providerId]);
    return { active: rows[0]?.status === "ACTIVE", hash: fingerprint(rows) };
  }

  private report(ratio: number, enabled: boolean, items: CreditSyncReport["items"] = [], errors: string[] = []): CreditSyncReport {
    return { at: new Date().toISOString(), enabled, cny_per_credit: ratio,
      updated_count: items.filter((item) => item.status === "UPDATED").length,
      unchanged_count: items.filter((item) => item.status === "UNCHANGED").length,
      skipped_count: items.filter((item) => item.status === "SKIPPED").length, items, errors };
  }

  async refreshProvider(adminId: string, providerId: string) {
    if (this.syncing.has(providerId)) throw new ConflictException("该供应商正在更新积分，请稍后重试");
    this.syncing.add(providerId);
    try {
      const config = await this.get();
      const before = await this.models(providerId);
      const route = await this.routing(providerId);
      const pricing = await this.pricing.query(providerId);
      if (!config.auto_sync || !route.active) return { ...pricing, credit_sync: this.report(config.cny_per_credit, false, [], route.active ? [] : ["供应商未启用，仅查询价格，未更新积分"]) };
      const currentModels = await Promise.all(before.map(async model => this.wagaMetadata && wagaProfiles[model.model_code]
        ? { ...model, parameter_schema_json: await this.wagaMetadata.schema(providerId, model.model_code) } : model));
      const items = currentModels.flatMap((model) => calculateModelCredits(model, pricing.models.find((price) => price.name === model.model_code), config.cny_per_credit))
        .map((item) => ({ ...item, provider_name: pricing.provider_name }));
      const report = this.report(config.cny_per_credit, true, items);
      await this.database.transaction(async (connection) => {
        const [rows] = await connection.query<ConfigRow[]>("SELECT * FROM model_credit_pricing_config WHERE id = 1 FOR UPDATE");
        if (!rows[0]?.auto_sync || Number(rows[0].revision) !== config.revision) throw new ConflictException("查询期间比例配置已改变，本次没有更新积分，请重试");
        if (fingerprint(await this.models(providerId, connection)) !== fingerprint(before) || (await this.routing(providerId, connection)).hash !== route.hash) {
          throw new ConflictException("查询期间模型或供应商/API Key 配置已改变，本次没有更新积分，请重试");
        }
        for (const model of before) {
          const results = items.filter((item) => item.model_id === model.id);
          for (const item of results.filter((item) => item.status === "UPDATED")) {
            if (item.resolution) await connection.execute("UPDATE provider_model_resolution_prices SET credit_cost = ? WHERE provider_model_id = ? AND resolution = ?", [item.credits, model.id, item.resolution]);
          }
          const valid = results.filter((item) => item.status !== "SKIPPED" && item.credits !== null);
          if (wagaProfiles[model.model_code] && valid.length) {
            const previous = model.config_json && typeof model.config_json === "object" ? model.config_json as Record<string, unknown> : {};
            const plans = { ...(previous.generation_parameters_by_resolution as Record<string, unknown> || {}) };
            for (const item of valid) plans[item.resolution] = item.parameters;
            // Persist the exact parameter tuple together with the price, also
            // when rounded credits are unchanged. No ledger/task is touched.
            await connection.execute("UPDATE provider_models SET config_json = ?, parameter_schema_json = ? WHERE id = ?",
              [JSON.stringify({ ...previous, generation_parameters_by_resolution: plans }),
                JSON.stringify(currentModels.find(current => current.id === model.id)!.parameter_schema_json), model.id]);
          }
          // Do not redefine the fallback/base price unless every configured tier was calculated.
          if (valid.length && valid.length === results.length) {
            const base = Math.min(...valid.map((item) => item.credits!));
            if (base !== model.credit_cost) await connection.execute("UPDATE provider_models SET credit_cost = ? WHERE id = ?", [base, model.id]);
          }
        }
        await connection.execute("UPDATE model_credit_pricing_config SET last_sync_at = CURRENT_TIMESTAMP(3), last_sync_report = ? WHERE id = 1", [JSON.stringify(report)]);
        await this.audit(connection, adminId, "credit_pricing.sync", { provider_id: providerId, config_revision: config.revision, ...report });
      });
      return { ...pricing, credit_sync: report };
    } finally { this.syncing.delete(providerId); }
  }

  async syncAll(adminId: string): Promise<CreditSyncReport> {
    const config = await this.get();
    if (!config.auto_sync) throw new BadRequestException("请先启用按实时价格自动更新积分");
    const providers = await this.database.query<RowDataPacket[]>("SELECT id, display_name, code, status FROM providers ORDER BY display_name");
    const items: CreditSyncReport["items"] = [], errors: string[] = [];
    for (const provider of providers) {
      if (String(provider.code).toLowerCase() !== "wagaai" || provider.status !== "ACTIVE") {
        errors.push(`${provider.display_name}：${provider.status !== "ACTIVE" ? "供应商未启用" : "尚未接入实时价格"}，保留原积分`);
        continue;
      }
      try {
        const current = await this.get();
        if (current.revision !== config.revision) throw new ConflictException("比例配置已改变，请重新同步");
        const result = await this.refreshProvider(adminId, String(provider.id));
        items.push(...result.credit_sync.items); errors.push(...result.credit_sync.errors);
      } catch (error) { errors.push(`${provider.display_name}：${error instanceof Error ? error.message : "积分同步失败"}`); }
    }
    const report = this.report(config.cny_per_credit, true, items, errors);
    if (!providers.length) report.errors.push("尚未配置供应商");
    await this.database.execute("UPDATE model_credit_pricing_config SET last_sync_at = CURRENT_TIMESTAMP(3), last_sync_report = ? WHERE id = 1 AND revision = ?", [JSON.stringify(report), config.revision]);
    return report;
  }

  private async audit(connection: PoolConnection, adminId: string, action: string, details: unknown) {
    await connection.execute("INSERT INTO audit_logs (id, admin_user_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, 'credit_pricing_config', '1', ?)", [randomUUID(), adminId, action, JSON.stringify(details)]);
  }
}
