import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";

const precision = 1_000_000n;

export function validateModelCreditMultiplier(value: unknown): number {
  const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  const number = Number(text);
  if (!/^\d+(?:\.\d{1,6})?$/.test(text) || number < 0.000001 || number > 1000) {
    throw new BadRequestException("模型积分系数须为 0.000001～1000 的数字，最多 6 位小数");
  }
  return number;
}

export function storedModelCreditMultiplier(value: unknown): number {
  try { return validateModelCreditMultiplier(value); }
  catch { throw new ServiceUnavailableException("模型积分系数配置无效"); }
}

function decimal(value: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) throw new ServiceUnavailableException("模型积分金额无效或超过上限");
  const [mantissa = "0", exponentText = "0"] = String(value).toLowerCase().split("e");
  const fractionDigits = mantissa.split(".")[1]?.length || 0;
  const exponent = Number(exponentText) - fractionDigits;
  return { numerator: BigInt(mantissa.replace(".", "")) * 10n ** BigInt(Math.max(exponent, 0)), denominator: 10n ** BigInt(Math.max(-exponent, 0)) };
}

/** Match the ledger's six decimal places, rounding any smaller positive charge upward. */
export function multiplyCredits(base: number, multiplier: number): number {
  const left = decimal(base), right = decimal(multiplier);
  const product = left.numerator * right.numerator * precision;
  const denominator = left.denominator * right.denominator;
  const result = (product + denominator - 1n) / denominator;
  if (result > 1_000_000_000_000n * precision) throw new ServiceUnavailableException("最终积分消耗超过上限");
  return Number(result) / Number(precision);
}

/** A configured model's billable unit price must be a whole credit. */
export function roundedModelCredits(base: number, multiplier: number): number {
  return Math.ceil(multiplyCredits(base, multiplier));
}
