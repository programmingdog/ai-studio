import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { RowDataPacket } from "mysql2/promise";
import { SecretCryptoService } from "../common/secret-crypto.service";
import { DatabaseService } from "../database/database.service";
import { normalizedEmail } from "../user-auth/registration-validation";

interface MailConfigRow extends RowDataPacket {
  api_url: string;
  delivery_method: "HTTP" | "SMTP";
  smtp_host: string;
  smtp_port: number;
  smtp_security: "STARTTLS" | "TLS";
  mail_from: string;
  password_ciphertext: string | null;
  status: "ACTIVE" | "DISABLED";
  revision: number;
  updated_at: Date;
}

export type MailDeliveryConfig = { from: string; password: string } & (
  { method: "HTTP"; apiUrl: string } |
  { method: "SMTP"; host: string; port: number; security: "STARTTLS" | "TLS" }
);
const columns = "api_url, delivery_method, smtp_host, smtp_port, smtp_security, mail_from, password_ciphertext, status, revision, updated_at";

export function validateSmtpSettings(host: unknown, port: unknown, security: unknown): { host: string; port: number; security: "STARTTLS" | "TLS" } {
  if (typeof host !== "string" || !host.trim() || host.trim().length > 253 || isIP(host.trim()) || !host.trim().split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new BadRequestException("SMTP 主机须为有效域名，不含协议、端口或路径");
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new BadRequestException("SMTP 端口须为 1～65535 的整数");
  if (security !== "STARTTLS" && security !== "TLS") throw new BadRequestException("SMTP 加密方式须为 STARTTLS 或 TLS，不支持明文发件");
  if (port === 465 && security !== "TLS") throw new BadRequestException("465 端口请使用 SSL/TLS 加密方式");
  return { host: host.trim().toLowerCase(), port: Number(port), security };
}

export function validateMailApiUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500) throw new BadRequestException("邮件 API 地址不能为空且不能超过 500 个字符");
  const result = value.trim();
  let url: URL;
  try { url = new URL(result); } catch { throw new BadRequestException("邮件 API 地址格式无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new BadRequestException("邮件 API 地址必须使用 HTTP 或 HTTPS，且不能包含账号密码、查询参数或片段");
  return result;
}

@Injectable()
export class MailConfigService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SecretCryptoService) private readonly secretCrypto: SecretCryptoService,
  ) {}

  private async row(): Promise<MailConfigRow> {
    const [row] = await this.database.query<MailConfigRow[]>(`SELECT ${columns} FROM mail_service_configs WHERE id = 1`);
    if (!row) throw new ServiceUnavailableException("邮箱配置不存在，请先执行数据库迁移");
    return row;
  }

  private publicConfig(row: MailConfigRow) {
    return { api_url: row.api_url, delivery_method: row.delivery_method, smtp_host: row.smtp_host, smtp_port: Number(row.smtp_port), smtp_security: row.smtp_security, mail_from: row.mail_from, password_configured: Boolean(row.password_ciphertext), status: row.status, revision: Number(row.revision), updated_at: row.updated_at };
  }

  async get() { return this.publicConfig(await this.row()); }

  async save(adminId: string, input: { api_url?: unknown; delivery_method?: unknown; smtp_host?: unknown; smtp_port?: unknown; smtp_security?: unknown; mail_from: unknown; password?: unknown; status: unknown; revision: unknown }) {
    if (typeof input.mail_from !== "string") throw new BadRequestException("发件邮箱必须是字符串");
    const from = input.mail_from.trim() ? normalizedEmail(input.mail_from) : "";
    if (input.status !== "ACTIVE" && input.status !== "DISABLED") throw new BadRequestException("邮箱配置状态无效");
    const status = input.status;
    if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new BadRequestException("邮箱配置版本无效");
    if (input.password !== undefined && typeof input.password !== "string") throw new BadRequestException("发件邮箱密码必须是字符串，留空可保留原密码");
    const password = input.password as string | undefined;
    if (password && (!password.trim() || password.length > 500)) throw new BadRequestException("发件邮箱密码不能为空白字符且不能超过 500 个字符");
    return this.database.transaction(async (connection) => {
      const [rows] = await connection.query<MailConfigRow[]>(`SELECT ${columns} FROM mail_service_configs WHERE id = 1 FOR UPDATE`);
      const current = rows[0];
      if (!current || Number(current.revision) !== input.revision) throw new ConflictException("邮箱配置已被修改，请重新读取后再保存");
      // Older admin clients omit transport fields; preserve the selected transport.
      const method = input.delivery_method === undefined ? current.delivery_method : input.delivery_method;
      if (method !== "HTTP" && method !== "SMTP") throw new BadRequestException("发件方式须为 HTTP 或 SMTP");
      const apiUrl = method === "HTTP" ? validateMailApiUrl(input.api_url === undefined ? current.api_url : input.api_url) : current.api_url;
      const smtp = method === "SMTP" ? validateSmtpSettings(
        input.smtp_host === undefined ? current.smtp_host : input.smtp_host,
        input.smtp_port === undefined ? Number(current.smtp_port) : input.smtp_port,
        input.smtp_security === undefined ? current.smtp_security : input.smtp_security,
      ) : { host: current.smtp_host, port: Number(current.smtp_port), security: current.smtp_security };
      const targetChanged = method !== current.delivery_method || from !== current.mail_from || (method === "HTTP"
        ? apiUrl !== current.api_url
        : smtp.host !== current.smtp_host || smtp.port !== Number(current.smtp_port) || smtp.security !== current.smtp_security);
      // Never send the existing secret to a newly configured endpoint/mailbox without re-entry.
      if (current.password_ciphertext && !password && targetChanged) throw new BadRequestException("修改发件方式、服务器、端口、加密方式或发件邮箱时，请重新填写发件邮箱密码");
      const ciphertext = password ? this.secretCrypto.encrypt(password) : current.password_ciphertext;
      if (status === "ACTIVE" && (!from || !ciphertext)) throw new BadRequestException("启用邮箱服务前必须填写发件邮箱和密码");
      await connection.execute("UPDATE mail_service_configs SET api_url = ?, mail_from = ?, password_ciphertext = ?, status = ?, revision = revision + 1, updated_by = ?, delivery_method = ?, smtp_host = ?, smtp_port = ?, smtp_security = ? WHERE id = 1", [apiUrl, from, ciphertext, status, adminId, method, smtp.host, smtp.port, smtp.security]);
      await connection.execute("INSERT INTO audit_logs (id, admin_user_id, action, entity_type, entity_id, details_json) VALUES (?, ?, 'mail_config.update', 'mail_service_configs', '1', ?)", [randomUUID(), adminId, JSON.stringify({ api_url: apiUrl, delivery_method: method, smtp_host: smtp.host, smtp_port: smtp.port, smtp_security: smtp.security, mail_from: from, status, password_changed: Boolean(password), revision: Number(current.revision) + 1 })]);
      const [saved] = await connection.query<MailConfigRow[]>(`SELECT ${columns} FROM mail_service_configs WHERE id = 1`);
      return this.publicConfig(saved[0]!);
    });
  }

  /** Server-only. No caching: admin changes affect the next mail request on every instance. */
  async deliveryConfig(): Promise<MailDeliveryConfig> {
    const row = await this.row();
    if (row.status !== "ACTIVE" || !row.mail_from || !row.password_ciphertext) throw new ServiceUnavailableException("邮箱验证码服务尚未配置或已停用，请联系管理员");
    try {
      const from = normalizedEmail(row.mail_from);
      const password = this.secretCrypto.decrypt(row.password_ciphertext);
      if (!password.trim()) throw new Error();
      if (row.delivery_method === "SMTP") return { method: "SMTP", ...validateSmtpSettings(row.smtp_host, Number(row.smtp_port), row.smtp_security), from, password };
      if (row.delivery_method !== "HTTP") throw new Error();
      return { method: "HTTP", apiUrl: validateMailApiUrl(row.api_url), from, password };
    } catch {
      throw new ServiceUnavailableException("邮箱验证码服务配置无效，请联系管理员");
    }
  }
}
