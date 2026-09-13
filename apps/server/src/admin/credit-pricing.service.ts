import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";
import { parseStoredJson } from "../common/input";
import { ProviderPricingService } from "./provider-pricing.service";
import { calculateModelCredits, CreditPriceModel, CreditPriceResult, validateCnyPerCredit } from "./credit-price-calculator";
import { WagaModelMetadataService } from "../common/waga-model-metadata.service";
import { wagaProfiles } from "../gateway/waga-media";
import { allaiinPointsToCredits, ALLAIIN_POINT_CNY, previousAllaiinSyncedCredits } from "../scripts/allaiin-credit-pricing";

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
    const rows = await query(`SELECT id, model_code, model_alias, capability, api_protocol, credit_cost, billing_unit, parameter_schema_json, config_json
      FROM provider_models WHERE provider_id = ? ORDER BY id${connection ? " FOR UPDATE" : ""}`);
    const prices = await query(`SELECT provider_model_id, resolution, credit_cost FROM provider_model_resolution_prices
      WHERE provider_model_id IN (SELECT id FROM provider_models WHERE provider_id = ?) ORDER BY provider_model_id, resolution${connection ? " FOR UPDATE" : ""}`);
    return rows.map((row) => ({ id: String(row.id), model_code: String(row.model_code), model_alias: String(row.model_alias),
      capability: String(row.capability), api_protocol: String(row.api_protocol), credit_cost: Number(row.credit_cost),
      billing_unit: row.capability === "VIDEO_GENERATION" && row.billing_unit === "PER_REQUEST" ? "PER_REQUEST" : "PER_SECOND",
      parameter_schema_json: parseStoredJson(row.parameter_schema_json), config_json: parseStoredJson(row.config_json),
      resolution_prices: prices.filter((price) => price.provider_model_id === row.id).map((price) => ({ resolution: String(price.resolution), credit_cost: Number(price.credit_cost) })),
    }));
  }

  private async routing(providerId: string, connection?: PoolConnection) {
    const sql = `SELECT p.code, p.base_url, p.status, pc.id AS credential_id, pc.api_key_ciphertext
      FROM providers p LEFT JOIN provider_credentials pc ON pc.provider_id = p.id AND pc.status = 'ACTIVE'
      WHERE p.id = ? ORDER BY pc.created_at, pc.id LIMIT 1${connection ? " FOR UPDATE" : ""}`;
    const rows = connection ? (await connection.query<RowDataPacket[]>(sql, [providerId]))[0] : await this.database.query<RowDataPacket[]>(sql, [providerId]);
    return { active: rows[0]?.status === "ACTIVE", code: String(rows[0]?.code || "").toLowerCase(), hash: fingerprint(rows) };
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
      if (route.code === "allaiin") {
        return { ...pricing, credit_sync: await this.refreshAllaiin(adminId, providerId, config, before, route.hash, pricing) };
      }
      const currentModels = await Promise.all(before.map(async model => this.wagaMetadata && wagaProfiles[model.model_code]
        ? { ...model, parameter_schema_json: await this.wagaMetadata.schema(providerId, model.model_code) } : model));
      const items = currentModels.flatMap((model) => model.capability === "VIDEO_GENERATION" && model.billing_unit === "PER_REQUEST"
        ? (model.resolution_prices.length ? model.resolution_prices : [{ resolution: "", credit_cost: model.credit_cost }]).map((tier): CreditPriceResult => ({
          model_id: model.id, model_code: model.model_code, model_alias: model.model_alias, resolution: tier.resolution,
          billing_unit: "PER_REQUEST", previous_credits: tier.credit_cost, credits: null, price_cny: null,
          channel: "", parameters: {}, status: "SKIPPED", reason: "按次视频价格由后台手工配置",
        }))
        : calculateModelCredits(model, pricing.models.find((price) => price.name === model.model_code), config.cny_per_credit))
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

  private async refreshAllaiin(
    adminId: string, providerId: string, config: Awaited<ReturnType<CreditPricingService["get"]>>,
    before: CreditPriceModel[], routeHash: string, pricing: Awaited<ReturnType<ProviderPricingService["query"]>>,
  ): Promise<CreditSyncReport> {
    const byId = new Map(pricing.models.filter((model) => model.remote_numeric_id !== undefined)
      .map((model) => [model.remote_numeric_id!, model]));
    const items: CreditSyncReport["items"] = [];
    const plans: Array<{ model: CreditPriceModel; source: NonNullable<typeof pricing.models[number]>; credits: number;
      tiers: string[]; config: Record<string, unknown>; updateBase: boolean }> = [];
    for (const model of before) {
      const stored = model.config_json && typeof model.config_json === "object" ? model.config_json as Record<string, unknown> : {};
      const source = byId.get(Number(stored.remote_numeric_id));
      const baseline = previousAllaiinSyncedCredits(stored);
      let credits: number | null = null;
      let error = !source ? "上游实时目录未找到该模型" : baseline === null ? "缺少上次同步基准，保留人工定价" : "";
      if (model.capability === "VIDEO_GENERATION" && model.billing_unit === "PER_REQUEST") error = "按次视频价格由后台手工配置";
      else if (source && baseline !== null) {
        try { credits = allaiinPointsToCredits(source.source_points!, config.cny_per_credit); }
        catch (reason) { error = reason instanceof Error ? reason.message : "价格换算失败"; }
      }
      const tiers = model.resolution_prices.length ? model.resolution_prices : [{ resolution: "", credit_cost: model.credit_cost }];
      const updateTiers: string[] = [];
      for (const tier of tiers) {
        const manual = baseline !== null && (model.credit_cost !== baseline || tier.credit_cost !== baseline);
        const status = credits === null || manual ? "SKIPPED" : tier.credit_cost === credits ? "UNCHANGED" : "UPDATED";
        if (status === "UPDATED" && tier.resolution) updateTiers.push(tier.resolution);
        items.push({ model_id: model.id, model_code: model.model_code, model_alias: model.model_alias,
          provider_name: pricing.provider_name, resolution: tier.resolution,
          billing_unit: model.capability === "VIDEO_GENERATION" && model.billing_unit !== "PER_REQUEST" ? "PER_SECOND" : "PER_REQUEST",
          previous_credits: tier.credit_cost, credits: status === "SKIPPED" ? null : credits,
          price_cny: source ? Number((source.source_points! * ALLAIIN_POINT_CNY).toFixed(12)) : null,
          channel: source ? "AllAIIn" : "", parameters: {}, status,
          reason: manual ? "检测到人工定价，保留原积分" : error });
      }
      if (source && credits !== null) plans.push({ model, source, credits, tiers: updateTiers,
        updateBase: model.credit_cost === baseline && model.credit_cost !== credits,
        config: { ...stored, source_points_cost: source.source_points, source_point_cny: ALLAIIN_POINT_CNY,
          source_credit_cost: credits, source_cny_per_credit: config.cny_per_credit,
          pricing_synced_at: pricing.queried_at },
      });
    }
    const report = this.report(config.cny_per_credit, true, items);
    await this.database.transaction(async (connection) => {
      const [rows] = await connection.query<ConfigRow[]>("SELECT * FROM model_credit_pricing_config WHERE id = 1 FOR UPDATE");
      if (!rows[0]?.auto_sync || Number(rows[0].revision) !== config.revision) throw new ConflictException("查询期间比例配置已改变，本次没有更新积分，请重试");
      if (fingerprint(await this.models(providerId, connection)) !== fingerprint(before) || (await this.routing(providerId, connection)).hash !== routeHash) {
        throw new ConflictException("查询期间模型或供应商/API Key 配置已改变，本次没有更新积分，请重试");
      }
      for (const plan of plans) {
        if (plan.updateBase) await connection.execute("UPDATE provider_models SET credit_cost = ? WHERE id = ?", [plan.credits, plan.model.id]);
        for (const resolution of plan.tiers) await connection.execute(
          "UPDATE provider_model_resolution_prices SET credit_cost = ? WHERE provider_model_id = ? AND resolution = ?",
          [plan.credits, plan.model.id, resolution]);
        await connection.execute("UPDATE provider_models SET config_json = ? WHERE id = ?", [JSON.stringify(plan.config), plan.model.id]);
      }
      await connection.execute("UPDATE model_credit_pricing_config SET last_sync_at = CURRENT_TIMESTAMP(3), last_sync_report = ? WHERE id = 1", [JSON.stringify(report)]);
      await this.audit(connection, adminId, "credit_pricing.sync", { provider_id: providerId, config_revision: config.revision, ...report });
    });
    return report;
  }

  async syncAll(adminId: string): Promise<CreditSyncReport> {
    const config = await this.get();
    if (!config.auto_sync) throw new BadRequestException("请先启用按实时价格自动更新积分");
    const providers = await this.database.query<RowDataPacket[]>("SELECT id, display_name, code, status FROM providers ORDER BY display_name");
    const items: CreditSyncReport["items"] = [], errors: string[] = [];
    for (const provider of providers) {
      if (!["wagaai", "allaiin"].includes(String(provider.code).toLowerCase()) || provider.status !== "ACTIVE") {
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
