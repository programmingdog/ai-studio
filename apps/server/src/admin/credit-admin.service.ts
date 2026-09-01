import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { RowDataPacket } from "mysql2/promise";
import { AuditService } from "../common/audit.service";
import { parseStoredJson } from "../common/input";
import { DatabaseService } from "../database/database.service";

export interface CreditPackageInput {
  code: string;
  name: string;
  description?: string;
  baseCredits: number;
  bonusCredits: number;
  priceFen: number;
  currency: string;
  status: string;
  sortOrder: number;
}

export interface CreditPurchaseInput {
  userId: string;
  packageId: string;
  creditsGranted?: number;
  paidAmountFen?: number;
  currency?: string;
  paymentOrderId?: string | null;
  status: string;
  purchasedAt?: string | null;
  notes?: string;
}

export interface CreditConsumptionInput {
  userId: string;
  taskId?: string | null;
  providerModelId?: string | null;
  category: string;
  creditsConsumed: number;
  status: string;
  description?: string;
  notes?: string;
  metadata?: unknown;
  occurredAt?: string | null;
}

interface PackageRow extends RowDataPacket {
  id: string;
  code: string;
  name: string;
  base_credits: number | string;
  bonus_credits: number | string;
  price_fen: number | string;
  currency: string;
}

const packageStatuses = new Set(["ACTIVE", "DISABLED"]);
const purchaseStatuses = new Set(["CREATED", "PAID", "CANCELED", "REFUNDED"]);
const consumptionStatuses = new Set(["PENDING", "CONFIRMED", "REVERSED", "CANCELED"]);
const consumptionCategories = new Set(["MODEL_TASK", "API_TEST", "MANUAL", "ADJUSTMENT"]);

function integer(value: number, field: string, minimum = 0, maximum = 9_000_000_000_000_000): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BadRequestException(`${field} 必须是 ${minimum}～${maximum} 的整数`);
  }
  return value;
}

function positiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 9_000_000_000_000) {
    throw new BadRequestException(`${field} 必须是大于 0 的数字`);
  }
  return value;
}

function currency(value?: string): string {
  const normalized = (value || "CNY").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw new BadRequestException("币种必须是 3 位大写字母");
  return normalized;
}

function dateValue(value: string | null | undefined, field: string, fallbackNow = false): Date | null {
  if (!value) return fallbackNow ? new Date() : null;
  const result = new Date(value);
  if (Number.isNaN(result.valueOf())) throw new BadRequestException(`${field} 格式无效`);
  return result;
}

function generatedNumber(prefix: string): string {
  return `${prefix}${Date.now()}${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

@Injectable()
export class CreditAdminService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async listPackages(): Promise<Record<string, unknown>[]> {
    const rows = await this.database.query<RowDataPacket[]>(
      `SELECT id, code, name, description, base_credits, bonus_credits, price_fen,
              currency, status, sort_order, created_at, updated_at
       FROM credit_packages ORDER BY sort_order, created_at`,
    );
    return rows.map((row) => ({
      ...row,
      base_credits: Number(row.base_credits),
      bonus_credits: Number(row.bonus_credits),
      total_credits: Number(row.base_credits) + Number(row.bonus_credits),
      price_fen: Number(row.price_fen),
      sort_order: Number(row.sort_order),
    }));
  }

  private validatePackage(input: CreditPackageInput): CreditPackageInput {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(input.code)) throw new BadRequestException("套餐 code 格式不正确");
    const status = input.status.toUpperCase();
    if (!packageStatuses.has(status)) throw new BadRequestException("套餐状态不正确");
    return {
      ...input,
      code: input.code.trim(),
      name: input.name.trim(),
      description: input.description?.trim() || "",
      baseCredits: integer(input.baseCredits, "基础积分", 1),
      bonusCredits: integer(input.bonusCredits, "赠送积分"),
      priceFen: integer(input.priceFen, "售价（分）", 1),
      currency: currency(input.currency),
      status,
      sortOrder: integer(input.sortOrder, "排序值", 0, 100000),
    };
  }

  async createPackage(adminUserId: string, rawInput: CreditPackageInput): Promise<{ id: string }> {
    const input = this.validatePackage(rawInput);
    const id = randomUUID();
    await this.database.execute(
      `INSERT INTO credit_packages
        (id, code, name, description, base_credits, bonus_credits, price_fen, currency, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.code, input.name, input.description, input.baseCredits, input.bonusCredits,
       input.priceFen, input.currency, input.status, input.sortOrder],
    );
    await this.audit.record({ adminUserId, action: "credit_package.create", entityType: "credit_package", entityId: id, details: { code: input.code, totalCredits: input.baseCredits + input.bonusCredits, priceFen: input.priceFen } });
    return { id };
  }

  async updatePackage(adminUserId: string, packageId: string, rawInput: CreditPackageInput): Promise<{ updated: true }> {
    const input = this.validatePackage(rawInput);
    const result = await this.database.execute(
      `UPDATE credit_packages SET code = ?, name = ?, description = ?, base_credits = ?,
              bonus_credits = ?, price_fen = ?, currency = ?, status = ?, sort_order = ?
       WHERE id = ?`,
      [input.code, input.name, input.description, input.baseCredits, input.bonusCredits,
       input.priceFen, input.currency, input.status, input.sortOrder, packageId],
    );
    if (!result.affectedRows) throw new NotFoundException("积分套餐不存在");
    await this.audit.record({ adminUserId, action: "credit_package.update", entityType: "credit_package", entityId: packageId, details: { code: input.code, totalCredits: input.baseCredits + input.bonusCredits, priceFen: input.priceFen } });
    return { updated: true };
  }

  async deletePackage(adminUserId: string, packageId: string): Promise<{ deleted: true }> {
    const result = await this.database.execute("DELETE FROM credit_packages WHERE id = ?", [packageId]);
    if (!result.affectedRows) throw new NotFoundException("积分套餐不存在");
    await this.audit.record({ adminUserId, action: "credit_package.delete", entityType: "credit_package", entityId: packageId });
    return { deleted: true };
  }

  async listPurchases(limit?: string): Promise<Record<string, unknown>[]> {
    const size = Math.max(1, Math.min(200, Number.isInteger(Number(limit)) ? Number(limit) : 100));
    const rows = await this.database.query<RowDataPacket[]>(
      `SELECT cpp.id, cpp.purchase_no, cpp.user_id, u.email AS user_email, u.display_name AS user_name,
              cpp.package_id, cpp.package_code_snapshot, cpp.package_name_snapshot,
              cpp.base_credits_snapshot, cpp.bonus_credits_snapshot, cpp.credits_granted,
              cpp.paid_amount_fen, cpp.currency, cpp.payment_order_id, cpp.status,
              cpp.purchased_at, cpp.notes, cpp.created_at, cpp.updated_at
       FROM credit_package_purchases cpp INNER JOIN users u ON u.id = cpp.user_id
       ORDER BY cpp.created_at DESC LIMIT ${size}`,
    );
    return rows.map((row) => ({
      ...row,
      base_credits_snapshot: Number(row.base_credits_snapshot),
      bonus_credits_snapshot: Number(row.bonus_credits_snapshot),
      credits_granted: Number(row.credits_granted),
      paid_amount_fen: Number(row.paid_amount_fen),
    }));
  }

  private async packageById(packageId: string): Promise<PackageRow> {
    const rows = await this.database.query<PackageRow[]>(
      "SELECT id, code, name, base_credits, bonus_credits, price_fen, currency FROM credit_packages WHERE id = ? LIMIT 1",
      [packageId],
    );
    if (!rows.length) throw new NotFoundException("积分套餐不存在");
    return rows[0]!;
  }

  private async assertReference(table: "users" | "payment_orders" | "ai_tasks" | "provider_models", id: string | null | undefined, label: string): Promise<void> {
    if (!id) return;
    const rows = await this.database.query<RowDataPacket[]>(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [id]);
    if (!rows.length) throw new NotFoundException(`${label}不存在`);
  }

  private validatePurchase(input: CreditPurchaseInput): CreditPurchaseInput {
    const status = input.status.toUpperCase();
    if (!purchaseStatuses.has(status)) throw new BadRequestException("购买记录状态不正确");
    return {
      ...input,
      status,
      creditsGranted: input.creditsGranted === undefined ? undefined : integer(input.creditsGranted, "到账积分", 1),
      paidAmountFen: input.paidAmountFen === undefined ? undefined : integer(input.paidAmountFen, "实付金额（分）", 0),
      currency: input.currency ? currency(input.currency) : undefined,
      notes: input.notes?.trim() || "",
    };
  }

  async createPurchase(adminUserId: string, rawInput: CreditPurchaseInput): Promise<{ id: string }> {
    const input = this.validatePurchase(rawInput);
    await this.assertReference("users", input.userId, "用户");
    await this.assertReference("payment_orders", input.paymentOrderId, "支付订单");
    const creditPackage = await this.packageById(input.packageId);
    const baseCredits = Number(creditPackage.base_credits);
    const bonusCredits = Number(creditPackage.bonus_credits);
    const id = randomUUID();
    const purchaseNo = generatedNumber("CP");
    const purchasedAt = dateValue(input.purchasedAt, "购买时间", input.status === "PAID");
    await this.database.execute(
      `INSERT INTO credit_package_purchases
        (id, purchase_no, user_id, package_id, package_code_snapshot, package_name_snapshot,
         base_credits_snapshot, bonus_credits_snapshot, credits_granted, paid_amount_fen,
         currency, payment_order_id, status, purchased_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, purchaseNo, input.userId, creditPackage.id, creditPackage.code, creditPackage.name,
       baseCredits, bonusCredits, input.creditsGranted ?? baseCredits + bonusCredits,
       input.paidAmountFen ?? Number(creditPackage.price_fen), input.currency || creditPackage.currency,
       input.paymentOrderId || null, input.status, purchasedAt, input.notes],
    );
    await this.audit.record({ adminUserId, action: "credit_purchase.create", entityType: "credit_package_purchase", entityId: id, details: { purchaseNo, userId: input.userId, packageId: input.packageId, status: input.status } });
    return { id };
  }

  async updatePurchase(adminUserId: string, purchaseId: string, rawInput: CreditPurchaseInput): Promise<{ updated: true }> {
    const input = this.validatePurchase(rawInput);
    await this.assertReference("users", input.userId, "用户");
    await this.assertReference("payment_orders", input.paymentOrderId, "支付订单");
    const creditPackage = await this.packageById(input.packageId);
    const baseCredits = Number(creditPackage.base_credits);
    const bonusCredits = Number(creditPackage.bonus_credits);
    const result = await this.database.execute(
      `UPDATE credit_package_purchases SET user_id = ?, package_id = ?, package_code_snapshot = ?,
              package_name_snapshot = ?, base_credits_snapshot = ?, bonus_credits_snapshot = ?,
              credits_granted = ?, paid_amount_fen = ?, currency = ?, payment_order_id = ?,
              status = ?, purchased_at = ?, notes = ? WHERE id = ?`,
      [input.userId, creditPackage.id, creditPackage.code, creditPackage.name, baseCredits, bonusCredits,
       input.creditsGranted ?? baseCredits + bonusCredits, input.paidAmountFen ?? Number(creditPackage.price_fen),
       input.currency || creditPackage.currency, input.paymentOrderId || null, input.status,
       dateValue(input.purchasedAt, "购买时间", input.status === "PAID"), input.notes, purchaseId],
    );
    if (!result.affectedRows) throw new NotFoundException("套餐购买记录不存在");
    await this.audit.record({ adminUserId, action: "credit_purchase.update", entityType: "credit_package_purchase", entityId: purchaseId, details: { userId: input.userId, packageId: input.packageId, status: input.status } });
    return { updated: true };
  }

  async deletePurchase(adminUserId: string, purchaseId: string): Promise<{ deleted: true }> {
    const result = await this.database.execute("DELETE FROM credit_package_purchases WHERE id = ?", [purchaseId]);
    if (!result.affectedRows) throw new NotFoundException("套餐购买记录不存在");
    await this.audit.record({ adminUserId, action: "credit_purchase.delete", entityType: "credit_package_purchase", entityId: purchaseId });
    return { deleted: true };
  }

  async listConsumptions(limit?: string): Promise<Record<string, unknown>[]> {
    const size = Math.max(1, Math.min(200, Number.isInteger(Number(limit)) ? Number(limit) : 100));
    const rows = await this.database.query<RowDataPacket[]>(
      `SELECT ccr.id, ccr.consumption_no, ccr.user_id, u.email AS user_email,
              u.display_name AS user_name, ccr.task_id, ccr.provider_model_id,
              pm.model_alias, pm.model_code, ccr.category, ccr.credits_consumed,
              ccr.status, ccr.description, ccr.notes, ccr.metadata_json,
              ccr.occurred_at, ccr.created_at, ccr.updated_at
       FROM credit_consumption_records ccr
       INNER JOIN users u ON u.id = ccr.user_id
       LEFT JOIN provider_models pm ON pm.id = ccr.provider_model_id
       ORDER BY ccr.occurred_at DESC LIMIT ${size}`,
    );
    return rows.map((row) => ({ ...row, credits_consumed: Number(row.credits_consumed), metadata_json: parseStoredJson(row.metadata_json) }));
  }

  private validateConsumption(input: CreditConsumptionInput): CreditConsumptionInput {
    const status = input.status.toUpperCase();
    const category = input.category.toUpperCase();
    if (!consumptionStatuses.has(status)) throw new BadRequestException("消耗记录状态不正确");
    if (!consumptionCategories.has(category)) throw new BadRequestException("消耗类型不正确");
    if (input.metadata !== undefined && (input.metadata === null || typeof input.metadata !== "object" || Array.isArray(input.metadata))) {
      throw new BadRequestException("扩展数据必须是 JSON 对象");
    }
    return {
      ...input,
      category,
      status,
      creditsConsumed: positiveNumber(input.creditsConsumed, "消耗积分"),
      description: input.description?.trim() || "",
      notes: input.notes?.trim() || "",
    };
  }

  async createConsumption(adminUserId: string, rawInput: CreditConsumptionInput): Promise<{ id: string }> {
    const input = this.validateConsumption(rawInput);
    await this.assertReference("users", input.userId, "用户");
    await this.assertReference("ai_tasks", input.taskId, "任务");
    await this.assertReference("provider_models", input.providerModelId, "供应商模型");
    const id = randomUUID();
    const consumptionNo = generatedNumber("CC");
    await this.database.execute(
      `INSERT INTO credit_consumption_records
        (id, consumption_no, user_id, task_id, provider_model_id, category,
         credits_consumed, status, description, notes, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, consumptionNo, input.userId, input.taskId || null, input.providerModelId || null,
       input.category, input.creditsConsumed, input.status, input.description, input.notes,
       input.metadata === undefined ? null : JSON.stringify(input.metadata),
       dateValue(input.occurredAt, "发生时间", true)],
    );
    await this.audit.record({ adminUserId, action: "credit_consumption.create", entityType: "credit_consumption_record", entityId: id, details: { consumptionNo, userId: input.userId, creditsConsumed: input.creditsConsumed, category: input.category } });
    return { id };
  }

  async updateConsumption(adminUserId: string, consumptionId: string, rawInput: CreditConsumptionInput): Promise<{ updated: true }> {
    const input = this.validateConsumption(rawInput);
    await this.assertReference("users", input.userId, "用户");
    await this.assertReference("ai_tasks", input.taskId, "任务");
    await this.assertReference("provider_models", input.providerModelId, "供应商模型");
    const result = await this.database.execute(
      `UPDATE credit_consumption_records SET user_id = ?, task_id = ?, provider_model_id = ?,
              category = ?, credits_consumed = ?, status = ?, description = ?, notes = ?,
              metadata_json = ?, occurred_at = ? WHERE id = ?`,
      [input.userId, input.taskId || null, input.providerModelId || null, input.category,
       input.creditsConsumed, input.status, input.description, input.notes,
       input.metadata === undefined ? null : JSON.stringify(input.metadata),
       dateValue(input.occurredAt, "发生时间", true), consumptionId],
    );
    if (!result.affectedRows) throw new NotFoundException("积分消耗记录不存在");
    await this.audit.record({ adminUserId, action: "credit_consumption.update", entityType: "credit_consumption_record", entityId: consumptionId, details: { userId: input.userId, creditsConsumed: input.creditsConsumed, category: input.category } });
    return { updated: true };
  }

  async deleteConsumption(adminUserId: string, consumptionId: string): Promise<{ deleted: true }> {
    const result = await this.database.execute("DELETE FROM credit_consumption_records WHERE id = ?", [consumptionId]);
    if (!result.affectedRows) throw new NotFoundException("积分消耗记录不存在");
    await this.audit.record({ adminUserId, action: "credit_consumption.delete", entityType: "credit_consumption_record", entityId: consumptionId });
    return { deleted: true };
  }
}
