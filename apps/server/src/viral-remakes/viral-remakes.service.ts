import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { AuditService } from "../common/audit.service";
import { asRecord, parseStoredJson } from "../common/input";
import { DatabaseService } from "../database/database.service";
import { categoryInput, ReplacementElement, templateInput, ViralRemakeCategoryInput, ViralRemakeFilters, ViralRemakeTemplateInput, viralRemakeId, viralRemakeMediaId } from "./viral-remakes.validation";

export interface CategoryRow extends RowDataPacket, ViralRemakeCategoryInput { id: string; created_at: string; updated_at: string; template_count?: number }
interface TemplateRow extends RowDataPacket, Omit<ViralRemakeTemplateInput, "replacement_elements"> {
  id: string; type: ViralRemakeCategoryInput["type"]; category_name: string; replacement_elements_json: unknown; created_at: string; updated_at: string;
}
interface CountRow extends RowDataPacket { total: number | string }
interface MediaRow extends RowDataPacket { id: string; media_type: string; mime_type: string }
const categoryColumns = "c.id,c.type,c.code,c.name,c.description,c.sort_order,c.status,c.created_at,c.updated_at";
const templateColumns = "t.id,t.category_id,c.type,c.name category_name,t.title,t.summary,t.video_url,t.original_share_url,t.script_content,t.replacement_elements_json,t.sort_order,t.status,t.created_at,t.updated_at";

function serialize(row: TemplateRow) {
  const { replacement_elements_json, ...rest } = row;
  return { ...rest, replacement_elements: parseStoredJson<ReplacementElement[]>(replacement_elements_json) };
}

function storageError(error: unknown): never {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "ER_DUP_ENTRY") throw new ConflictException("相同类型下的分类标识或分类名称已经存在");
  if (code === "ER_ROW_IS_REFERENCED_2") throw new ConflictException("分类下已有爆款视频，请先移动或删除这些视频");
  if (code === "ER_NO_REFERENCED_ROW_2") throw new BadRequestException("所属分类不存在，请重新选择");
  throw error;
}

@Injectable()
export class ViralRemakesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async categories(filters: ViralRemakeFilters, publicOnly: boolean) {
    const conditions = [publicOnly ? "c.status='ACTIVE'" : "1=1"], parameters: unknown[] = [];
    if (filters.type) { conditions.push("c.type=?"); parameters.push(filters.type); }
    if (!publicOnly && filters.status) { conditions.push("c.status=?"); parameters.push(filters.status); }
    if (filters.q) { conditions.push("(c.name LIKE ? OR c.description LIKE ?)"); parameters.push(`%${filters.q}%`, `%${filters.q}%`); }
    const rows = await this.database.query<CategoryRow[]>(
      `SELECT ${categoryColumns},(SELECT COUNT(*) FROM viral_remake_templates t WHERE t.category_id=c.id${publicOnly ? " AND t.status='ACTIVE'" : ""}) template_count
       FROM viral_remake_categories c WHERE ${conditions.join(" AND ")} ORDER BY c.sort_order ASC,c.created_at ASC,c.id ASC`, parameters);
    return rows.map(row => ({ ...row, template_count: Number(row.template_count || 0) }));
  }

  async categoryGet(id: string): Promise<CategoryRow> {
    const rows = await this.database.query<CategoryRow[]>(`SELECT ${categoryColumns} FROM viral_remake_categories c WHERE c.id=? LIMIT 1`, [viralRemakeId(id)]);
    if (!rows[0]) throw new NotFoundException("爆款分类不存在");
    return rows[0];
  }

  async templates(filters: ViralRemakeFilters, publicOnly: boolean) {
    const conditions = [publicOnly ? "t.status='ACTIVE' AND c.status='ACTIVE'" : "1=1"], parameters: unknown[] = [];
    if (filters.type) { conditions.push("c.type=?"); parameters.push(filters.type); }
    if (filters.category) { conditions.push("t.category_id=?"); parameters.push(filters.category); }
    if (!publicOnly && filters.status) { conditions.push("t.status=?"); parameters.push(filters.status); }
    if (filters.q) { conditions.push("(t.title LIKE ? OR t.summary LIKE ?)"); parameters.push(`%${filters.q}%`, `%${filters.q}%`); }
    const from = `FROM viral_remake_templates t INNER JOIN viral_remake_categories c ON c.id=t.category_id WHERE ${conditions.join(" AND ")}`;
    const counts = await this.database.query<CountRow[]>(`SELECT COUNT(*) total ${from}`, parameters);
    const total = Number(counts[0]?.total || 0);
    const rows = await this.database.query<TemplateRow[]>(
      `SELECT ${templateColumns} ${from} ORDER BY t.sort_order ASC,t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`,
      [...parameters, filters.page_size, (filters.page - 1) * filters.page_size]);
    return { items: rows.map(serialize), total, page: filters.page, page_size: filters.page_size, total_pages: Math.ceil(total / filters.page_size) };
  }

  async templateGet(id: string, publicOnly = false) {
    const rows = await this.database.query<TemplateRow[]>(
      `SELECT ${templateColumns} FROM viral_remake_templates t INNER JOIN viral_remake_categories c ON c.id=t.category_id
       WHERE t.id=?${publicOnly ? " AND t.status='ACTIVE' AND c.status='ACTIVE'" : ""} LIMIT 1`, [viralRemakeId(id)]);
    if (!rows[0]) throw new NotFoundException(publicOnly ? "爆款视频不存在或已下架" : "爆款视频不存在");
    return serialize(rows[0]);
  }

  async categoryCreate(adminUserId: string, value: unknown) {
    const input = categoryInput(value), id = randomUUID();
    try {
      await this.database.execute("INSERT INTO viral_remake_categories (id,type,code,name,description,sort_order,status,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?)",
        [id, input.type, input.code, input.name, input.description, input.sort_order, input.status, adminUserId, adminUserId]);
    } catch (error) { storageError(error); }
    await this.audit.record({ adminUserId, action: "viral-remake.category.create", entityType: "viral_remake_category", entityId: id, details: { type: input.type, status: input.status } });
    return this.categoryGet(id);
  }

  async categoryUpdate(adminUserId: string, id: string, value: unknown) {
    const normalizedId = viralRemakeId(id);
    try {
      await this.database.transaction(async connection => {
        const [rows] = await connection.query<CategoryRow[]>("SELECT * FROM viral_remake_categories WHERE id=? FOR UPDATE", [normalizedId]);
        const previous = rows[0];
        if (!previous) throw new NotFoundException("爆款分类不存在");
        const input = categoryInput(value, previous);
        if (input.type !== previous.type) {
          const [counts] = await connection.query<CountRow[]>("SELECT COUNT(*) total FROM viral_remake_templates WHERE category_id=?", [normalizedId]);
          if (Number(counts[0]?.total || 0)) throw new ConflictException("分类下已有爆款视频，不能修改分类类型");
        }
        await connection.execute("UPDATE viral_remake_categories SET type=?,code=?,name=?,description=?,sort_order=?,status=?,updated_by=? WHERE id=?",
          [input.type, input.code, input.name, input.description, input.sort_order, input.status, adminUserId, normalizedId]);
      });
    } catch (error) { storageError(error); }
    await this.audit.record({ adminUserId, action: "viral-remake.category.update", entityType: "viral_remake_category", entityId: normalizedId });
    return this.categoryGet(normalizedId);
  }

  async categoryDelete(adminUserId: string, id: string) {
    try {
      const result = await this.database.execute("DELETE FROM viral_remake_categories WHERE id=?", [viralRemakeId(id)]);
      if (!result.affectedRows) throw new NotFoundException("爆款分类不存在");
    } catch (error) { storageError(error); }
    await this.audit.record({ adminUserId, action: "viral-remake.category.delete", entityType: "viral_remake_category", entityId: id });
    return { deleted: true };
  }

  private async validateMedia(input: ViralRemakeTemplateInput) {
    const video = viralRemakeMediaId(input.video_url)!;
    const images = input.replacement_elements.map(element => viralRemakeMediaId(element.image_url, "替换元素原图", false)).filter((id): id is string => !!id);
    const ids = [...new Set([video, ...images])];
    const rows = await this.database.query<MediaRow[]>(`SELECT id,media_type,mime_type FROM tutorial_media WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    const records = new Map(rows.map(row => [row.id.toLowerCase(), row]));
    if (records.get(video)?.media_type !== "VIDEO") throw new BadRequestException("上传的爆款视频不存在或不是视频，请重新上传");
    if (images.some(id => records.get(id)?.media_type !== "IMAGE")) throw new BadRequestException("替换元素原图不存在或不是图片，请重新上传");
    if (images.some(id => !["image/png", "image/jpeg", "image/webp"].includes(records.get(id)!.mime_type))) throw new BadRequestException("替换元素原图仅支持 PNG、JPEG、WebP 图片");
  }

  private async lockCategory(connection: PoolConnection, categoryId: string, value: unknown) {
    const [categories] = await connection.query<CategoryRow[]>("SELECT * FROM viral_remake_categories WHERE id=? LOCK IN SHARE MODE", [categoryId]);
    const category = categories[0];
    if (!category) throw new BadRequestException("所属分类不存在，请重新选择");
    const body = asRecord(value);
    if (body.type !== undefined && body.type !== category.type) throw new BadRequestException("所属分类与爆款类型不一致");
  }

  async templateCreate(adminUserId: string, value: unknown) {
    const input = templateInput(value), id = randomUUID();
    await this.validateMedia(input);
    try {
      await this.database.transaction(async connection => {
        await this.lockCategory(connection, input.category_id, value);
        await connection.execute(`INSERT INTO viral_remake_templates
          (id,category_id,title,summary,video_url,original_share_url,script_content,replacement_elements_json,sort_order,status,created_by,updated_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, input.category_id, input.title, input.summary, input.video_url, input.original_share_url, input.script_content, JSON.stringify(input.replacement_elements), input.sort_order, input.status, adminUserId, adminUserId]);
      });
    } catch (error) { storageError(error); }
    await this.audit.record({ adminUserId, action: "viral-remake.template.create", entityType: "viral_remake_template", entityId: id, details: { category_id: input.category_id, status: input.status } });
    return this.templateGet(id);
  }

  async templateUpdate(adminUserId: string, id: string, value: unknown) {
    const normalizedId = viralRemakeId(id), previous = await this.templateGet(normalizedId);
    const input = templateInput(value, previous);
    await this.validateMedia(input);
    try {
      await this.database.transaction(async connection => {
        await this.lockCategory(connection, input.category_id, value);
        const [result] = await connection.execute<import("mysql2/promise").ResultSetHeader>(`UPDATE viral_remake_templates SET category_id=?,title=?,summary=?,video_url=?,original_share_url=?,script_content=?,replacement_elements_json=?,sort_order=?,status=?,updated_by=? WHERE id=?`,
          [input.category_id, input.title, input.summary, input.video_url, input.original_share_url, input.script_content, JSON.stringify(input.replacement_elements), input.sort_order, input.status, adminUserId, normalizedId]);
        if (!result.affectedRows) throw new NotFoundException("爆款视频不存在");
      });
    } catch (error) { storageError(error); }
    await this.audit.record({ adminUserId, action: "viral-remake.template.update", entityType: "viral_remake_template", entityId: normalizedId, details: { category_id: input.category_id, status: input.status } });
    return this.templateGet(normalizedId);
  }

  async templateDelete(adminUserId: string, id: string) {
    const result = await this.database.execute("DELETE FROM viral_remake_templates WHERE id=?", [viralRemakeId(id)]);
    if (!result.affectedRows) throw new NotFoundException("爆款视频不存在");
    await this.audit.record({ adminUserId, action: "viral-remake.template.delete", entityType: "viral_remake_template", entityId: id });
    return { deleted: true };
  }
}
