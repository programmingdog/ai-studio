import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class AuditService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async record(input: {
    adminUserId?: string;
    action: string;
    entityType: string;
    entityId?: string;
    details?: unknown;
  }): Promise<void> {
    await this.database.execute(
      `INSERT INTO audit_logs
        (id, admin_user_id, action, entity_type, entity_id, details_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.adminUserId || null,
        input.action,
        input.entityType,
        input.entityId || null,
        input.details === undefined ? null : JSON.stringify(input.details),
      ],
    );
  }
}
