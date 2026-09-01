import { Body, Controller, Get, Header, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard, AdminRequest } from "../auth/admin-auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { RequirePermissions } from "../auth/permissions.decorator";
import { asRecord, optionalString, requiredString } from "../common/input";
import { ReferralsService } from "./referrals.service";

@Controller("admin/distribution")
@UseGuards(AdminAuthGuard, PermissionsGuard)
export class ReferralsAdminController {
  constructor(@Inject(ReferralsService) private readonly referrals: ReferralsService) {}
  @Get("config")
  @RequirePermissions("configs.manage")
  config() { return this.referrals.config(); }
  @Patch("config")
  @RequirePermissions("configs.manage", "distribution.manage")
  save(@Req() req: AdminRequest, @Body() body: unknown) { return this.referrals.saveConfig(req.admin.sub, asRecord(body)); }
  @Get("records/:kind")
  @RequirePermissions("distribution.manage")
  @Header("Cache-Control", "no-store")
  records(@Param("kind") kind: string, @Query("page") page?: string, @Query("status") status?: string, @Query("user_id") userId?: string) { return this.referrals.records(kind, userId, page, status); }
  @Post("withdrawals/:id/review")
  @RequirePermissions("distribution.manage")
  review(@Req() req: AdminRequest, @Param("id") id: string, @Body() input: unknown) { const body = asRecord(input); return this.referrals.review(req.admin.sub, id, requiredString(body, "decision", 20), optionalString(body, "note", 500) || ""); }
  @Get("withdrawals/:id/payee")
  @RequirePermissions("payouts.manage")
  @Header("Cache-Control", "no-store")
  payee(@Req() req: AdminRequest, @Param("id") id: string) { return this.referrals.payee(req.admin.sub, id); }
  @Post("withdrawals/:id/paid")
  @RequirePermissions("payouts.manage")
  @Header("Cache-Control", "no-store")
  paid(@Req() req: AdminRequest, @Param("id") id: string, @Body() input: unknown) { return this.referrals.confirmPayout(req.admin.sub, id, asRecord(input)); }
  @Post("withdrawals/:id/claim")
  @RequirePermissions("payouts.manage")
  claim(@Req() req: AdminRequest, @Param("id") id: string) { return this.referrals.claimPayout(req.admin.sub, id); }
  @Post("withdrawals/:id/release")
  @RequirePermissions("payouts.manage")
  release(@Req() req: AdminRequest, @Param("id") id: string, @Body() input: unknown) { return this.referrals.releasePayout(req.admin.sub, id, asRecord(input)); }
}
