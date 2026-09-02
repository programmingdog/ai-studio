import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createPrivateKey, createPublicKey, createSign, createVerify, X509Certificate } from "node:crypto";
import { RowDataPacket } from "mysql2/promise";
import { AuditService } from "../common/audit.service";
import { SecretCryptoService } from "../common/secret-crypto.service";
import { DatabaseService } from "../database/database.service";

const CONFIG_ID = "82000000-0000-0000-0000-000000000001";
const maxCredentialBytes = 512 * 1024;

interface PaymentConfigRow extends RowDataPacket {
  id: string; merchant_id: string; payment_notify_url: string;
  merchant_key_ciphertext: string | null; merchant_key_hint: string;
  certificate_ciphertext: string | null; certificate_filename: string | null; certificate_uploaded_at: Date | null;
  private_key_ciphertext: string | null; private_key_filename: string | null; private_key_uploaded_at: Date | null;
  platform_certificate_ciphertext: string | null; platform_certificate_filename: string | null;
  platform_certificate_serial: string | null; platform_certificate_uploaded_at: Date | null;
  wechatpay_public_key_ciphertext: string | null; wechatpay_public_key_filename: string | null;
  wechatpay_public_key_id: string; wechatpay_public_key_uploaded_at: Date | null;
  payment_verification_mode: string;
  official_account_name: string; app_id: string; app_secret_ciphertext: string | null; app_secret_hint: string;
  official_account_token_ciphertext: string | null; official_account_token_hint: string;
  official_account_encoding_aes_key_ciphertext: string | null; official_account_encoding_aes_key_hint: string;
  official_account_callback_url: string; status: string; created_at: Date; updated_at: Date;
}

export interface WechatPaymentConfigInput {
  merchantId: string; paymentNotifyUrl: string; merchantKey?: string;
  certificateContent?: string; certificateBase64?: string; certificateFilename?: string;
  privateKeyContent?: string; privateKeyBase64?: string; privateKeyFilename?: string;
  platformCertificateContent?: string; platformCertificateBase64?: string; platformCertificateFilename?: string;
  wechatpayPublicKeyContent?: string; wechatpayPublicKeyBase64?: string; wechatpayPublicKeyFilename?: string; wechatpayPublicKeyId: string;
  paymentVerificationMode: string;
  officialAccountName: string; appId: string; appSecret?: string;
  officialAccountToken?: string; officialAccountEncodingAesKey?: string; officialAccountCallbackUrl: string;
  status: string;
}

function safeFilename(value: string | undefined, fallback: string): string {
  const normalized = (value || fallback).split(/[\\/]/).pop()?.trim() || fallback;
  if (normalized.length > 255 || !/^[\w.()\-\u4e00-\u9fff ]+$/.test(normalized)) throw new BadRequestException("证书文件名格式无效");
  return normalized;
}

function uploadBuffer(base64: string | undefined, text: string | undefined, field: string): Buffer | null {
  if (!base64 && !text) return null;
  let result: Buffer;
  if (base64) {
    const normalized = base64.replace(/\s/g, "");
    if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new BadRequestException(`${field}文件编码无效`);
    result = Buffer.from(normalized, "base64");
  } else result = Buffer.from((text || "").replace(/^\uFEFF/, ""), "utf8");
  if (result.length < 64 || result.length > maxCredentialBytes) throw new BadRequestException(`${field}文件大小必须在 64B～512KB 之间`);
  return result;
}

export function certificatePem(value: Buffer, field: string): { pem: string; serial: string } {
  let certificate: X509Certificate;
  try { certificate = new X509Certificate(value); }
  catch {
    try { certificate = new X509Certificate(value.toString("utf8").replace(/^\uFEFF/, "").trim()); }
    catch { throw new BadRequestException(`${field}必须是有效的 X.509 证书（支持 PEM 或 DER）`); }
  }
  if (certificate.publicKey.asymmetricKeyType !== "rsa") throw new BadRequestException(`${field}必须使用 RSA 公钥`);
  return { pem: `${certificate.toString().trim()}\n`, serial: certificate.serialNumber.replaceAll(":", "").toUpperCase() };
}

function privateKeyPem(value: Buffer): string {
  try {
    const key = createPrivateKey(value);
    if (key.asymmetricKeyType !== "rsa") throw new Error("not rsa");
    return String(key.export({ format: "pem", type: "pkcs8" })).trim() + "\n";
  } catch { throw new BadRequestException("商户 key 必须是未加密的有效 RSA PEM 私钥（apiclient_key.pem）"); }
}

function publicKeyPem(value: Buffer): string {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "rsa") throw new Error("not rsa");
    return String(key.export({ format: "pem", type: "spki" })).trim() + "\n";
  } catch {
    try {
      const certificate = certificatePem(value, "微信支付验签文件").pem;
      return String(createPublicKey(certificate).export({ format: "pem", type: "spki" })).trim() + "\n";
    } catch { throw new BadRequestException("微信支付公钥必须是有效的 RSA PEM 公钥"); }
  }
}

function verifyMerchantKeyPair(certificate: string, privateKey: string): void {
  const payload = Buffer.from("aivs-wechatpay-key-pair-check", "utf8");
  try {
    const signer = createSign("RSA-SHA256"); signer.update(payload); signer.end();
    const signature = signer.sign(privateKey);
    const verifier = createVerify("RSA-SHA256"); verifier.update(payload); verifier.end();
    if (!verifier.verify(certificate, signature)) throw new Error("mismatch");
  } catch { throw new BadRequestException("商户 cert 证书与商户 key 私钥不匹配"); }
}

function httpsUrl(value: string, field: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new BadRequestException(`${field}格式无效`); }
  if (parsed.protocol !== "https:" || parsed.search || parsed.hash) throw new BadRequestException(`${field}必须是无查询参数和片段的 HTTPS URL`);
  return parsed.toString();
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
      `SELECT id, merchant_id, merchant_key_ciphertext, merchant_key_hint, payment_notify_url,
              certificate_ciphertext, certificate_filename, certificate_uploaded_at,
              private_key_ciphertext, private_key_filename, private_key_uploaded_at,
              platform_certificate_ciphertext, platform_certificate_filename, platform_certificate_serial, platform_certificate_uploaded_at,
              wechatpay_public_key_ciphertext, wechatpay_public_key_filename,
              wechatpay_public_key_id, wechatpay_public_key_uploaded_at, payment_verification_mode,
              official_account_name, app_id, app_secret_ciphertext, app_secret_hint,
              official_account_token_ciphertext, official_account_token_hint,
              official_account_encoding_aes_key_ciphertext, official_account_encoding_aes_key_hint,
              official_account_callback_url, status, created_at, updated_at
       FROM wechat_payment_configs WHERE id = ? LIMIT 1`, [CONFIG_ID]);
    if (!rows.length) throw new NotFoundException("微信配置不存在，请先执行数据库迁移");
    return rows[0]!;
  }

  async get(): Promise<Record<string, unknown>> {
    const row = await this.row();
    return {
      id: row.id, merchant_id: row.merchant_id, payment_notify_url: row.payment_notify_url,
      merchant_key_configured: Boolean(row.merchant_key_ciphertext), merchant_key_hint: row.merchant_key_hint,
      certificate_configured: Boolean(row.certificate_ciphertext), certificate_filename: row.certificate_filename, certificate_uploaded_at: row.certificate_uploaded_at,
      private_key_configured: Boolean(row.private_key_ciphertext), private_key_filename: row.private_key_filename, private_key_uploaded_at: row.private_key_uploaded_at,
      platform_certificate_configured: Boolean(row.platform_certificate_ciphertext), platform_certificate_filename: row.platform_certificate_filename,
      platform_certificate_serial: row.platform_certificate_serial, platform_certificate_uploaded_at: row.platform_certificate_uploaded_at,
      wechatpay_public_key_configured: Boolean(row.wechatpay_public_key_ciphertext), wechatpay_public_key_filename: row.wechatpay_public_key_filename,
      wechatpay_public_key_id: row.wechatpay_public_key_id, wechatpay_public_key_uploaded_at: row.wechatpay_public_key_uploaded_at,
      payment_verification_mode: row.payment_verification_mode,
      official_account_name: row.official_account_name, app_id: row.app_id,
      app_secret_configured: Boolean(row.app_secret_ciphertext), app_secret_hint: row.app_secret_hint,
      official_account_token_configured: Boolean(row.official_account_token_ciphertext), official_account_token_hint: row.official_account_token_hint,
      official_account_encoding_aes_key_configured: Boolean(row.official_account_encoding_aes_key_ciphertext), official_account_encoding_aes_key_hint: row.official_account_encoding_aes_key_hint,
      official_account_callback_url: row.official_account_callback_url,
      status: row.status, created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  async update(adminUserId: string, rawInput: WechatPaymentConfigInput): Promise<Record<string, unknown>> {
    const current = await this.row();
    const merchantId = rawInput.merchantId.trim();
    const paymentNotifyUrl = httpsUrl(rawInput.paymentNotifyUrl.trim(), "支付通知地址");
    const officialAccountCallbackUrl = httpsUrl(rawInput.officialAccountCallbackUrl.trim(), "公众号事件回调地址");
    const officialAccountName = rawInput.officialAccountName.trim();
    const appId = rawInput.appId.trim();
    const publicKeyId = rawInput.wechatpayPublicKeyId.trim();
    const paymentVerificationMode = rawInput.paymentVerificationMode.toUpperCase();
    const status = rawInput.status.toUpperCase();
    if (!/^\d{6,32}$/.test(merchantId)) throw new BadRequestException("商户号必须是 6～32 位数字");
    if (!officialAccountName || officialAccountName.length > 100) throw new BadRequestException("公众号名称不能为空且不能超过 100 个字符");
    if (!/^wx[A-Za-z0-9]{8,62}$/.test(appId)) throw new BadRequestException("公众号 AppID 格式不正确");
    if (!new Set(["PLATFORM_CERTIFICATE", "WECHATPAY_PUBLIC_KEY"]).has(paymentVerificationMode)) throw new BadRequestException("微信支付验签方式不正确");
    if (!new Set(["ACTIVE", "DISABLED"]).has(status)) throw new BadRequestException("微信配置状态不正确");

    const merchantKey = rawInput.merchantKey?.trim();
    const appSecret = rawInput.appSecret?.trim();
    const officialAccountToken = rawInput.officialAccountToken?.trim();
    const encodingAesKey = rawInput.officialAccountEncodingAesKey?.trim();
    if (merchantKey && Buffer.byteLength(merchantKey, "utf8") !== 32) throw new BadRequestException("商户 APIv3 Key 必须是 32 字节");
    if (appSecret && (appSecret.length < 8 || appSecret.length > 128)) throw new BadRequestException("公众号 AppSecret 长度必须是 8～128 个字符");
    if (officialAccountToken && !/^[A-Za-z0-9]{3,32}$/.test(officialAccountToken)) throw new BadRequestException("公众号 Token 必须是 3～32 位字母或数字");
    if (encodingAesKey && !/^[A-Za-z0-9+/]{43}$/.test(encodingAesKey)) throw new BadRequestException("公众号 EncodingAESKey 必须是 43 位 Base64 字符");
    if (!merchantKey && !current.merchant_key_ciphertext) throw new BadRequestException("首次配置必须填写商户 APIv3 Key");
    if (!appSecret && !current.app_secret_ciphertext) throw new BadRequestException("首次配置必须填写公众号 AppSecret");
    if (!officialAccountToken && !current.official_account_token_ciphertext) throw new BadRequestException("首次配置必须填写公众号服务器 Token");

    const certificateUpload = uploadBuffer(rawInput.certificateBase64, rawInput.certificateContent, "商户 cert");
    const privateKeyUpload = uploadBuffer(rawInput.privateKeyBase64, rawInput.privateKeyContent, "商户 key");
    const platformCertificateUpload = uploadBuffer(rawInput.platformCertificateBase64, rawInput.platformCertificateContent, "微信支付平台证书");
    const publicKeyUpload = uploadBuffer(rawInput.wechatpayPublicKeyBase64, rawInput.wechatpayPublicKeyContent, "微信支付公钥");
    if (!certificateUpload && !current.certificate_ciphertext) throw new BadRequestException("首次配置必须上传商户 cert 证书");
    if (!privateKeyUpload && !current.private_key_ciphertext) throw new BadRequestException("首次配置必须上传商户 key 私钥");
    if (paymentVerificationMode === "PLATFORM_CERTIFICATE" && !platformCertificateUpload && !current.platform_certificate_ciphertext) throw new BadRequestException("平台证书验签模式必须上传微信支付平台证书");
    if (paymentVerificationMode === "WECHATPAY_PUBLIC_KEY" && !publicKeyUpload && !current.wechatpay_public_key_ciphertext) throw new BadRequestException("微信支付公钥验签模式必须上传微信支付公钥");
    const effectivePublicKeyId = publicKeyId || current.wechatpay_public_key_id;
    if (paymentVerificationMode === "WECHATPAY_PUBLIC_KEY" && !/^PUB_KEY_ID_[A-Za-z0-9]+$/.test(effectivePublicKeyId)) throw new BadRequestException("微信支付公钥 ID 格式不正确，应以 PUB_KEY_ID_ 开头");

    const certificate = certificateUpload ? certificatePem(certificateUpload, "商户 cert 证书").pem : this.secretCrypto.decrypt(current.certificate_ciphertext!);
    const privateKey = privateKeyUpload ? privateKeyPem(privateKeyUpload) : this.secretCrypto.decrypt(current.private_key_ciphertext!);
    verifyMerchantKeyPair(certificate, privateKey);

    const fields = ["merchant_id = ?", "payment_notify_url = ?", "payment_verification_mode = ?", "official_account_name = ?", "app_id = ?", "official_account_callback_url = ?", "status = ?"];
    const values: unknown[] = [merchantId, paymentNotifyUrl, paymentVerificationMode, officialAccountName, appId, officialAccountCallbackUrl, status];
    const updatedSecrets: string[] = [];
    if (merchantKey) { fields.push("merchant_key_ciphertext = ?", "merchant_key_hint = ?"); values.push(this.secretCrypto.encrypt(merchantKey), this.secretCrypto.mask(merchantKey)); updatedSecrets.push("merchant_key"); }
    if (appSecret) { fields.push("app_secret_ciphertext = ?", "app_secret_hint = ?"); values.push(this.secretCrypto.encrypt(appSecret), this.secretCrypto.mask(appSecret)); updatedSecrets.push("app_secret"); }
    if (officialAccountToken) { fields.push("official_account_token_ciphertext = ?", "official_account_token_hint = ?"); values.push(this.secretCrypto.encrypt(officialAccountToken), this.secretCrypto.mask(officialAccountToken)); updatedSecrets.push("official_account_token"); }
    if (encodingAesKey) { fields.push("official_account_encoding_aes_key_ciphertext = ?", "official_account_encoding_aes_key_hint = ?"); values.push(this.secretCrypto.encrypt(encodingAesKey), this.secretCrypto.mask(encodingAesKey)); updatedSecrets.push("official_account_encoding_aes_key"); }
    if (certificateUpload) { fields.push("certificate_ciphertext = ?", "certificate_filename = ?", "certificate_uploaded_at = CURRENT_TIMESTAMP(3)"); values.push(this.secretCrypto.encrypt(certificate), safeFilename(rawInput.certificateFilename, "apiclient_cert.pem")); updatedSecrets.push("certificate"); }
    if (privateKeyUpload) { fields.push("private_key_ciphertext = ?", "private_key_filename = ?", "private_key_uploaded_at = CURRENT_TIMESTAMP(3)"); values.push(this.secretCrypto.encrypt(privateKey), safeFilename(rawInput.privateKeyFilename, "apiclient_key.pem")); updatedSecrets.push("private_key"); }
    if (platformCertificateUpload) {
      const platformCertificate = certificatePem(platformCertificateUpload, "微信支付平台证书");
      fields.push("platform_certificate_ciphertext = ?", "platform_certificate_filename = ?", "platform_certificate_serial = ?", "platform_certificate_uploaded_at = CURRENT_TIMESTAMP(3)");
      values.push(this.secretCrypto.encrypt(platformCertificate.pem), safeFilename(rawInput.platformCertificateFilename, "wechatpay.pem"), platformCertificate.serial);
      updatedSecrets.push("platform_certificate");
    }
    if (publicKeyUpload) { fields.push("wechatpay_public_key_ciphertext = ?", "wechatpay_public_key_filename = ?", "wechatpay_public_key_id = ?", "wechatpay_public_key_uploaded_at = CURRENT_TIMESTAMP(3)"); values.push(this.secretCrypto.encrypt(publicKeyPem(publicKeyUpload)), safeFilename(rawInput.wechatpayPublicKeyFilename, "wechatpay_public_key.pem"), effectivePublicKeyId); updatedSecrets.push("wechatpay_public_key"); }
    else if (current.wechatpay_public_key_ciphertext && effectivePublicKeyId !== current.wechatpay_public_key_id) { fields.push("wechatpay_public_key_id = ?"); values.push(effectivePublicKeyId); }
    values.push(CONFIG_ID);
    await this.database.execute(`UPDATE wechat_payment_configs SET ${fields.join(", ")} WHERE id = ?`, values);
    await this.audit.record({ adminUserId, action: "wechat_config.update", entityType: "wechat_payment_config", entityId: CONFIG_ID, details: { merchantId, appId, paymentVerificationMode, status, updatedSecrets } });
    return this.get();
  }
}
