import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { RowDataPacket } from "mysql2/promise";
import { X509Certificate } from "node:crypto";
import { AuditService } from "../common/audit.service";
import { SecretCryptoService } from "../common/secret-crypto.service";
import { DatabaseService } from "../database/database.service";

const CONFIG_ID = "82000000-0000-0000-0000-000000000001";
const maxCertificateBytes = 512 * 1024;

interface PaymentConfigRow extends RowDataPacket {
  id: string;
  merchant_id: string;
  payment_notify_url: string;
  merchant_key_ciphertext: string | null;
  merchant_key_hint: string;
  certificate_ciphertext: string | null;
  certificate_filename: string | null;
  certificate_uploaded_at: Date | null;
  private_key_ciphertext: string | null;
  private_key_filename: string | null;
  private_key_uploaded_at: Date | null;
  platform_certificate_ciphertext: string | null;
  platform_certificate_filename: string | null;
  platform_certificate_serial: string | null;
  platform_certificate_uploaded_at: Date | null;
  official_account_name: string;
  app_id: string;
  app_secret_ciphertext: string | null;
  app_secret_hint: string;
  open_platform_app_id: string;
  open_platform_app_secret_ciphertext: string | null;
  open_platform_app_secret_hint: string;
  open_platform_redirect_uri: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface WechatPaymentConfigInput {
  merchantId: string;
  paymentNotifyUrl: string;
  merchantKey?: string;
  certificateContent?: string;
  certificateFilename?: string;
  privateKeyContent?: string;
  privateKeyFilename?: string;
  platformCertificateContent?: string;
  platformCertificateFilename?: string;
  officialAccountName: string;
  appId: string;
  appSecret?: string;
  openPlatformAppId: string;
  openPlatformAppSecret?: string;
  openPlatformRedirectUri: string;
  status: string;
}

function safeFilename(value: string | undefined, fallback: string): string {
  const normalized = (value || fallback).split(/[\\/]/).pop()?.trim() || fallback;
  if (normalized.length > 255 || !/^[\w.()\-\u4e00-\u9fff ]+$/.test(normalized)) {
    throw new BadRequestException("证书文件名格式无效");
  }
  return normalized;
}

function validateCertificate(content: string, kind: "certificate" | "private_key"): string {
  const normalized = content.replace(/^\uFEFF/, "").trim();
  const size = Buffer.byteLength(normalized, "utf8");
  if (size < 100 || size > maxCertificateBytes) throw new BadRequestException("证书文件大小必须在 100B～512KB 之间");
  if (kind === "certificate" && (!normalized.includes("-----BEGIN CERTIFICATE-----") || !normalized.includes("-----END CERTIFICATE-----"))) {
    throw new BadRequestException("cert 证书必须是有效的 PEM 证书");
  }
  if (kind === "private_key" && !/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(normalized)) {
    throw new BadRequestException("key 证书必须是有效的 PEM 私钥");
  }
  return `${normalized}\n`;
}

@Injectable()
export class WechatPaymentConfigService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SecretCryptoService) private readonly secretCrypto: SecretCryptoService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async row(): Promise<PaymentConfigRow> {
    const rows = await this.database.query<PaymentConfigRow[]>(
      `SELECT id, merchant_id, merchant_key_ciphertext, merchant_key_hint,
              payment_notify_url,
              certificate_ciphertext, certificate_filename, certificate_uploaded_at,
              private_key_ciphertext, private_key_filename, private_key_uploaded_at,
              platform_certificate_ciphertext, platform_certificate_filename,
              platform_certificate_serial, platform_certificate_uploaded_at,
              official_account_name, app_id, app_secret_ciphertext, app_secret_hint,
              open_platform_app_id, open_platform_app_secret_ciphertext,
              open_platform_app_secret_hint, open_platform_redirect_uri,
              status, created_at, updated_at
       FROM wechat_payment_configs WHERE id = ? LIMIT 1`,
      [CONFIG_ID],
    );
    if (!rows.length) throw new NotFoundException("微信支付配置不存在，请先执行数据库迁移");
    return rows[0]!;
  }

  async get(): Promise<Record<string, unknown>> {
    const row = await this.row();
    return {
      id: row.id,
      merchant_id: row.merchant_id,
      payment_notify_url: row.payment_notify_url,
      merchant_key_configured: Boolean(row.merchant_key_ciphertext),
      merchant_key_hint: row.merchant_key_hint,
      certificate_configured: Boolean(row.certificate_ciphertext),
      certificate_filename: row.certificate_filename,
      certificate_uploaded_at: row.certificate_uploaded_at,
      private_key_configured: Boolean(row.private_key_ciphertext),
      private_key_filename: row.private_key_filename,
      private_key_uploaded_at: row.private_key_uploaded_at,
      platform_certificate_configured: Boolean(row.platform_certificate_ciphertext),
      platform_certificate_filename: row.platform_certificate_filename,
      platform_certificate_serial: row.platform_certificate_serial,
      platform_certificate_uploaded_at: row.platform_certificate_uploaded_at,
      official_account_name: row.official_account_name,
      app_id: row.app_id,
      app_secret_configured: Boolean(row.app_secret_ciphertext),
      app_secret_hint: row.app_secret_hint,
      open_platform_app_id: row.open_platform_app_id,
      open_platform_app_secret_configured: Boolean(row.open_platform_app_secret_ciphertext),
      open_platform_app_secret_hint: row.open_platform_app_secret_hint,
      open_platform_redirect_uri: row.open_platform_redirect_uri,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async update(adminUserId: string, rawInput: WechatPaymentConfigInput): Promise<Record<string, unknown>> {
    const current = await this.row();
    const merchantId = rawInput.merchantId.trim();
    const paymentNotifyUrl = rawInput.paymentNotifyUrl.trim();
    const officialAccountName = rawInput.officialAccountName.trim();
    const appId = rawInput.appId.trim();
    const openPlatformAppId = rawInput.openPlatformAppId.trim();
    const openPlatformRedirectUri = rawInput.openPlatformRedirectUri.trim();
    const status = rawInput.status.toUpperCase();
    if (!/^\d{6,32}$/.test(merchantId)) throw new BadRequestException("商户号必须是 6～32 位数字");
    for (const [value, field] of [[paymentNotifyUrl, "支付回调地址"], [openPlatformRedirectUri, "微信登录回调地址"]] as const) {
      let parsed: URL; try { parsed = new URL(value); } catch { throw new BadRequestException(`${field}格式无效`); }
      if (parsed.protocol !== "https:" || parsed.search) throw new BadRequestException(`${field}必须是无查询参数的 HTTPS URL`);
    }
    if (!officialAccountName || officialAccountName.length > 100) throw new BadRequestException("公众号名称不能为空且不能超过 100 个字符");
    if (!/^wx[A-Za-z0-9]{8,62}$/.test(appId)) throw new BadRequestException("公众号 AppID 格式不正确");
    if (!/^wx[A-Za-z0-9]{8,62}$/.test(openPlatformAppId)) throw new BadRequestException("开放平台网站应用 AppID 格式不正确");
    if (!new Set(["ACTIVE", "DISABLED"]).has(status)) throw new BadRequestException("微信支付配置状态不正确");

    const merchantKey = rawInput.merchantKey?.trim();
    const appSecret = rawInput.appSecret?.trim();
    const openPlatformAppSecret = rawInput.openPlatformAppSecret?.trim();
    if (merchantKey && Buffer.byteLength(merchantKey, "utf8") !== 32) throw new BadRequestException("商户 APIv3 Key 必须是 32 字节");
    if (appSecret && (appSecret.length < 8 || appSecret.length > 128)) throw new BadRequestException("公众号 AppSecret 长度必须是 8～128 个字符");
    if (openPlatformAppSecret && (openPlatformAppSecret.length < 8 || openPlatformAppSecret.length > 128)) throw new BadRequestException("开放平台 AppSecret 长度必须是 8～128 个字符");
    if (!merchantKey && !current.merchant_key_ciphertext) throw new BadRequestException("首次配置必须填写商户 Key");
    if (!appSecret && !current.app_secret_ciphertext) throw new BadRequestException("首次配置必须填写公众号 AppSecret");
    if (!rawInput.certificateContent && !current.certificate_ciphertext) throw new BadRequestException("首次配置必须上传 cert 证书");
    if (!rawInput.privateKeyContent && !current.private_key_ciphertext) throw new BadRequestException("首次配置必须上传 key 证书");
    if (!rawInput.platformCertificateContent && !current.platform_certificate_ciphertext) throw new BadRequestException("首次配置必须上传微信支付平台证书");
    if (!openPlatformAppSecret && !current.open_platform_app_secret_ciphertext) throw new BadRequestException("首次配置必须填写开放平台 AppSecret");

    const fields = ["merchant_id = ?", "payment_notify_url = ?", "official_account_name = ?", "app_id = ?", "open_platform_app_id = ?", "open_platform_redirect_uri = ?", "status = ?"];
    const values: unknown[] = [merchantId, paymentNotifyUrl, officialAccountName, appId, openPlatformAppId, openPlatformRedirectUri, status];
    const updatedSecrets: string[] = [];
    if (merchantKey) {
      fields.push("merchant_key_ciphertext = ?", "merchant_key_hint = ?");
      values.push(this.secretCrypto.encrypt(merchantKey), this.secretCrypto.mask(merchantKey));
      updatedSecrets.push("merchant_key");
    }
    if (appSecret) {
      fields.push("app_secret_ciphertext = ?", "app_secret_hint = ?");
      values.push(this.secretCrypto.encrypt(appSecret), this.secretCrypto.mask(appSecret));
      updatedSecrets.push("app_secret");
    }
    if (openPlatformAppSecret) {
      fields.push("open_platform_app_secret_ciphertext = ?", "open_platform_app_secret_hint = ?");
      values.push(this.secretCrypto.encrypt(openPlatformAppSecret), this.secretCrypto.mask(openPlatformAppSecret));
      updatedSecrets.push("open_platform_app_secret");
    }
    if (rawInput.certificateContent) {
      const certificate = validateCertificate(rawInput.certificateContent, "certificate");
      fields.push("certificate_ciphertext = ?", "certificate_filename = ?", "certificate_uploaded_at = CURRENT_TIMESTAMP(3)");
      values.push(this.secretCrypto.encrypt(certificate), safeFilename(rawInput.certificateFilename, "apiclient_cert.pem"));
      updatedSecrets.push("certificate");
    }
    if (rawInput.privateKeyContent) {
      const privateKey = validateCertificate(rawInput.privateKeyContent, "private_key");
      fields.push("private_key_ciphertext = ?", "private_key_filename = ?", "private_key_uploaded_at = CURRENT_TIMESTAMP(3)");
      values.push(this.secretCrypto.encrypt(privateKey), safeFilename(rawInput.privateKeyFilename, "apiclient_key.pem"));
      updatedSecrets.push("private_key");
    }
    if (rawInput.platformCertificateContent) {
      const platformCertificate = validateCertificate(rawInput.platformCertificateContent, "certificate");
      let serial: string;
      try { serial = new X509Certificate(platformCertificate).serialNumber.replaceAll(":", "").toUpperCase(); }
      catch { throw new BadRequestException("微信支付平台证书无法解析"); }
      fields.push("platform_certificate_ciphertext = ?", "platform_certificate_filename = ?", "platform_certificate_serial = ?", "platform_certificate_uploaded_at = CURRENT_TIMESTAMP(3)");
      values.push(this.secretCrypto.encrypt(platformCertificate), safeFilename(rawInput.platformCertificateFilename, "wechatpay_platform_cert.pem"), serial);
      updatedSecrets.push("platform_certificate");
    }
    values.push(CONFIG_ID);
    await this.database.execute(`UPDATE wechat_payment_configs SET ${fields.join(", ")} WHERE id = ?`, values);
    await this.audit.record({ adminUserId, action: "wechat_payment_config.update", entityType: "wechat_payment_config", entityId: CONFIG_ID, details: { merchantId, appId, openPlatformAppId, status, updatedSecrets } });
    return this.get();
  }
}
