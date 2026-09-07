import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "./audit.service";

type ProductBrandConfigRow = RowDataPacket & {
  chinese_name: string;
  english_name: string;
  revision: number;
  updated_at: Date | string;
};

export type ProductBrandConfig = {
  chinese_name: string;
  english_name: string;
  revision: number;
  updated_at: Date | string;
};

@Injectable()
export class ProductBrandConfigService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async get(): Promise<ProductBrandConfig> {
    const rows = await this.database.query<ProductBrandConfigRow[]>(
      `SELECT chinese_name, english_name, revision, updated_at
       FROM product_brand_configs WHERE id = 1 LIMIT 1`,
    );
    const row = rows[0];
    if (!row) throw new BadRequestException("产品名称配置尚未初始化，请先执行数据库迁移");
    return {
      chinese_name: row.chinese_name,
      english_name: row.english_name,
      revision: Number(row.revision),
      updated_at: row.updated_at,
    };
  }

  async update(adminUserId: string, input: { chineseName: string; englishName: string }): Promise<ProductBrandConfig> {
    await this.database.execute(
      `UPDATE product_brand_configs
       SET chinese_name = ?, english_name = ?, revision = revision + 1, updated_by = ?
       WHERE id = 1`,
      [input.chineseName, input.englishName, adminUserId],
    );
    await this.audit.record({
      adminUserId,
      action: "product_brand.update",
      entityType: "product_brand_config",
      entityId: "1",
      details: { chinese_name: input.chineseName, english_name: input.englishName },
    });
    return this.get();
  }
}
