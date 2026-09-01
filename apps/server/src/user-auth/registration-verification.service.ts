import { BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { PoolConnection, RowDataPacket } from "mysql2/promise";
import svgCaptcha from "svg-captcha";
import { EnvironmentService } from "../config/environment.service";
import { DatabaseService } from "../database/database.service";
import { RegistrationMailService } from "./registration-mail.service";
import { normalizedEmail } from "./registration-validation";
import { MailDeliveryUnconfirmedException } from "./mail-delivery-unconfirmed.exception";

const MINUTE = 60_000;
const CAPTCHA_TTL = 5 * MINUTE;
const TOKEN_TTL = 2 * MINUTE;
const CODE_TTL = 10 * MINUTE;
const MAX_ATTEMPTS = 5;
const CHARACTERS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
// svg-captcha's runtime exports a renderer accepting explicit text; its typings omit this overload.
const renderCaptcha = svgCaptcha as unknown as (text: string, options: { width: number; height: number; noise: number; background: string; fontSize: number }) => string;

@Injectable()
export class RegistrationVerificationService {
  private readonly logger = new Logger(RegistrationVerificationService.name);
  private nextCleanupAt = 0;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EnvironmentService) private readonly environment: EnvironmentService,
    @Inject(RegistrationMailService) private readonly mail: RegistrationMailService,
  ) {}

  private digest(scope: string, value: string): string {
    return createHmac("sha256", this.environment.values.credentialEncryptionKey).update(`${scope}\0${value}`).digest("hex");
  }

  private matches(scope: string, value: string, stored: unknown): boolean {
    if (typeof stored !== "string" || !/^[a-f0-9]{64}$/.test(stored)) return false;
    return timingSafeEqual(Buffer.from(this.digest(scope, value), "hex"), Buffer.from(stored, "hex"));
  }

  private tooFrequent(seconds: number): never {
    throw new HttpException({ statusCode: 429, message: `请求过于频繁，请在 ${seconds} 秒后重试`, retry_after_seconds: seconds }, 429);
  }

  private async limit(connection: PoolConnection, scope: string, value: string, maximum: number, windowMs: number): Promise<void> {
    const key = this.digest(`rate:${scope}`, value);
    const now = Date.now();
    await connection.execute(
      "INSERT INTO registration_rate_limits (bucket_key, hits, window_ends_at) VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE bucket_key = VALUES(bucket_key)",
      [key, new Date(now + windowMs)],
    );
    const [rows] = await connection.query<RowDataPacket[]>("SELECT hits, window_ends_at FROM registration_rate_limits WHERE bucket_key = ? FOR UPDATE", [key]);
    const row = rows[0]!;
    const end = new Date(row.window_ends_at).getTime();
    if (end > now && Number(row.hits) >= maximum) this.tooFrequent(Math.max(1, Math.ceil((end - now) / 1000)));
    await connection.execute("UPDATE registration_rate_limits SET hits = ?, window_ends_at = ? WHERE bucket_key = ?", [end <= now ? 1 : Number(row.hits) + 1, new Date(end <= now ? now + windowMs : end), key]);
  }

  private async limitIp(scope: string, ip: string, maximum: number, windowMs: number): Promise<void> {
    this.cleanup();
    await this.database.transaction((connection) => this.limit(connection, scope, ip, maximum, windowMs));
  }

  private cleanup(): void {
    if (Date.now() < this.nextCleanupAt) return;
    this.nextCleanupAt = Date.now() + 5 * MINUTE;
    // Bounded, indexed cleanup; never delete live reservations/codes/rate windows.
    void Promise.all([
      this.database.execute("DELETE FROM registration_captchas WHERE expires_at < ? LIMIT 1000", [new Date(Date.now() - 60 * MINUTE)]),
      this.database.execute("DELETE FROM registration_email_codes WHERE next_send_at < ? LIMIT 1000", [new Date(Date.now() - 24 * 60 * MINUTE)]),
      this.database.execute("DELETE FROM registration_rate_limits WHERE window_ends_at < ? LIMIT 1000", [new Date(Date.now() - 60 * MINUTE)]),
    ]).catch(() => this.logger.warn("Registration verification cleanup failed"));
  }

  async emailStatus(rawEmail: string, ip: string) {
    const email = normalizedEmail(rawEmail);
    // Deliberate account discovery for the unified login UI: expose only existence,
    // not profile/status fields, and share a database-backed per-IP rate limit.
    await this.limitIp("email-status", ip, 30, MINUTE);
    const rows = await this.database.query<RowDataPacket[]>("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    return { email, registered: rows.length > 0 };
  }

  async createCaptcha(rawEmail: string, ip: string) {
    const email = normalizedEmail(rawEmail);
    await this.mail.assertConfigured();
    await this.limitIp("captcha", ip, 10, MINUTE);
    const id = randomUUID();
    const answer = Array.from({ length: 5 }, () => CHARACTERS[randomInt(CHARACTERS.length)]).join("");
    const svg = renderCaptcha(answer, { width: 200, height: 64, noise: 4, background: "#f5f3ff", fontSize: 48 });
    const expiresAt = new Date(Date.now() + CAPTCHA_TTL);
    await this.database.execute(
      "INSERT INTO registration_captchas (id, email, ip_hash, answer_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
      [id, email, this.digest("ip", ip), this.digest(`captcha:${id}`, answer), expiresAt],
    );
    return { captcha_id: id, image_data_url: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, expires_in: CAPTCHA_TTL / 1000 };
  }

  async verifyCaptcha(rawEmail: string, id: string, answer: string, ip: string) {
    const email = normalizedEmail(rawEmail);
    await this.limitIp("captcha-verify", ip, 30, MINUTE);
    const token = randomBytes(32).toString("base64url");
    const verified = await this.database.transaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT * FROM registration_captchas WHERE id = ? FOR UPDATE", [id]);
      const row = rows[0];
      if (!row || row.email !== email || !this.matches("ip", ip, row.ip_hash) || row.consumed_at || row.token_hash || !row.answer_hash || Number(row.attempts) >= MAX_ATTEMPTS || new Date(row.expires_at).getTime() <= Date.now()) return false;
      if (!this.matches(`captcha:${id}`, answer.trim().toUpperCase(), row.answer_hash)) {
        await connection.execute("UPDATE registration_captchas SET attempts = attempts + 1 WHERE id = ?", [id]);
        return false; // Commit failed-attempt accounting before returning an error.
      }
      await connection.execute("UPDATE registration_captchas SET answer_hash = NULL, token_hash = ?, expires_at = ? WHERE id = ?", [this.digest("captcha-token", token), new Date(Date.now() + TOKEN_TTL), id]);
      return true;
    });
    if (!verified) throw new BadRequestException("图形验证码错误、已使用或已过期，请刷新后重试");
    return { captcha_token: token, expires_in: TOKEN_TTL / 1000 };
  }

  async sendEmailCode(rawEmail: string, token: string, ip: string) {
    const email = normalizedEmail(rawEmail);
    await this.mail.assertConfigured();
    await this.limitIp("mail-send", ip, 10, 60 * MINUTE);
    const sendId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await this.database.transaction(async (connection) => {
      const [captchas] = await connection.query<RowDataPacket[]>("SELECT * FROM registration_captchas WHERE token_hash = ? FOR UPDATE", [this.digest("captcha-token", token)]);
      const captcha = captchas[0];
      if (!captcha || captcha.email !== email || !this.matches("ip", ip, captcha.ip_hash) || captcha.consumed_at || new Date(captcha.expires_at).getTime() <= Date.now()) throw new BadRequestException("请先完成图形验证码验证");
      const [users] = await connection.query<RowDataPacket[]>("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
      if (users.length) throw new ConflictException("该邮箱已经注册，请直接登录");
      // Shared database counters and row locks enforce limits across API instances.
      await this.limit(connection, "mail-global", "registration", 200, 60 * MINUTE);
      await this.limit(connection, "mail-email", email, 5, 60 * MINUTE);
      await connection.execute("INSERT INTO registration_email_codes (email, next_send_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email)", [email, new Date(0)]);
      const [codes] = await connection.query<RowDataPacket[]>("SELECT next_send_at FROM registration_email_codes WHERE email = ? FOR UPDATE", [email]);
      const remaining = new Date(codes[0]!.next_send_at).getTime() - Date.now();
      if (remaining > 0) this.tooFrequent(Math.ceil(remaining / 1000));
      await connection.execute("UPDATE registration_captchas SET consumed_at = ?, token_hash = NULL WHERE id = ?", [new Date(), captcha.id]);
      await connection.execute("UPDATE registration_email_codes SET send_id = ?, code_hash = NULL, status = 'PENDING', attempts = 0, expires_at = NULL, next_send_at = ? WHERE email = ?", [sendId, new Date(Date.now() + MINUTE), email]);
    });
    try {
      // No network call while holding database locks. Pending codes cannot register.
      await this.mail.sendCode(email, code);
    } catch (error) {
      if (error instanceof MailDeliveryUnconfirmedException) {
        // Receipt of the unpredictable code still proves mailbox ownership even if the HTTP acknowledgment was lost.
        const result = await this.database.execute("UPDATE registration_email_codes SET status = 'UNCERTAIN', code_hash = ?, expires_at = ? WHERE email = ? AND send_id = ? AND status = 'PENDING'", [this.digest(`email-code:${email}:${sendId}`, code), new Date(Date.now() + CODE_TTL), email, sendId]);
        if (!result.affectedRows) throw new ConflictException("验证码状态已变更，请使用最新一次邮件中的验证码或重新发送");
        throw new ServiceUnavailableException({ ...error.getResponse() as Record<string, unknown>, expires_in: CODE_TTL / 1000, retry_after_seconds: MINUTE / 1000 });
      }
      await this.database.execute("UPDATE registration_email_codes SET status = 'FAILED', code_hash = NULL WHERE email = ? AND send_id = ? AND status = 'PENDING'", [email, sendId]);
      throw error;
    }
    const expiresAt = new Date(Date.now() + CODE_TTL);
    const result = await this.database.execute("UPDATE registration_email_codes SET status = 'SENT', code_hash = ?, expires_at = ? WHERE email = ? AND send_id = ? AND status = 'PENDING'", [this.digest(`email-code:${email}:${sendId}`, code), expiresAt, email, sendId]);
    if (!result.affectedRows) throw new ConflictException("验证码状态已变更，请重新发送");
    return { sent: true, expires_in: CODE_TTL / 1000, retry_after_seconds: MINUTE / 1000 };
  }

  async withVerifiedEmail<T>(rawEmail: string, code: string, ip: string, operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const email = normalizedEmail(rawEmail);
    await this.limitIp("register", ip, 30, MINUTE);
    if (!/^\d{6}$/.test(code)) throw new BadRequestException("请输入 6 位邮箱验证码");
    const result = await this.database.transaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT * FROM registration_email_codes WHERE email = ? FOR UPDATE", [email]);
      const row = rows[0];
      if (!row || !["SENT", "UNCERTAIN"].includes(row.status) || !row.expires_at || new Date(row.expires_at).getTime() <= Date.now() || Number(row.attempts) >= MAX_ATTEMPTS) return { ok: false as const };
      if (!this.matches(`email-code:${email}:${row.send_id}`, code, row.code_hash)) {
        await connection.execute("UPDATE registration_email_codes SET attempts = attempts + 1 WHERE email = ?", [email]);
        return { ok: false as const };
      }
      const value = await operation(connection);
      // Account creation and code consumption commit or roll back together.
      await connection.execute("UPDATE registration_email_codes SET status = 'CONSUMED', code_hash = NULL WHERE email = ?", [email]);
      return { ok: true as const, value };
    });
    if (!result.ok) throw new BadRequestException("邮箱验证码错误、已过期或尝试次数过多，请重试或重新发送");
    return result.value;
  }
}
