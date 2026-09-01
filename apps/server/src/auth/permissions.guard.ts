import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AdminRequest } from "./admin-auth.guard";
import { REQUIRED_PERMISSIONS } from "./permissions.decorator";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]) || [];
    if (!required.length) return true;
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (request.admin.mustChangePassword) {
      throw new ForbiddenException("首次登录必须先修改临时密码");
    }
    if (request.admin.roles.includes("SUPER_ADMIN")) return true;
    if (!required.every((permission) => request.admin.permissions.includes(permission))) {
      throw new ForbiddenException("当前管理员没有执行此操作的权限");
    }
    return true;
  }
}
