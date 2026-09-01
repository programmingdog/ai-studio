import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { RowDataPacket } from "mysql2";
import { AuditService } from "../common/audit.service";
import { DatabaseService } from "../database/database.service";

export type CatalogKind = "visual-styles" | "creative-types";

export interface CatalogCategoryInput {
  code: string;
  name: string;
  description?: string;
  sortOrder: number;
  status: string;
}

export interface CatalogItemInput extends CatalogCategoryInput {
  categoryId: string;
  prompt: string;
}

interface CatalogDefinition {
  categoryTable: "visual_style_categories" | "creative_type_categories";
  itemTable: "visual_styles" | "creative_types";
  auditPrefix: "visual_style" | "creative_type";
}

const definitions: Record<CatalogKind, CatalogDefinition> = {
  "visual-styles": { categoryTable: "visual_style_categories", itemTable: "visual_styles", auditPrefix: "visual_style" },
  "creative-types": { categoryTable: "creative_type_categories", itemTable: "creative_types", auditPrefix: "creative_type" },
};
const statuses = new Set(["ACTIVE", "DISABLED"]);

function definition(kind: CatalogKind): CatalogDefinition {
  const result = definitions[kind];
  if (!result) throw new BadRequestException("不支持的目录类型");
  return result;
}

function validateCommon(input: CatalogCategoryInput): CatalogCategoryInput {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.code)) throw new BadRequestException("编码只能使用小写字母、数字和短横线");
  if (!input.name.trim() || input.name.trim().length > 100) throw new BadRequestException("名称长度不正确");
  const status = input.status.toUpperCase();
  if (!statuses.has(status)) throw new BadRequestException("状态不正确");
  const sortOrder = Number(input.sortOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) throw new BadRequestException("排序值必须是 0 到 100000 的整数");
  return { ...input, code: input.code.trim(), name: input.name.trim(), description: input.description?.trim() || "", status, sortOrder };
}

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async publicCategories(kind: CatalogKind) {
    const { categoryTable } = definition(kind);
    return this.database.query<RowDataPacket[]>(
      `SELECT code AS id, code, name, description, sort_order
       FROM ${categoryTable} WHERE status = 'ACTIVE' ORDER BY sort_order, name`,
    );
  }

  async publicItems(kind: CatalogKind) {
    const { categoryTable, itemTable } = definition(kind);
    return this.database.query<RowDataPacket[]>(
      `SELECT i.code AS id, i.code, c.code AS category_code, c.name AS category,
              i.name, i.description, i.prompt, i.sort_order
       FROM ${itemTable} i INNER JOIN ${categoryTable} c ON c.id = i.category_id
       WHERE i.status = 'ACTIVE' AND c.status = 'ACTIVE'
       ORDER BY c.sort_order, c.name, i.sort_order, i.name`,
    );
  }

  async adminCategories(kind: CatalogKind) {
    const { categoryTable, itemTable } = definition(kind);
    return this.database.query<RowDataPacket[]>(
      `SELECT c.id AS record_id, c.code, c.name, c.description, c.sort_order, c.status,
              COUNT(i.id) AS item_count, c.created_at, c.updated_at
       FROM ${categoryTable} c LEFT JOIN ${itemTable} i ON i.category_id = c.id
       GROUP BY c.id, c.code, c.name, c.description, c.sort_order, c.status, c.created_at, c.updated_at
       ORDER BY c.sort_order, c.name`,
    );
  }

  async adminItems(kind: CatalogKind) {
    const { categoryTable, itemTable } = definition(kind);
    return this.database.query<RowDataPacket[]>(
      `SELECT i.id AS record_id, i.code, i.category_id, c.code AS category_code, c.name AS category,
              i.name, i.description, i.prompt, i.sort_order, i.status, i.created_at, i.updated_at
       FROM ${itemTable} i INNER JOIN ${categoryTable} c ON c.id = i.category_id
       ORDER BY c.sort_order, c.name, i.sort_order, i.name`,
    );
  }

  async createCategory(adminUserId: string, kind: CatalogKind, raw: CatalogCategoryInput) {
    const input = validateCommon(raw);
    const { categoryTable, auditPrefix } = definition(kind);
    const id = randomUUID();
    try {
      await this.database.execute(
        `INSERT INTO ${categoryTable} (id, code, name, description, sort_order, status) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, input.code, input.name, input.description, input.sortOrder, input.status],
      );
    } catch (error) { this.rethrowDuplicate(error, "分类编码已存在"); }
    await this.audit.record({ adminUserId, action: `${auditPrefix}_category.create`, entityType: `${auditPrefix}_category`, entityId: id, details: { code: input.code } });
    return { id };
  }

  async updateCategory(adminUserId: string, kind: CatalogKind, id: string, raw: CatalogCategoryInput) {
    const input = validateCommon(raw);
    const { categoryTable, auditPrefix } = definition(kind);
    try {
      const result = await this.database.execute(
        `UPDATE ${categoryTable} SET code = ?, name = ?, description = ?, sort_order = ?, status = ? WHERE id = ?`,
        [input.code, input.name, input.description, input.sortOrder, input.status, id],
      );
      if (!result.affectedRows) throw new NotFoundException("分类不存在");
    } catch (error) { this.rethrowDuplicate(error, "分类编码已存在"); }
    await this.audit.record({ adminUserId, action: `${auditPrefix}_category.update`, entityType: `${auditPrefix}_category`, entityId: id, details: { code: input.code } });
    return { updated: true };
  }

  async deleteCategory(adminUserId: string, kind: CatalogKind, id: string) {
    const { categoryTable, itemTable, auditPrefix } = definition(kind);
    const children = await this.database.query<RowDataPacket[]>(`SELECT id FROM ${itemTable} WHERE category_id = ? LIMIT 1`, [id]);
    if (children.length) throw new ConflictException("请先删除或移动该分类下的条目");
    const result = await this.database.execute(`DELETE FROM ${categoryTable} WHERE id = ?`, [id]);
    if (!result.affectedRows) throw new NotFoundException("分类不存在");
    await this.audit.record({ adminUserId, action: `${auditPrefix}_category.delete`, entityType: `${auditPrefix}_category`, entityId: id });
    return { deleted: true };
  }

  async createItem(adminUserId: string, kind: CatalogKind, raw: CatalogItemInput) {
    const input = this.validateItem(raw);
    const { categoryTable, itemTable, auditPrefix } = definition(kind);
    await this.assertCategory(categoryTable, input.categoryId);
    const id = randomUUID();
    try {
      await this.database.execute(
        `INSERT INTO ${itemTable} (id, category_id, code, name, description, prompt, sort_order, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.categoryId, input.code, input.name, input.description, input.prompt, input.sortOrder, input.status],
      );
    } catch (error) { this.rethrowDuplicate(error, "条目编码已存在"); }
    await this.audit.record({ adminUserId, action: `${auditPrefix}.create`, entityType: auditPrefix, entityId: id, details: { code: input.code, categoryId: input.categoryId } });
    return { id };
  }

  async updateItem(adminUserId: string, kind: CatalogKind, id: string, raw: CatalogItemInput) {
    const input = this.validateItem(raw);
    const { categoryTable, itemTable, auditPrefix } = definition(kind);
    await this.assertCategory(categoryTable, input.categoryId);
    try {
      const result = await this.database.execute(
        `UPDATE ${itemTable} SET category_id = ?, code = ?, name = ?, description = ?, prompt = ?, sort_order = ?, status = ? WHERE id = ?`,
        [input.categoryId, input.code, input.name, input.description, input.prompt, input.sortOrder, input.status, id],
      );
      if (!result.affectedRows) throw new NotFoundException("条目不存在");
    } catch (error) { this.rethrowDuplicate(error, "条目编码已存在"); }
    await this.audit.record({ adminUserId, action: `${auditPrefix}.update`, entityType: auditPrefix, entityId: id, details: { code: input.code, categoryId: input.categoryId } });
    return { updated: true };
  }

  async deleteItem(adminUserId: string, kind: CatalogKind, id: string) {
    const { itemTable, auditPrefix } = definition(kind);
    const result = await this.database.execute(`DELETE FROM ${itemTable} WHERE id = ?`, [id]);
    if (!result.affectedRows) throw new NotFoundException("条目不存在");
    await this.audit.record({ adminUserId, action: `${auditPrefix}.delete`, entityType: auditPrefix, entityId: id });
    return { deleted: true };
  }

  private validateItem(raw: CatalogItemInput): CatalogItemInput {
    const input = validateCommon(raw) as CatalogItemInput;
    const prompt = raw.prompt.trim();
    if (!raw.categoryId) throw new BadRequestException("必须选择分类");
    if (prompt.length < 10 || prompt.length > 10000) throw new BadRequestException("提示词长度必须在 10 到 10000 个字符之间");
    return { ...input, categoryId: raw.categoryId, prompt };
  }

  private async assertCategory(table: CatalogDefinition["categoryTable"], id: string) {
    const rows = await this.database.query<RowDataPacket[]>(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [id]);
    if (!rows.length) throw new BadRequestException("所选分类不存在");
  }

  private rethrowDuplicate(error: unknown, message: string): never {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new ConflictException(message);
    }
    throw error;
  }
}
