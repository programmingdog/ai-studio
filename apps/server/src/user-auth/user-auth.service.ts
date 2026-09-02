import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { compare, hash } from "bcryptjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt, { SignOptions } from "jsonwebtoken";
import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { SecretCryptoService } from "../common/secret-crypto.service";
import { EnvironmentService } from "../config/environment.service";
import { DatabaseService } from "../database/database.service";
import { UserPrincipal } from "./user-auth.types";
import { RegistrationVerificationService } from "./registration-verification.service";
import { normalizedEmail, validatePassword } from "./registration-validation";
import { ReferralsService } from "../referrals/referrals.service";
import { decryptWechatMessage, verifyWechatMessageSignature, xmlValue } from "./wechat-official-account";

interface UserRow extends RowDataPacket {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  display_name: string;
  avatar_url: string | null;
  bio: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface WechatConfigRow extends RowDataPacket {
  app_id: string;
  app_secret_ciphertext: string | null;
  official_account_token_ciphertext: string | null;
  official_account_encoding_aes_key_ciphertext: string | null;
  status: string;
}

interface WechatAccessTokenResponse { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
interface WechatQrTicketResponse { ticket?: string; expire_seconds?: number; url?: string; errcode?: number; errmsg?: string }
interface WechatUserResponse { subscribe?: number; openid?: string; unionid?: string; nickname?: string; headimgurl?: string; errcode?: number; errmsg?: string }

const phonePattern = /^\+?[1-9]\d{7,14}$/;

function tokenHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function normalizedPhone(value: string): string {
  const result = value.trim().replace(/[\s-]/g, "");
  if (!phonePattern.test(result) || result.length > 32) throw new BadRequestException("手机号格式不正确");
  return result;
}
function safeDisplayName(value: string | undefined, fallback: string): string {
  const result = value?.trim() || fallback;
  if (!result || result.length > 100) throw new BadRequestException("昵称不能为空且不能超过 100 个字符");
  return result;
}
function duplicateError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === "ER_DUP_ENTRY") throw new ConflictException("邮箱或手机号已经注册");
  throw error;
}

@Injectable()
export class UserAuthService {
  private wechatAccessTokenCache: { credentialHash: string; value: string; expiresAt: number } | null = null;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EnvironmentService) private readonly environment: EnvironmentService,
    @Inject(SecretCryptoService) private readonly secretCrypto: SecretCryptoService,
    @Inject(RegistrationVerificationService) private readonly registration: RegistrationVerificationService,
    @Inject(ReferralsService) private readonly referrals: ReferralsService,
  ) {}

  private accessToken(userId: string, sessionId: string): string {
    const principal: UserPrincipal = { sub: userId, type: "user", sessionId };
    const options: SignOptions = { expiresIn: "2h", issuer: "ai-video-studio", audience: "client" };
    return jwt.sign(principal, this.environment.values.jwtSecret, options);
  }

  private async issueTokens(userId: string, deviceName = "", connection?: PoolConnection): Promise<Record<string, unknown>> {
    const sessionId = randomUUID();
    const refreshToken = randomBytes(48).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const sql =
      `INSERT INTO user_refresh_tokens (id, user_id, token_hash, device_name, expires_at)
       VALUES (?, ?, ?, ?, ?)`;
    const parameters = [sessionId, userId, tokenHash(refreshToken), deviceName.slice(0, 100), expiresAt];
    if (connection) await connection.execute(sql, parameters);
    else await this.database.execute(sql, parameters);
    return { access_token: this.accessToken(userId, sessionId), refresh_token: refreshToken, token_type: "Bearer", expires_in: 7200 };
  }

  private async createUser(input: { email?: string; phone?: string; password: string; displayName?: string; emailCode?: string; ip?: string; inviteCode?: string }): Promise<Record<string, unknown>> {
    const email = input.email ? normalizedEmail(input.email) : null;
    const phone = input.phone ? normalizedPhone(input.phone) : null;
    const password = validatePassword(input.password);
    const fallback = email?.split("@")[0] || (phone ? `用户${phone.slice(-4)}` : "新用户");
    const userId = randomUUID();
    const displayName = safeDisplayName(input.displayName, fallback);
    try {
      const insertUser = async (connection: PoolConnection) => {
        await connection.execute(
          `INSERT INTO users (id, email, phone, password_hash, display_name)
           VALUES (?, ?, ?, ?, ?)`,
          [userId, email, phone, await hash(password, 12), displayName],
        );
        await connection.execute(
          `INSERT INTO ledger_accounts (id, owner_type, owner_id, account_type, currency)
           VALUES (?, 'USER', ?, 'AVAILABLE', 'CREDIT')`,
          [randomUUID(), userId],
        );
        await this.referrals.newUser(connection, userId, input.inviteCode);
      };
      if (email) await this.registration.withVerifiedEmail(email, input.emailCode || "", input.ip || "unknown", insertUser);
      else await this.database.transaction(insertUser);
    } catch (error) { duplicateError(error); }
    return { ...(await this.issueTokens(userId)), user: await this.profile(userId) };
  }

  registerEmail(email: string, password: string, emailCode: string, displayName?: string, ip = "unknown", inviteCode?: string) { return this.createUser({ email, password, emailCode, displayName, ip, inviteCode }); }
  registerPhone(phone: string, password: string, displayName?: string) { return this.createUser({ phone, password, displayName }); }

  async login(identifier: string, password: string, deviceName = ""): Promise<Record<string, unknown>> {
    const normalized = identifier.trim();
    const rows = await this.database.query<UserRow[]>(
      `SELECT id, email, phone, password_hash, display_name, avatar_url, bio, status, created_at, updated_at
       FROM users WHERE email = ? OR phone = ? LIMIT 1`,
      [normalized.toLowerCase(), normalized.replace(/[\s-]/g, "")],
    );
    const user = rows[0];
    if (!user || user.status !== "ACTIVE" || !user.password_hash || !(await compare(password, user.password_hash))) {
      throw new UnauthorizedException("账号或密码错误");
    }
    await this.database.execute("UPDATE users SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [user.id]);
    return { ...(await this.issueTokens(user.id, deviceName)), user: await this.profile(user.id) };
  }

  async refresh(refreshToken: string, deviceName = ""): Promise<Record<string, unknown>> {
    const rotated = await this.database.transaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT id, user_id FROM user_refresh_tokens
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3) LIMIT 1 FOR UPDATE`,
        [tokenHash(refreshToken)],
      );
      const session = rows[0];
      if (!session) throw new UnauthorizedException("刷新令牌无效或已过期");
      await connection.execute("UPDATE user_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP(3), last_used_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [session.id]);
      return { userId: String(session.user_id), tokens: await this.issueTokens(String(session.user_id), deviceName, connection) };
    });
    return { ...rotated.tokens, user: await this.profile(rotated.userId) };
  }

  async logout(principal: UserPrincipal): Promise<{ logged_out: true }> {
    await this.database.execute("UPDATE user_refresh_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(3)) WHERE id = ? AND user_id = ?", [principal.sessionId, principal.sub]);
    return { logged_out: true };
  }

  verify(token: string): UserPrincipal {
    try {
      const payload = jwt.verify(token, this.environment.values.jwtSecret, { issuer: "ai-video-studio", audience: "client" });
      if (typeof payload === "string" || payload.type !== "user" || typeof payload.sub !== "string" || typeof payload.sessionId !== "string") throw new Error("invalid token");
      return payload as unknown as UserPrincipal;
    } catch { throw new UnauthorizedException("登录已失效，请重新登录"); }
  }

  async authenticate(token: string): Promise<UserPrincipal> {
    const principal = this.verify(token);
    const rows = await this.database.query<RowDataPacket[]>(
      `SELECT rt.id FROM user_refresh_tokens rt INNER JOIN users u ON u.id = rt.user_id
       WHERE rt.id = ? AND rt.user_id = ? AND rt.revoked_at IS NULL
         AND rt.expires_at > CURRENT_TIMESTAMP(3) AND u.status = 'ACTIVE' LIMIT 1`,
      [principal.sessionId, principal.sub],
    );
    if (!rows.length) throw new UnauthorizedException("登录会话已失效，请重新登录");
    return principal;
  }

  async profile(userId: string): Promise<Record<string, unknown>> {
    const rows = await this.database.query<UserRow[]>(
      `SELECT id, email, phone, display_name, avatar_url, bio, status, pid, invite_code, balance_fen, created_at, updated_at
       FROM users WHERE id = ? LIMIT 1`,
      [userId],
    );
    const user = rows[0];
    if (!user || user.status !== "ACTIVE") throw new UnauthorizedException("用户不存在或已停用");
    const balanceRows = await this.database.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(le.amount), 0) AS balance
       FROM ledger_accounts la LEFT JOIN ledger_entries le ON le.account_id = la.id
       WHERE la.owner_type = 'USER' AND la.owner_id = ? AND la.account_type = 'AVAILABLE' AND la.currency = 'CREDIT'`,
      [userId],
    );
    const holdRows = await this.database.query<RowDataPacket[]>("SELECT COALESCE(SUM(amount), 0) AS held FROM credit_holds WHERE user_id = ? AND status = 'ACTIVE'", [userId]);
    const balance = Number(balanceRows[0]?.balance || 0);
    const held = Number(holdRows[0]?.held || 0);
    const inviteCode = user.invite_code || await this.referrals.ensureInviteCode(userId);
    return { ...user, invite_code: inviteCode, balance_fen: Number(user.balance_fen || 0), credit_balance: balance, held_credits: held, available_credits: balance - held };
  }

  async updateProfile(userId: string, input: { displayName?: string; avatarUrl?: string | null; bio?: string; email?: string; phone?: string; currentPassword?: string; newPassword?: string }): Promise<Record<string, unknown>> {
    const rows = await this.database.query<UserRow[]>(
      `SELECT id, email, phone, password_hash, display_name, avatar_url, bio, status, created_at, updated_at FROM users WHERE id = ? LIMIT 1`,
      [userId],
    );
    const current = rows[0];
    if (!current) throw new UnauthorizedException("用户不存在");
    const email = input.email === undefined ? current.email : input.email ? normalizedEmail(input.email) : null;
    const phone = input.phone === undefined ? current.phone : input.phone ? normalizedPhone(input.phone) : null;
    const credentialsChanged = email !== current.email || phone !== current.phone || input.newPassword !== undefined;
    if (credentialsChanged && current.password_hash && (!input.currentPassword || !(await compare(input.currentPassword, current.password_hash)))) {
      throw new UnauthorizedException("修改登录信息需要验证当前密码");
    }
    let avatarUrl = input.avatarUrl === undefined ? current.avatar_url : input.avatarUrl?.trim() || null;
    if (avatarUrl) {
      let parsed: URL;
      try { parsed = new URL(avatarUrl); } catch { throw new BadRequestException("头像地址格式无效"); }
      if (parsed.protocol !== "https:") throw new BadRequestException("头像地址必须使用 HTTPS");
      if (avatarUrl.length > 1000) throw new BadRequestException("头像地址过长");
    }
    const passwordHash = input.newPassword ? await hash(validatePassword(input.newPassword), 12) : current.password_hash;
    try {
      await this.database.execute(
        `UPDATE users SET email = ?, phone = ?, password_hash = ?, display_name = ?, avatar_url = ?, bio = ? WHERE id = ?`,
        [email, phone, passwordHash, input.displayName === undefined ? current.display_name : safeDisplayName(input.displayName, current.display_name), avatarUrl,
         input.bio === undefined ? current.bio : input.bio.trim().slice(0, 500), userId],
      );
    } catch (error) { duplicateError(error); }
    return this.profile(userId);
  }

  private async wechatConfig(): Promise<{ appId: string; appSecret: string; token: string; encodingAesKey: string | null }> {
    const rows = await this.database.query<WechatConfigRow[]>(
      `SELECT app_id, app_secret_ciphertext, official_account_token_ciphertext,
              official_account_encoding_aes_key_ciphertext, status
       FROM wechat_payment_configs LIMIT 1`,
    );
    const row = rows[0];
    if (!row || row.status !== "ACTIVE" || !row.app_id || !row.app_secret_ciphertext || !row.official_account_token_ciphertext) {
      throw new ServiceUnavailableException("微信公众号扫码登录尚未完整配置");
    }
    return {
      appId: row.app_id,
      appSecret: this.secretCrypto.decrypt(row.app_secret_ciphertext),
      token: this.secretCrypto.decrypt(row.official_account_token_ciphertext),
      encodingAesKey: row.official_account_encoding_aes_key_ciphertext ? this.secretCrypto.decrypt(row.official_account_encoding_aes_key_ciphertext) : null,
    };
  }

  private async wechatAccessToken(config: { appId: string; appSecret: string }): Promise<string> {
    const credentialHash = tokenHash(`${config.appId}\0${config.appSecret}`);
    if (this.wechatAccessTokenCache?.credentialHash === credentialHash && this.wechatAccessTokenCache.expiresAt > Date.now()) return this.wechatAccessTokenCache.value;
    const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
    url.searchParams.set("grant_type", "client_credential"); url.searchParams.set("appid", config.appId); url.searchParams.set("secret", config.appSecret);
    const result = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then((response) => response.json() as Promise<WechatAccessTokenResponse>);
    if (!result.access_token) throw new ServiceUnavailableException(`获取公众号 access_token 失败：${result.errmsg || result.errcode || "未知错误"}`);
    this.wechatAccessTokenCache = { credentialHash, value: result.access_token, expiresAt: Date.now() + Math.max(60, Number(result.expires_in || 7200) - 300) * 1000 };
    return result.access_token;
  }

  async createWechatQrSession(inviteCode?: string): Promise<Record<string, unknown>> {
    const config = await this.wechatConfig();
    const inviterId = inviteCode ? await this.referrals.inviter(inviteCode) : null;
    const state = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const accessToken = await this.wechatAccessToken(config);
    const qrUrl = new URL("https://api.weixin.qq.com/cgi-bin/qrcode/create");
    qrUrl.searchParams.set("access_token", accessToken);
    const qrResponse = await fetch(qrUrl, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ expire_seconds: 300, action_name: "QR_STR_SCENE", action_info: { scene: { scene_str: state } } }),
    }).then((response) => response.json() as Promise<WechatQrTicketResponse>);
    if (!qrResponse.ticket || !qrResponse.url) throw new ServiceUnavailableException(`生成公众号带参二维码失败：${qrResponse.errmsg || qrResponse.errcode || "未知错误"}`);
    await this.database.execute(
      "INSERT INTO wechat_auth_sessions (id, state_hash, expires_at, inviter_id) VALUES (?, ?, ?, ?)",
      [randomUUID(), tokenHash(state), expiresAt, inviterId],
    );
    return { state, login_url: qrResponse.url, expires_at: expiresAt, requires_follow: true };
  }

  async verifyOfficialAccountServer(signature: string, timestamp: string, nonce: string, echo: string, messageSignature?: string, encrypted = false): Promise<string> {
    const config = await this.wechatConfig();
    if (encrypted) {
      if (!config.encodingAesKey) throw new ServiceUnavailableException("公众号 EncodingAESKey 尚未配置");
      verifyWechatMessageSignature(config.token, timestamp, nonce, messageSignature || "", echo);
      return decryptWechatMessage(echo, config.encodingAesKey, config.appId);
    }
    verifyWechatMessageSignature(config.token, timestamp, nonce, signature);
    return echo;
  }

  async handleOfficialAccountEvent(input: { signature: string; timestamp: string; nonce: string; messageSignature?: string; encrypted?: boolean; body: string }): Promise<"success"> {
    const config = await this.wechatConfig();
    let xml = input.body;
    if (input.encrypted) {
      const encrypted = xmlValue(xml, "Encrypt");
      if (!encrypted || !config.encodingAesKey) throw new BadRequestException("公众号加密事件缺少 Encrypt 或 EncodingAESKey");
      verifyWechatMessageSignature(config.token, input.timestamp, input.nonce, input.messageSignature || "", encrypted);
      xml = decryptWechatMessage(encrypted, config.encodingAesKey, config.appId);
    } else verifyWechatMessageSignature(config.token, input.timestamp, input.nonce, input.signature);
    if (xmlValue(xml, "MsgType").toLowerCase() !== "event") return "success";
    const event = xmlValue(xml, "Event").toUpperCase();
    if (event !== "SUBSCRIBE" && event !== "SCAN") return "success";
    const rawEventKey = xmlValue(xml, "EventKey");
    const state = rawEventKey.startsWith("qrscene_") ? rawEventKey.slice("qrscene_".length) : rawEventKey;
    const wechatOpenId = xmlValue(xml, "FromUserName");
    if (!state || !wechatOpenId) return "success";
    const sessions = await this.database.query<RowDataPacket[]>(
      `SELECT id, status FROM wechat_auth_sessions WHERE state_hash = ? AND expires_at > CURRENT_TIMESTAMP(3) LIMIT 1`, [tokenHash(state)]);
    const session = sessions[0];
    if (!session || session.status === "COMPLETED") return "success";
    if (session.status !== "PENDING") return "success";
    let wechatUser: WechatUserResponse = { openid: wechatOpenId };
    try {
      const accessToken = await this.wechatAccessToken(config);
      const userUrl = new URL("https://api.weixin.qq.com/cgi-bin/user/info");
      userUrl.searchParams.set("access_token", accessToken); userUrl.searchParams.set("openid", wechatOpenId); userUrl.searchParams.set("lang", "zh_CN");
      const result = await fetch(userUrl, { signal: AbortSignal.timeout(10_000) }).then((response) => response.json() as Promise<WechatUserResponse>);
      if (result.openid) wechatUser = result;
    } catch { /* Profile permission/network failure must not prevent OpenID login. */ }
    await this.database.transaction(async (connection) => {
      const [lockedSessions] = await connection.query<RowDataPacket[]>("SELECT id, status, inviter_id FROM wechat_auth_sessions WHERE id = ? AND expires_at > CURRENT_TIMESTAMP(3) FOR UPDATE", [session.id]);
      if (lockedSessions[0]?.status !== "PENDING") return;
      let [identityRows] = await connection.query<RowDataPacket[]>("SELECT id, user_id FROM user_external_identities WHERE provider = 'WECHAT' AND provider_user_id = ? LIMIT 1 FOR UPDATE", [wechatOpenId]);
      if (!identityRows.length && wechatUser.unionid) {
        [identityRows] = await connection.query<RowDataPacket[]>("SELECT id, user_id FROM user_external_identities WHERE provider = 'WECHAT' AND union_id = ? LIMIT 1 FOR UPDATE", [wechatUser.unionid]);
      }
      let userId = identityRows.length ? String(identityRows[0]!.user_id) : "";
      if (!userId) {
        userId = randomUUID();
        await connection.execute("INSERT INTO users (id, display_name, avatar_url) VALUES (?, ?, ?)", [userId, safeDisplayName(wechatUser.nickname, "微信用户"), wechatUser.headimgurl || null]);
        await connection.execute("INSERT INTO ledger_accounts (id, owner_type, owner_id, account_type, currency) VALUES (?, 'USER', ?, 'AVAILABLE', 'CREDIT')", [randomUUID(), userId]);
        await this.referrals.newUser(connection, userId, undefined, lockedSessions[0].inviter_id ? String(lockedSessions[0].inviter_id) : undefined);
        await connection.execute(
          `INSERT INTO user_external_identities (id, user_id, provider, provider_user_id, union_id, display_name_snapshot, avatar_url_snapshot)
           VALUES (?, ?, 'WECHAT', ?, ?, ?, ?)`,
          [randomUUID(), userId, wechatOpenId, wechatUser.unionid || null, wechatUser.nickname || "", wechatUser.headimgurl || null],
        );
      } else {
        await connection.execute(
          `UPDATE user_external_identities SET provider_user_id = ?, union_id = COALESCE(?, union_id),
                  display_name_snapshot = ?, avatar_url_snapshot = ? WHERE id = ?`,
          [wechatOpenId, wechatUser.unionid || null, wechatUser.nickname || "", wechatUser.headimgurl || null, identityRows[0]!.id],
        );
      }
      await connection.execute("UPDATE users SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [userId]);
      await connection.execute("UPDATE wechat_auth_sessions SET user_id = ?, status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [userId, session.id]);
    });
    return "success";
  }

  async pollWechatSession(state: string, deviceName = ""): Promise<Record<string, unknown>> {
    if (!state?.trim()) throw new BadRequestException("微信登录状态参数不能为空");
    const claimed = await this.database.transaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT id, user_id, status, expires_at, token_delivered_at FROM wechat_auth_sessions WHERE state_hash = ? LIMIT 1 FOR UPDATE`,
        [tokenHash(state)],
      );
      const session = rows[0];
      if (!session) throw new BadRequestException("微信登录会话不存在");
      if (new Date(session.expires_at).getTime() <= Date.now() && session.status === "PENDING") return { status: "EXPIRED" };
      if (session.status !== "COMPLETED") return { status: String(session.status) };
      if (session.token_delivered_at) throw new UnauthorizedException("该微信登录结果已经领取");
      const userId = String(session.user_id);
      const tokens = await this.issueTokens(userId, deviceName, connection);
      await connection.execute("UPDATE wechat_auth_sessions SET token_delivered_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [session.id]);
      return { status: "COMPLETED", userId, tokens };
    });
    if (claimed.status !== "COMPLETED" || !("userId" in claimed) || !("tokens" in claimed)) return claimed;
    const completed = claimed as { status: "COMPLETED"; userId: string; tokens: Record<string, unknown> };
    return { status: "COMPLETED", ...completed.tokens, user: await this.profile(completed.userId) };
  }
}
