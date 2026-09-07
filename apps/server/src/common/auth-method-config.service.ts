import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "./audit.service";

type AuthMethodConfigRow = RowDataPacket & {
  registration_enabled: number;
  email_enabled: number;
  phone_otp_enabled: number;
  wechat_enabled: number;
  revision: number;
  updated_at: Date | string;
};

export type AuthMethodConfig = {
  registration_enabled: boolean;
  email_enabled: boolean;
  phone_otp_enabled: boolean;
  phone_otp_available: false;
  wechat_enabled: boolean;
  revision: number;
  updated_at: Date | string;
};

@Injectable()
export class AuthMethodConfigService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async get(): Promise<AuthMethodConfig> {
    const rows = await this.database.query<AuthMethodConfigRow[]>(
      `SELECT registration_enabled, email_enabled, phone_otp_enabled, wechat_enabled, revision, updated_at
       FROM client_auth_method_configs WHERE id = 1 LIMIT 1`,
    );
    const row = rows[0];
    if (!row) throw new BadRequestException("登录方式配置尚未初始化，请先执行数据库迁移");
    return {
      registration_enabled: Boolean(Number(row.registration_enabled)),
      email_enabled: Boolean(Number(row.email_enabled)),
      // 短信服务接入前，不向客户端暴露一个不可用的入口。
      phone_otp_enabled: false,
      phone_otp_available: false,
      wechat_enabled: Boolean(Number(row.wechat_enabled)),
      revision: Number(row.revision),
      updated_at: row.updated_at,
    };
  }

  async publicConfig(): Promise<Pick<AuthMethodConfig, "registration_enabled" | "email_enabled" | "phone_otp_enabled" | "phone_otp_available" | "wechat_enabled">> {
    const config = await this.get();
    return {
      registration_enabled: config.registration_enabled,
      email_enabled: config.email_enabled,
      phone_otp_enabled: config.phone_otp_enabled,
      phone_otp_available: config.phone_otp_available,
      wechat_enabled: config.wechat_enabled,
    };
  }

  async assertRegistrationEnabled(): Promise<void> {
    if (!(await this.get()).registration_enabled) {
      throw new ForbiddenException("当前暂未开放新用户注册，请直接登录已有账户");
    }
  }

  async update(adminUserId: string, input: { registrationEnabled: boolean; emailEnabled: boolean; phoneOtpEnabled: boolean; wechatEnabled: boolean }): Promise<AuthMethodConfig> {
    if (input.phoneOtpEnabled) {
      throw new BadRequestException("手机验证码注册登录尚未接入短信服务，暂时不能启用");
    }
    if (!input.emailEnabled && !input.wechatEnabled) {
      throw new BadRequestException("至少需要启用一种当前可用的登录方式");
    }
    await this.database.execute(
      `UPDATE client_auth_method_configs
       SET registration_enabled = ?, email_enabled = ?, phone_otp_enabled = 0, wechat_enabled = ?, revision = revision + 1, updated_by = ?
       WHERE id = 1`,
      [input.registrationEnabled ? 1 : 0, input.emailEnabled ? 1 : 0, input.wechatEnabled ? 1 : 0, adminUserId],
    );
    await this.audit.record({
      adminUserId,
      action: "client_auth_methods.update",
      entityType: "client_auth_method_config",
      entityId: "1",
      details: { registration_enabled: input.registrationEnabled, email_enabled: input.emailEnabled, phone_otp_enabled: false, wechat_enabled: input.wechatEnabled },
    });
    return this.get();
  }
}
