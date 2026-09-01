import { Controller, Get, Inject } from "@nestjs/common";
import { RowDataPacket } from "mysql2";
import { DatabaseService } from "./database/database.service";

interface VersionRow extends RowDataPacket {
  version: string;
}

@Controller("health")
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get()
  async health(): Promise<Record<string, unknown>> {
    const rows = await this.database.query<VersionRow[]>("SELECT VERSION() AS version");
    return {
      status: "ok",
      service: "ai-video-studio-server",
      database: { status: "ok", version: rows[0]?.version || "unknown" },
      media_storage: "disabled",
      timestamp: new Date().toISOString(),
    };
  }
}
