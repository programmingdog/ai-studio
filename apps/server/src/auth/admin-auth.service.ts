import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { compare, hash } from "bcryptjs";
import jwt, { SignOptions } from "jsonwebtoken";
import { RowDataPacket } from "mysql2";
import { DatabaseService } from "../database/database.service";
import { EnvironmentService } from "../config/environment.service";
import { AdminPrincipal } from "./admin-auth.types";
import { AuditService } from "../common/audit.service";

interface AdminRow extends RowDataPacket {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  status: string;
  must_change_password: number;
  mfa_required: number;
}

interface CodeRow extends RowDataPacket {
  code: string;
}

@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EnvironmentService) private readonly environment: EnvironmentService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string): Promise<Record<string, unknown>> {
    const rows = await this.database.query<AdminRow[]>(
      `SELECT id, email, password_hash, display_name, status, must_change_password, mfa_required
       FROM admin_users WHERE email = ? LIMIT 1`,
      [email.toLowerCase()],
    );
    const admin = rows[0];
    if (!admin || admin.status !== "ACTIVE" || !(await compare(password, admin.password_hash))) {
      throw new UnauthorizedException("邮箱或密码错误");
    }

    const roles = await this.database.query<CodeRow[]>(
      `SELECT r.code FROM admin_roles r
       INNER JOIN admin_user_roles ur ON ur.role_id = r.id
       WHERE ur.admin_user_id = ? ORDER BY r.code`,
      [admin.id],
    );
    const permissions = await this.database.query<CodeRow[]>(
      `SELECT DISTINCT p.code FROM admin_permissions p
       INNER JOIN admin_role_permissions rp ON rp.permission_id = p.id
       INNER JOIN admin_user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.admin_user_id = ? ORDER BY p.code`,
      [admin.id],
    );

    const principal: AdminPrincipal = {
      sub: admin.id,
      email: admin.email,
      displayName: admin.display_name,
      roles: roles.map((row) => row.code),
      permissions: permissions.map((row) => row.code),
      type: "admin",
      mustChangePassword: Boolean(admin.must_change_password),
      mfaRequired: Boolean(admin.mfa_required),
    };
    const options: SignOptions = {
      expiresIn: this.environment.values.jwtExpiresIn as SignOptions["expiresIn"],
      issuer: "ai-video-studio",
      audience: "admin-web",
    };
    const accessToken = jwt.sign(principal, this.environment.values.jwtSecret, options);
    await this.database.execute("UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [admin.id]);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.environment.values.jwtExpiresIn,
      must_change_password: Boolean(admin.must_change_password),
      mfa_required: Boolean(admin.mfa_required),
      admin: principal,
    };
  }

  async changePassword(principal: AdminPrincipal, currentPassword: string, newPassword: string): Promise<{ changed: true }> {
    if (newPassword.length < 12) throw new UnauthorizedException("新密码至少需要 12 个字符");
    const rows = await this.database.query<AdminRow[]>(
      `SELECT id, email, password_hash, display_name, status, must_change_password, mfa_required
       FROM admin_users WHERE id = ? LIMIT 1`,
      [principal.sub],
    );
    const admin = rows[0];
    if (!admin || !(await compare(currentPassword, admin.password_hash))) {
      throw new UnauthorizedException("当前密码不正确");
    }
    if (await compare(newPassword, admin.password_hash)) throw new UnauthorizedException("新密码不能与当前密码相同");
    const passwordHash = await hash(newPassword, 12);
    await this.database.execute(
      "UPDATE admin_users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
      [passwordHash, principal.sub],
    );
    await this.audit.record({ adminUserId: principal.sub, action: "admin.password.change", entityType: "admin_user", entityId: principal.sub });
    return { changed: true };
  }

  verify(token: string): AdminPrincipal {
    try {
      const payload = jwt.verify(token, this.environment.values.jwtSecret, {
        issuer: "ai-video-studio",
        audience: "admin-web",
      });
      if (typeof payload === "string" || payload.type !== "admin") throw new Error("Invalid token type");
      return payload as unknown as AdminPrincipal;
    } catch {
      throw new UnauthorizedException("登录已失效，请重新登录");
    }
  }
}
