import { BadRequestException } from "@nestjs/common";
import { randomInt } from "node:crypto";

const MAX_RECEIPT_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_RECEIPT_DATA_URL_LENGTH = Math.ceil(MAX_RECEIPT_IMAGE_BYTES / 3) * 4 + 32;

export function generateInviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
    if (/[A-Z]/.test(code) && /[0-9]/.test(code)) return code;
  }
}
export function inviteCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) throw new BadRequestException("邀请码须为 8 位字母数字");
  return code;
}
export function integer(value: unknown, name: string, min = 0, max = 1_000_000_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new BadRequestException(`${name}必须是 ${min}～${max} 的整数`);
  return value;
}
export function commissionFen(amount: number, bps: number): number {
  integer(amount, "实付金额", 0, Number.MAX_SAFE_INTEGER); integer(bps, "分润比例", 0, 10000);
  return Number(BigInt(amount) * BigInt(bps) / 10000n);
}
export function withdrawalWindow(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  const weekday = shifted.getUTCDay();
  const next = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + ((5 - weekday + 7) % 7 || 7)) - 8 * 3600_000);
  return { withdrawal_open: weekday === 5, timezone: "Asia/Shanghai", server_time: now.toISOString(), next_open_at: next.toISOString() };
}
export function publicUrl(value: unknown, name: string, maxLength = 1000): string {
  if (typeof value !== "string" || value.length > maxLength) throw new BadRequestException(`${name}格式无效`);
  const result = value.trim();
  if (!result) return "";
  let url: URL;
  try { url = new URL(result); } catch { throw new BadRequestException(`${name}须为完整网址`); }
  if (url.username || url.password || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new BadRequestException(`${name}须为 HTTPS（本地调试可用 HTTP），且不能包含账号密码或片段`);
  return result;
}
export function receiptImage(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_RECEIPT_DATA_URL_LENGTH) throw new BadRequestException("收款码须为不超过 2MB 的 PNG/JPEG 图片");
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new BadRequestException("只支持 PNG/JPEG 收款码，不接受链接或 SVG");
  const bytes = Buffer.from(match[2]!, "base64");
  const valid = match[1] === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!valid || bytes.length > MAX_RECEIPT_IMAGE_BYTES || bytes.length < 20 || bytes.toString("base64") !== match[2]) throw new BadRequestException("收款码图片无效或超过 2MB");
  return value;
}
