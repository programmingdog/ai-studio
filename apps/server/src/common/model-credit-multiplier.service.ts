import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";

export const modelCapabilities = ["TEXT_GENERATION", "VIDEO_UNDERSTANDING", "IMAGE_GENERATION", "VIDEO_GENERATION"] as const;
export type ModelCapability = typeof modelCapabilities[number];
export type CreditMultipliers = Record<ModelCapability, number>;
const columns = ["text_generation", "video_understanding", "image_generation", "video_generation"] as const;
const precision = 1_000_000n;

export function validateMultiplier(value: unknown): number {
  const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  const number = Number(text);
  if (!/^\d+(?:\.\d{1,6})?$/.test(text) || number < 0.000001 || number > 1000) throw new BadRequestException("模型积分系数须为 0.000001～1000 的数字，最多 6 位小数");
  return number;
}

function decimal(value: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) throw new ServiceUnavailableException("模型积分金额无效或超过上限");
  const [mantissa = "0", exponentText = "0"] = String(value).toLowerCase().split("e");
  const fractionDigits = mantissa.split(".")[1]?.length || 0;
  const exponent = Number(exponentText) - fractionDigits;
  return { numerator: BigInt(mantissa.replace(".", "")) * 10n ** BigInt(Math.max(exponent, 0)), denominator: 10n ** BigInt(Math.max(-exponent, 0)) };
}

/** Match the ledger's six decimal places without rounding fractional credits to integers. */
export function multiplyCredits(base: number, multiplier: number): number {
  const left = decimal(base), right = decimal(multiplier);
  const product = left.numerator * right.numerator * precision;
  const denominator = left.denominator * right.denominator;
  const result = (product + denominator - 1n) / denominator;
  if (result > 1_000_000_000_000n * precision) throw new ServiceUnavailableException("最终积分消耗超过上限");
  return Number(result) / Number(precision);
}

export function multiplierFor(values: CreditMultipliers, capability: string): number {
  if (!modelCapabilities.includes(capability as ModelCapability)) throw new ServiceUnavailableException("模型类型无法匹配积分系数");
  try { return validateMultiplier(values[capability as ModelCapability]); }
  catch { throw new ServiceUnavailableException("模型积分系数配置无效"); }
}

@Injectable()
export class ModelCreditMultiplierService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async get(): Promise<{ multipliers: CreditMultipliers; revision: number }> {
    const [row] = await this.database.query<RowDataPacket[]>("SELECT * FROM model_credit_multipliers WHERE id = 1");
    if (!row) throw new ServiceUnavailableException("模型积分系数配置缺失，请执行数据库迁移");
    const values = Object.fromEntries(modelCapabilities.map((capability, index) => [capability, Number(row[columns[index]!])])) as CreditMultipliers;
    for (const capability of modelCapabilities) multiplierFor(values, capability);
    return { multipliers: values, revision: Number(row.revision) };
  }

  async save(adminId: string, input: { multipliers: unknown; revision: unknown }) {
    const source = input.multipliers && typeof input.multipliers === "object" && !Array.isArray(input.multipliers) ? input.multipliers as Record<string, unknown> : {};
    const values = modelCapabilities.map((capability) => validateMultiplier(source[capability]));
    if (!Number.isInteger(input.revision) || Number(input.revision) < 0) throw new BadRequestException("系数配置版本无效");
    if (Object.keys(source).some((name) => !modelCapabilities.includes(name as ModelCapability))) throw new BadRequestException("不支持的模型系数类型");
    await this.database.transaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT * FROM model_credit_multipliers WHERE id = 1 FOR UPDATE");
      const previous = rows[0];
      if (!previous || Number(previous.revision) !== input.revision) throw new ConflictException("积分系数已被修改，请重新读取后再保存");
      await connection.execute("UPDATE model_credit_multipliers SET text_generation = ?, video_understanding = ?, image_generation = ?, video_generation = ?, revision = revision + 1, updated_by = ? WHERE id = 1", [...values, adminId]);
      await connection.execute("INSERT INTO audit_logs (id, admin_user_id, action, entity_type, entity_id, details_json) VALUES (?, ?, 'credit_multiplier.configure', 'model_credit_multipliers', '1', ?)", [randomUUID(), adminId, JSON.stringify({
        previous: Object.fromEntries(modelCapabilities.map((capability, index) => [capability, Number(previous[columns[index]!])])),
        next: Object.fromEntries(modelCapabilities.map((capability, index) => [capability, values[index]])),
      })]);
    });
    return this.get();
  }
}
