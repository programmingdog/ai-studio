import { BadRequestException } from "@nestjs/common";

// Exactly one mailbox: the upstream API treats commas as multiple recipients.
export function normalizedEmail(value: string): string {
  const result = value.trim().toLowerCase();
  if (result.length > 191 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(result)) {
    throw new BadRequestException("邮箱格式不正确，请填写一个邮箱地址");
  }
  const local = result.split("@")[0]!;
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) throw new BadRequestException("邮箱格式不正确");
  return result;
}

export function validatePassword(value: string): string {
  if (value.length < 8 || value.length > 128) throw new BadRequestException("密码长度必须是 8～128 个字符");
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) throw new BadRequestException("密码必须同时包含字母和数字");
  return value;
}
