import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AnnouncementsAdminController, AnnouncementsController } from "./announcements.controller";
import { AnnouncementsService } from "./announcements.service";

@Module({
  imports: [AuthModule],
  controllers: [AnnouncementsController, AnnouncementsAdminController],
  providers: [AnnouncementsService],
})
export class AnnouncementsModule {}
