import { SetMetadata } from "@nestjs/common";

export const REQUIRED_PERMISSIONS = "required_permissions";
export const RequirePermissions = (...permissions: string[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);
