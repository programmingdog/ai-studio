import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import type { RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";
import { EnvironmentService } from "../config/environment.service";
import { AuditService } from "./audit.service";

type ClientRuntimeConfigRow = RowDataPacket & {
  recommended_video_concurrency: number | string | null;
  revision: number;
  updated_at: Date | string;
};

export type ClientRuntimeConfig = {
  recommended_video_concurrency: number;
  configured_video_concurrency: number | null;
  environment_default_video_concurrency: number;
  source: "database" | "environment";
  revision: number;
  updated_at: Date | string;
};

@Injectable()
export class ClientRuntimeConfigService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EnvironmentService) private readonly environment: EnvironmentService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async get(): Promise<ClientRuntimeConfig> {
    const rows = await this.database.query<ClientRuntimeConfigRow[]>(
      `SELECT recommended_video_concurrency, revision, updated_at
       FROM client_runtime_configs WHERE id = 1 LIMIT 1`,
    );
    const row = rows[0];
    if (!row) throw new BadRequestException("客户端运行配置尚未初始化，请先执行数据库迁移");
    const configured = row.recommended_video_concurrency === null
      ? null
      : this.nonNegativeSafeInteger(row.recommended_video_concurrency, "视频并发数");
    const environmentDefault = this.environment.values.recommendedVideoConcurrency;
    return {
      recommended_video_concurrency: configured ?? environmentDefault,
      configured_video_concurrency: configured,
      environment_default_video_concurrency: environmentDefault,
      source: configured === null ? "environment" : "database",
      revision: Number(row.revision),
      updated_at: row.updated_at,
    };
  }

  async effectiveVideoConcurrency(): Promise<number> {
    return (await this.get()).recommended_video_concurrency;
  }

  async update(adminUserId: string, input: { recommendedVideoConcurrency: unknown; revision: unknown }): Promise<ClientRuntimeConfig> {
    const configured = input.recommendedVideoConcurrency === null
      ? null
      : this.nonNegativeSafeInteger(input.recommendedVideoConcurrency, "视频并发数");
    const revision = this.nonNegativeSafeInteger(input.revision, "配置版本");
    const previous = await this.database.transaction(async (connection) => {
      const [rows] = await connection.query<ClientRuntimeConfigRow[]>(
        `SELECT recommended_video_concurrency, revision, updated_at
         FROM client_runtime_configs WHERE id = 1 FOR UPDATE`,
      );
      const row = rows[0];
      if (!row) throw new BadRequestException("客户端运行配置尚未初始化，请先执行数据库迁移");
      if (Number(row.revision) !== revision) throw new ConflictException("配置已更新，请重新读取后再保存");
      await connection.execute(
        `UPDATE client_runtime_configs
         SET recommended_video_concurrency = ?, revision = revision + 1, updated_by = ?
         WHERE id = 1`,
        [configured, adminUserId],
      );
      return row.recommended_video_concurrency === null
        ? null
        : this.nonNegativeSafeInteger(row.recommended_video_concurrency, "原视频并发数");
    });
    await this.audit.record({
      adminUserId,
      action: "client_runtime_config.update",
      entityType: "client_runtime_config",
      entityId: "1",
      details: {
        before: previous,
        after: configured,
        environment_default: this.environment.values.recommendedVideoConcurrency,
      },
    });
    return this.get();
  }

  private nonNegativeSafeInteger(value: unknown, label: string): number {
    const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
    if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < 0) {
      throw new BadRequestException(`${label}必须是非负整数，0 表示不限制`);
    }
    return numeric;
  }
}
