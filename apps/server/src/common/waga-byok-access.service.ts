import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "./audit.service";

@Injectable()
export class WagaByokAccessService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService, @Inject(AuditService) private readonly audit: AuditService) {}

  async get(userId: string) {
    try {
      const rows = await this.db.query<RowDataPacket[]>("SELECT enabled, revision FROM user_waga_byok_access WHERE user_id = ?", [userId]);
      return { user_id: userId, enabled: Number(rows[0]?.enabled) === 1, revision: Number(rows[0]?.revision || 0), migration_required: false };
    } catch (error) {
      if ((error as { code?: string }).code === "ER_NO_SUCH_TABLE") return { user_id: userId, enabled: false, revision: 0, migration_required: true };
      throw error;
    }
  }

  async update(adminUserId: string, userId: string, input: { enabled: unknown; revision: unknown }) {
    if (typeof input.enabled !== "boolean" || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new BadRequestException("开关或配置版本无效");
    const previous = await this.db.transaction(async connection => {
      // Lock the user, including first grant, so concurrent inserts cannot bypass revision checks.
      const [users] = await connection.query<RowDataPacket[]>("SELECT id FROM users WHERE id = ? FOR UPDATE", [userId]);
      if (!users[0]) throw new NotFoundException("用户不存在");
      const [rows] = await connection.query<RowDataPacket[]>("SELECT enabled, revision FROM user_waga_byok_access WHERE user_id = ? FOR UPDATE", [userId]);
      if (Number(rows[0]?.revision || 0) !== input.revision) throw new ConflictException("此用户的授权已更新，请重新读取后再保存");
      await connection.execute("INSERT INTO user_waga_byok_access (user_id, enabled, revision, updated_by) VALUES (?, ?, 1, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), revision = revision + 1, updated_by = VALUES(updated_by)", [userId, input.enabled ? 1 : 0, adminUserId]);
      return Number(rows[0]?.enabled) === 1;
    });
    await this.audit.record({ adminUserId, action: "user.waga_byok.update", entityType: "user", entityId: userId, details: { before: previous, after: input.enabled } });
    return this.get(userId);
  }
}
