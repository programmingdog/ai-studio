import { Body, Controller, Delete, Get, Header, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard, AdminRequest } from "../auth/admin-auth.guard";
import { RequirePermissions } from "../auth/permissions.decorator";
import { PermissionsGuard } from "../auth/permissions.guard";
import { asRecord, requiredBoolean, requiredString } from "../common/input";
import { AnnouncementsService } from "./announcements.service";

@Controller("announcements")
export class AnnouncementsController {
  constructor(@Inject(AnnouncementsService) private readonly announcements: AnnouncementsService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  list() { return this.announcements.publicList(); }
}

@Controller("admin/announcements")
@UseGuards(AdminAuthGuard, PermissionsGuard)
@RequirePermissions("announcements.manage")
export class AnnouncementsAdminController {
  constructor(@Inject(AnnouncementsService) private readonly announcements: AnnouncementsService) {}

  @Get()
  list() { return this.announcements.adminList(); }

  @Post()
  create(@Req() request: AdminRequest, @Body() value: unknown) {
    return this.announcements.create(request.admin.sub, this.input(value));
  }

  @Patch(":announcementId")
  update(@Req() request: AdminRequest, @Param("announcementId") id: string, @Body() value: unknown) {
    return this.announcements.update(request.admin.sub, id, this.input(value));
  }

  @Post(":announcementId/publish")
  publish(@Req() request: AdminRequest, @Param("announcementId") id: string) {
    return this.announcements.publish(request.admin.sub, id);
  }

  @Post(":announcementId/unpublish")
  unpublish(@Req() request: AdminRequest, @Param("announcementId") id: string) {
    return this.announcements.unpublish(request.admin.sub, id);
  }

  @Delete(":announcementId")
  delete(@Req() request: AdminRequest, @Param("announcementId") id: string) {
    return this.announcements.delete(request.admin.sub, id);
  }

  private input(value: unknown) {
    const body = asRecord(value);
    return {
      title: requiredString(body, "title", 200),
      content: requiredString(body, "content", 2_000_000),
      isPinned: requiredBoolean(body, "is_pinned"),
    };
  }
}
