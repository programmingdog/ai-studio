import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { RowDataPacket } from "mysql2/promise";
import { AuditService } from "../common/audit.service";
import { DatabaseService } from "../database/database.service";

export interface AnnouncementRow extends RowDataPacket {
  id: string;
  title: string;
  content: string;
  status: "DRAFT" | "PUBLISHED";
  is_pinned: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  created_by_name?: string | null;
}

export interface AnnouncementInput {
  title: string;
  content: string;
  isPinned: boolean;
}

const allowedTags = [
  "p", "br", "strong", "b", "em", "i", "u", "s", "blockquote", "pre", "code", "h1", "h2", "h3",
  "h4", "ul", "ol", "li", "a", "img", "video", "source", "figure", "figcaption", "hr", "span",
];

function cleanContent(content: string): string {
  const cleaned = sanitizeHtml(content, {
    allowedTags,
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      video: ["src", "poster", "controls", "preload", "width", "height"],
      source: ["src", "type"],
    },
    allowedSchemes: ["https", "http"],
    allowedSchemesByTag: { a: ["https", "http", "mailto"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attribs) => ({ tagName: "a", attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }),
      img: (_tagName, attribs) => ({ tagName: "img", attribs: { ...attribs, loading: "lazy" } }),
      video: (_tagName, attribs) => ({ tagName: "video", attribs: { ...attribs, controls: "", preload: "metadata" } }),
    },
    exclusiveFilter: (frame) => ["img", "video", "source"].includes(frame.tag) && !frame.attribs.src,
  }).trim();
  const plainText = sanitizeHtml(cleaned, { allowedTags: [], allowedAttributes: {} }).trim();
  const hasMedia = /<(?:img|video)\b/i.test(cleaned);
  if (!cleaned || (!plainText && !hasMedia)) {
    throw new BadRequestException("公告正文不能为空");
  }
  if (cleaned.length > 2_000_000) throw new BadRequestException("公告正文不能超过 200 万字符");
  return cleaned;
}

@Injectable()
export class AnnouncementsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async publicList(): Promise<AnnouncementRow[]> {
    return this.database.query<AnnouncementRow[]>(
      `SELECT id,title,content,status,is_pinned,published_at,created_at,updated_at
       FROM announcements
       WHERE status='PUBLISHED' AND published_at IS NOT NULL AND published_at<=CURRENT_TIMESTAMP(3)
         AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP(3))
       ORDER BY is_pinned DESC,published_at DESC,id DESC LIMIT 100`,
    );
  }

  async adminList(): Promise<AnnouncementRow[]> {
    return this.database.query<AnnouncementRow[]>(
      `SELECT a.id,a.title,a.content,a.status,a.is_pinned,a.published_at,a.created_at,a.updated_at,
              a.created_by,au.display_name created_by_name
       FROM announcements a LEFT JOIN admin_users au ON au.id=a.created_by
       ORDER BY a.is_pinned DESC,COALESCE(a.published_at,a.created_at) DESC,a.id DESC`,
    );
  }

  async create(adminUserId: string, input: AnnouncementInput): Promise<AnnouncementRow> {
    const id = randomUUID();
    await this.database.execute(
      `INSERT INTO announcements (id,title,content,status,is_pinned,created_by)
       VALUES (?,?,?,'DRAFT',?,?)`,
      [id, input.title, cleanContent(input.content), input.isPinned, adminUserId],
    );
    await this.audit.record({ adminUserId, action: "announcement.create", entityType: "announcement", entityId: id });
    return this.get(id);
  }

  async update(adminUserId: string, id: string, input: AnnouncementInput): Promise<AnnouncementRow> {
    const result = await this.database.execute(
      "UPDATE announcements SET title=?,content=?,is_pinned=? WHERE id=?",
      [input.title, cleanContent(input.content), input.isPinned, id],
    );
    if (!result.affectedRows) throw new NotFoundException("通知公告不存在");
    await this.audit.record({ adminUserId, action: "announcement.update", entityType: "announcement", entityId: id });
    return this.get(id);
  }

  async publish(adminUserId: string, id: string): Promise<AnnouncementRow> {
    const result = await this.database.execute(
      "UPDATE announcements SET status='PUBLISHED',published_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      [id],
    );
    if (!result.affectedRows) throw new NotFoundException("通知公告不存在");
    await this.audit.record({ adminUserId, action: "announcement.publish", entityType: "announcement", entityId: id });
    return this.get(id);
  }

  async unpublish(adminUserId: string, id: string): Promise<AnnouncementRow> {
    const result = await this.database.execute(
      "UPDATE announcements SET status='DRAFT',published_at=NULL WHERE id=?",
      [id],
    );
    if (!result.affectedRows) throw new NotFoundException("通知公告不存在");
    await this.audit.record({ adminUserId, action: "announcement.unpublish", entityType: "announcement", entityId: id });
    return this.get(id);
  }

  async delete(adminUserId: string, id: string): Promise<{ deleted: true }> {
    const result = await this.database.execute("DELETE FROM announcements WHERE id=?", [id]);
    if (!result.affectedRows) throw new NotFoundException("通知公告不存在");
    await this.audit.record({ adminUserId, action: "announcement.delete", entityType: "announcement", entityId: id });
    return { deleted: true };
  }

  private async get(id: string): Promise<AnnouncementRow> {
    const rows = await this.database.query<AnnouncementRow[]>(
      `SELECT a.id,a.title,a.content,a.status,a.is_pinned,a.published_at,a.created_at,a.updated_at,
              a.created_by,au.display_name created_by_name
       FROM announcements a LEFT JOIN admin_users au ON au.id=a.created_by WHERE a.id=? LIMIT 1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException("通知公告不存在");
    return rows[0];
  }
}
