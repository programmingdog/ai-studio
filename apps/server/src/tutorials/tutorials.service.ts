import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { RowDataPacket } from "mysql2/promise";
import { AuditService } from "../common/audit.service";
import { DatabaseService } from "../database/database.service";
import { asRecord } from "../common/input";
import { resolveBilibiliVideo, tutorialInput, TutorialInput, uploadedVideoAssetId } from "./tutorials.validation";

export interface TutorialRow extends RowDataPacket, TutorialInput {
  id: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}
interface CountRow extends RowDataPacket { total: number | string }
interface MediaRow extends RowDataPacket { media_type: string }
const detailColumns = "id,title,content,video_type,video_url,status,sort_order,created_at,updated_at,published_at";
const summaryColumns = "id,title,video_type,status,sort_order,created_at,updated_at,published_at";
const published = "status='PUBLISHED' AND published_at IS NOT NULL AND published_at<=UTC_TIMESTAMP(3)";

@Injectable()
export class TutorialsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  publicList(page: number) { return this.list(page, true); }
  adminList(page: number, query?: string) { return this.list(page, false, query); }

  private async list(page: number, publicOnly: boolean, query?: string) {
    const parameters: unknown[] = [];
    const clauses = [publicOnly ? published : "1=1"];
    if (query !== undefined) {
      if (typeof query !== "string" || query.length > 200) throw new BadRequestException("教程搜索词不能超过 200 字符");
      if (query.trim()) { clauses.push("title LIKE ?"); parameters.push(`%${query.trim()}%`); }
    }
    const where = clauses.join(" AND ");
    const counts = await this.database.query<CountRow[]>(`SELECT COUNT(*) total FROM tutorials WHERE ${where}`, parameters);
    const total = Number(counts[0]?.total || 0);
    const items = await this.database.query<RowDataPacket[]>(
      `SELECT ${summaryColumns} FROM tutorials WHERE ${where}
       ORDER BY sort_order ASC,COALESCE(published_at,created_at) DESC,id DESC LIMIT 10 OFFSET ?`,
      [...parameters, (page - 1) * 10],
    );
    return { items, page, page_size: 10, total, page_count: Math.ceil(total / 10) };
  }

  async publicGet(id: string): Promise<TutorialRow> {
    const rows = await this.database.query<TutorialRow[]>(`SELECT ${detailColumns} FROM tutorials WHERE id=? AND ${published} LIMIT 1`, [id]);
    if (!rows[0]) throw new NotFoundException("教程不存在或尚未发布");
    return rows[0];
  }

  async adminGet(id: string): Promise<TutorialRow> {
    const rows = await this.database.query<TutorialRow[]>(`SELECT ${detailColumns} FROM tutorials WHERE id=? LIMIT 1`, [id]);
    if (!rows[0]) throw new NotFoundException("教程不存在");
    return rows[0];
  }

  private async validateMedia(input: TutorialInput) {
    if (input.video_type !== "UPLOAD" || !input.video_url) return;
    const rows = await this.database.query<MediaRow[]>("SELECT media_type FROM tutorial_media WHERE id=? LIMIT 1", [uploadedVideoAssetId(input.video_url)]);
    if (rows[0]?.media_type !== "VIDEO") throw new BadRequestException("上传的视频不存在，请重新上传");
  }

  private async input(value: unknown, previous?: TutorialInput) {
    const body = asRecord(value);
    const videoType = body.video_type ?? previous?.video_type;
    const videoUrl = "video_url" in body ? body.video_url : previous?.video_url;
    if (videoType === "BILIBILI" && typeof videoUrl === "string" && videoUrl.trim() && videoUrl.length <= 10_000) {
      return tutorialInput({ ...body, video_url: await resolveBilibiliVideo(videoUrl) }, previous);
    }
    return tutorialInput(body, previous);
  }

  async create(adminUserId: string, value: unknown): Promise<TutorialRow> {
    const input = await this.input(value);
    await this.validateMedia(input);
    const id = randomUUID();
    await this.database.execute(
      `INSERT INTO tutorials (id,title,content,video_type,video_url,status,sort_order,created_by,updated_by,published_at)
       VALUES (?,?,?,?,?,?,?,?,?,IF(?='PUBLISHED',UTC_TIMESTAMP(3),NULL))`,
      [id, input.title, input.content, input.video_type, input.video_url, input.status, input.sort_order, adminUserId, adminUserId, input.status],
    );
    await this.audit.record({ adminUserId, action: "tutorial.create", entityType: "tutorial", entityId: id, details: { status: input.status, video_type: input.video_type } });
    return this.adminGet(id);
  }

  async update(adminUserId: string, id: string, value: unknown): Promise<TutorialRow> {
    const previous = await this.adminGet(id);
    const input = await this.input(value, previous);
    await this.validateMedia(input);
    const result = await this.database.execute(
      `UPDATE tutorials SET title=?,content=?,video_type=?,video_url=?,sort_order=?,updated_by=?,
       published_at=IF(?='PUBLISHED',COALESCE(published_at,UTC_TIMESTAMP(3)),NULL),status=? WHERE id=?`,
      [input.title, input.content, input.video_type, input.video_url, input.sort_order, adminUserId, input.status, input.status, id],
    );
    if (!result.affectedRows) throw new NotFoundException("教程不存在");
    await this.audit.record({ adminUserId, action: "tutorial.update", entityType: "tutorial", entityId: id, details: { status: input.status, video_type: input.video_type } });
    return this.adminGet(id);
  }

  async delete(adminUserId: string, id: string) {
    const result = await this.database.execute("DELETE FROM tutorials WHERE id=?", [id]);
    if (!result.affectedRows) throw new NotFoundException("教程不存在");
    await this.audit.record({ adminUserId, action: "tutorial.delete", entityType: "tutorial", entityId: id });
    return { deleted: true };
  }
}
