import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";
import { SecretCryptoService } from "../common/secret-crypto.service";
import { EnvironmentService } from "../config/environment.service";
import { requiredString } from "../common/input";
import { commissionFen, generateInviteCode, integer, inviteCode, publicUrl, receiptImage, withdrawalWindow } from "./referral-rules";

const withdrawalColumns = "id, user_id, amount_fen, status, review_note, reviewed_at, processing_by, processing_at, paid_at, created_at";
type Config = { enabled: boolean; direct_rate_bps: number; indirect_rate_bps: number; minimum_withdrawal_fen: number; invitation_reward_credits: number; invitation_anti_abuse_enabled: boolean; invitation_daily_reward_limit: number; invitation_monthly_reward_limit: number; invite_page_base_url: string; windows_download_url: string; macos_download_url: string; revision: number; updated_at?: unknown };

function chinaRewardPeriodKeys(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  const year = shifted.getUTCFullYear(), month = shifted.getUTCMonth(), day = shifted.getUTCDate();
  const date = (value: number) => `${year}-${String(month + 1).padStart(2, "0")}-${String(value).padStart(2, "0")}`;
  return {
    dayKey: date(day),
    monthKey: date(1),
  };
}

@Injectable()
export class ReferralsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService, @Inject(SecretCryptoService) private readonly crypto: SecretCryptoService, @Inject(EnvironmentService) private readonly environment: EnvironmentService) {}

  private configValue(row: RowDataPacket): Config {
    return { enabled: Boolean(row.enabled), direct_rate_bps: Number(row.direct_rate_bps), indirect_rate_bps: Number(row.indirect_rate_bps), minimum_withdrawal_fen: Number(row.minimum_withdrawal_fen), invitation_reward_credits: Number(row.invitation_reward_credits), invitation_anti_abuse_enabled: Boolean(row.invitation_anti_abuse_enabled), invitation_daily_reward_limit: Number(row.invitation_daily_reward_limit ?? 20), invitation_monthly_reward_limit: Number(row.invitation_monthly_reward_limit ?? 200), invite_page_base_url: row.invite_page_base_url || `${this.environment.values.adminOrigin.split(",")[0]!.replace(/\/$/, "")}/invite`, windows_download_url: row.windows_download_url, macos_download_url: row.macos_download_url, revision: Number(row.revision), updated_at: row.updated_at };
  }
  async config(connection?: PoolConnection): Promise<Config> {
    const rows = connection ? (await connection.query<RowDataPacket[]>("SELECT * FROM distribution_configs WHERE id = 1"))[0] : await this.db.query<RowDataPacket[]>("SELECT * FROM distribution_configs WHERE id = 1");
    if (!rows[0]) throw new ConflictException("请先执行分销数据库迁移");
    return this.configValue(rows[0]);
  }
  async saveConfig(adminId: string, input: Record<string, unknown>) {
    if (typeof input.enabled !== "boolean") throw new BadRequestException("分销开关必须为布尔值");
    const enabled = input.enabled;
    const direct = integer(input.direct_rate_bps, "直接分润比例", 0, 10000), indirect = integer(input.indirect_rate_bps, "间接分润比例", 0, 10000);
    if (direct + indirect > 10000 || (input.enabled && direct + indirect === 0)) throw new BadRequestException("分润比例合计不得超过 100%，启用时不能都为零");
    const minimum = integer(input.minimum_withdrawal_fen, "最低提现金额（分）", 1);
    const reward = integer(input.invitation_reward_credits, "邀请奖励积分", 0, 100000);
    if (typeof input.invitation_anti_abuse_enabled !== "boolean") throw new BadRequestException("邀请防刷开关必须为布尔值");
    const antiAbuse = input.invitation_anti_abuse_enabled;
    const dailyLimit = integer(input.invitation_daily_reward_limit, "每日邀请奖励人数上限", 1, 100000);
    const monthlyLimit = integer(input.invitation_monthly_reward_limit, "每月邀请奖励人数上限", 1, 1000000);
    if (monthlyLimit < dailyLimit) throw new BadRequestException("每月邀请奖励人数上限不能小于每日上限");
    const base = publicUrl(input.invite_page_base_url, "邀请页地址", 500).replace(/\/$/, "");
    if (base && new URL(base).search) throw new BadRequestException("邀请页地址不能包含查询参数");
    const windows = publicUrl(input.windows_download_url, "Windows 安装包地址"), macos = publicUrl(input.macos_download_url, "macOS 安装包地址");
    integer(input.revision, "配置版本");
    await this.db.transaction(async c => {
      const [rows] = await c.query<RowDataPacket[]>("SELECT revision FROM distribution_configs WHERE id = 1 FOR UPDATE");
      if (Number(rows[0]?.revision) !== input.revision) throw new ConflictException("配置已更新，请重新读取");
      await c.execute("UPDATE distribution_configs SET enabled = ?, direct_rate_bps = ?, indirect_rate_bps = ?, minimum_withdrawal_fen = ?, invitation_reward_credits = ?, invitation_anti_abuse_enabled = ?, invitation_daily_reward_limit = ?, invitation_monthly_reward_limit = ?, invite_page_base_url = ?, windows_download_url = ?, macos_download_url = ?, revision = revision + 1, updated_by = ? WHERE id = 1", [enabled, direct, indirect, minimum, reward, antiAbuse, dailyLimit, monthlyLimit, base, windows, macos, adminId]);
      await this.audit(c, adminId, "distribution.config", "1", { enabled: input.enabled, direct_rate_bps: direct, indirect_rate_bps: indirect, minimum_withdrawal_fen: minimum, invitation_reward_credits: reward, invitation_anti_abuse_enabled: antiAbuse, invitation_daily_reward_limit: dailyLimit, invitation_monthly_reward_limit: monthlyLimit, invite_page_base_url: base, windows_download_url: windows, macos_download_url: macos, revision: Number(input.revision) + 1 });
    });
    return this.config();
  }

  async downloadConfig() {
    const config = await this.config();
    return {
      windows_download_url: config.windows_download_url,
      macos_download_url: config.macos_download_url,
      revision: config.revision,
      updated_at: config.updated_at,
    };
  }

  async saveDownloadConfig(adminId: string, input: Record<string, unknown>) {
    const windows = publicUrl(input.windows_download_url, "Windows 安装包地址");
    const macos = publicUrl(input.macos_download_url, "macOS 安装包地址");
    if (!windows && !macos) throw new BadRequestException("至少需要配置一个软件下载地址");
    const revision = integer(input.revision, "配置版本");
    await this.db.transaction(async c => {
      const [rows] = await c.query<RowDataPacket[]>("SELECT revision FROM distribution_configs WHERE id = 1 FOR UPDATE");
      if (Number(rows[0]?.revision) !== revision) throw new ConflictException("配置已更新，请重新读取");
      await c.execute(
        "UPDATE distribution_configs SET windows_download_url = ?, macos_download_url = ?, revision = revision + 1, updated_by = ? WHERE id = 1",
        [windows, macos, adminId],
      );
      await this.audit(c, adminId, "software_downloads.config", "1", { windows_download_url: windows, macos_download_url: macos, revision: revision + 1 });
    });
    return this.downloadConfig();
  }

  async ensureInviteCode(userId: string, connection?: PoolConnection): Promise<string> {
    const work = async (c: PoolConnection) => {
      const [rows] = await c.query<RowDataPacket[]>("SELECT invite_code FROM users WHERE id = ? FOR UPDATE", [userId]);
      if (!rows[0]) throw new NotFoundException("用户不存在");
      if (rows[0].invite_code) return String(rows[0].invite_code);
      for (let i = 0; i < 20; i++) {
        const code = generateInviteCode();
        try { await c.execute("UPDATE users SET invite_code = ? WHERE id = ? AND invite_code IS NULL", [code, userId]); return code; }
        catch (error) { if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error; }
      }
      throw new ConflictException("邀请码生成繁忙，请重试");
    };
    return connection ? work(connection) : this.db.transaction(work);
  }
  async inviter(code: string, connection?: PoolConnection): Promise<string> {
    const sql = "SELECT id FROM users WHERE invite_code = ? AND status = 'ACTIVE' LIMIT 1";
    const parameters = [inviteCode(code)];
    const rows = connection ? (await connection.query<RowDataPacket[]>(sql, parameters))[0] : await this.db.query<RowDataPacket[]>(sql, parameters);
    if (!rows[0]) throw new BadRequestException("邀请码不存在或邀请人已停用");
    return String(rows[0].id);
  }

  /** Called only inside the NEW, verified account creation transaction. No reparent API. */
  async newUser(c: PoolConnection, userId: string, code?: string, inviterId?: string) {
    await this.ensureInviteCode(userId, c);
    const parent = code ? await this.inviter(code, c) : inviterId;
    if (!parent) return;
    if (parent === userId) throw new BadRequestException("不能邀请自己");
    const [parents] = await c.query<RowDataPacket[]>("SELECT id FROM users WHERE id = ? AND status = 'ACTIVE' FOR UPDATE", [parent]);
    if (!parents.length) throw new BadRequestException("邀请人已停用");
    const [update] = await c.execute<ResultSetHeader>("UPDATE users SET pid = ? WHERE id = ? AND pid IS NULL", [parent, userId]);
    if (update.affectedRows !== 1) throw new ConflictException("上级关系已绑定，不能重复绑定");
    const config = await this.config(c), rewardId = randomUUID();
    const pending = config.invitation_anti_abuse_enabled;
    await c.execute("INSERT INTO referral_rewards (id, inviter_id, invited_user_id, credits, config_revision, status, daily_limit_snapshot, monthly_limit_snapshot, rewarded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [rewardId, parent, userId, config.invitation_reward_credits, config.revision, pending ? "PENDING_PAYMENT" : "REWARDED", config.invitation_daily_reward_limit, config.invitation_monthly_reward_limit, pending ? null : new Date()]);
    if (!pending) {
      const reward = { id: rewardId, inviter_id: parent, invited_user_id: userId, credits: config.invitation_reward_credits };
      await this.creditInvitationReward(c, reward);
      await this.incrementInvitationRewardUsage(c, parent, Number(reward.credits));
    }
  }

  private async usageRows(c: PoolConnection, inviterId: string) {
    const { dayKey, monthKey } = chinaRewardPeriodKeys();
    await c.execute("INSERT INTO invitation_reward_usage (inviter_id, period_type, period_key, rewarded_count) VALUES (?, 'DAY', ?, 0), (?, 'MONTH', ?, 0) ON DUPLICATE KEY UPDATE inviter_id = VALUES(inviter_id)", [inviterId, dayKey, inviterId, monthKey]);
    const [rows] = await c.query<RowDataPacket[]>("SELECT period_type, rewarded_count FROM invitation_reward_usage WHERE inviter_id = ? AND ((period_type = 'DAY' AND period_key = ?) OR (period_type = 'MONTH' AND period_key = ?)) FOR UPDATE", [inviterId, dayKey, monthKey]);
    return { dayKey, monthKey, dayCount: Number(rows.find(row => row.period_type === "DAY")?.rewarded_count || 0), monthCount: Number(rows.find(row => row.period_type === "MONTH")?.rewarded_count || 0) };
  }

  private async incrementInvitationRewardUsage(c: PoolConnection, inviterId: string, credits: number) {
    if (credits <= 0) return;
    const usage = await this.usageRows(c, inviterId);
    await c.execute("UPDATE invitation_reward_usage SET rewarded_count = rewarded_count + 1 WHERE inviter_id = ? AND ((period_type = 'DAY' AND period_key = ?) OR (period_type = 'MONTH' AND period_key = ?))", [inviterId, usage.dayKey, usage.monthKey]);
  }

  private async creditInvitationReward(c: PoolConnection, reward: RowDataPacket | { id: string; inviter_id: string; invited_user_id: string; credits: number }, paymentOrderId?: string): Promise<boolean> {
    if (Number(reward.credits) <= 0) return true;
    const [accounts] = await c.query<RowDataPacket[]>("SELECT id FROM ledger_accounts WHERE owner_type = 'USER' AND owner_id = ? AND account_type = 'AVAILABLE' AND currency = 'CREDIT' FOR UPDATE", [reward.inviter_id]);
    if (!accounts[0]) {
      if (paymentOrderId) return false;
      throw new ConflictException("邀请人积分账户不存在");
    }
    const transaction = randomUUID();
    await c.execute("INSERT INTO ledger_transactions (id, transaction_type, reference_type, reference_id, metadata_json) VALUES (?, 'INVITATION_REWARD', 'referral_reward', ?, ?)", [transaction, reward.id, JSON.stringify({ invited_user_id: reward.invited_user_id, qualified_payment_order_id: paymentOrderId })]);
    await c.execute("INSERT INTO ledger_entries (id, transaction_id, account_id, amount) VALUES (?, ?, ?, ?)", [randomUUID(), transaction, accounts[0].id, Number(reward.credits)]);
    return true;
  }

  private async qualifyInvitationReward(c: PoolConnection, invitedUserId: string, paymentOrderId: string, paidAmountFen: number) {
    if (paidAmountFen <= 0) return;
    const [candidateRows] = await c.query<RowDataPacket[]>("SELECT inviter_id FROM referral_rewards WHERE invited_user_id = ? AND status = 'PENDING_PAYMENT' LIMIT 1", [invitedUserId]);
    if (!candidateRows[0]) return;
    const inviterId = String(candidateRows[0].inviter_id);
    const [inviterRows] = await c.query<RowDataPacket[]>("SELECT status FROM users WHERE id = ? FOR UPDATE", [inviterId]);
    const [rewardRows] = await c.query<RowDataPacket[]>("SELECT * FROM referral_rewards WHERE invited_user_id = ? FOR UPDATE", [invitedUserId]);
    const reward = rewardRows[0];
    if (!reward || reward.status !== "PENDING_PAYMENT") return;
    if (inviterRows[0]?.status !== "ACTIVE") {
      await c.execute("UPDATE referral_rewards SET status = 'LIMITED', qualified_payment_order_id = ?, qualified_at = CURRENT_TIMESTAMP(3), status_note = '邀请人已停用' WHERE id = ?", [paymentOrderId, reward.id]);
      return;
    }
    if (Number(reward.credits) <= 0) {
      await c.execute("UPDATE referral_rewards SET status = 'REWARDED', qualified_payment_order_id = ?, qualified_at = CURRENT_TIMESTAMP(3), rewarded_at = CURRENT_TIMESTAMP(3), status_note = '' WHERE id = ?", [paymentOrderId, reward.id]);
      return;
    }
    const usage = await this.usageRows(c, inviterId);
    const dailyLimit = Number(reward.daily_limit_snapshot), monthlyLimit = Number(reward.monthly_limit_snapshot);
    if (usage.dayCount >= dailyLimit || usage.monthCount >= monthlyLimit) {
      const note = usage.dayCount >= dailyLimit ? "已达到每日邀请奖励人数上限" : "已达到每月邀请奖励人数上限";
      await c.execute("UPDATE referral_rewards SET status = 'LIMITED', qualified_payment_order_id = ?, qualified_at = CURRENT_TIMESTAMP(3), status_note = ? WHERE id = ?", [paymentOrderId, note, reward.id]);
      return;
    }
    if (!await this.creditInvitationReward(c, reward, paymentOrderId)) {
      await c.execute("UPDATE referral_rewards SET status = 'LIMITED', qualified_payment_order_id = ?, qualified_at = CURRENT_TIMESTAMP(3), status_note = '邀请人积分账户异常' WHERE id = ?", [paymentOrderId, reward.id]);
      return;
    }
    await c.execute("UPDATE invitation_reward_usage SET rewarded_count = rewarded_count + 1 WHERE inviter_id = ? AND ((period_type = 'DAY' AND period_key = ?) OR (period_type = 'MONTH' AND period_key = ?))", [inviterId, usage.dayKey, usage.monthKey]);
    await c.execute("UPDATE referral_rewards SET status = 'REWARDED', qualified_payment_order_id = ?, qualified_at = CURRENT_TIMESTAMP(3), rewarded_at = CURRENT_TIMESTAMP(3), status_note = '' WHERE id = ?", [paymentOrderId, reward.id]);
  }

  async publicInvitation(code: string) {
    const normalized = inviteCode(code);
    await this.inviter(normalized);
    const config = await this.config();
    return { invite_code: normalized, windows_download_url: config.windows_download_url, macos_download_url: config.macos_download_url };
  }
  async summary(userId: string) {
    const code = await this.ensureInviteCode(userId), config = await this.config();
    const [wallet] = await this.db.query<RowDataPacket[]>("SELECT available_fen, frozen_fen, earned_fen, paid_fen FROM commission_wallets WHERE user_id = ?", [userId]);
    const [count] = await this.db.query<RowDataPacket[]>("SELECT COUNT(*) AS invited_count, COALESCE(SUM(CASE WHEN status = 'REWARDED' THEN credits ELSE 0 END), 0) AS reward_credits FROM referral_rewards WHERE inviter_id = ?", [userId]);
    return { invite_code: code, invitation_url: `${config.invite_page_base_url}/${code}`, invited_count: Number(count?.invited_count || 0), reward_credits: Number(count?.reward_credits || 0), invitation_reward_credits: config.invitation_reward_credits, invitation_anti_abuse_enabled: config.invitation_anti_abuse_enabled, enabled: config.enabled, direct_rate_bps: config.direct_rate_bps, indirect_rate_bps: config.indirect_rate_bps, minimum_withdrawal_fen: config.minimum_withdrawal_fen, available_fen: Number(wallet?.available_fen || 0), frozen_fen: Number(wallet?.frozen_fen || 0), earned_fen: Number(wallet?.earned_fen || 0), paid_fen: Number(wallet?.paid_fen || 0), ...withdrawalWindow() };
  }

  private async wallet(c: PoolConnection, userId: string) {
    await c.execute("INSERT INTO commission_wallets (user_id) VALUES (?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)", [userId]);
    const [rows] = await c.query<RowDataPacket[]>("SELECT * FROM commission_wallets WHERE user_id = ? FOR UPDATE", [userId]);
    return rows[0]!;
  }
  private async entry(c: PoolConnection, user: string, event: string, reference: string, available: number, frozen: number) {
    // Every wallet mutation and its user-table projection commit/rollback together.
    // Holds/releases don't change total balance; only commission and paid payouts do.
    await c.execute("UPDATE users u INNER JOIN commission_wallets w ON w.user_id = u.id SET u.balance_fen = w.available_fen + w.frozen_fen WHERE u.id = ?", [user]);
    await c.execute("INSERT INTO commission_wallet_entries (id, user_id, event_type, reference_id, available_delta_fen, frozen_delta_fen) VALUES (?, ?, ?, ?, ?, ?)", [randomUUID(), user, event, reference, available, frozen]);
  }

  /** Payment row must already be locked; commission and credited package commit together. */
  async settlePayment(c: PoolConnection, orderId: string, payerId: string, paidAmountFen: number) {
    integer(paidAmountFen, "实付金额", 0, Number.MAX_SAFE_INTEGER);
    const [existing] = await c.query<RowDataPacket[]>("SELECT payment_order_id FROM distribution_settlements WHERE payment_order_id = ?", [orderId]);
    if (existing.length) return;
    const config = await this.config(c);
    await c.execute("INSERT INTO distribution_settlements (payment_order_id, payer_id, paid_amount_fen, enabled, direct_rate_bps, indirect_rate_bps, config_revision) VALUES (?, ?, ?, ?, ?, ?, ?)", [orderId, payerId, paidAmountFen, config.enabled, config.direct_rate_bps, config.indirect_rate_bps, config.revision]);
    await this.qualifyInvitationReward(c, payerId, orderId, paidAmountFen);
    if (!config.enabled || paidAmountFen === 0) return;
    const [rows] = await c.query<RowDataPacket[]>("SELECT p.id AS direct_id, p.status AS direct_status, gp.id AS indirect_id, gp.status AS indirect_status FROM users u LEFT JOIN users p ON p.id = u.pid LEFT JOIN users gp ON gp.id = p.pid WHERE u.id = ?", [payerId]);
    const chain = rows[0];
    if (!chain) return;
    const seen = new Set([payerId]);
    // Stable wallet lock order prevents cross-level payment/withdrawal deadlocks.
    const recipients = [{ id: chain.direct_id, status: chain.direct_status, level: 1, rate: config.direct_rate_bps }, { id: chain.indirect_id, status: chain.indirect_status, level: 2, rate: config.indirect_rate_bps }]
      .filter(item => { if (!item.id || seen.has(String(item.id))) return false; seen.add(String(item.id)); return item.status === "ACTIVE"; }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const item of recipients) {
      const amount = commissionFen(paidAmountFen, item.rate);
      if (!amount) continue;
      await this.wallet(c, String(item.id));
      const id = randomUUID();
      await c.execute("INSERT INTO commission_records (id, payment_order_id, beneficiary_id, payer_id, level, base_amount_fen, rate_bps, amount_fen, config_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, orderId, item.id, payerId, item.level, paidAmountFen, item.rate, amount, config.revision]);
      await c.execute("UPDATE commission_wallets SET available_fen = available_fen + ?, earned_fen = earned_fen + ? WHERE user_id = ?", [amount, amount, item.id]);
      await this.entry(c, String(item.id), "COMMISSION", id, amount, 0);
    }
  }

  async applyWithdrawal(userId: string, input: Record<string, unknown>) {
    const amount = integer(input.amount_fen, "提现金额（分）", 1);
    const key = requiredString(input, "idempotency_key", 64);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw new BadRequestException("提现请求标识无效");
    const name = requiredString(input, "alipay_real_name", 100), account = requiredString(input, "alipay_account", 191), qr = receiptImage(input.alipay_qr_code);
    const payee = JSON.stringify({ alipay_real_name: name, alipay_account: account, alipay_qr_code: qr });
    const fingerprint = createHash("sha256").update(JSON.stringify([amount, payee])).digest("hex");
    return this.db.transaction(async c => {
      const wallet = await this.wallet(c, userId);
      const [existing] = await c.query<RowDataPacket[]>(`SELECT ${withdrawalColumns}, request_hash FROM withdrawal_applications WHERE user_id = ? AND idempotency_key = ?`, [userId, key]);
      if (existing[0]) {
        if (existing[0].request_hash !== fingerprint) throw new ConflictException("相同请求标识不能用于不同的提现资料");
        const { request_hash: _, ...result } = existing[0]; return { ...result, idempotent_replay: true };
      }
      if (!withdrawalWindow().withdrawal_open) throw new BadRequestException("提现申请仅在每周五（北京时间）开放");
      const config = await this.config(c);
      if (amount < config.minimum_withdrawal_fen) throw new BadRequestException(`最低提现金额为 ${(config.minimum_withdrawal_fen / 100).toFixed(2)} 元`);
      if (BigInt(wallet.available_fen) < BigInt(amount)) throw new BadRequestException("可提现余额不足");
      const id = randomUUID();
      await c.execute("INSERT INTO withdrawal_applications (id, user_id, idempotency_key, request_hash, amount_fen, minimum_fen_snapshot, config_revision, payee_ciphertext) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, userId, key, fingerprint, amount, config.minimum_withdrawal_fen, config.revision, this.crypto.encrypt(payee)]);
      await c.execute("UPDATE commission_wallets SET available_fen = available_fen - ?, frozen_fen = frozen_fen + ? WHERE user_id = ?", [amount, amount, userId]);
      await this.entry(c, userId, "WITHDRAWAL_HOLD", id, -amount, amount);
      return { id, amount_fen: amount, status: "PENDING" };
    });
  }

  async review(adminId: string, id: string, decision: string, note: string) {
    if (!["APPROVED", "REJECTED"].includes(decision)) throw new BadRequestException("审核操作无效");
    if (decision === "REJECTED" && !note.trim()) throw new BadRequestException("驳回时必须填写原因");
    await this.db.transaction(async c => {
      const [rows] = await c.query<RowDataPacket[]>("SELECT * FROM withdrawal_applications WHERE id = ? FOR UPDATE", [id]);
      const row = rows[0];
      if (!row) throw new NotFoundException("提现申请不存在");
      if (row.status === decision) return;
      if (row.status !== "PENDING" && !(row.status === "APPROVED" && decision === "REJECTED")) throw new ConflictException("当前申请状态不能执行该审核操作");
      if (decision === "REJECTED") {
        const wallet = await this.wallet(c, String(row.user_id));
        if (BigInt(wallet.frozen_fen) < BigInt(row.amount_fen)) throw new ConflictException("冻结余额异常，请核对账本");
        await c.execute("UPDATE commission_wallets SET available_fen = available_fen + ?, frozen_fen = frozen_fen - ? WHERE user_id = ?", [row.amount_fen, row.amount_fen, row.user_id]);
        await this.entry(c, String(row.user_id), "WITHDRAWAL_RELEASE", id, Number(row.amount_fen), -Number(row.amount_fen));
      }
      await c.execute("UPDATE withdrawal_applications SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [decision, note, adminId, id]);
      await this.audit(c, adminId, `withdrawal.${decision.toLowerCase()}`, id, { note });
    });
    return { id, status: decision };
  }
  async payee(adminId: string, id: string) {
    return this.db.transaction(async c => {
      const [rows] = await c.query<RowDataPacket[]>(`SELECT ${withdrawalColumns}, payee_ciphertext FROM withdrawal_applications WHERE id = ?`, [id]);
      if (!rows[0]) throw new NotFoundException("提现申请不存在");
      await this.audit(c, adminId, "withdrawal.payee_view", id, {});
      const { payee_ciphertext, ...row } = rows[0];
      return { ...row, can_confirm: row.status === "PROCESSING" && row.processing_by === adminId, ...JSON.parse(this.crypto.decrypt(String(payee_ciphertext))) as Record<string, string> };
    });
  }
  async claimPayout(adminId: string, id: string) {
    await this.db.transaction(async c => {
      const [rows] = await c.query<RowDataPacket[]>("SELECT status, processing_by FROM withdrawal_applications WHERE id = ? FOR UPDATE", [id]);
      const row = rows[0];
      if (!row) throw new NotFoundException("提现申请不存在");
      if (row.status === "PROCESSING" && row.processing_by === adminId) return;
      if (row.status !== "APPROVED") throw new ConflictException("此申请尚未通过审核，或已被其他管理员领取打款");
      await c.execute("UPDATE withdrawal_applications SET status = 'PROCESSING', processing_by = ?, processing_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [adminId, id]);
      await this.audit(c, adminId, "withdrawal.claim", id, {});
    });
    return { id, status: "PROCESSING" };
  }
  async releasePayout(adminId: string, id: string, input: Record<string, unknown>) {
    if (input.not_paid !== true) throw new BadRequestException("必须确认尚未实际打款才能释放任务");
    const note = requiredString(input, "note", 500);
    await this.db.transaction(async c => {
      const [rows] = await c.query<RowDataPacket[]>("SELECT status, processing_by FROM withdrawal_applications WHERE id = ? FOR UPDATE", [id]);
      if (rows[0]?.status !== "PROCESSING" || rows[0].processing_by !== adminId) throw new ConflictException("只能释放自己正在处理且未打款的申请");
      await c.execute("UPDATE withdrawal_applications SET status = 'APPROVED', processing_by = NULL, processing_at = NULL WHERE id = ?", [id]);
      await this.audit(c, adminId, "withdrawal.release_claim", id, { note });
    });
    return { id, status: "APPROVED" };
  }
  async confirmPayout(adminId: string, id: string, input: Record<string, unknown>) {
    if (input.confirmed !== true) throw new BadRequestException("请确认已通过支付宝完成实际打款");
    const trade = requiredString(input, "alipay_trade_no", 100), note = requiredString(input, "note", 500);
    if (!/^[A-Za-z0-9_-]{6,100}$/.test(trade)) throw new BadRequestException("支付宝交易流水号格式无效");
    try {
      await this.db.transaction(async c => {
        const [rows] = await c.query<RowDataPacket[]>("SELECT * FROM withdrawal_applications WHERE id = ? FOR UPDATE", [id]);
        const row = rows[0];
        if (!row) throw new NotFoundException("提现申请不存在");
        if (row.status === "PAID") {
          const [paid] = await c.query<RowDataPacket[]>("SELECT alipay_trade_no FROM manual_payout_records WHERE withdrawal_id = ?", [id]);
          if (paid[0]?.alipay_trade_no !== trade) throw new ConflictException("此申请已用其他流水号记为打款成功");
          return;
        }
        if (row.status !== "PROCESSING" || row.processing_by !== adminId) throw new ConflictException("请先领取此打款任务；仅领取人可以确认打款");
        const wallet = await this.wallet(c, String(row.user_id));
        if (BigInt(wallet.frozen_fen) < BigInt(row.amount_fen)) throw new ConflictException("冻结余额异常，请核对账本");
        await c.execute("INSERT INTO manual_payout_records (id, withdrawal_id, user_id, amount_fen, alipay_trade_no, operator_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)", [randomUUID(), id, row.user_id, row.amount_fen, trade, adminId, note]);
        await c.execute("UPDATE commission_wallets SET frozen_fen = frozen_fen - ?, paid_fen = paid_fen + ? WHERE user_id = ?", [row.amount_fen, row.amount_fen, row.user_id]);
        await c.execute("UPDATE withdrawal_applications SET status = 'PAID', paid_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [id]);
        await this.entry(c, String(row.user_id), "WITHDRAWAL_PAID", id, 0, -Number(row.amount_fen));
        await this.audit(c, adminId, "withdrawal.paid", id, { alipay_trade_no: trade, amount_fen: Number(row.amount_fen) });
      });
    } catch (error) { if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw new ConflictException("该支付宝流水号已用于其他打款，不能重复记账"); throw error; }
    return { id, status: "PAID" };
  }
  async records(kind: string, userId?: string, rawPage?: string, status?: string) {
    const page = rawPage === undefined ? 1 : Number(rawPage);
    integer(page, "页码", 1, 100000);
    const offset = (page - 1) * 50;
    const table = kind === "commissions" ? "commission_records" : kind === "withdrawals" ? "withdrawal_applications" : kind === "payouts" ? "manual_payout_records" : kind === "rewards" ? "referral_rewards" : "";
    if (!table) throw new BadRequestException("记录类型无效");
    const owner = kind === "commissions" ? "beneficiary_id" : kind === "rewards" ? "inviter_id" : "user_id";
    const conditions: string[] = [], parameters: unknown[] = [];
    if (userId) { conditions.push(`${owner} = ?`); parameters.push(userId); }
    if (status && (kind === "withdrawals" || kind === "rewards")) {
      const allowed = kind === "withdrawals" ? ["PENDING", "APPROVED", "PROCESSING", "REJECTED", "PAID"] : ["PENDING_PAYMENT", "REWARDED", "LIMITED"];
      if (!allowed.includes(status)) throw new BadRequestException(kind === "withdrawals" ? "提现状态无效" : "邀请奖励状态无效");
      conditions.push("status = ?"); parameters.push(status);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const columns = kind === "withdrawals" ? withdrawalColumns : "*";
    const rows = await this.db.query<RowDataPacket[]>(`SELECT ${columns} FROM ${table}${where} ORDER BY created_at DESC, id DESC LIMIT 51 OFFSET ${offset}`, parameters);
    return { items: rows.slice(0, 50), page, has_more: rows.length > 50 };
  }
  private audit(c: PoolConnection, admin: string, action: string, id: string, detail: unknown) {
    return c.execute("INSERT INTO audit_logs (id, admin_user_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, 'distribution', ?, ?)", [randomUUID(), admin, action, id, JSON.stringify(detail)]);
  }
}
