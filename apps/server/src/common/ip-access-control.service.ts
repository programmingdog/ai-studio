import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import * as ipaddr from "ipaddr.js";
import type { RowDataPacket } from "mysql2";
import { AuditService } from "./audit.service";
import { DatabaseService } from "../database/database.service";

type Address = ipaddr.IPv4 | ipaddr.IPv6;
type ParsedRule = { cidr: string; family: 4 | 6; prefixLength: number; address: Address };
interface RuleRow extends RowDataPacket {
  id: string; cidr: string; address_family: number; prefix_length: number; note: string;
  enabled: number; created_by: string; updated_by: string; created_at: Date | string; updated_at: Date | string;
}

function withoutZone(value: string): string {
  const trimmed = value.trim();
  const percent = trimmed.indexOf("%");
  return percent >= 0 ? trimmed.slice(0, percent) : trimmed;
}

export function parseClientIp(value: string | undefined | null): Address | null {
  if (!value) return null;
  try {
    const parsed = ipaddr.parse(withoutZone(value));
    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6;
      return ipv6.isIPv4MappedAddress() ? ipv6.toIPv4Address() : ipv6;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeClientIp(value: string | undefined | null): string | null {
  return parseClientIp(value)?.toString() || null;
}

export function parseIpRule(value: string): ParsedRule {
  const raw = value.trim();
  if (!raw || raw.length > 64) throw new BadRequestException("请输入有效的 IP 地址或 CIDR 网段");
  try {
    let address: Address;
    let prefixLength: number;
    if (raw.includes("/")) [address, prefixLength] = ipaddr.parseCIDR(raw);
    else {
      address = ipaddr.parse(withoutZone(raw));
      prefixLength = address.kind() === "ipv4" ? 32 : 128;
    }
    if (address.kind() === "ipv6" && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
      if (prefixLength < 96) throw new Error("ambiguous mapped IPv4 range");
      address = (address as ipaddr.IPv6).toIPv4Address();
      prefixLength -= 96;
    }
    const family = address.kind() === "ipv4" ? 4 : 6;
    const bytes = address.toByteArray();
    for (let index = 0; index < bytes.length; index += 1) {
      const remaining = prefixLength - index * 8;
      const mask = remaining >= 8 ? 255 : remaining <= 0 ? 0 : (255 << (8 - remaining)) & 255;
      bytes[index] = (bytes[index] || 0) & mask;
    }
    const network = ipaddr.fromByteArray(bytes);
    return { cidr: `${network.toString()}/${prefixLength}`, family, prefixLength, address: network };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException("请输入有效的 IPv4、IPv6 地址或 CIDR 网段，例如 203.0.113.8 或 203.0.113.0/24");
  }
}

export function ipMatchesRule(ip: string | undefined | null, ruleValue: string): boolean {
  const address = parseClientIp(ip);
  if (!address) return false;
  const rule = parseIpRule(ruleValue);
  if ((address.kind() === "ipv4" ? 4 : 6) !== rule.family) return false;
  return rule.family === 4
    ? (address as ipaddr.IPv4).match(rule.address as ipaddr.IPv4, rule.prefixLength)
    : (address as ipaddr.IPv6).match(rule.address as ipaddr.IPv6, rule.prefixLength);
}

@Injectable()
export class IpAccessControlService {
  private cache: { expiresAt: number; rules: ParsedRule[] } | null = null;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async isBlocked(ip: string | undefined | null): Promise<boolean> {
    const address = parseClientIp(ip);
    if (!address) return false;
    const family = address.kind() === "ipv4" ? 4 : 6;
    const rules = await this.activeRules();
    return rules.some((rule) => rule.family === family && (rule.family === 4
      ? (address as ipaddr.IPv4).match(rule.address as ipaddr.IPv4, rule.prefixLength)
      : (address as ipaddr.IPv6).match(rule.address as ipaddr.IPv6, rule.prefixLength)));
  }

  async list(currentIp?: string | null) {
    const rows = await this.database.query<RuleRow[]>(`SELECT id, cidr, address_family, prefix_length, note, enabled, created_by, updated_by, created_at, updated_at FROM ip_access_rules ORDER BY enabled DESC, updated_at DESC`);
    return { current_ip: normalizeClientIp(currentIp), rules: rows.map((row) => this.present(row)) };
  }

  async create(adminUserId: string, input: { cidr: string; note?: string; enabled: boolean }, currentIp?: string | null) {
    const rule = parseIpRule(input.cidr);
    this.assertDoesNotBlockCurrentAdmin(rule.cidr, input.enabled, currentIp);
    const note = (input.note || "").trim();
    if (note.length > 200) throw new BadRequestException("备注不能超过 200 个字符");
    const count = await this.database.query<(RowDataPacket & { count: number })[]>("SELECT COUNT(*) AS count FROM ip_access_rules");
    if (Number(count[0]?.count || 0) >= 1000) throw new BadRequestException("IP 风控规则最多允许 1000 条");
    const id = randomUUID();
    try {
      await this.database.execute(`INSERT INTO ip_access_rules (id, cidr, address_family, prefix_length, note, enabled, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, rule.cidr, rule.family, rule.prefixLength, note, input.enabled ? 1 : 0, adminUserId, adminUserId]);
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw new ConflictException("该 IP 或网段规则已经存在");
      throw error;
    }
    this.invalidate();
    await this.audit.record({ adminUserId, action: "ip_access_rule.create", entityType: "ip_access_rule", entityId: id, details: { cidr: rule.cidr, note, enabled: input.enabled } });
    return this.get(id);
  }

  async update(adminUserId: string, id: string, input: { cidr: string; note?: string; enabled: boolean }, currentIp?: string | null) {
    const existing = await this.find(id);
    const rule = parseIpRule(input.cidr);
    this.assertDoesNotBlockCurrentAdmin(rule.cidr, input.enabled, currentIp);
    const note = (input.note || "").trim();
    if (note.length > 200) throw new BadRequestException("备注不能超过 200 个字符");
    try {
      await this.database.execute(`UPDATE ip_access_rules SET cidr = ?, address_family = ?, prefix_length = ?, note = ?, enabled = ?, updated_by = ? WHERE id = ?`, [rule.cidr, rule.family, rule.prefixLength, note, input.enabled ? 1 : 0, adminUserId, id]);
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw new ConflictException("该 IP 或网段规则已经存在");
      throw error;
    }
    this.invalidate();
    await this.audit.record({ adminUserId, action: "ip_access_rule.update", entityType: "ip_access_rule", entityId: id, details: { before: this.present(existing), after: { cidr: rule.cidr, note, enabled: input.enabled } } });
    return this.get(id);
  }

  async remove(adminUserId: string, id: string) {
    const existing = await this.find(id);
    await this.database.execute("DELETE FROM ip_access_rules WHERE id = ?", [id]);
    this.invalidate();
    await this.audit.record({ adminUserId, action: "ip_access_rule.delete", entityType: "ip_access_rule", entityId: id, details: { cidr: existing.cidr, note: existing.note, enabled: Boolean(existing.enabled) } });
    return { deleted: true, id };
  }

  private async activeRules(): Promise<ParsedRule[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.rules;
    const rows = await this.database.query<(RowDataPacket & { cidr: string })[]>("SELECT cidr FROM ip_access_rules WHERE enabled = 1");
    const rules = rows.map((row) => parseIpRule(row.cidr));
    this.cache = { expiresAt: Date.now() + 5000, rules };
    return rules;
  }

  private invalidate() { this.cache = null; }
  private assertDoesNotBlockCurrentAdmin(cidr: string, enabled: boolean, currentIp?: string | null) {
    if (enabled && currentIp && ipMatchesRule(currentIp, cidr)) throw new BadRequestException("该规则会立即阻止你当前的管理端 IP，不能启用");
  }
  private async find(id: string): Promise<RuleRow> {
    const rows = await this.database.query<RuleRow[]>(`SELECT id, cidr, address_family, prefix_length, note, enabled, created_by, updated_by, created_at, updated_at FROM ip_access_rules WHERE id = ? LIMIT 1`, [id]);
    if (!rows[0]) throw new NotFoundException("IP 风控规则不存在");
    return rows[0];
  }
  private async get(id: string) { return this.present(await this.find(id)); }
  private present(row: RuleRow) {
    return { id: row.id, cidr: row.cidr, address_family: Number(row.address_family), prefix_length: Number(row.prefix_length), note: row.note, enabled: Boolean(row.enabled), created_by: row.created_by, updated_by: row.updated_by, created_at: row.created_at, updated_at: row.updated_at };
  }
}

export function createIpAccessMiddleware(service: Pick<IpAccessControlService, "isBlocked">) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const ip = request.ip || request.socket.remoteAddress;
      if (await service.isBlocked(ip)) {
        response.status(403).json({ statusCode: 403, message: "当前网络地址已被平台风控限制", error: "Forbidden", code: "IP_ACCESS_DENIED" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
