import { Module } from "@nestjs/common";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminAuthService } from "./admin-auth.service";
import { PermissionsGuard } from "./permissions.guard";

@Module({
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminAuthGuard, PermissionsGuard],
  exports: [AdminAuthService, AdminAuthGuard, PermissionsGuard],
})
export class AuthModule {}
