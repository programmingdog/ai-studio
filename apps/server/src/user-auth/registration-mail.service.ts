import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { EnvironmentService } from "../config/environment.service";
import { normalizedEmail } from "./registration-validation";
import { MailConfigService, validateMailApiUrl, validateSmtpSettings, type MailDeliveryConfig } from "../mail/mail-config.service";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { MailDeliveryUnconfirmedException } from "./mail-delivery-unconfirmed.exception";
import { ProductBrandConfigService } from "../common/product-brand-config.service";

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function smtpFailure(error: unknown): ServiceUnavailableException {
  const source = error && typeof error === "object" ? error as { code?: string; message?: string } : {};
  let code = "MAIL_SMTP_FAILED", message = "SMTP 邮件发送失败，请联系管理员检查邮局服务";
  if (source.code === "EAUTH") { code = "MAIL_SMTP_AUTH_FAILED"; message = "SMTP 认证失败，请联系管理员检查发件邮箱、密码及 SMTP 认证设置"; }
  else if (source.code === "ETLS" || /CERT|TLS|SELF_SIGNED/.test(source.code || "") || /certificate|self.signed|TLS|SSL/i.test(source.message || "")) { code = "MAIL_SMTP_TLS_FAILED"; message = "SMTP 加密连接失败，请联系管理员检查 STARTTLS/SSL 设置与域名证书"; }
  else if (["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EDNS", "EAI_AGAIN"].includes(source.code || "")) { code = "MAIL_SMTP_CONNECTION_FAILED"; message = "SMTP 连接失败或超时，请联系管理员检查主机、端口、防火墙及网络"; }
  else if (source.code === "EENVELOPE") { code = "MAIL_SMTP_REJECTED"; message = "SMTP 服务拒绝发件，请联系管理员检查发件权限和收件地址"; }
  return new ServiceUnavailableException({ statusCode: 503, code, message: `${message}；重试前请重新进行图形验证` });
}

@Injectable()
export class RegistrationMailService {
  private readonly logger = new Logger(RegistrationMailService.name);
  constructor(
    @Inject(EnvironmentService) private readonly environment: EnvironmentService,
    @Inject(MailConfigService) private readonly mailConfig: MailConfigService,
    @Inject(ProductBrandConfigService) private readonly productBrand: ProductBrandConfigService,
  ) {}

  private async config() {
    const config = { ...await this.mailConfig.deliveryConfig(), timeoutMs: this.environment.values.mailApiTimeoutMs };
    try {
      if (config.method === "HTTP") validateMailApiUrl(config.apiUrl);
      else if (config.method === "SMTP") validateSmtpSettings(config.host, config.port, config.security);
      else throw new Error();
      if (!config.from || !config.password || !Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 60000) throw new Error();
      normalizedEmail(config.from);
    } catch {
      throw new ServiceUnavailableException("邮箱验证码服务尚未配置，请联系管理员");
    }
    return config;
  }

  async assertConfigured(): Promise<void> { await this.config(); }

  async sendCode(email: string, code: string): Promise<void> {
    const recipient = normalizedEmail(email);
    const config = await this.config();
    const brand = await this.productBrand.get();
    const subject = `${brand.chinese_name} 注册邮箱验证码`;
    const content = `您正在注册 ${brand.chinese_name}。\n\n邮箱验证码：${code}\n\n验证码 10 分钟内有效，仅可使用一次。重新发送后旧验证码失效。请勿向他人透露验证码。\n如果不是您本人操作，请忽略此邮件。`;
    if (config.method === "SMTP") return this.sendSmtp(config, recipient, subject, content, brand.chinese_name);
    const diagnosticId = randomUUID(), started = Date.now();
    let httpStatus: number | null = null, responseShape = "unknown", reason = "TRANSPORT_ERROR", rejected = false;
    let outerStatus: boolean | null = null, innerStatus: boolean | null = null;
    const diagnostic = (outcome: "SENT" | "REJECTED" | "UNCERTAIN") => ({ event: "registration.mail_http", diagnostic_id: diagnosticId, outcome, reason,
      http_status: httpStatus, elapsed_ms: Date.now() - started, timeout_ms: config.timeoutMs, response_shape: responseShape, outer_status: outerStatus, inner_status: innerStatus });
    try {
      const response = await fetch(config.apiUrl, {
        method: "POST",
        // Do not forward the sender password through redirects, even on the same host.
        redirect: "error",
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          mail_from: config.from,
          password: config.password,
          mail_to: recipient,
          subject,
          content,
          subtype: "plain",
        }),
      });
      httpStatus = response.status;
      if (!response.ok) {
        // A timeout or server error can occur after the upstream has already sent mail.
        rejected = httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408;
        reason = rejected ? "HTTP_REJECTED" : "HTTP_SERVER_ERROR";
        await response.body?.cancel();
        throw new Error();
      }
      reason = "INVALID_JSON";
      const result = record(await response.json());
      const nested = record(result?.data);
      const wrapped = result !== null && "data" in result;
      responseShape = !result ? "unknown" : wrapped ? "wrapped" : "legacy";
      outerStatus = typeof result?.status === "boolean" ? result.status : null;
      innerStatus = typeof nested?.status === "boolean" ? nested.status : null;
      // New panels wrap the real mail result in data. Outer success alone is insufficient.
      rejected = outerStatus === false || innerStatus === false || (typeof result?.code === "number" && result.code !== 0);
      if (rejected) { reason = "UPSTREAM_REJECTED"; throw new Error(); }
      if (outerStatus !== true || (result && "code" in result && result.code !== 0) || (wrapped && (innerStatus !== true || result?.code !== 0))) {
        reason = "UNRECOGNIZED_RESPONSE"; throw new Error();
      }
      reason = "CONFIRMED";
      this.logger.log(diagnostic("SENT"));
    } catch (error) {
      const source = error as { name?: unknown; cause?: { code?: unknown } } | null;
      if (source?.name === "TimeoutError" || source?.name === "AbortError") reason = "TIMEOUT";
      else if (httpStatus === null && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(String(source?.cause?.code))) { reason = "CONNECTION_FAILED"; rejected = true; }
      // Allowlisted metadata only: never log raw errors, response text, URLs, recipients or credentials.
      this.logger.warn(diagnostic(rejected ? "REJECTED" : "UNCERTAIN"));
      if (!rejected) throw new MailDeliveryUnconfirmedException(diagnosticId);
      const message = reason === "CONNECTION_FAILED" ? "邮件接口无法连接，请联系管理员检查 API 地址及网络" : "邮件接口明确拒绝请求，请联系管理员检查发件凭据、权限及邮局日志";
      throw new ServiceUnavailableException({ statusCode: 503, code: "MAIL_HTTP_REJECTED", delivery_status: "FAILED", diagnostic_id: diagnosticId, message: `${message}；重试前请重新进行图形验证` });
    }
  }

  private async sendSmtp(config: Extract<MailDeliveryConfig, { method: "SMTP" }> & { timeoutMs: number }, recipient: string, subject: string, text: string, brandName: string): Promise<void> {
    const options: SMTPTransport.Options & { dnsTimeout: number } = {
      host: config.host, port: config.port,
      secure: config.security === "TLS",
      requireTLS: config.security === "STARTTLS",
      opportunisticTLS: false,
      tls: { servername: config.host, rejectUnauthorized: true, minVersion: "TLSv1.2" },
      auth: { user: config.from, pass: config.password },
      connectionTimeout: config.timeoutMs, greetingTimeout: config.timeoutMs,
      socketTimeout: config.timeoutMs, dnsTimeout: config.timeoutMs,
      logger: false, debug: false,
      disableFileAccess: true, disableUrlAccess: true,
    };
    const transport = nodemailer.createTransport(options);
    try {
      const info = await transport.sendMail({ from: { name: brandName, address: config.from }, to: recipient, envelope: { from: config.from, to: [recipient] }, subject, text });
      if (!info.accepted?.some((value) => (typeof value === "string" ? value : value.address).toLowerCase() === recipient) || info.rejected?.length) throw Object.assign(new Error(), { code: "EENVELOPE" });
    } catch (error) {
      // No raw server response, credentials, or message contents are exposed/logged.
      throw smtpFailure(error);
    } finally { transport.close(); }
  }
}
