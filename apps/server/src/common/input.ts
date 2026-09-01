import { BadRequestException } from "@nestjs/common";

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${key} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new BadRequestException(`${key} is too long`);
  return normalized;
}

export function optionalString(body: Record<string, unknown>, key: string, maxLength = 500): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new BadRequestException(`${key} must be a string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new BadRequestException(`${key} is too long`);
  return normalized;
}

export function jsonValue(body: Record<string, unknown>, key: string): unknown {
  if (!(key in body)) throw new BadRequestException(`${key} is required`);
  const value = body[key];
  if (value === undefined) throw new BadRequestException(`${key} is required`);
  return value;
}

export function parseStoredJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}
