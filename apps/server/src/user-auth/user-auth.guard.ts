import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import { UserAuthService } from "./user-auth.service";
import { UserPrincipal } from "./user-auth.types";

export type UserRequest = Request & { user: UserPrincipal };

@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(@Inject(UserAuthService) private readonly auth: UserAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedException("请先登录");
    (request as UserRequest).user = await this.auth.authenticate(authorization.slice(7));
    return true;
  }
}
