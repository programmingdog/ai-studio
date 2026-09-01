import { Body, Controller, Get, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { asRecord, requiredString } from "../common/input";
import { AdminAuthGuard, AdminRequest } from "./admin-auth.guard";
import { AdminAuthService } from "./admin-auth.service";

@Controller("admin/auth")
export class AdminAuthController {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}

  @Post("login")
  login(@Body() input: unknown): Promise<Record<string, unknown>> {
    const body = asRecord(input);
    return this.auth.login(requiredString(body, "email", 191), requiredString(body, "password", 200));
  }

  @Get("me")
  @UseGuards(AdminAuthGuard)
  me(@Req() request: AdminRequest): AdminRequest["admin"] {
    return request.admin;
  }

  @Post("change-password")
  @UseGuards(AdminAuthGuard)
  changePassword(@Req() request: AdminRequest, @Body() input: unknown) {
    const body = asRecord(input);
    return this.auth.changePassword(
      request.admin,
      requiredString(body, "current_password", 200),
      requiredString(body, "new_password", 200),
    );
  }
}
