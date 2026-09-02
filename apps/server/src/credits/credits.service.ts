import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createDecipheriv, createHash, createSign, createVerify, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { RowDataPacket } from "mysql2/promise";
import { SecretCryptoService } from "../common/secret-crypto.service";
import { DatabaseService } from "../database/database.service";
import { ReferralsService } from "../referrals/referrals.service";
import { integer } from "../referrals/referral-rules";

interface PackageRow extends RowDataPacket { id: string; code: string; name: string; description: string; base_credits: number | string; bonus_credits: number | string; price_fen: number | string; currency: string; status: string }
interface WechatRuntimeRow extends RowDataPacket {
  merchant_id: string; payment_notify_url: string; merchant_key_ciphertext: string | null;
  certificate_ciphertext: string | null; private_key_ciphertext: string | null;
  platform_certificate_ciphertext: string | null; platform_certificate_serial: string | null;
  wechatpay_public_key_ciphertext: string | null; wechatpay_public_key_id: string;
  payment_verification_mode: string;
  official_account_name: string; app_id: string; status: string;
}

type WechatRuntime = { merchantId: string; notifyUrl: string; apiV3Key: string; merchantCertificate: string; merchantPrivateKey: string; verifierKey: string; verifierId: string; appId: string };

function orderNumber(): string { return `AV${Date.now()}${randomBytes(5).toString("hex")}`.slice(0, 32); }
function transactionNumber(prefix: string): string { return `${prefix}${Date.now()}${randomBytes(5).toString("hex")}`; }
function responseJson(text: string): Record<string, unknown> { try { return JSON.parse(text) as Record<string, unknown>; } catch { return { raw: text }; } }

@Injectable()
export class CreditsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SecretCryptoService) private readonly secretCrypto: SecretCryptoService,
    @Inject(ReferralsService) private readonly referrals: ReferralsService,
  ) {}

  async packages(): Promise<Record<string, unknown>[]> {
    const rows = await this.database.query<PackageRow[]>(
      `SELECT id, code, name, description, base_credits, bonus_credits, price_fen, currency, status, sort_order
       FROM credit_packages WHERE status = 'ACTIVE' ORDER BY sort_order, created_at`,
    );
    return rows.map((row) => ({ ...row, base_credits: Number(row.base_credits), bonus_credits: Number(row.bonus_credits), total_credits: Number(row.base_credits) + Number(row.bonus_credits), price_fen: Number(row.price_fen) }));
  }

  async balance(userId: string): Promise<Record<string, number>> {
    const balanceRows = await this.database.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(le.amount), 0) AS balance FROM ledger_accounts la
       LEFT JOIN ledger_entries le ON le.account_id = la.id
       WHERE la.owner_type = 'USER' AND la.owner_id = ? AND la.account_type = 'AVAILABLE' AND la.currency = 'CREDIT'`,
      [userId],
    );
    const holdRows = await this.database.query<RowDataPacket[]>("SELECT COALESCE(SUM(amount), 0) AS held FROM credit_holds WHERE user_id = ? AND status = 'ACTIVE'", [userId]);
    const balance = Number(balanceRows[0]?.balance || 0); const held = Number(holdRows[0]?.held || 0);
    return { balance, held, available: balance - held };
  }

  async purchases(userId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.database.query<RowDataPacket[]>(
      `SELECT cpp.id, cpp.purchase_no, cpp.package_id, cpp.package_code_snapshot,
              cpp.package_name_snapshot, cpp.base_credits_snapshot, cpp.bonus_credits_snapshot,
              cpp.credits_granted, cpp.paid_amount_fen, cpp.currency, cpp.status,
              cpp.purchased_at, cpp.created_at, po.out_trade_no, po.code_url, po.expires_at, po.paid_at
       FROM credit_package_purchases cpp
       LEFT JOIN payment_orders po ON po.id = cpp.payment_order_id
       WHERE cpp.user_id = ? ORDER BY cpp.created_at DESC LIMIT 100`,
      [userId],
    );
    return rows.map((row) => ({
      ...row,
      base_credits_snapshot: Number(row.base_credits_snapshot),
      bonus_credits_snapshot: Number(row.bonus_credits_snapshot),
      credits_granted: Number(row.credits_granted),
      paid_amount_fen: Number(row.paid_amount_fen),
    }));
  }

  async consumptions(userId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.database.query<RowDataPacket[]>(
      `SELECT ccr.id, ccr.consumption_no, ccr.task_id, ccr.provider_model_id,
              pm.model_alias, pm.model_code, ccr.category, ccr.credits_consumed,
              ccr.status, ccr.description, ccr.occurred_at, ccr.created_at
       FROM credit_consumption_records ccr
       LEFT JOIN provider_models pm ON pm.id = ccr.provider_model_id
       WHERE ccr.user_id = ? ORDER BY ccr.occurred_at DESC LIMIT 100`,
      [userId],
    );
    return rows.map((row) => ({ ...row, credits_consumed: Number(row.credits_consumed) }));
  }

  private async wechatRuntime(requireActive = true): Promise<WechatRuntime> {
    const rows = await this.database.query<WechatRuntimeRow[]>(
      `SELECT merchant_id, payment_notify_url, merchant_key_ciphertext, certificate_ciphertext,
              private_key_ciphertext, platform_certificate_ciphertext, platform_certificate_serial,
              wechatpay_public_key_ciphertext, wechatpay_public_key_id, payment_verification_mode, official_account_name, app_id, status
       FROM wechat_payment_configs LIMIT 1`,
    );
    const row = rows[0];
    const usePublicKey = row?.payment_verification_mode === "WECHATPAY_PUBLIC_KEY";
    const verifierConfigured = usePublicKey ? Boolean(row?.wechatpay_public_key_ciphertext) : Boolean(row?.platform_certificate_ciphertext);
    if (!row || (requireActive && row.status !== "ACTIVE") || !row.merchant_id || !row.payment_notify_url || !row.merchant_key_ciphertext || !row.certificate_ciphertext || !row.private_key_ciphertext || !verifierConfigured || !row.app_id) {
      throw new ServiceUnavailableException("微信 Native 支付尚未完整配置");
    }
    const apiV3Key = this.secretCrypto.decrypt(row.merchant_key_ciphertext);
    if (Buffer.byteLength(apiV3Key, "utf8") !== 32) throw new ServiceUnavailableException("微信支付 APIv3 密钥必须是 32 字节");
    return {
      merchantId: row.merchant_id, notifyUrl: row.payment_notify_url, apiV3Key,
      merchantCertificate: this.secretCrypto.decrypt(row.certificate_ciphertext),
      merchantPrivateKey: this.secretCrypto.decrypt(row.private_key_ciphertext),
      verifierKey: this.secretCrypto.decrypt(usePublicKey ? row.wechatpay_public_key_ciphertext! : row.platform_certificate_ciphertext!),
      verifierId: usePublicKey ? row.wechatpay_public_key_id : String(row.platform_certificate_serial || "").replaceAll(":", "").toUpperCase(),
      appId: row.app_id,
    };
  }

  private authorization(config: WechatRuntime, method: string, path: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const signer = createSign("RSA-SHA256"); signer.update(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`); signer.end();
    const signature = signer.sign(config.merchantPrivateKey, "base64");
    const serial = new X509Certificate(config.merchantCertificate).serialNumber.replaceAll(":", "").toUpperCase();
    return `WECHATPAY2-SHA256-RSA2048 mchid="${config.merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${serial}",signature="${signature}"`;
  }

  private verifyWechatSignature(config: WechatRuntime, timestamp: string | null, nonce: string | null, signature: string | null, serial: string | null, body: string): void {
    if (!timestamp || !nonce || !signature || !serial) throw new UnauthorizedException("微信支付签名请求头不完整");
    if (!config.verifierId || serial.toUpperCase() !== config.verifierId.toUpperCase()) throw new UnauthorizedException("微信支付验签公钥 ID 或平台证书序列号不匹配");
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new UnauthorizedException("微信支付签名时间戳已过期");
    const verifier = createVerify("RSA-SHA256"); verifier.update(`${timestamp}\n${nonce}\n${body}\n`); verifier.end();
    if (!verifier.verify(config.verifierKey, signature, "base64")) throw new UnauthorizedException("微信支付签名验证失败");
  }

  private decryptNotification(config: WechatRuntime, resource: Record<string, unknown>): Record<string, unknown> {
    if (resource.algorithm !== "AEAD_AES_256_GCM") throw new BadRequestException("不支持的微信支付回调加密算法");
    const encrypted = Buffer.from(String(resource.ciphertext || ""), "base64");
    if (encrypted.length <= 16) throw new BadRequestException("微信支付回调密文无效");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(config.apiV3Key, "utf8"), Buffer.from(String(resource.nonce || ""), "utf8"));
    decipher.setAAD(Buffer.from(String(resource.associated_data || ""), "utf8"));
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(0, encrypted.length - 16)), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as Record<string, unknown>;
  }

  private async purchaseByIdempotencyKey(userId: string, idempotencyKey: string, packageId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.database.query<RowDataPacket[]>(
      `SELECT cpp.id, cpp.purchase_no, cpp.package_id, cpp.package_name_snapshot, cpp.credits_granted,
              cpp.paid_amount_fen, cpp.currency, cpp.status, cpp.purchased_at,
              po.id AS payment_order_id, po.out_trade_no, po.code_url, po.expires_at, po.paid_at
       FROM payment_orders po INNER JOIN credit_package_purchases cpp ON cpp.payment_order_id = po.id
       WHERE po.user_id = ? AND po.client_idempotency_key = ? LIMIT 1`,
      [userId, idempotencyKey],
    );
    if (!rows.length) return null;
    const row = rows[0]!;
    if (row.package_id !== packageId) throw new ConflictException("相同幂等键对应了不同积分套餐");
    return { ...row, credits_granted: Number(row.credits_granted), paid_amount_fen: Number(row.paid_amount_fen), idempotent_replay: true };
  }

  async createPurchase(userId: string, packageId: string, idempotencyKey: string): Promise<Record<string, unknown>> {
    const replay = await this.purchaseByIdempotencyKey(userId, idempotencyKey, packageId);
    if (replay) return replay;
    const packageRows = await this.database.query<PackageRow[]>("SELECT id, code, name, description, base_credits, bonus_credits, price_fen, currency, status FROM credit_packages WHERE id = ? AND status = 'ACTIVE' LIMIT 1", [packageId]);
    const creditPackage = packageRows[0];
    if (!creditPackage) throw new NotFoundException("积分套餐不存在或已停用");
    const config = await this.wechatRuntime();
    const paymentId = randomUUID(); const purchaseId = randomUUID(); const outTradeNo = orderNumber();
    const baseCredits = Number(creditPackage.base_credits); const bonusCredits = Number(creditPackage.bonus_credits);
    const credits = baseCredits + bonusCredits; const amountFen = Number(creditPackage.price_fen);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    try {
      await this.database.transaction(async (connection) => {
        await connection.execute(
        `INSERT INTO payment_orders
          (id, user_id, credit_package_id, client_idempotency_key, out_trade_no, description, amount_fen, credits_to_grant,
           currency, payment_channel, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'WECHAT_NATIVE', 'CREATED', ?)`,
          [paymentId, userId, creditPackage.id, idempotencyKey, outTradeNo, `${creditPackage.name} - ${credits}积分`, amountFen, credits, creditPackage.currency, expiresAt],
        );
        await connection.execute(
        `INSERT INTO credit_package_purchases
          (id, purchase_no, user_id, package_id, package_code_snapshot, package_name_snapshot,
           base_credits_snapshot, bonus_credits_snapshot, credits_granted, paid_amount_fen,
           currency, payment_order_id, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', '')`,
        [purchaseId, transactionNumber("CP"), userId, creditPackage.id, creditPackage.code, creditPackage.name,
         baseCredits, bonusCredits, credits, amountFen, creditPackage.currency, paymentId],
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
        const concurrent = await this.purchaseByIdempotencyKey(userId, idempotencyKey, packageId);
        if (concurrent) return concurrent;
      }
      throw error;
    }
    const path = "/v3/pay/transactions/native";
    const requestBody = JSON.stringify({ appid: config.appId, mchid: config.merchantId, description: `${creditPackage.name} - ${credits}积分`, out_trade_no: outTradeNo, time_expire: expiresAt.toISOString(), attach: purchaseId, notify_url: config.notifyUrl, amount: { total: amountFen, currency: creditPackage.currency } });
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: this.authorization(config, "POST", path, requestBody),
      };
      if (config.verifierId.startsWith("PUB_KEY_ID_")) headers["Wechatpay-Serial"] = config.verifierId;
      const response = await fetch(`https://api.mch.weixin.qq.com${path}`, { method: "POST", headers, body: requestBody });
      const raw = await response.text();
      const result = responseJson(raw);
      if (!response.ok || typeof result.code_url !== "string") throw new ServiceUnavailableException(`微信支付下单失败：${String(result.message || result.code || response.status)}`);
      this.verifyWechatSignature(config, response.headers.get("wechatpay-timestamp"), response.headers.get("wechatpay-nonce"), response.headers.get("wechatpay-signature"), response.headers.get("wechatpay-serial"), raw);
      await this.database.execute("UPDATE payment_orders SET code_url = ? WHERE id = ?", [result.code_url, paymentId]);
      return { id: purchaseId, payment_order_id: paymentId, out_trade_no: outTradeNo, package_id: packageId, credits, amount_fen: amountFen, currency: creditPackage.currency, status: "CREATED", code_url: result.code_url, expires_at: expiresAt };
    } catch (error) {
      await this.database.transaction(async (connection) => {
        await connection.execute("UPDATE payment_orders SET status = 'FAILED' WHERE id = ? AND status = 'CREATED'", [paymentId]);
        await connection.execute("UPDATE credit_package_purchases SET status = 'CANCELED', notes = '微信支付下单失败' WHERE id = ? AND status = 'CREATED'", [purchaseId]);
      });
      throw error;
    }
  }

  async purchase(userId: string, purchaseId: string): Promise<Record<string, unknown>> {
    const rows = await this.database.query<RowDataPacket[]>(
      `SELECT cpp.id, cpp.purchase_no, cpp.package_name_snapshot, cpp.credits_granted,
              cpp.paid_amount_fen, cpp.currency, cpp.status, cpp.purchased_at,
              po.id AS payment_order_id, po.out_trade_no, po.code_url, po.expires_at, po.paid_at
       FROM credit_package_purchases cpp INNER JOIN payment_orders po ON po.id = cpp.payment_order_id
       WHERE cpp.id = ? AND cpp.user_id = ? LIMIT 1`,
      [purchaseId, userId],
    );
    if (!rows.length) throw new NotFoundException("积分购买记录不存在");
    const row = rows[0]!;
    return { ...row, credits_granted: Number(row.credits_granted), paid_amount_fen: Number(row.paid_amount_fen) };
  }

  async handleWechatNotification(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<{ code: "SUCCESS"; message: "成功" }> {
    const config = await this.wechatRuntime(false);
    const header = (name: string) => { const value = headers[name]; return Array.isArray(value) ? value[0] || null : value || null; };
    this.verifyWechatSignature(config, header("wechatpay-timestamp"), header("wechatpay-nonce"), header("wechatpay-signature"), header("wechatpay-serial"), rawBody);
    const envelope = JSON.parse(rawBody) as Record<string, unknown>;
    const notificationId = String(envelope.id || "");
    if (!notificationId) throw new BadRequestException("微信支付通知 ID 缺失");
    const transaction = this.decryptNotification(config, (envelope.resource || {}) as Record<string, unknown>);
    if (transaction.trade_state !== "SUCCESS") return { code: "SUCCESS", message: "成功" };
    const outTradeNo = String(transaction.out_trade_no || "");
    const amount = (transaction.amount || {}) as Record<string, unknown>;
    await this.database.transaction(async (connection) => {
      const [notificationRows] = await connection.query<RowDataPacket[]>("SELECT id FROM payment_notifications WHERE notification_id = ? LIMIT 1 FOR UPDATE", [notificationId]);
      if (notificationRows.length) return;
      const [orderRows] = await connection.query<RowDataPacket[]>("SELECT * FROM payment_orders WHERE out_trade_no = ? LIMIT 1 FOR UPDATE", [outTradeNo]);
      const order = orderRows[0];
      if (!order) throw new NotFoundException("微信支付订单不存在");
      if (String(transaction.mchid) !== config.merchantId || String(transaction.appid) !== config.appId) throw new ConflictException("微信支付商户或 AppID 不匹配");
      if (Number(amount.total) !== Number(order.amount_fen) || String(amount.currency || "CNY") !== String(order.currency)) throw new ConflictException("微信支付回调金额或币种不匹配");
      const paidFen = integer(amount.payer_total, "微信实付金额", 0, Number(order.amount_fen));
      if (amount.payer_currency !== "CNY") throw new ConflictException("分润仅支持人民币实付金额");
      await connection.execute(
        `INSERT INTO payment_notifications
          (id, notification_id, payment_order_id, body_sha256, signature_valid, processing_status, processed_at)
         VALUES (?, ?, ?, ?, 1, 'PROCESSED', CURRENT_TIMESTAMP(3))`,
        [randomUUID(), notificationId, order.id, createHash("sha256").update(rawBody).digest("hex")],
      );
      if (order.status === "PAID") return;
      const [purchaseRows] = await connection.query<RowDataPacket[]>("SELECT id, user_id, credits_granted FROM credit_package_purchases WHERE payment_order_id = ? LIMIT 1 FOR UPDATE", [order.id]);
      const purchase = purchaseRows[0];
      if (!purchase) throw new NotFoundException("微信支付订单缺少积分购买记录");
      const [accountRows] = await connection.query<RowDataPacket[]>("SELECT id FROM ledger_accounts WHERE owner_type = 'USER' AND owner_id = ? AND account_type = 'AVAILABLE' AND currency = 'CREDIT' LIMIT 1 FOR UPDATE", [purchase.user_id]);
      const account = accountRows[0];
      if (!account) throw new NotFoundException("用户积分账户不存在");
      const ledgerTransactionId = randomUUID();
      await connection.execute("INSERT INTO ledger_transactions (id, transaction_type, reference_type, reference_id, metadata_json) VALUES (?, 'CREDIT_PURCHASE', 'credit_package_purchase', ?, ?)", [ledgerTransactionId, purchase.id, JSON.stringify({ out_trade_no: outTradeNo, wechat_transaction_id: transaction.transaction_id })]);
      await connection.execute("INSERT INTO ledger_entries (id, transaction_id, account_id, amount) VALUES (?, ?, ?, ?)", [randomUUID(), ledgerTransactionId, account.id, Number(purchase.credits_granted)]);
      await connection.execute("UPDATE payment_orders SET wechat_transaction_id = ?, status = 'PAID', paid_at = ?, payer_paid_amount_fen = ? WHERE id = ?", [String(transaction.transaction_id || ""), transaction.success_time ? new Date(String(transaction.success_time)) : new Date(), paidFen, order.id]);
      await connection.execute("UPDATE credit_package_purchases SET status = 'PAID', purchased_at = COALESCE(purchased_at, CURRENT_TIMESTAMP(3)), paid_amount_fen = ? WHERE id = ?", [paidFen, purchase.id]);
      await this.referrals.settlePayment(connection, String(order.id), String(purchase.user_id), paidFen);
    });
    return { code: "SUCCESS", message: "成功" };
  }
}
